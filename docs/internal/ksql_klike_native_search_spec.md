# 仕様案: `KLIKE` — kintone ネイティブ `like` 検索オペレータ

- 作成日: 2026-07-15
- ステータス: **R2確定・KLIKE v1 実装済み・実機検証済み（v2.8.0 リリース準備中）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 中核の再定義（codex 総括）: KLIKE は「**高速な LIKE**」ではなく「**kintone のキーワード検索を明示的に呼び出す演算子**」。意味論・上限・制約は kintone に準ずる。
- 更新履歴:
  - 2026-07-15 R1: 初版（検討）。
  - 2026-07-15 R2: codex レビュー反映（全点コードで裏取り）。
  - 2026-07-15 v1実装: lexer/AST/parser、kintone変換、共通静的検証、変数置換後検証、全DML拒否、EXPLAIN、単体・統合テストを実装（commit 935e993・全1081+25 green）。
  - 2026-07-15 実機検証済み（APP4221 / APP730）: SIMPLE 押し下げ（EXPLAIN で `件名 like "…"`）・`=`/`IN`/`>` との AND/OR は SIMPLE で結合押し下げ・`LIKE` 併用と全 DML は実行前拒否・`NOT KLIKE` 反転。**kintone like 意味論の実測**（英数字=空白区切りの語単位で語の一部は不一致 `TOK`/`OKYO`✗、日本語=2文字以上の部分一致で中間含む `の内`○・1文字 `内`✗）。**性能実証**（APP730 数十万件で `LIKE '%東京%'` は取得上限エラー・`KLIKE '東京都'` は即応）。言語リファレンスに実例追記（commit 6a8407d ほか）。**未検証**: 半角/全角の相互一致・10万件打ち切りの実挙動（P0・実測困難）。
    - **[P0] kintone `like` の 10 万件打ち切りを現クライアントが検出不能**。`X-Cybozu-Warning: Filter aborted…` ヘッダーを返すが、`KintoneGetResponse`（[fetchAll.ts:27](../../src/api/fetchAll.ts#L27)）は `records` のみ・Node の `requestJson`（[nodeKintoneClient.ts:36](../../src/cli/nodeKintoneClient.ts#L36)）と plugin の `kintone.api()`（[kintoneClient.ts:58](../../src/ui/kintoneClient.ts#L58)）は本文しか読まない → **サイレントな過少一致**（SELECT で結果欠落・DML で一部だけ変更）。§3.7・§4 に主要リスクとして追加。
    - **[P1a] SIMPLE 限定判定は `whereRequiresJsEval` では不十分**。`resolveSelectMode`（[selectToKintone.ts:60](../../src/converter/selectToKintone.ts#L60)）は JOIN/GROUP BY/DISTINCT/集計/式 ORDER BY でも FULL_SCAN。FULL_SCAN は取得後に WHERE 全体を JS 再評価（[process.ts:843](../../src/engine/process.ts#L843)）。→ 不変条件を「**WHERE に KLIKE があり、対象 SELECT の `resolveSelectMode===FULL_SCAN` なら実行前に拒否**」に。CTE・UNION 各枝・IN/EXISTS/スカラーサブクエリ内 SELECT にも適用。**パーサーでなく AST 後の共通静的検証**で（単文/バッチ/EXPLAIN で統一）。
    - **[P1b] `%`/`_` は別扱い・「リテラル」は不正確**。kintone 検索では `%`=キーワードから除外される記号／`_`=英数字単語の構成文字。→ **`%` は拒否（静的・変数置換後とも）／`_` は許可＋非ワイルドカードと明記**。KLIKE 右辺は `STRING | VARIABLE` に限定（`parseSqlValue`（[parser.ts:1593](../../src/parser/parser.ts#L1593)）は数値/関数/算術/サブクエリまで受理するため専用の限定パース）。**警告でなく拒否**（DML result 型に `warnings` が無い＝[execute.ts:165](../../src/execute.ts#L165) の `UpdateResult`/`DeleteResult`）。
    - **[P1c] DML 可は親レコードのみ・サブテーブル DML では不成立**。親 UPDATE/DELETE は WHERE を kintone クエリ化して $id 解決（[dmlToKintone.ts:140](../../src/converter/dmlToKintone.ts#L140)）だが、サブテーブル UPDATE/DELETE/REORDER は親全取得→`evalWhere` JS 評価（[execute.ts:2778](../../src/execute.ts#L2778)）。→ **サブテーブル DML は KLIKE 禁止**。P0 も踏まえ **v1 は全 DML で KLIKE 拒否**（親 DML は P0 のヘッダー検出完成後に解禁）。
    - **[P2a] `NOT (...)` 対応が欠落**。`WHERE NOT (件名 KLIKE '至急')` は `pushDownNot` で反転するが `negateOp`（[pushDownNot.ts:38](../../src/engine/pushDownNot.ts#L38)）に KLIKE が無い → **`KLIKE→NOT_KLIKE` / `NOT_KLIKE→KLIKE` を追加**。
    - **[P2b] 対象フィールドは公式の演算子対応表を正とする**。文字列1行/複数行/リッチ/リンクに加え**添付ファイル**（ファイル名・内容が検索対象）。ルックアップ・関連レコードは参照元型に依存。「文字列系のみ」を撤回。
    - **[P3] キーワード予約の互換性**。KLIKE を lexer キーワード化すると既存フィールドコード `KLIKE` は裸参照不可（バッククォート必要・LIKE と同様）。minor リリースの互換注記に記載。
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
- **右辺は `STRING | VARIABLE` に限定**（数値・関数・算術・サブクエリは不可・[P1b]）。専用の限定パースを使う（`parseSqlValue` は非文字列を受理するため流用不可）。
- **`%` / `_` は別扱い（[P1b]・kintone 検索仕様）**:
  - **`%` は拒否**（静的リテラルでも、変数置換後の値でも）。kintone 検索では `%` はキーワードから除外される記号で、`LIKE` の書き間違いの可能性が高い。**警告でなく拒否**（DML result に `warnings` 無し・§3.5）。
  - **`_` は許可**。ただし**ワイルドカードではなく英数字単語の構成文字**として扱われる旨を明記。
- **対象フィールド**: **公式の演算子対応表を正**とする（文字列1行/複数行/リッチエディター/リンク＋**添付ファイル**＝ファイル名・内容が検索対象）。ルックアップ・関連レコードは参照元型に依存。非対応フィールドは kintone がクエリエラー。v1 は**型検証せず kintone のエラーに委ねる**＋ドキュメントで公式対応表を参照（将来 型メタで事前検証も可）。
- 半角/全角・単語分割・大小文字・**10 万件打ち切り**（§3.7）などの挙動は **kintone の仕様に準拠**（kSQL は関与しない）。ドキュメントで「kintone のキーワード検索に準ずる」と明記。

## 3. 設計

### 3.1 lexer / AST / parser
- **lexer**: `KLIKE` をキーワードトークン化（`tokens.ts` の KEYWORDS へ追加）。**互換**: 既存フィールドコード `KLIKE` は裸参照不可＝バッククォート必要（LIKE と同様・[P3]・互換注記）。
- **AST**: `CompareOp`（[ast.ts:367](../../src/types/ast.ts#L367)）に `"KLIKE" | "NOT_KLIKE"` を追加。
- **parser**: 比較演算子に `KLIKE`、`NOT` 分岐（[parser.ts:1470](../../src/parser/parser.ts#L1470)）に `NOT KLIKE` を追加。**右辺は専用の限定パースで `STRING | VARIABLE` のみ受理**（[P1b]・`parseSqlValue` 流用不可）。
- **`pushDownNot` の `negateOp`（[pushDownNot.ts:38](../../src/engine/pushDownNot.ts#L38)）に `KLIKE→NOT_KLIKE` / `NOT_KLIKE→KLIKE` を追加**（[P2a]・`NOT (KLIKE)` 対応）。

### 3.2 変換（kintone へ素通し）
- `whereToKintone` の `convertOp`（[whereToKintone.ts:82](../../src/converter/whereToKintone.ts#L82)）に `KLIKE→"like"` / `NOT_KLIKE→"not like"` を追加。**`isLike` の throw 対象にはしない**（KLIKE は変換可）。
- `core/like.ts` に `isKlike(where)` ヘルパーを新設（`isLike` と区別）。

### 3.3 実行モード（KLIKE は JS を要求しない）
- `whereRequiresJsEval`（[selectToKintone.ts:81](../../src/converter/selectToKintone.ts#L81)）は **`KLIKE` を JS 評価要求に含めない**（`isLike` とは別扱い）。→ WHERE が `KLIKE` と押し下げ可能述語だけなら **SIMPLE モード**（kintone 側検索・高速）。これが本提案の主目的。

### 3.4 スコープ（v1 / v2）＝SELECT 全体の最終モードで判定（[P1a]）
kintone ネイティブゆえ **`KLIKE` は JS で再評価できない**。FULL_SCAN パイプラインは取得後に WHERE 全体を JS 再評価する（[process.ts:843](../../src/engine/process.ts#L843)）ため、KLIKE が FULL_SCAN の SELECT に含まれると評価不能になる。

- **v1（推奨・最小・安全）＝不変条件**:
  ```
  WHERE ツリーに KLIKE が存在し、対象 SELECT の resolveSelectMode === FULL_SCAN なら実行前に拒否
  ```
  FULL_SCAN の理由は WHERE 混在に限らない（JOIN・GROUP BY・DISTINCT・集計・式 ORDER BY・サブテーブル＝[resolveSelectMode](../../src/converter/selectToKintone.ts#L60)）。「KLIKE と LIKE の混在」ではなく **SELECT 全体の最終モード**で判定する。
  - **AST 構築後の共通静的検証**として実装（パーサー内でなく）。**単文・バッチ・EXPLAIN で挙動統一**。**CTE・UNION 各枝・IN/EXISTS/スカラーサブクエリ内の SELECT にも個別適用**。
  - メッセージ例:「KLIKE は kintone へ押し下げるため SIMPLE クエリでのみ使えます。この SELECT は <理由> により全件取得（FULL_SCAN）になります。LIKE を使うか、KLIKE を単純な検索クエリに分けてください。」
  - evalWhere に KLIKE 処理を入れず、プレフィルタ複雑性も無し。**主目的（検索の SIMPLE 化）を満たす**。
- **v2（後続・強力）**: `KLIKE` を**安全な AND リーフとして押し下げ**（`extractSafePushdownLeaves` に追加）、FULL_SCAN でも kintone が KLIKE で絞り、JS が残り（LIKE 等）を精製。evalWhere は KLIKE リーフを **押し下げ済み＝真** として扱う（KLIKE が必ず押し下げられる AND 文脈に限る前提）。または JS 評価用 WHERE から KLIKE リーフを TRUE へ書き換え。v1 実績後に検討。

> 補足: `KLIKE OR =` のような OR でも、**SELECT 全体が SIMPLE なら kintone が丸ごと処理するため v1 で許可**（FULL_SCAN 化する場合のみ拒否）。判定は必ず `resolveSelectMode`。

### 3.5 DML（v1 は全 DML で KLIKE 拒否・[P1c][P0]）
- 親 `UPDATE`/`DELETE` は対象解決 `resolveDmlTargetIds`（[sharedPlanner.ts:39](../../src/core/optimization/sharedPlanner.ts#L39)）が kintone クエリで $id を取得するため、KLIKE を**技術的には**利用できる（`LIKE` は JS 評価経路なしで拒否＝[dmlToKintone.ts:32](../../src/converter/dmlToKintone.ts#L32)）。
- **一方、サブテーブル `UPDATE`/`DELETE`/`REORDER` は親全取得→`evalWhere` の JS 評価（[execute.ts:2778](../../src/execute.ts#L2778)）**なので KLIKE 評価不能 → **禁止**。
- **v1 の方針（確定・保守）＝全 DML で KLIKE 拒否**:
  - サブテーブル DML: 技術的に不可（JS 評価）→ 恒久禁止。
  - 親 DML: 技術的には可能だが、**[P0] の 10 万件打ち切りをクライアントが検出できない**間は、**対象の一部だけを更新/削除するサイレント事故**の危険がある → **v1 では拒否**。P0 のヘッダー検出＋エラー化（§3.7）完成後に**親レコード DML のみ解禁**を検討。
  - 「事前 SELECT 推奨」は意味論確認には役立つが、SELECT 後の更新との競合や 10 万件打ち切りは解消しないため、DML 解禁の根拠にはしない。
- DML result 型に `warnings` が無い（[execute.ts:165](../../src/execute.ts#L165)）ため「警告付き DML 許可」は現状実装不可。解禁時は result 型拡張が前提。

### 3.6 EXPLAIN
- SIMPLE: `kintone query` に `件名 like "至急"` が現れる。
- v2 の FULL_SCAN 押し下げ時: `pushdown` として現れる（型不要・kintone ネイティブ）。

### 3.7 10 万件打ち切り（[P0]・主要リスク・要検出基盤）
kintone の `like`/`not like` は一致が **10 万件で検索打ち切り**になり `X-Cybozu-Warning: Filter aborted because of too many search results` を返すが、現状クライアントは**ヘッダーを読まない**（`KintoneGetResponse` は `records` のみ＝[fetchAll.ts:27](../../src/api/fetchAll.ts#L27)／Node `requestJson`／plugin `kintone.api()`）。→ **KLIKE は結果がサイレントに欠落し得る**。
- **SELECT（v1 許可）**: 「一致候補が 10 万件を超えると kintone が検索を打ち切り、**完全な結果を保証しない場合がある**」を明記。将来、レスポンスヘッダー検出（`X-Cybozu-Warning` → warning）を実装して EXPLAIN/結果に警告表示するのが望ましい（別作業として起票可）。
- **DML（v1 拒否）**: §3.5。ヘッダー検出＋エラー化が完成するまで解禁しない。
- **検出基盤（推奨・別作業）**: `KintoneGetResponse` に警告フィールドを追加し、Node はレスポンスヘッダーから、plugin は取得手段に応じて `X-Cybozu-Warning` を拾う。KLIKE の安全な DML 解禁の前提。

## 4. 効果評価

### 4.1 性能効果
- **`LIKE`（FULL_SCAN・全件取得＋JS）→ `KLIKE`（SIMPLE・kintone 側で絞って取得）**。大規模アプリで取得件数・レイテンシを削減。テキスト検索の主目的に直接効く。
- **効果の正確な条件（[P0] 反映）**: 「`maxRecords` 到達を回避」は無条件ではなく、**一致候補が `maxRecords` 以下、かつ kintone の 10 万件検索上限未満のとき**に成り立つ。10 万件を超える一致では kintone が検索を打ち切り、**結果がサイレントに欠落し得る**（§3.7）。
- 述語分割（LIKE を JS のまま安全述語だけ押し下げ）と比べ、**KLIKE は検索そのものを kintone に委ねる**ため効果が大きい（ただし意味論・10 万件上限が kintone 依存になるトレードオフ）。

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
- ワイルドカード非対応: **`%` は拒否**（誤用検出）、`_` は許可だが単語構成文字（非ワイルドカード）。
- 対象は公式の演算子対応表のフィールド（文字列系＋添付ファイル等・非対応型は kintone エラー）。
- v1 は **FULL_SCAN になる SELECT では使用不可**（JOIN/GROUP BY/DISTINCT/集計/式 ORDER BY/JS 評価述語のいずれか。v2 で押し下げ解禁）。
- **サイレント過少一致**: 一致が 10 万件を超えると kintone が打ち切り、結果が欠落し得る（検出基盤が無い間は警告も出ない・§3.7）。
- kintone の単語検索は完全一致より**過剰一致し得る**。
- **v1 は全 DML で使用不可**（サブテーブルは恒久・親は P0 解消まで）。

## 5. リスク・エッジ
- `%` 混入の誤用（LIKE のつもり）→ 静的リテラル・変数置換後とも拒否。`_` は許可するが非ワイルドカード。
- 非対応フィールド → kintone エラー（v1 は委譲・将来 型メタで事前検証）。
- OR/NOT 文脈：SIMPLE なら可・FULL_SCAN 化する場合のみ拒否（v1）。
- DML の過剰／過少一致 → v1 は全 DML で拒否。親DMLはP0解消後に別仕様で再検討。
- 保存クエリ・バッチ変数・EXPLAIN との整合。

## 6. 3 論点の確定（codex R2）
| 論点 | 確定 |
|---|---|
| v1 スコープ | **SIMPLE 限定**。WHERE 混在判定ではなく **`resolveSelectMode===FULL_SCAN` を全理由込みで実行前拒否**（AST 後の共通静的検証・CTE/UNION/サブクエリ内 SELECT にも適用） |
| ワイルドカード | **`%` は拒否**（静的・変数置換後とも）／**`_` は許可＋非ワイルドカードと明記**。右辺は `STRING|VARIABLE` 限定 |
| DML | **v1 は全 DML で拒否**。サブテーブルは恒久（JS 評価）。親は [P0] の 10 万件打ち切りヘッダー検出が完成後に解禁検討 |

## 7. 進め方（提案）
1. R2 を codex 再確認（必要なら）。
2. **v1 実装（完了）**: KLIKE トークン/AST/parser（右辺 STRING|VARIABLE・`%` 拒否）・`convertOp` で `like`/`not like`・`negateOp` に KLIKE↔NOT_KLIKE・`whereRequiresJsEval` 非該当化・**AST 後の静的検証で「KLIKE ∧ FULL_SCAN」拒否**（全 SELECT スコープ）・**全 DML で KLIKE 拒否**・互換注記（フィールドコード `KLIKE`）。
3. **実機（完了・APP4221 / APP730）**: SIMPLE 押し下げ・演算子組み合わせ・拒否・意味論・性能を確認しドキュメント化（更新履歴参照）。未検証は半角/全角相互一致・10 万件打ち切りの実挙動（実測困難）。
4. **リリース（minor・v2.8.0）** ← 現在ここ。
5. **後続（別作業）**: [P0] レスポンスヘッダー（`X-Cybozu-Warning`）検出基盤 → SELECT 警告表示・親 DML 解禁の前提。**v2**（KLIKE プレフィルタ押し下げ）。
