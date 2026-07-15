# 仕様案: KLIKE プレフィルタ押し下げ（v2）

- 作成日: 2026-07-15
- ステータス: **仕様案 R1（検討・codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 前提: KLIKE v1（[ksql_klike_native_search_spec.md](ksql_klike_native_search_spec.md)・**v2.8.0 リリース済**）。v1 は KLIKE を **SIMPLE SELECT の WHERE 限定**とし、FULL_SCAN になる SELECT では拒否している。
- 関連コード: `src/core/optimization/wherePredicatePushdown.ts`（`extractSafePushdownLeaves` / `isSafeComparison` / `extractAndLeaves`）、`src/engine/evalWhere.ts`（KLIKE の評価）、`src/core/klikeValidation.ts`（静的検証）、`src/execute.ts`（FULL_SCAN の押し下げ配線）

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

### 2.1 押し下げ（`wherePredicatePushdown.ts`）
- `isSafeComparison` に **`isKlikeComparison` を追加**。KLIKE は型メタ・選択肢メタ不要（左辺が対象フィールド参照で、右辺が文字列＝解決後 STRING なら常に kintone へ変換可能）。
  - 条件: 左辺が対象テーブルの単純フィールド参照、`op` が `KLIKE`/`NOT_KLIKE`、右辺が `STRING`（バッチ変数は実行時に置換済み）。
- これで `extractSafePushdownLeaves` が AND/GROUP 経由の KLIKE を抽出し、既存の `whereToKintone`（v1 で `like`/`not like` 変換済み）でプレフィルタクエリに乗る。
- 数値・選択系・$id の既存押し下げと**併存**（同じ AND リーフ抽出器に相乗り）。

### 2.2 JS 評価（`evalWhere.ts`）
- 現在 KLIKE/NOT_KLIKE は throw（v1 防御）。v2 では **`return true`（押し下げ済み＝適用済み）** に変更する。
- **前提**: §2.3 の検証で「すべての KLIKE が押し下げられる」ことが保証されているときだけ安全。押し下げられない KLIKE が evalWhere に到達すると誤結果になるため、検証と厳密に整合させる。

### 2.3 静的検証（`klikeValidation.ts`）の緩和
v1 は「KLIKE ∧ FULL_SCAN → 拒否」。v2 は次に緩和する:

- SIMPLE SELECT: 従来どおり KLIKE 可（WHERE 全体が kintone へ）。
- **FULL_SCAN SELECT: すべての KLIKE が「押し下げ可能な AND リーフ」なら可、そうでなければ拒否**。
  - 「押し下げ可能な AND リーフ」= WHERE ルートから **`AND`（LOGICAL AND）と `GROUP` ノードだけを経由**して到達する `KLIKE`/`NOT_KLIKE` の BINARY リーフ。かつ**対象が押し下げ可能な物理テーブル**（メインまたは解決可能な JOIN 物理テーブル・CTE/一時テーブルは不可）。
  - `OR` 配下・`NOT` ノード配下（`NOT (件名 KLIKE 'x')` 形。直接の `NOT KLIKE` 演算子は BINARY `NOT_KLIKE` なので可）・非対象テーブルの KLIKE があれば**拒否**（明確なメッセージ）。
- **整合性の要件**: この検証の「押し下げ可能」判定は、`extractAndLeaves`/`isSafeComparison` の抽出結果と**厳密に一致**しなければならない（検証が許可した KLIKE は必ず押し下げられ、evalWhere で真扱いになる）。実装では、抽出器を用いて「押し下げられた KLIKE 集合」を求め、WHERE 内の全 KLIKE がその集合に含まれることを検証するのが安全（重複ロジックによる乖離を避ける）。

### 2.4 実行配線（`execute.ts`）
- FULL_SCAN 経路で `extractMainSafePushdown` / 各 JOIN の `extractSafePushdownLeaves` が KLIKE を含む安全リーフを抽出 → `pushQuery` に乗る（既存の数値/選択系押し下げと同じ配線）。
- `baseQuery`（`selectToFetchAllParams` の丸ごと変換）と併存: KLIKE は `whereRequiresJsEval` 非該当なので、`GROUP BY` 等で FULL_SCAN・WHERE 変換可能な経路では `baseQuery` にも KLIKE が乗る（冗長だが無害）。`LIKE` 併用経路では `baseQuery` 空・`pushQuery` に KLIKE。
- EXPLAIN: KLIKE を含む押し下げクエリを表示。

