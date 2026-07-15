# 仕様案: `KLIKE` — kintone ネイティブ `like` 検索オペレータ

- 作成日: 2026-07-15
- ステータス: **仕様案 R1（検討・codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 関連: v2.0.0 で `LIKE` を JS 評価に統一（[[like-js-default-optin-spec]]）した経緯の裏返し。述語分割（[ksql_like_predicate_pushdown_spec.md](ksql_like_predicate_pushdown_spec.md)）の代替アプローチ。
- 関連コード: `src/lexer/tokens.ts`（キーワード）、`src/types/ast.ts`（`CompareOp`）、`src/parser/parser.ts`（比較演算子）、`src/converter/whereToKintone.ts`（`convertOp`）、`src/converter/selectToKintone.ts`（`whereRequiresJsEval`）、`src/core/like.ts`、`src/engine/evalWhere.ts`、`src/converter/dmlToKintone.ts`（DML ガード）

## 0. 課題

`LIKE` は v2.0.0 以降 **常に JS 評価（FULL_SCAN）**。理由は「kintone の `like` が単語（トークン）検索で、半角/全角・語の切り分け等の詳細が API 独自かつ不透明」で、SQL LIKE の部分一致意味論と一致させられないため（実行モードで結果が食い違う事故を防ぐ）。

結果として、**テキスト検索を含む SELECT は必ず全件取得**になり、大規模アプリでは `maxRecords` 到達・性能劣化を招く。ユーザーは「kintone 側で検索を効かせて速くしたい」が、`LIKE` の意味論は kintone に寄せられない。

## 1. 提案: 別オペレータ `KLIKE`

**`LIKE` とは別の明示オペレータ `KLIKE` / `NOT KLIKE` を新設し、kintone の `like` / `not like` へ素通し変換する。**

```sql
-- kintone 側で検索（SIMPLE・高速）。意味論は kintone の like（単語/部分一致）
SELECT 件名, 担当 FROM APP100 WHERE 件名 KLIKE '至急'
```

- **意味論はユーザーが引き受ける**: `KLIKE` は「kintone の `like` そのもの」で、SQL LIKE でも kSQL の `includes` でもない。別オペレータにすることで **`LIKE` との意味論混同を排除**（`LIKE` は従来どおり JS 評価で予測可能な部分一致、`KLIKE` は kintone ネイティブ検索）。
- **`KLIKE` 指定時はそのまま API へ**（ユーザー要件）。kSQL は JS 側で再現しない。

## 2. 意味論（重要・ドキュメント必須）

- `field KLIKE 'キーワード'` → kintone クエリ `field like "キーワード"`。`NOT KLIKE` → `not like`。
- **SQL ワイルドカード `%` `_` は使わない**（kintone の `like` は部分/単語一致でワイルドカード非対応）。パターン内の `%`/`_` は**リテラル文字**として kintone に渡る。→ **`KLIKE` パターンに `%`/`_` が含まれたら警告 or 拒否**（`LIKE` の書き間違い検出。R2 で方針確定）。
- **対象フィールド**: kintone の `like` が使えるのは文字列系（`SINGLE_LINE_TEXT` / `MULTI_LINE_TEXT` / `RICH_TEXT` / `LINK` 等）。非対応フィールドに使うと kintone がクエリエラー。v1 は**型検証せず kintone のエラーに委ねる**（パススルー）＋ドキュメントで対象型を明記（将来 型メタで事前検証も可）。
- 半角/全角・単語分割・大小文字などの一致挙動は **kintone の仕様に準拠**（kSQL は関与しない）。ドキュメントで「kintone の like に準ずる」と明記。

## 3. 設計

