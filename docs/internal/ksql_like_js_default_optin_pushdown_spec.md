# 仕様案・効果評価: LIKE を JS 判定のみに統一する

> **注記(2026-07-14 R3)**: 本書は当初「LIKE 既定 JS + `OPTION (like=kintone)` オプト‑イン」案(R1/R2)だったが、オプト‑インを 1 つでも残すと実行コンテキスト全体へ方針を引き回す配管が必要になり(codex R2 指摘)、割に合わないと判断。**LIKE は JS 判定のみに統一(オプト‑イン無し)** へ方針変更した。OPTION 案は §7「見送った代替案」に記録し、将来の性能要求が実測で出た場合の復活候補として保持する。ファイル名の "optin_pushdown" は経緯の名残。

- 作成日: 2026-07-14
- 更新履歴:
  - 2026-07-14 R1: 初版。LIKE 既定 JS + OPTION オプト‑イン案
  - 2026-07-14 R2: codex レビュー反映(OPTION をトップレベル文単位・段階導入・ソフトキーワード・用語・DML D1)
  - 2026-07-14 R3: **方針変更 — LIKE は JS 判定のみに統一(OPTION オプト‑インは見送り)。** codex R2 追加指摘(ネスト SELECT への実行時伝播 / 親 DML の `like=js` 矛盾 / EXPLAIN・CREATE TEMP への配置 / 用語)が、いずれも「オプト‑インを残す限り生じる複雑さ」であり、意味論を合わせられない前提では JS-only が最小で一貫、と判断
  - 2026-07-14 R5: codex + Fable5 レビュー反映。①リリース範囲を **R‑2(JS-only 先行・述語分割は独立仕様)** に確定(両レビュー推奨。正しさの修正と未証明最適化の分離)。②§6 の矛盾訂正 — FULL_SCAN は取得後に **WHERE 全体を JS 再評価**([process.ts:815](../../src/engine/process.ts#L815))するため push はプレフィルタ、**superset で十分**(exact 不要)と明記。③サブテーブル DML fetch は `onLimit` 未指定=**既定 error**([execute.ts:2297](../../src/execute.ts#L2297) / [fetchAll.ts:76](../../src/api/fetchAll.ts#L76))で truncate による黙った部分 DML は起きない、を §2 に明記。④親/サブテーブル DML の非対称と将来の親 DML JS 経路(§7)、移行手順の実務性(§8)、保存クエリの黙った変化・v1.x 非推奨警告(§8)、EXPLAIN 文言の LIKE 特定(§3)を追記。⑤§5.1 の「大量ヒット」→「全走査件数」に訂正
  - 2026-07-14 R4: codex レビュー反映(JS-only 方針は承認)。①**取得上限の影響を追記** — FULL_SCAN 既定 `maxRecords=10,000`・`onLimitReached="error"` のため、従来 SIMPLE で成功した LIKE 検索が 10,000 件超でエラー化、`truncate` 設定時は不完全候補の JS 評価で**偽陰性(一致行欠落)**。「性能が唯一」→「性能・取得上限・結果取得可能性」へ。②**述語分割前は絞り込み併記でも全件取得**(`selectToKintone.ts:162` は WHERE 全体を push/非push の二択)を明記。「LIKE 単独のみ残課題」は述語分割**後**の説明に限定。③**対象バージョンを v2.0.0 に確定**(案 B。取得上限による成否変化・親 DML 拒否・逃げ道なしを含む既定実行方式変更)。④述語分割の「証明可能に厳密」を「演算子・フィールド型ごとに包含性を確認できた述語のみ・AND 分解限定」へ弱め
- ステータス: **実装完了(v2.0.0)。JS-only 方針・R-2で実装し、回帰テスト・全成果物ビルド済み**
- 対象バージョン: **v2.0.0**(公開言語の全 LIKE に対する既定実行方式変更。結果集合・SIMPLE→FULL_SCAN・取得上限による成否・親 DML 拒否を含み、オプト‑イン経路なし)
- 前提: [ksql_where_rhs_field_and_like_fix_spec.md](ksql_where_rhs_field_and_like_fix_spec.md)(v1.14.0)/ [ksql_where_rhs_field_and_like_mode_divergence_issue.md](ksql_where_rhs_field_and_like_mode_divergence_issue.md)
- 共有ヘルパ: [src/core/like.ts](../../src/core/like.ts)(`likePatternHasWildcard` / `isLike` / `whereHasLike`)

---

## 1. 背景と方針

v1.14.0 で **`%`/`_` 付き LIKE** は常に JS 評価に統一済み(報告②の再現ケース解消)。残るのは **ワイルドカードなし LIKE(`LIKE '会社'`)** で、単一テーブル SELECT(SIMPLE)は kintone へ委譲(単語検索)、FULL_SCAN は JS `includes`、と経路で乖離しうる点(課題文書 §3.5)。

kintone `like`(全文/トークン検索)と JS の部分文字列一致は**意味論を一致させるのが困難**で、包含保証も取れない。オプト‑インで kintone 押し下げを残す案(R1/R2)は、OPTION を実行コンテキスト全体へ引き回す配管(UNION/CTE/サブクエリ/EXPLAIN/CREATE TEMP/DML)が必要で複雑。

> **方針(R3)**: **すべての LIKE / NOT LIKE を JS(kSQL §6 意味論)でのみ評価する。** kintone へ LIKE を押し下げる経路を全廃する。これで「実行モードが結果集合を変えない」不変条件が LIKE 全般で成立し、実装・仕様とも最小になる。

### 用語(kSQL §6 意味論)

- `%` / `_` 付き: **SQL ワイルドカード意味論**(`%`=0文字以上 / `_`=任意1文字)。
- ワイルドカードなし: **kSQL 独自の部分一致(contains)**。※標準 SQL の裸 LIKE は完全一致だが、kSQL は独自仕様として contains として評価する。kintone の `like` は単語検索であり、これとも厳密には同義でない。
- 総称して本書では「kSQL §6 意味論」と呼ぶ。JS 側 `matchLike`([evalWhere.ts:242-269](../../src/engine/evalWhere.ts#L242))がこの意味論の実装。

---

## 2. 仕様

1. **SELECT**: すべての LIKE / NOT LIKE を JS で評価する。非ワイルドカード LIKE を含む単一テーブル SELECT は **FULL_SCAN**(全件取得 → JS フィルタ)になる。kintone へ LIKE を送らない。
2. **親(レコード)DML**: JS 評価経路を持たないため、**WHERE に LIKE / NOT LIKE を含む UPDATE / DELETE は種類を問わず拒否**(`DmlConvertError`)。v1.14.0 の「ワイルドカードのみ拒否」を「あらゆる LIKE 拒否」へ拡張。運用は「SELECT で対象レコード番号を確認 → `IN` / 完全一致で DML」。
3. **サブテーブル DML**: `executeUpdateSubtable` / `executeDeleteSubtable` は全件取得 + `evalWhere` の JS 経路のため、**LIKE を従来どおり評価可能**(拒否対象外)。
   - **取得上限は既定 error(truncate による黙った部分 DML なし)**: サブテーブル DML の親フェッチ([execute.ts:2297](../../src/execute.ts#L2297) ほか)は `fetchAll` に `onLimit` を渡さず、`fetchAll` 既定は `"error"`([fetchAll.ts:76](../../src/api/fetchAll.ts#L76))。よって 10,000 件超は**エラーで停止**し、一致行の一部だけを黙って更新/削除することはない。**この不変条件(DML fetch に truncate を伝播させない)を維持し、回帰テストで固定する**(SELECT の §4.2③ より深刻な事故の防止)。
4. **中央ガード**: `whereToKintone` は **あらゆる LIKE を変換拒否**(バックストップ)。正常系では routing により LIKE が到達しないが、漏れた場合は fail-loud。
5. **オプト‑イン無し**: 実行方式を切り替える構文(OPTION 等)は追加しない。LIKE は常に JS。

---

## 3. 実装スケッチ(小規模)

v1.14.0 の「ワイルドカード LIKE のみ JS」を「あらゆる LIKE を JS」へ広げるだけ。`src/core/like.ts` に **任意の LIKE 判定**を追加し、既存の `isWildcardLike` 参照を用途に応じて置換する。

```ts
// src/core/like.ts に追加
export function isLike(where: WhereExpr): boolean {
  return where.type === "BINARY" && (where.op === "LIKE" || where.op === "NOT_LIKE");
}
export function whereHasLike(where: WhereExpr | null): boolean { /* isLike を再帰 */ }
```

| 箇所 | v1.14.0 | R3(JS-only) |
|---|---|---|
| `whereRequiresJsEval`([selectToKintone.ts:84](../../src/converter/selectToKintone.ts#L84)) | `isWildcardLike(where)` | `isLike(where)`(あらゆる LIKE で JS 必須) |
| 中央ガード `convertBinary`([whereToKintone.ts:59](../../src/converter/whereToKintone.ts#L59)) | ワイルドカードで例外 | **あらゆる LIKE で例外** |
| JOIN 押し下げ `extractTableCondition` / `referencesOnlyTable`([wherePredicatePushdown.ts:17,69](../../src/core/optimization/wherePredicatePushdown.ts#L17)) | ワイルドカード除外 | **あらゆる LIKE 除外** |
| 親 DML `assertDmlWhereIsSafe`([dmlToKintone.ts:30](../../src/converter/dmlToKintone.ts#L30)) | `whereHasWildcardLike` で拒否 | `whereHasLike` で拒否 |
| `matchLike`([evalWhere.ts:242](../../src/engine/evalWhere.ts#L242)) | 変更なし | 変更なし |

- パーサ・AST・lexer 変更**なし**。OPTION 無し。
- EXPLAIN: 新たに FULL_SCAN 化するのは LIKE 起因が大半のため、**原因を特定できる文言**にする(例: 「LIKE は常に JS 評価のため全件取得」)。既存の「WHERE 句に JS 評価が必要な式」に LIKE 専用の補足を足すと問い合わせを減らせる(Fable5 #7)。
- ドキュメント: 言語リファレンス §6 を「LIKE は常に JS(kSQL §6)評価。kintone へ押し下げない。親 DML の LIKE は不可」に更新。CHANGELOG。
- プラグイン(`prod/js/desktop.js`)へ波及するため全成果物再ビルド。

---

## 4. 効果評価

### 4.1 メリット

- LIKE の意味論が**どのモード・経路でも常に kSQL §6(JS)**。§3.5 の乖離が完全に消える。モデル/利用者のメンタルモデルと一致。
- 実装・仕様が**最小**。OPTION の配管(伝播・スコープ・EXPLAIN/TEMP 配置・DML の option 矛盾)が全て不要。パーサ無変更。
- 親 DML の LIKE 拒否が「ワイルドカードのみ」→「全 LIKE」で一貫。誤選択リスクの面でも明快。

### 4.2 コスト・リスク(性能・取得上限・結果取得可能性)

非ワイルドカード LIKE の単一テーブル検索が常に FULL_SCAN(全件取得 → JS フィルタ)になる。新規に変わる例:
```sql
WHERE 会社名 LIKE '東京'   -- 現状 SIMPLE(kintone push) → 常に FULL_SCAN(全件取得)
```
(`LIKE '%東京%'` は v1.14.0 で既に FULL_SCAN のため新規回帰ではない。)**逃げ道(オプト‑イン)は無い**。影響は性能だけでなく**取得上限と結果の取得可能性**に及ぶ:

- **① 取得量・応答時間の増加**: kintone 側フィルタが効かず全件フェッチ。
- **② 取得上限によるエラー化(挙動変更)**: FULL_SCAN は既定 `maxRecords = 10,000`・`onLimitReached = "error"`([execute.ts:983](../../src/execute.ts#L983), [:1017](../../src/execute.ts#L1017))。従来 SIMPLE で kintone が数百件に絞って**成功していた LIKE 検索**が、全件が 10,000 件を超えると**上限到達エラー**になりうる。
- **③ `truncate` 設定時の偽陰性(正しさのリスク)**: `onLimitReached = "truncate"` では上限までの**不完全な候補集合**を JS 評価するため、10,000 件目以降にある一致行を**取りこぼす**(false negative)。上限より後ろの該当レコードが結果から欠落する。**要明記**。
- **④ 述語分割前は「絞り込み併記でも全件取得」**: 現行の単一テーブル経路は、WHERE に JS 評価要素が 1 つでもあると **WHERE 全体を押し下げない**([selectToKintone.ts:162](../../src/converter/selectToKintone.ts#L162))。したがって述語分割(§6)を実装するまでは、次も**全アプリ走査**になる(②③の上限リスクもこの広い範囲に及ぶ):
  ```sql
  WHERE 状態 = '完了' AND 会社名 LIKE '東京'   -- 述語分割前は 状態 も押し下げず全件取得
  ```
  → 「実害は LIKE 単独のみ」という限定は**述語分割実装後の説明**であり、それまでは「安全な絞り込み条件を併記しても全件取得になる」が正しい(§5・§6 と整合)。

- **後方互換**: 非ワイルドカード裸 LIKE が「kintone 単語検索 → kSQL §6 の JS contains + 全件取得」に変化(結果・コスト・成否)。親 DML の非ワイルドカード LIKE が拒否に。
- **想定利用頻度は未計測**: 「裸 LIKE が高頻度」は仮説。逃げ道が無いため、②③④の露出を**述語分割の同梱 or 明示告知**で扱うことが前提(§5)。

### 4.3 規模感

- コード: `isLike`/`whereHasLike` 追加 + 参照 4 箇所置換 + DML(小)。パーサ無変更。
- テスト: 非ワイルドカード LIKE の FULL_SCAN 化 / 親 DML LIKE 拒否 / サブテーブル DML LIKE 可 / JOIN 押し下げ除外 / 中央ガード / EXPLAIN。既存の v1.14.0 テストの一部更新(非ワイルドカード LIKE が SIMPLE→FULL_SCAN に変わる箇所、非ワイルドカード DML LIKE が可→拒否に変わる箇所)。
- ドキュメント・CHANGELOG・全成果物再ビルド。
- **小〜中規模**(OPTION 案より大幅に小さい)。

---

## 5. バージョニングとリリース範囲

### 5.1 バージョン: v2.0.0(確定)

JS-only は公開言語の**全 LIKE に対する既定実行方式変更**であり、次を同時に含む:

- 同じ SQL の**結果集合**変更(kintone 単語検索 → JS contains)
- **SIMPLE → FULL_SCAN** への実行モード変更
- **取得上限(10,000 件)による成功→失敗**の変更(§4.2②)、`truncate` 時の**偽陰性**(§4.2③)
- 親 UPDATE/DELETE の**成功→拒否**(§4.2)
- **代替となるオプト‑イン経路なし**

これは v1.14.0 のような限定的な安全ガード追加ではないため、**厳密な SemVer どおり v2.0.0**(案 B)とする。利用者にも「**v1.14.0 でワイルドカード不整合を修正 → v2.0.0 で LIKE 全体を JS 意味論へ統一**」と区切る方が明快。CHANGELOG は **Breaking**、移行案内を厚くする:

- 裸 LIKE は全件取得になる。**大規模アプリでは LIKE の一致件数にかかわらず、取得元アプリの全走査件数が `maxRecords` に到達し得る**ため、`maxRecords` と `onLimitReached` の設定を確認する(「大量ヒット」ではなく全走査件数が問題。Codex 指摘)。`maxRecords` 引き上げ時はメモリ・API リクエスト数の増加に注意。
- 親 DML は SELECT+`IN`・完全一致へ(§8 の実務手順参照)。

### 5.2 リリース範囲(述語分割を同梱するか)

§4.2④のとおり、述語分割前は「安全な絞り込みを併記しても全件取得」で、②③の上限リスクが広く出る。2 案のうち:

- **案 R‑2(JS-only 先行・採用)**: v2.0.0 は **JS-only のみ**。述語分割は独立仕様で包含性を検証してから v2.x で追加。**CHANGELOG・docs で「安全な絞り込み条件を併記しても全件取得になる(既定 `error` で上限到達時は停止 / `truncate` 選択時は偽陰性)」を明示**する。
- 案 R‑1(述語分割同梱)は見送り。

**採用は R‑2**(codex + Fable5 両推奨)。理由:
- **正しさの修正(JS-only)と未証明の最適化(述語分割)を分離**できる。JS-only は小さく意味論を確実に統一。
- 既定 `onLimitReached = "error"` は不完全結果ではなく**明示停止**。`truncate` は明示選択で警告・文書化で管理可能。
- **述語分割を誤ると既定設定でもサイレントな偽陰性**を生む。押し下げ対象の包含性はフィールド型別確認が要り、現行 `selectToFetchAllParams(stmt, appId)`([selectToKintone.ts:152](../../src/converter/selectToKintone.ts#L152))は**フィールド型情報を持たない**(メタデータ伝播か全型安全な静的ホワイトリストが必要)。JS-only より明らかに大きな設計で、ブロッカーにすべきでない。

順序: (1) v2.0.0 で JS-only 実装・リリース、(2) 全件取得・10,000 件上限・`truncate` 偽陰性を Breaking として明示、(3) 述語分割は独立仕様で包含性検証、(4) 安全性を証明できた範囲だけ v2.x で追加。

---

## 6. 関連する将来最適化(性能の正しい対処)

**述語分割(conjunct splitting)** — v1.14.0 spec §3.4 の Phase 2 と同一。JS-only を採るなら、性能・上限緩和はオプト‑インではなくこれで行うのが筋。

- `selectToFetchAllParams` / 単一テーブル FULL_SCAN で、WHERE の **AND を分解**し、**押し下げ可能な述語だけ kintone へ push**(取得量を絞るプレフィルタ)。(JOIN 経路 `extractTableCondition` の AND 分割ロジックを単一テーブルへ横展開)。
- **push はプレフィルタのみ・WHERE 全体は常に JS 再評価**(Fable5 #1): FULL_SCAN は取得後に `applyFilter(rows, stmt.where)` で **WHERE 全体を JS で再評価**する([process.ts:815](../../src/engine/process.ts#L815))。したがって push した述語も JS で再チェックされる。→ **push 対象は"厳密一致"でなく"superset(候補集合を落とさない)"で十分**。kintone が余分な行を返しても JS 再評価で除かれる(偽陽性は漏れない)。危険なのは kintone が**行を取りこぼす**方向(偽陰性・復元不能)のみ。JS 再評価コストは取得済みレコードに対するもので実害は小。
- **push 対象の安全性は要検証(未証明)**: superset で足りるとはいえ、**kintone 評価が該当述語の JS 評価に対して superset(取りこぼさない)になることを、演算子・フィールド型ごとに確認**する必要がある。`=` / `!=` / `IN` / 範囲 / `IS NULL` を無条件に安全と断定しない。特に以下は要確認:
  - null / 空文字 / 未設定フィールドの扱い(`IS NULL` = `""` 慣習との整合)
  - 数値文字列の表現差(先頭ゼロ・指数等)、日付・日時比較
  - `!=` での欠損値の扱い、文字列の範囲比較(`<`/`>`)
  - **AND 分解のみ対象**。OR / NOT は全体の包含性を証明できない限り押し下げない。
  - (補足: 既存の JOIN 押し下げ `extractTableCondition` も同種の前提に立っており、この検証は JOIN 経路の健全性確認にもなる。)
- これで `WHERE 絞り込み AND LIKE` 形は取得量が減り、§4.2②③の上限リスクも下がる。**LIKE 単独クエリのみ全件取得が残る**(この「LIKE 単独のみ残課題」は述語分割**実装後**の説明)。
- **JS-only とは独立の別仕様(v2.x)**。フィールド型別の包含性検証には `selectToFetchAllParams` へのメタデータ伝播(または全型で安全な静的ホワイトリスト)が要り、JS-only より大きい設計。v2.0.0 のブロッカーにしない(§5.2 R‑2)。

---

## 7. 見送った代替案(記録)

### 7.1 OPTION オプト‑イン(R1/R2)

「LIKE 既定 JS + `OPTION (like=kintone)` で kintone 押し下げを選択」。**見送り理由**:

- OPTION をトップレベル文単位にしても、実行時は UNION/CTE/サブクエリ/INSERT・UPSERT ソースが**個別 `SelectStatement` として実行**される([execute.ts:1109](../../src/execute.ts#L1109) UNION / [:1177](../../src/execute.ts#L1177) 非インライン CTE / [:2801](../../src/execute.ts#L2801) サブクエリ)。トップレベル AST に持つだけでは子から参照できず、**実行コンテキスト(`LikeEvaluationPolicy`)を全経路へ引き回す配管**が必要。
- Phase 1 で親 DML に `OPTION (like=js)` を書かれても JS 経路が無く実行不能 → 別の fail-loud 仕様が要る。
- EXPLAIN / CREATE TEMP TABLE AS SELECT への OPTION 配置も個別定義が必要。
- 得られる価値(kintone index 検索)は**需要未計測**。YAGNI により、必要が実測で出るまで作らない。

将来、大規模アプリでの LIKE index 検索需要が実測で確認されたら、この設計を復活させる(実行コンテキスト伝播込みで再仕様化)。

### 7.2 kintone/JS 意味論の一致(A-b 押し下げ+JS 再判定)

kintone 単語検索が JS 候補集合を包含する保証がなく(偽陰性復元不能)、不採用(課題文書 §未証明の安全性)。

---

## 8. 将来課題・移行・着手条件

### 8.1 親 DML への JS 評価経路(親/サブテーブルの非対称の解消・将来)

「親 UPDATE/DELETE の LIKE は拒否、サブテーブルは可」は利用者から見て説明の要る非対称(Fable5 #3)。docs で明記するとともに、将来課題として記録:

- 親 DML にも**全件取得 → `evalWhere` で対象 `$id` 特定 → ID 指定更新**の JS 経路を追加すれば、LIKE 拒否を解消できる(サブテーブル DML と同じ機構で技術的障壁は低い)。取得上限は §2-3 と同様に **`error` 固定(truncate 禁止)** とし、黙った部分 DML を防ぐ。
- v2.x の改善余地として保持。

### 8.2 移行案内(実務手順)

「SELECT で確認 → `IN` で DML」は、その SELECT 自体が FULL_SCAN + 10,000 件上限に当たり得る。`IN` の要素数も kintone クエリ長上限に制約される(Fable5 #4)。移行ガイドには次まで書く:

- 対象が多い場合の**分割実行**(絞り込み条件を足す / レコード番号レンジで分割 / `maxRecords` 調整)。
- `IN` の要素数上限に応じたバッチ分割。

### 8.3 保存クエリ・非推奨警告(移行の緩衝)

- **保存クエリの黙った変化(Fable5 #5)**: `ksql_save_query` 系に裸 LIKE を含む保存クエリがあると、v2.0.0 後に**結果変化・上限エラー化が黙って起きる**。アップグレード時に保存クエリをスキャンして警告する、または CHANGELOG に「**保存クエリの裸 LIKE を点検せよ**」と明記する。
- **v1.x 最終版での非推奨警告(Fable5 #6)**: v2.0.0 の前に、v1.x で裸 LIKE を kintone に push する際「v2 で結果と実行方式が変わる」旨の警告(EXPLAIN or 実行時 warning)を出す移行ステップを検討。Breaking の緩衝になる。

### 8.4 着手条件

- **(確定)** バージョン=**v2.0.0**(§5.1)。リリース範囲=**R‑2(JS-only 先行)**(§5.2)。DML=全 LIKE 拒否。JS-only 方針は codex + Fable5 承認済み。
- **(着手可)** JS-only 本体(§3 の 4 箇所置換 + DML + §2-3 の DML 上限 error 固定テスト)は独立・小規模で着手可能。
- **(別仕様・v2.x)** 述語分割(§6)は包含性検証(演算子・フィールド型ごと・AND 限定・superset 基準)を済ませてから独立追加。selectToFetchAllParams へのメタデータ伝播設計を含む。
- 実 API 検証(kintone `like` 乖離)は本体に不要。述語分割の包含性検証は別物として必要。
