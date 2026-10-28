# B203 外部注入（`DECLARE` + `variables`）で文字列配列を受ける

- 状態: ✅ **v3.89.0 でリリース（2026-10-28）**。テスト 31 件（`src/flow-library/__tests__/b203ArrayVariableInjection.test.ts` 24 件・`src/parser/__tests__/b203DeclareArray.test.ts` 7 件）。言語（`IN @list` / `NOT IN @list`）と押し下げ、空配列の畳み込みは**既にある**。足りないのは宣言と注入の型だけ
- 種別: 機能（公開 API の純加法追加）
- 優先: 中（急ぎではない。依頼元の Ver.1 は「条件で絞る」形で出せる）
- 版: minor（v3.89.0 想定）。`variables` に文字列を渡す既存の呼び出しは型も動きも不変
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261028-KJ4-配列の注入.md`（依頼 KJ-4）。回答は同じ場所の `kSQLエンジンからの回答-20261028-KJ4-配列の注入.md`
- 関連: [B200](ksql_b200_apply_append_values_issue.md)（`APPEND … SELECT`＝本件の用途の前提。v3.88.0）、[B198](ksql_b198_flow_apply_mutation_publication_issue.md)

## 1. なぜ必要か

v3.88.0 の `APPEND … SELECT` は **`REMOVE ALL ROWS` 必須の全置換**なので、
「一覧で選んだ複数レコードを 1 つの親のテーブルにまとめて入れる」用途を**ループで代替できない**
（1 件ずつ流すと最後の 1 件だけが残る）。選択の集合を 1 回の文へ渡す口が要る。

依頼元は 2026-10-27 に「プラグインが 1 レコードずつループするので集合は要らない」と整理してこの依頼を保留していたが、
v3.88.0 でその前提が変わったため再開した（依頼書 §2）。

## 2. 今の状態（v3.88.0 で実測）

| 形 | 今の動き |
|---|---|
| `DECLARE @ids = [];` | **parse エラー** `KSQL1202 算術式のオペランドには識別子・数値・括弧式を指定してください`（既定値を `parseScalarExpr` で読むため） |
| `SET @ids = ['311','301']` + `IN @ids` | 動く。`$id in ("311","301")` に押し下がる（`src/execute.ts:3374-3387` が `IN_LIST` へ差し替え） |
| 空配列 + `IN` | **GET 0 回**（`{ type: "BOOLEAN", value: false }` に畳む） |
| 空配列 + `NOT IN` の SELECT | 全件（定数真） |
| 空配列 + `NOT IN` の UPDATE / DELETE / REORDER | `ArgumentError: empty-array simplification makes the target WHERE always true`（fail-closed） |
| `variables` に配列 | `{ type: "string" }` と無条件に包むため（`src/execute.ts:2631`）`ParseError: scalar variable @ids cannot be used as IN @ids` |
| `APPEND … SELECT` のソースの `WHERE $id IN @ids`（`SET` 形） | **動く**（実測。変数の解決は文の AST を丸ごと歩くため） |

## 3. 出すもの

1. **宣言**: `DECLARE @ids = [];` / `DECLARE @ids = ['A','B'];` を通す（`SET` と同じ `parseArrayLiteral`＝文字列要素のみ）。
   AST は `DeclareVariableStatement.default` に `ArrayLiteral` が入るだけ。**注釈（`ARRAY`）は足さない**＝配列リテラルが自己記述的で、
   依頼元の保存時の検査も `st.default.type === "ARRAY"` の 1 行で済む（規則を 2 つにしない）。
2. **注入**: `/flow` の `variables` を `Readonly<Record<string, string | readonly string[]>>` へ。
   **宣言が種類を決める**（配列宣言に文字列／スカラー宣言に配列／要素に文字列以外は、いずれも `createExecutionContext` で `ArgumentError`）。
3. **使える位置**: `IN @list` / `NOT IN @list` だけ。**スカラー位置の使用は `createExecutionContext` で `ArgumentError`**
   （バッチ解析が `VariableUseKind`＝`scalar` / `select-column` / `array-in-list` を既に持っている。`src/core/batch.ts:104`）。
   **スカラーを `IN @list` に書いた既存のエラーは文言も変えない**（依頼の受入基準 4）。
4. **上限**: `variableArrayMaxElements`（`/flow`・正の安全な整数・**既定 500**）。注入と既定値の両方に効き、超過は実行前に `ArgumentError`（読み書き 0 回）。
5. **EXPLAIN**: 配列の宣言を配列のプレースホルダーとして扱う（`SET` の配列は既にそう）。
6. **CLI / MCP は変えない**（`--var` と MCP の `variables` は文字列のまま）。実需が出たら別に起票する。
7. 文書: 言語リファレンス §25 に配列の節、README の `/flow` に `variables` の型と `variableArrayMaxElements`。

## 4. 上限の根拠（実測。回答 §5.2 と同じ）

kintone は **`in (…)` の要素数もクエリ長も文書で定めていない**
（[get-records](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/)・[クエリの書き方](https://cybozu.dev/ja/kintone/docs/overview/query/)。
定めがあるのは 500 件 / `offset` 10,000 / `like` の 10 万件打ち切りだけ。2026-10-28 確認）。
実際の壁は **URL の長さ**で、`/flow` の `createKintoneClient` は GET のクエリ文字列で送る（`src/flow-library/writableClient.ts:95-104`）。

`$id IN @ids`（3 桁の ID）で生成されるクエリ:

| 要素数 | 生 | URL エンコード後 |
|---|---|---|
| 50 | 344 字 | 666 字 |
| 100 | 644 字 | 1,266 字 |
| 200 | 1,315 字 | 2,537 字 |
| 500 | 3,415 字 | 6,437 字 |
| 1,000 | 6,915 字 | 12,937 字 |

要素 1 件の費用はおおよそ「(値の長さ + 3) × 2」字（エンコード後）で、**日本語は 1 文字 9 字**（`%XX%XX%XX`）。
したがって**要素数だけでは URL 長を保証できない**。既定 500（読取ページ数と同じ数字）にし、
依頼元には**選択数 200 を推奨**して `variableArrayMaxElements` を明示で渡してもらう。

## 5. 受入基準（依頼 KJ-4 §5）

1. `variables` から `["a","b"]` を注入して `IN @list` が `in ("a","b")` に押し下がる。
2. 空配列は 0 件・kintone を読まない・書込 0。
3. 配列をスカラー位置に書いたら**実行前**にエラー（`createExecutionContext`）。
4. スカラーを `IN @list` に書いた既存のエラーは不変（文言も）。
5. `NOT IN @list` も同じ規則（空配列の DML 対象 `WHERE` は従来どおり拒否）。
6. 要素数の上限を超えたら実行前にエラー。
7. `APPEND … SELECT` のソースの `WHERE` で使える。
8. 既存の文字列注入は不変。

## 6. 実装（2026-10-28）

| 触った場所 | 内容 |
|---|---|
| `src/types/ast.ts` | `DeclareVariableStatement.default` に `ArrayLiteral` を足した（1 行） |
| `src/parser/parser.ts` | `parseDeclareVariable` に `LBRACKET` の分岐（`SET` と同じ `parseArrayLiteral`） |
| `src/core/batch.ts` | 変数の種類の判定に「DECLARE の既定値が配列」を足した（**既存の静的チェック 2 本がそのまま効く**＝配列をスカラー位置で使えば `analyzeBatch` が止める・スカラーを `IN @x` に書いた既存のエラーは不変） |
| `src/core/batchVariables.ts` | `BatchVariableInput = string \| readonly string[]`・要素の型の検査・**宣言と注入の種類の突き合わせ**・要素数の上限（`DEFAULT_VARIABLE_ARRAY_MAX_ELEMENTS = 500`。注入と `DECLARE` の既定値の両方） |
| `src/execute.ts` | `BatchExecuteOptions.variables` の型と `variableArrayMaxElements`・DECLARE 実行の配列分岐（注入と既定値）・`prepareRelativeDateVariables` の型・EXPLAIN の配列プレースホルダー・3 か所の `validateDeclaredBatchVariables` へ上限を渡す |
| `src/flow-library/` | `CreateExecutionContextOptions` と `ExplainScriptOptions` の `variables` を union へ・`variableArrayMaxElements`・`explainScript` の配線 |
| 文書 | 言語リファレンス §25 に「配列の変数」、README の `/flow` に「外部パラメータ注入」 |

**実装して分かったこと**: 受入基準 3（配列をスカラー位置に書いたら実行前にエラー）は**新しいコードを書かずに満たせた**。
`analyzeBatch` が変数の使い方を `scalar` / `select-column` / `array-in-list` で持ち、
「配列の定義 × 非 array-in-list の使用」を既に拒否していたため（`src/core/batch.ts:336-341`）、
**DECLARE の種類判定に 1 行足すだけで静的チェックが有効になった**。
CLI / MCP は注入の型を広げていないので、配列を渡す経路は `/flow` だけに閉じている。

## 7. 再現

work-link の `ksql-action-kj4-array-probe.mjs`（押し下げクエリの長さの表・空配列・`DECLARE` の parse エラー）と
`ksql-action-kj4-append-select-probe.mjs`（受入基準 7 の形。要 v3.88.0）。どちらもモックの client で kintone に接続しない。