### 3.1 lexer / AST / parser
- **lexer**: `KLIKE` をキーワードトークン化（`tokens.ts` の KEYWORDS へ追加）。
- **AST**: `CompareOp`（[ast.ts:367](../../src/types/ast.ts#L367)）に `"KLIKE" | "NOT_KLIKE"` を追加。
- **parser**: 比較演算子に `KLIKE`、`NOT` 分岐（[parser.ts:1470](../../src/parser/parser.ts#L1470)）に `NOT KLIKE` を追加。右辺は文字列リテラル（`LIKE` と同様、バッチ変数も可）。

### 3.2 変換（kintone へ素通し）
- `whereToKintone` の `convertOp`（[whereToKintone.ts:82](../../src/converter/whereToKintone.ts#L82)）に `KLIKE→"like"` / `NOT_KLIKE→"not like"` を追加。**`isLike` の throw 対象にはしない**（KLIKE は変換可）。
- `core/like.ts` に `isKlike(where)` ヘルパーを新設（`isLike` と区別）。

### 3.3 実行モード（KLIKE は JS を要求しない）
- `whereRequiresJsEval`（[selectToKintone.ts:81](../../src/converter/selectToKintone.ts#L81)）は **`KLIKE` を JS 評価要求に含めない**（`isLike` とは別扱い）。→ WHERE が `KLIKE` と押し下げ可能述語だけなら **SIMPLE モード**（kintone 側検索・高速）。これが本提案の主目的。

### 3.4 スコープ（v1 / v2）
kintone ネイティブゆえ **`KLIKE` は JS で再評価できない**。混在時の扱いで 2 段階に分ける:

- **v1（推奨・最小・安全）**: `KLIKE` は **クエリ全体が SIMPLE に解決するときだけ**許可。`KLIKE` が JS 評価を要する述語（`LIKE`・関数・算術・サブクエリ）と共存して **FULL_SCAN になる場合はパースエラー**（明確なメッセージ「KLIKE は kintone へ押し下げるため、LIKE 等の JS 評価条件と併用できません。LIKE を KLIKE にするか、条件を分けてください」）。evalWhere に KLIKE 処理を入れず、プレフィルタ複雑性も無し。**主目的（検索の SIMPLE 化）を満たす**。
- **v2（後続・強力）**: `KLIKE` を**安全な AND リーフとして押し下げ**（`extractSafePushdownLeaves` に追加）、FULL_SCAN でも kintone が KLIKE で絞り、JS が残り（LIKE 等）を精製。evalWhere は KLIKE リーフを **押し下げ済み＝真** として扱う（KLIKE が必ず押し下げられる AND 文脈に限る前提）。または JS 評価用 WHERE から KLIKE リーフを TRUE へ書き換え。「kintone が絞り JS が精製」という最も強い形。v1 実績後に検討。

> 補足: `KLIKE OR =` のような OR でも、**クエリ全体が SIMPLE なら kintone が丸ごと処理するため v1 で許可**される（FULL_SCAN 化する場合のみ v1 は拒否）。判定は「この WHERE が FULL_SCAN か？（`whereRequiresJsEval`）」で行う。

### 3.5 DML（KLIKE は LIKE と違い許可可能）
- 親 `UPDATE`/`DELETE` の対象解決 `resolveDmlTargetIds`（[sharedPlanner.ts:39](../../src/core/optimization/sharedPlanner.ts#L39)）は **kintone クエリで $id を取得 → ID 指定で変更**。`LIKE` は「JS 評価経路がない」ため拒否（[dmlToKintone.ts:32](../../src/converter/dmlToKintone.ts#L32)）だが、**`KLIKE` は kintone クエリへ変換できるので対象解決が成立**する。
- 方針（R2 で確定）: **選択肢A=許可**（kintone の like で対象 $id を解決 → ID 指定で変更。意味論は kintone・JS 不一致なし）。ただし kintone の単語検索は**曖昧（過剰一致し得る）**ため、**選択肢B=当面は SELECT で対象確認 → IN 指定を推奨し、DML では警告 or 拒否**（保守）。推奨=**A（許可）だが `--allow-dml` 前提でドキュメントに「KLIKE は kintone の like で対象選定＝過剰一致に注意・事前に SELECT で確認」を明記**。

### 3.6 EXPLAIN
- SIMPLE: `kintone query` に `件名 like "至急"` が現れる。
- v2 の FULL_SCAN 押し下げ時: `pushdown` として現れる（型不要・kintone ネイティブ）。

## 4. 効果評価

### 4.1 性能効果
- **`LIKE`（FULL_SCAN・全件取得＋JS）→ `KLIKE`（SIMPLE・kintone 側で絞って取得）**。大規模アプリで取得件数・レイテンシ・`maxRecords` 到達を大幅削減。テキスト検索の主目的に直接効く。
- 述語分割（LIKE を JS のまま安全述語だけ押し下げ）と比べ、**KLIKE は検索そのものを kintone に委ねる**ため効果が大きい（ただし意味論が kintone 依存になるトレードオフ）。

### 4.2 `LIKE` と `KLIKE` の使い分け（ドキュメント）
| | `LIKE`（従来） | `KLIKE`（新） |
|---|---|---|
| 意味論 | kSQL 部分一致（`includes`）・SQL ワイルドカード | **kintone の like**（単語/部分一致・詳細は kintone 依存） |
| 実行 | 常に FULL_SCAN（JS） | SIMPLE で kintone 側（高速） |
| 予測可能性 | 高（モード非依存で一定） | kintone 仕様に依存 |
| 用途 | 正確な部分一致・少量データ | **大規模アプリの高速検索**・kintone の検索で十分な場合 |

### 4.3 回避策との比較（この仕様が無い場合）
- 現状の回避策は「`LIKE` で全件取得」または「`= 完全一致`／`IN` で絞る」。**部分一致を kintone 側で効かせる手段は現状ない**（`LIKE` は必ず JS）。→ **KLIKE は現状で代替不可能な性能改善**（能力の追加）。※ v2.0.0 で「kintone like を LIKE に載せる」ことは意図的に排除したので、別オペレータが唯一の道。

### 4.4 限界
- **意味論が kintone 依存**（半角/全角・語分割が不透明）＝ユーザーが受容する前提。
- ワイルドカード非対応（`%`/`_` はリテラル）。
- 対象は文字列系フィールド（非対応型は kintone エラー）。
- v1 は JS 評価条件（LIKE 等）と併用不可（v2 で解禁）。
- kintone の単語検索は完全一致より**過剰一致し得る**（DML では特に注意）。

## 5. リスク・エッジ
- `%`/`_` 混入の誤用（LIKE のつもり）→ 警告 or 拒否で救済。
- 非対応フィールド → kintone エラー（v1 は委譲・将来 型メタで事前検証）。
- OR/NOT 文脈：SIMPLE なら可・FULL_SCAN 化する場合のみ拒否（v1）。
- DML 過剰一致 → ドキュメント警告＋事前 SELECT 推奨。
- 保存クエリ・バッチ変数・EXPLAIN との整合。

## 6. 進め方（提案）
1. 本仕様を codex レビュー（特に v1 スコープ判定・`whereRequiresJsEval` 非該当化・DML 方針・ワイルドカード方針）。
2. v1 実装（KLIKE=SIMPLE 限定・FULL_SCAN 併用は拒否・DML 許可＋警告）→ 実機（kintone like の実挙動＝半角全角/単語分割を APP4221 等で観測しドキュメント化）→ リリース（minor）。
3. v2（KLIKE プレフィルタ押し下げ）は v1 実績後に別途。
