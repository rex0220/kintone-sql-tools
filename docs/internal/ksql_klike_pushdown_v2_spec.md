# 仕様案: KLIKE プレフィルタ押し下げ（v2）

- 作成日: 2026-07-15
- ステータス: **v2 実装済み・v2.9.0 リリース済（FULL_SCAN での KLIKE プレフィルタ押し下げ・INNER JOIN 限定・fail-closed 集合ゲート）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版（検討）。
  - 2026-07-15 R2: codex レビュー反映（全点コードで裏取り）。
    - **[P0] 外部結合で KLIKE を一律 true にすると誤結果**。`applyJoin`（[process.ts:90](../../src/engine/process.ts#L90)）は LEFT/RIGHT で**未一致側に空行を生成**する。nullable 側テーブルの KLIKE を押し下げると、条件不一致の右行が消えて LEFT JOIN が空右行を再生成し、KLIKE を true 扱いすると本来除外すべき左行が残る（既存の数値等は JS 再評価で空行が偽になり安全だが、KLIKE は再評価不可）。→ **v2 minimal は KLIKE 押し下げを「JOIN が無い、または全 JOIN が INNER」に限定**（§2.6）。外部結合解禁は nullable 側判定 or 来歴付与が要る（将来）。
    - **[答1] 共有押し下げ計画**: 検証で同じ関数を呼ぶだけでなく、**テーブル別押し下げ計画を一度生成し、検証・fetch・JS 評価・EXPLAIN で共有**する（§2.1）。
    - **[答2] グローバル `return true` は不採用**: `evalWhere` へ**実際に押し下げた KLIKE ノード集合**を渡し、集合内なら true・集合外なら**従来どおり throw**（検証漏れを fail-open にしない・§2.2）。
    - **[答3] `NOT (KLIKE)` は v2 minimal では拒否**（直接の `NOT KLIKE` で代替可・正規化採用は全経路で正規化済み AST 共有が必要・§2.5）。
    - **[P1] CTE インライン化後の AST で計画を作る**。R1時点では検証側 `buildEffectiveInlineSelect` と実行側 `buildInlinedQuery` が別実装で、実行側だけが CTE エイリアスを除去していた。ノード同一性・対象テーブル判定の乖離を避けるため、**共通インライン化関数へ集約**する（§2.7）。
  - 2026-07-15 v2実装: 共有計画、INNER限定、集合ゲート、共通CTEインライン化、EXPLAIN、単体・統合テストを実装。全1100テスト＋CLI subprocess 25テスト green。実機検証待ち。
- 前提: KLIKE v1（[ksql_klike_native_search_spec.md](ksql_klike_native_search_spec.md)・**v2.8.0 リリース済**）。v1 は KLIKE を **SIMPLE SELECT の WHERE 限定**とし、FULL_SCAN になる SELECT では拒否している。
- 関連コード: `src/core/optimization/klikePushdownPlan.ts`（共有計画）、`src/core/optimization/wherePredicatePushdown.ts`（安全リーフ抽出）、`src/core/cteInlining.ts`（共通CTEインライン化）、`src/engine/evalWhere.ts`（集合ゲート）、`src/core/klikeValidation.ts`（静的検証）、`src/execute.ts`（FULL_SCAN・EXPLAIN配線）

## 0. 目的

v1 で拒否している「**KLIKE と、FULL_SCAN を要する条件の併用**」を、KLIKE を**安全な AND リーフとして kintone にプレフィルタ押し下げ**することで解禁する。kintone が KLIKE で候補を絞り、JS が残りの条件（`LIKE`・関数・集計など）を精製する。

```sql
-- v1 では拒否。v2 では: kintone が 件名 like "至急" で絞り込み → JS が備考の LIKE を精製
SELECT 件名, 備考 FROM APP100 WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'

-- 集計・JOIN・DISTINCT で FULL_SCAN になるが、KLIKE を kintone 側で効かせたい
SELECT COUNT(*) FROM APP100 WHERE 件名 KLIKE '至急'
```

## 1. 正しさの枠組み（超集合性＋KLIKE は JS 再評価不可）

- **KLIKE は JS で再評価できない**（kintone ネイティブ）。よって KLIKE は**必ず kintone 側で適用される（＝押し下げられる）ことが保証される位置**でのみ許可する。
- 押し下げは `extractSafePushdownLeaves`（AND リーフ抽出）で行う。KLIKE を安全リーフに追加すると、**AND/GROUP 経由で到達する KLIKE リーフ**が kintone プレフィルタに乗る（`extractAndLeaves` は OR/NOT を `null` にする）。
- 取得後の JS 再評価では、**押し下げ済みの KLIKE リーフを「適用済み＝真」として扱う**。プレフィルタ集合 ⊇ 最終一致集合（超集合性）なので、JS が KLIKE 以外の条件で精製すれば正しい結果になる。
- **不変条件（安全性の要）**: WHERE 内のすべての KLIKE が「押し下げられる位置」にあること。1 つでも押し下げられない KLIKE（OR/NOT 配下・非対象テーブル）があると、JS が「真」扱いして**誤結果**になる → **実行前に拒否**。

## 2. 設計

### 2.1 共有押し下げ計画（[答1]・設計の中心）
検証・fetch・JS 評価・EXPLAIN の**乖離を無くす**ため、**テーブル別押し下げ計画を一度だけ生成して全経路で共有**する。
- 計画 = 「テーブル（メイン／各 JOIN）ごとの押し下げ WHERE」＋「**実際に押し下げた KLIKE ノードの集合**（参照同一性で保持）」。
- 生成は既存の `extractMainSafePushdown` / 各 JOIN の `extractSafePushdownLeaves` を用いる（下記 §2.4 で `isKlikeComparison` を追加）。抽出された KLIKE リーフを計画の「押し下げ済み KLIKE 集合」に記録する。
- この 1 つの計画を: 検証（§2.3）・fetch（§2.6）・JS 評価（§2.2・集合を渡す）・EXPLAIN が参照する。**同じ AST（CTE インライン化後・§2.7）に対して生成**する。

### 2.2 JS 評価（`evalWhere.ts`）＝集合ゲート（[答2]）
- グローバルな `return true` は**不採用**。`evalWhere`（および評価経路）へ**押し下げ済み KLIKE ノード集合**を渡す。
  - KLIKE/NOT_KLIKE リーフが**集合内**（実際に押し下げられた）→ `true`（適用済み）。
  - **集合外**（押し下げられていない）→ **従来どおり throw**（fail-closed）。検証漏れや計画の想定外を**誤結果でなく明示エラー**にする。
- ノード同一性は §2.1 の計画で保持した参照で判定（`WeakSet` 等）。

### 2.3 静的検証（`klikeValidation.ts`）の緩和＝計画ベース
v1 は「KLIKE ∧ FULL_SCAN → 拒否」。v2 は次に緩和する（**§2.1 の計画を使う**）:
- SIMPLE SELECT: 従来どおり KLIKE 可（WHERE 全体が kintone へ）。
- **FULL_SCAN SELECT: WHERE 内の全 KLIKE が計画の「押し下げ済み KLIKE 集合」に含まれれば可、1 つでも含まれなければ拒否**。
  - 含まれない典型: `OR` 配下・`NOT` ノード配下（§2.5）・非対象テーブル（CTE/一時テーブル）・**外部結合の nullable 側**（§2.6）。明確なメッセージで拒否。
- **整合性**: 検証は独立ロジックを再実装せず、§2.1 の計画（抽出器が実際に押し下げる集合）を正とする。これで「検証は許可したが押し下げられない」乖離が原理的に起きない。

### 2.4 押し下げ判定（`wherePredicatePushdown.ts`）
- `isSafeComparison` に **`isKlikeComparison` を追加**。KLIKE は型メタ・選択肢メタ不要（左辺が対象テーブルの単純フィールド参照・`op` が `KLIKE`/`NOT_KLIKE`・右辺が解決後 `STRING` なら常に kintone へ変換可能）。
- `extractAndLeaves` は AND/GROUP 経由のみ抽出（OR/NOT は `null`）＝KLIKE の安全位置と一致。数値・選択系・$id の既存押し下げと**併存**。

### 2.5 実行配線（`execute.ts`）
- FULL_SCAN 経路は共有計画の `mainCondition` / `joinConditions` をそのまま `pushQuery` に使う（既存の数値/選択系押し下げも同じ計画に含む）。
- `baseQuery`（`selectToFetchAllParams` の丸ごと変換）と併存: KLIKE は `whereRequiresJsEval` 非該当なので、`GROUP BY` 等で FULL_SCAN・WHERE 変換可能な経路では `baseQuery` にも KLIKE が乗る（冗長だが無害）。`LIKE` 併用経路では `baseQuery` 空・`pushQuery` に KLIKE。
- EXPLAIN: KLIKE を含む押し下げクエリを表示。

### 2.5 NOT の扱い（[答3]・拒否で単純化）
- `件名 NOT KLIKE 'x'`（直接の否定演算子・BINARY `NOT_KLIKE`）は AND リーフとして押し下げ可。
- `NOT (件名 KLIKE 'x')`（`NOT` ノード）は `extractAndLeaves` が `null` にするため押し下げられない → **v2 minimal では拒否**（`pushDownNot` 正規化での救済は、検証・抽出・JS 評価の全経路で同じ正規化済み AST を共有する必要があり複雑。直接の `NOT KLIKE` で代替可）。

### 2.6 JOIN は INNER 限定（[P0]・正しさの要）
外部結合の nullable 側で KLIKE を押し下げると、`applyJoin`（[process.ts:90](../../src/engine/process.ts#L90)）が生成する**未一致の空行**を KLIKE→true が誤って通す（KLIKE は JS 再評価できないため既存述語のような超集合性だけでは安全にならない）。
- **v2 minimal: KLIKE 押し下げは「JOIN が無い、または全 JOIN が INNER」のときだけ許可**。LEFT/RIGHT/FULL を含む SELECT に KLIKE があれば**拒否**（メイン側 KLIKE は安全だが、minimal では join 種別で単純に判定）。
- 将来: nullable 側判定（結合順・保存側/nullable 側の解析）や取得行への KLIKE 適用済み来歴付与で、非 nullable 側の KLIKE を解禁。

#### 将来課題 B6 — 外部結合の非 nullable（保存）側の KLIKE 押し下げ解禁（⏸ 却下・代替策あり・2026-07-21）

**状態**: **却下（2026-07-21）**。下記「回避策」で用途を安全・等価にカバーできるため、専用実装（非 nullable 側判定に結合順/来歴解析が必要・誤ると P0 誤結果再導入・実需未確認）はリスクに見合わず却下とした。台帳 §3。以下は判断の記録。

**何を解禁するか**: 現状は `stmt.joins.every(j => j.type === "INNER")`（[klikePushdownPlan.ts:63](../../src/core/optimization/klikePushdownPlan.ts#L63)）で、LEFT/RIGHT/FULL を1つでも含む SELECT は KLIKE 押し下げを**一律拒否**する。しかし外部結合でも **非 nullable（保存）側の KLIKE は本来安全に押し下げられる**。B6 はその判定を入れて非 nullable 側だけ解禁する（nullable 側は拒否のまま）。

**なぜ一律拒否なのか（[P0] の再掲）**: `applyJoin`（[process.ts:90](../../src/engine/process.ts#L90)）は外部結合の未一致側に**空行**を生成する。例 `A LEFT JOIN B` では A（左）=保存側=**非 nullable**、B（右）=未一致時に空行=**nullable 側**。
- **nullable 側（B）の KLIKE を押し下げると誤結果**: fetch で非一致の B 行が落ち、LEFT JOIN が空 B 行を再生成する。**KLIKE は JS 再評価できない**（押し下げ済み集合＝`appliedKlikes` に無ければ評価不能で throw）ため、その空行の KLIKE を安全に false 化できず、本来除外すべき行が残り得る。数値/LIKE は JS 残余評価で空行が偽になり超集合性が効くが、**KLIKE は再評価不可なので超集合性だけでは安全にならない**。
- **非 nullable 側（A）の KLIKE は安全**: 保存側の行は空合成されないため、fetch で絞った集合がそのまま正しい。

**なぜ非自明（＝棚上げの理由）**: 「どちらが非 nullable（保存）側か」は **join 種別＋結合順の解析**が要る。`A LEFT JOIN B` は A が保存側、`A RIGHT JOIN B` は B が保存側、複数 JOIN や混在ではさらに複雑。誤ると P0 の誤結果を再導入するため、**来歴（どのテーブルが保存側か）を正しく付与する設計**が前提。v2 minimal は安全側に倒して join 種別だけで単純判定している。最も単純な第一歩は「メイン（FROM）テーブルは LEFT JOIN 連鎖で常に保存側 → メイン側 KLIKE のみ外部結合でも解禁」だが、RIGHT JOIN の保存側や被結合テーブルの保存側まで一般化するには上記の来歴解析が必要。

**効果と判断**: 効果は「外部結合 ＋ 保存側フィールドの KLIKE ＋ 大規模アプリ」という**狭いケースの性能改善**に限られ、実需も確認されていない。誤結果リスク（正しさ）に対して費用対効果が低いため保留が妥当。実需が出たら、非 nullable 側判定の正しさ設計を主眼とする専用仕様で着手する。

**回避策（推奨・実データ確認済み 2026-07-21）**: 非 nullable（保存）側の KLIKE ＋ 外部結合は、**一時テーブルを KLIKE で作ってから JOIN する**ことで既存機能だけで安全に実現できる。B6 の実用ケースをほぼ完全にカバーするため、当面 B6 の実装は不要。

```sql
-- 現状拒否される形（KLIKE は JS 再評価不可で外部結合下は文ごと拒否）:
-- SELECT ... FROM A LEFT JOIN B ON ... WHERE A.件名 KLIKE '至急';

-- 回避策（等価・安全・高速）:
CREATE TEMP TABLE #a AS SELECT ... FROM A WHERE 件名 KLIKE '至急';  -- JOIN なし→KLIKE 押し下げ OK・実体化
SELECT ... FROM #a LEFT JOIN B ON ...;                             -- KLIKE なし→制約に触れない
```

- **なぜ安全か**: KLIKE は「JOIN なしの単純 SELECT（一時テーブル作成）」でのみ使う → §2.6 の [P0]（外部結合の空行を KLIKE→true が誤って通す）が原理的に起きない。一時テーブルは KLIKE 一致行の確定集合として実体化され、続く LEFT JOIN には KLIKE が無い。
- **なぜ等価か**: 一時テーブル #a は「A の KLIKE 一致行」＝保存側そのもの。`#a LEFT JOIN B` は未一致 B を NULL 埋めするため、`A LEFT JOIN B WHERE A.KLIKE ...` と同じ結果になる。
- **性能**: KLIKE は一時テーブル作成時に kintone へ押し下がるため、native 検索の速度を維持する。
- **制約**: KLIKE は10万件未満に絞る（一時テーブル実体化も打ち切り時は fail-closed）。JOIN 相手 B はクライアント側で全件取得するため常識的なサイズにする（JOIN 一般の性質）。nullable 側の KLIKE はこの回避策でも等価にならない（が、それは元々安全でない別物）。
- **一時テーブルと WITH（CTE）のどちらでも書ける（v3.11.0 以降）**: 本回避策は一時テーブル（`CREATE TEMP TABLE ... AS SELECT`）でも WITH（CTE）でも書ける。KLIKE は「JOIN なしの単純 SELECT」＝一時テーブル本体 or CTE 本体で使い、外側の LEFT JOIN には KLIKE を含めない。
  ```sql
  -- 一時テーブル版
  CREATE TEMP TABLE #a AS SELECT ... FROM A WHERE 件名 KLIKE '至急';
  SELECT ... FROM #a a LEFT JOIN #b b ON ...;

  -- WITH（CTE）版（v3.11.0 以降）
  WITH a AS (SELECT ... FROM A WHERE 件名 KLIKE '至急'), b AS (SELECT ... FROM B ...)
  SELECT ... FROM a LEFT JOIN b ON ...;
  ```
  **注意（v3.10.0 以前）**: v3.10.0 以前は WITH の CTE 間 JOIN に別バグ（B51＝左 CTE の列が空・行重複・LEFT 未一致欠落）があり誤結果になった。**v3.11.0 の B51 修正（effective alias）で解消**（[ksql_b51_cte_to_cte_join_wrong_result_issue.md](ksql_b51_cte_to_cte_join_wrong_result_issue.md)）。v3.11.0 以降はどちらでも正しい。
- **実データ確認**: APP730 で①一時テーブル版 `#gifu(KLIKE ギフケン,IN 1..5) LEFT JOIN #b(IN 1..3)`②WITH 版 `WITH a AS(...KLIKE ギフケン...IN 1..5), b AS(...IN 1..3) SELECT ... FROM a LEFT JOIN b` の**両方**で、一致3件は結合列を持ち未一致2件は NULL 埋め＝`A LEFT JOIN B WHERE A.KLIKE` と等価な結果を確認した（②は v3.11.0 の B51 修正後）。

### 2.7 CTE インライン化後の AST で計画を作る（[P1]）
R1時点では検証用と実行用のインライン化が別実装で、実行側だけが `stripCteAlias` 相当の処理を行っていた。ノード同一性・対象テーブル判定（§2.1/2.2）を使う v2 では、この差で検証・抽出の集合が乖離する。
- **実装**: `src/core/cteInlining.ts` の `canInlineSingleCte` / `buildInlinedQuery` に集約し、インライン化後の AST に対して押し下げ計画（§2.1）を生成する。同じ AST をfetch・JS評価へ渡し、EXPLAINにも`effective: inlined CTE`として表示する。
- 押し下げ済み KLIKE ノード集合の参照同一性は、この**インライン化後 AST 上のノード**で保持する（インライン前 AST とは別オブジェクトになるため）。

## 3. P0（10 万件打ち切り）との関係
- KLIKE プレフィルタ取得が **10 万件打ち切り**に達すると、kintone が検索を打ち切り、**JS が精製する母集合が欠落**し得る（v1 SELECT と同じサイレント過少一致）。→ v2 でも「完全な結果を保証しない場合がある」を継承（[ksql_search_abort_warning_issue.md](ksql_search_abort_warning_issue.md) の P0 が解決基盤）。
- v1 と同様、DML では KLIKE を引き続き禁止（v2 は SELECT の押し下げのみ）。

## 4. 効果評価
- **解禁される主なパターン**: ① KLIKE ＋ `LIKE`（kintone で粗く絞り JS で精密一致）② KLIKE ＋ 集計/`DISTINCT`（`COUNT(*) … WHERE KLIKE` 等）③ KLIKE ＋ JOIN。
- **効果**: v1 では「KLIKE を含むと FULL_SCAN 化する条件は一切併用不可」だったのが、KLIKE で kintone 側の絞り込みを効かせつつ JS 精製ができる。特に **KLIKE ＋ LIKE** は「kintone の高速キーワード検索」と「JS の正確な部分一致」を両取りできる実用価値が高い。
- **回避策との比較**: v1 では「LIKE のみ（全件 FULL_SCAN・遅い）」か「KLIKE のみ（精密一致は不可）」の二択。v2 は両立を可能にする（現状代替が乏しい）。
- **限界**: 意味論は kintone 依存（v1 と同じ）。10 万件打ち切りで母集合欠落の可能性（P0）。KLIKE は **AND リーフ位置のみ**（OR/`NOT`ノード配下は不可）。**JOIN は INNER 限定**（外部結合含む SELECT では不可・§2.6）。③ の「KLIKE ＋ JOIN」は INNER JOIN に限る。

## 5. リスク・エッジ
- **検証と抽出の乖離**が最大リスク → **§2.1 の共有押し下げ計画**（抽出器が実際に押し下げる集合を全経路で共有）と **§2.2 の集合ゲート（集合外は throw＝fail-closed）** で原理的に回避。
- **外部結合の nullable 側**（[P0]）→ §2.6 で INNER 限定。
- **CTE インライン化の実装差**（[P1]）→ §2.7 でインライン化後 AST に計画生成・参照同一性を後 AST で保持。
- バッチ変数置換後の再検証・計画再生成（v1 と同様・置換後 STRING で押し下げ判定）。
- サブテーブル DML・親 DML は対象外（KLIKE 禁止のまま）。EXPLAIN・保存クエリ・UNION 各枝・CTE の整合。

## 6. スコープと進め方
- **v2 = SELECT の KLIKE プレフィルタ押し下げのみ**（AND リーフ位置・**INNER JOIN 限定**・`NOT`ノード配下不可・DML 非対象・P0 は継承）。
- **確定事項（R2）**: (1) 検証は**共有押し下げ計画ベース**（§2.1・独立ロジック再実装しない）／(2) `evalWhere` は**集合ゲート**（集合外は throw・fail-closed・§2.2）／(3) `NOT (KLIKE)` は**拒否**（§2.5）／外部結合は **INNER 限定**（§2.6）／CTE は**インライン化後 AST で計画生成**（§2.7）。
- 受入（実装後）: KLIKE＋LIKE で kintone 絞り込み＋JS 精製が正しい・KLIKE＋COUNT(*)/DISTINCT・INNER JOIN の KLIKE 押下・**LEFT/RIGHT JOIN の KLIKE は拒否**・OR/`NOT`ノード配下の KLIKE 拒否・押し下げ集合外 KLIKE が評価到達で throw・CTE インライン後も検証/評価一致・EXPLAIN 表示・バッチ変数置換後・v1 の SIMPLE KLIKE と既存押し下げが非退行。
- 進め方: R2確定 → **実装・自動テスト完了** → 実機（上記受入）→ minor リリース。将来: 外部結合の非 nullable 側解禁・P0 検出基盤・DML 解禁は別課題。