### 2.5 NOT の扱い（注意）
- `件名 NOT KLIKE 'x'`（直接の否定演算子・BINARY `NOT_KLIKE`）は AND リーフとして押し下げ可。
- `NOT (件名 KLIKE 'x')`（`NOT` ノード）は `extractAndLeaves` が `null` にするため押し下げられない → v2 でも**拒否**（`pushDownNot` 正規化を検証前に適用して `NOT_KLIKE` 化する案もあるが、v2 minimal では拒否で単純化）。

## 3. P0（10 万件打ち切り）との関係
- KLIKE プレフィルタ取得が **10 万件打ち切り**に達すると、kintone が検索を打ち切り、**JS が精製する母集合が欠落**し得る（v1 SELECT と同じサイレント過少一致）。→ v2 でも「完全な結果を保証しない場合がある」を継承（[ksql_search_abort_warning_issue.md](ksql_search_abort_warning_issue.md) の P0 が解決基盤）。
- v1 と同様、DML では KLIKE を引き続き禁止（v2 は SELECT の押し下げのみ）。

## 4. 効果評価
- **解禁される主なパターン**: ① KLIKE ＋ `LIKE`（kintone で粗く絞り JS で精密一致）② KLIKE ＋ 集計/`DISTINCT`（`COUNT(*) … WHERE KLIKE` 等）③ KLIKE ＋ JOIN。
- **効果**: v1 では「KLIKE を含むと FULL_SCAN 化する条件は一切併用不可」だったのが、KLIKE で kintone 側の絞り込みを効かせつつ JS 精製ができる。特に **KLIKE ＋ LIKE** は「kintone の高速キーワード検索」と「JS の正確な部分一致」を両取りできる実用価値が高い。
- **回避策との比較**: v1 では「LIKE のみ（全件 FULL_SCAN・遅い）」か「KLIKE のみ（精密一致は不可）」の二択。v2 は両立を可能にする（現状代替が乏しい）。
- **限界**: 意味論は kintone 依存（v1 と同じ）。10 万件打ち切りで母集合欠落の可能性（P0）。KLIKE は AND リーフ位置のみ（OR/NOT 配下は不可）。

## 5. リスク・エッジ
- **検証と抽出の乖離**が最大リスク（押し下げられない KLIKE を真扱い→誤結果）。§2.3 の「抽出器で押し下げ集合を求めて全 KLIKE の包含を検証」で厳密整合。
- `evalWhere` の KLIKE→真 は、押し下げ保証が崩れると危険 → 防御として「押し下げ集合に無い KLIKE が evalWhere に来たら throw」を残す案も検討（v1 の防御 throw を条件付きで維持）。
- バッチ変数置換後の再検証（v1 と同様・置換後 STRING で押し下げ判定）。
- サブテーブル DML・親 DML は対象外（KLIKE 禁止のまま）。
- EXPLAIN・保存クエリ・UNION 各枝・CTE の整合。

## 6. スコープと進め方
- **v2 = SELECT の KLIKE プレフィルタ押し下げのみ**（AND リーフ位置・DML 非対象・P0 は継承）。
- 進め方: 本仕様を codex レビュー（特に §2.3 検証と §2.1 抽出の**整合性の実装方法**・§2.5 NOT・防御 throw の残置可否）→ 実装 → 実機（KLIKE＋LIKE で kintone 絞り込み＋JS 精製が正しい・KLIKE＋COUNT・OR/NOT 配下の拒否・EXPLAIN）→ minor リリース。
- 未確定論点（R2 で確定）: (1) 検証を抽出器ベースにするか独立ロジックにするか、(2) `evalWhere` の KLIKE→真 に加え防御 throw を残すか、(3) `NOT (KLIKE)` を `pushDownNot` 正規化で救済するか拒否のままにするか。
