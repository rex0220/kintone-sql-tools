# 保存クエリのパラメータ化（名前付きバインド変数）仕様案

- 作成日: 2026-07-12
- 更新履歴:
  - 2026-07-12 R2: codex レビュー反映。optional 値の未解決を禁止、カタログの条件付き version 2 移行、lexer 共通化 + parser モードを明記。保存・実行とも既存どおり単文限定であることを確認
  - 2026-07-12 R1: 初版（設計評価と codex レビュー反映）
- ステータス: **ドラフト**
- 対象バージョン: 未定
- 対象機能: MCP 保存クエリ（`ksql_save_query` / `ksql_list_queries` / `ksql_get_query` / `ksql_run_saved_query`）
- 関連実装: `src/mcp/savedQueries.ts`、`src/mcp/tools.ts`、`src/mcp/schemas.ts`、`src/lexer/`、`src/parser/`、`src/types/ast.ts`

## 1. 背景と目的

現行の保存クエリは SQL 文字列をそのまま保存するため、条件値も SQL に固定される。

```sql
SELECT * FROM APP100 WHERE 登録日 >= '2026-01-01'
```

名前付きパラメータを導入し、同じ定型クエリへ実行時の値だけを安全に渡せるようにする。

```sql
SELECT * FROM APP100 WHERE 登録日 >= :since
```

主な利用者は MCP クライアントであり、「保存済みの用途・対象アプリ・文型は固定し、値だけを実行ごとに変える」ことを目的とする。

## 2. 設計原則

1. パラメータは**値位置だけ**で使用できる。テーブル名、フィールド名、alias、演算子、SQL キーワードは動的化しない
2. SQL 文字列への生の置換は行わない。lexer / parser が `ParamRef` を認識し、専用バインドフェーズで既存のリテラル AST に解決する
3. バインド完了後の AST に `ParamRef` を残さない。既存の検証、WHERE pushdown、評価器、kintone query 変換は既存リテラルだけを受け取る
4. 保存時と実行時の双方で、SQL 内の参照とパラメータ宣言の整合を検証する
5. 未指定、余剰、型不一致、使用位置不一致を暗黙補正せずエラーにする

## 3. 初回リリースのスコープ

### 3.1 含める

- `ksql_run_saved_query` の `params` 入力
- `:name` 形式の名前付きパラメータ
- scalar parameter: `string` / `number` / `integer`
- list parameter: `string[]` / `number[]`
- `IN (:list)` / `NOT IN (:list)` に限ったリスト展開
- パラメータ宣言（名前、型、必須、デフォルト、説明）
- `ksql_list_queries` / `ksql_get_query` による宣言の提示
- SELECT と DML の保存クエリ（既存の DML 承認ガードは維持）

### 3.2 含めない

- `ksql_query` / `ksql_mutate` / `ksql_validate` / `ksql_explain` の直接 `params` 入力
- 位置パラメータ `?`
- 識別子、テーブル、アプリ ID、profile、演算子、SQL 断片のパラメータ化
- scalar subquery や式そのものの注入
- CLI の `--param`、コンソール入力、プラグイン UI
- SQL 結果キャッシュ
- 複文（バッチ）の保存クエリおよびバッチのパラメータ化（保存・実行とも既存どおり単文限定）
- 値の未指定によって述語自体を省略する任意フィルタ

CLI / プラグイン対応は後続機能とし、初回仕様の互換性要件には含めない。

## 4. 文法と AST

### 4.1 字句規則

パラメータ参照は `:` に名前を続ける。

```text
ParamRef ::= ":" ParamName
ParamName ::= [A-Za-z_][A-Za-z0-9_]*
```

`:name` は ISO SQL 標準としてではなく、広く使われる名前付きパラメータの慣用記法として採用する。文字列リテラル、backtick 識別子、コメント内の `:name` は通常の文字列またはコメントであり、パラメータ参照として扱わない。

lexer はテンプレート用と通常 SQL 用に分岐させず、常に `:name` を共通の `PARAM` token として生成する。parser は同一実装に `allowParams` 相当のモードを持ち、保存クエリのテンプレート parse だけが `PARAM` を受理する。通常 SQL で `PARAM` が現れた場合は明示的に拒否する。これにより字句・構文処理の二重実装を避ける。

### 4.2 AST

テンプレート parse 用 AST に次のノードを追加する。

```ts
interface ParamRef {
  type: "PARAM_REF";
  name: string;
}
```

リスト専用の別構文は追加しない。`IN (` の直下に単独で現れた `ParamRef` と宣言型の組み合わせにより、binder が `IN_LIST` へ解決する。

### 4.3 許可位置

初回リリースでは次の値位置だけを許可する。

| 位置 | 許可型 | 例 |
|---|---|---|
| WHERE / JOIN ON / HAVING / ASSERT の比較右辺 | scalar | `金額 >= :min` |
| `IN` / `NOT IN` の括弧内にある唯一の要素 | list | `状態 IN (:statuses)` |
| INSERT / UPSERT の VALUES | scalar | `VALUES (:name, :amount)` |
| UPDATE の SET 右辺 | scalar | `SET 状態 = :status` |
| LIMIT / OFFSET | integer | `LIMIT :limit OFFSET :offset` |

関数引数、算術式、CASE 式、SELECT 列の値位置は初回リリースでは対象外とする。必要性を確認して後続仕様で拡張する。

次は parse またはテンプレート検証で拒否する。

```sql
SELECT * FROM :app
SELECT :field FROM APP100
SELECT * FROM APP100 WHERE :field = 'x'
SELECT * FROM APP100 WHERE 状態 IN (:a, :b)
```

## 5. パラメータ宣言

保存クエリに `parameters` を追加する。

```json
{
  "name": "recent_orders",
  "sql": "SELECT * FROM APP100 WHERE 登録日 >= :since AND 状態 IN (:statuses) LIMIT :limit",
  "parameters": [
    { "name": "since", "type": "string", "required": true, "description": "YYYY-MM-DD" },
    { "name": "statuses", "type": "string[]", "required": true },
    { "name": "limit", "type": "integer", "required": false, "default": 100 }
  ]
}
```

### 5.1 宣言規則

- 名前は `ParamName` と一致し、同一クエリ内で一意であること
- `required: true` と `default` は同時指定不可とする
- `required: false` では `default` を必須とする。optional かつ default なしの宣言は禁止する
- `required` 省略時は、`default` があれば `false`、なければ `true` とする
- SQL で参照されるすべての名前に宣言が必要
- 宣言されたすべての名前は SQL 内で1回以上参照される必要がある
- 同じ名前を複数箇所で参照できるが、すべて宣言型に適合する位置でなければならない
- `description` は任意の非空文字列

宣言と参照の完全一致を採用し、SQL からの型推論や未使用宣言の黙認は行わない。
未使用宣言の禁止はテンプレート編集時の柔軟性より、公開メタデータと実際の SQL の完全一致を優先する意図的な選択である。

## 6. 入力値と型規約

`ksql_run_saved_query` に JSON object の `params` を追加する。

```json
{
  "name": "recent_orders",
  "params": {
    "since": "2026-01-01",
    "statuses": ["受付", "処理中"],
    "limit": 50
  }
}
```

| 宣言型 | 受理する JSON 値 | 解決先 AST |
|---|---|---|
| `string` | string | `STRING` |
| `number` | finite number | `NUMBER` |
| `integer` | finite safe integer | `NUMBER`（LIMIT / OFFSET では 0 以上） |
| `string[]` | 1件以上の string 配列 | `IN_LIST` |
| `number[]` | 1件以上の finite number 配列 | `IN_LIST` |

### 6.1 拒否規則

- `null` と boolean は全型で拒否する
- `NaN` / `Infinity` / `-Infinity` は拒否する
- 空配列、混在型配列、入れ子配列は拒否する
- scalar 位置に list、list 位置に scalar を渡した場合は拒否する
- `IN (:scalar)`、scalar 位置での list 宣言参照は保存時に拒否する
- `required: true` のパラメータが未指定なら実行時エラー
- `required: false` のパラメータが未指定なら宣言の default を使用する
- 入力 object の余剰キーは実行時エラー
- kintone フィールド型を見て string を number へ寄せるなどの暗黙変換は行わない

日付、日時、選択肢、ユーザー等は初回リリースでは `string` として扱う。値の形式・選択肢存在性は kintone API の既存検証に委ねる。必要なら後続で `date` / `datetime` 等の宣言型を追加する。

未指定値によって WHERE 述語そのものを削除する処理は行わない。すべての参照は実行時に入力値または default のどちらかへ必ず解決される。`null` を使った任意フィルタも初回リリースでは非対応とする。

## 7. 保存・実行パイプライン

### 7.1 保存時

```text
SQL テンプレート
→ profile / APP@profile 正規化
→ 共通 parser の parameter 許可モードで template parse
→ 単文制約・文型・DML/readOnly・許可位置を静的検証
→ SQL 内 ParamRef と parameters 宣言の完全一致を検証
→ カタログへ保存
```

必須パラメータに値がなくても保存できるため、保存時検証は binder の実行を要求しない。lexer は `:name` を常に token 化するが、通常 SQL の parser モードでは拒否し、保存テンプレートのモードでだけ受理する。保存 SQL を未検証のまま格納する迂回経路は設けない。

現行実装は `ksql_save_query` と `ksql_run_saved_query` の双方で `requireSingleStatement` を通しており、保存・実行とも既に単文限定である。本仕様もこの制約を維持し、バッチパラメータ化は扱わない。

### 7.2 実行時

```text
カタログ読み込み
→ profile override 検証
→ template parse と宣言整合を再検証
→ 入力 params + default を型検証
→ ParamRef を STRING / NUMBER / IN_LIST へバインド
→ ParamRef が残っていないことを確認
→ 既存 AST 検証・安全性判定・pushdown・実行
```

カタログは手編集可能なため、保存時に検証済みであっても実行時検証を省略しない。

### 7.3 AST の受け渡し

現行の `validate(sql)`、`query(sql)`、`mutate(sql)`、`execute(sql)` は SQL 文字列を入口として内部で parse する。バインド済み AST を安全に使うため、実装では解析・実行の AST 入口を共有化する。

- binder 後に AST を SQL 文字列へ戻して再parseしない
- `params` を `evalWhere` / `evalFunc` / `whereToKintone` まで伝播させない
- AST 入口と従来の SQL 入口は同じ安全性検証・DML ガードを通す
- `PARAM_REF` が実行層へ到達した場合は内部エラーとして停止する

具体的な関数分割は実装計画で決めるが、文字列化による擬似バインドへ戻さないことを受け入れ条件とする。

## 8. 安全性

生の文字列置換は採用しない。理由は次のとおり。

- quote / escape の漏れがインジェクション、述語改変、複文注入につながる
- 安全性が全値型・全SQL位置の文字列エスケープ実装へ依存する
- 値以外の SQL 構造を変えないという保証を型で表現できない

現行の `ksql_run_saved_query` は実行時にも `validate` と `assertSavedQuerySafety` を適用しており、置換後に同じ経路を通す限り readOnly SQL が DML に変化してそのまま実行されるわけではない。この再検証は最後の防壁として維持するが、生の文字列置換を採用する根拠にはしない。

DML 保存クエリでは、バインド後も既存の `allowDml: true`、`confirmText: "yes"`、`dmlMaxRows` を必須とする。パラメータ機能によって承認条件を緩和しない。

## 9. カタログバージョンと互換性

### 9.1 決定

パラメータ宣言の追加に伴い、カタログを `version: 2` に上げる。

旧コードは `version !== 1` を拒否する一方、version 1 の reader は既知フィールドだけを再構築する。version 1 に optional `parameters` を追加すると、旧コードが読み込み後に保存した際に宣言を黙って落とす可能性がある。この前方互換のデータ欠損を避けるため version 2 を採用する。

### 9.2 移行

- 新コードは version 1 と version 2 を読み込める
- version 1 の各保存クエリは `parameters: []` として扱う
- version 1 を読み込んだ後も、全保存クエリの `parameters` が空である間は version 1 のまま書き続ける
- 初めて1つ以上の parameter 宣言を持つクエリを保存するとき、カタログ全体を version 2 へ移行する
- 一度 version 2 になったカタログは、parameter 宣言がすべて削除されても自動で version 1 へ戻さない
- version 2 は `parameters` を必須配列とする（空配列可）
- 旧コードは version 2 を明示的に拒否するため、宣言を黙って欠落させない
- version 2 への初回移行前に元ファイルを保持する方法と rollback 手順を実装計画で定める

`saveSavedQueryCatalog` はカタログ全体を書き直すため、version 2 への移行は1クエリだけでなく全保存クエリに影響する。移行後に parameter 機能を持たない旧バージョンへダウングレードすると、旧コードはカタログ全体を拒否し、parameter を使わない既存クエリも取得・実行できなくなる。条件付き移行は、この一方向ドアを実際に parameter 機能を使用した環境に限定するための措置である。

## 10. MCP メタデータ

### 10.1 入力 schema

- `ksql_run_saved_query` のみに `params` を追加する
- `params` は JSON object とし、具体的な許容キーと型は対象保存クエリの `parameters` で決まることを description に明記する
- `ksql_query`、`ksql_mutate` 等、直接 params を受けないツールの入力 schema / description に params が使えると誤認させる記述を追加しない

### 10.2 出力

- `ksql_get_query`: SQL と完全な `parameters` 宣言を返す
- `ksql_list_queries`: 各クエリに `parameters` 宣言または同等の概要を返す
- `ksql_run_saved_query`: 実行結果に秘密値となり得る実入力 params をechoしない

### 10.3 同期テスト

`scripts/mcp-smoke.mjs` で少なくとも次を固定する。

1. `ksql_run_saved_query.inputSchema.properties.params` が存在し、description が非空
2. params を受けないツールに `params` 入力が存在しない
3. `ksql_run_saved_query` の description が名前付きパラメータ対応を示す
4. get/list の実レスポンスに `parameters` が含まれる

## 11. キャッシュ

現行の `cacheContext` は SQL 結果ではなく、profile / APP binding ごとのアプリメタデータキャッシュを分離するキーである。バインド値はキーに含めない。

将来 SQL 結果キャッシュを導入する場合は、正規化 SQL、対象 profile / APP binding、バインド値を含む安定したキー設計を別仕様で定める。

## 12. エラー契約

外部入力に起因する失敗は既存方針どおり `ArgumentError:` とする。最低限、次を区別できるメッセージを返す。

- 宣言の重複、未宣言参照、未使用宣言
- 必須値の不足、余剰入力
- 宣言型と JSON 値の不一致
- scalar / list の使用位置不一致
- 空配列
- LIMIT / OFFSET の負数・非整数
- 許可されない SQL 位置での ParamRef
- バインド後に未解決 ParamRef が残った内部不整合

値そのものをエラーメッセージへ無制限に含めない。パラメータ名、期待型、実際の JSON 型を中心に診断する。

## 13. テスト計画

### 13.1 lexer / parser / binder

1. `:name` を `ParamRef` としてparseできる
2. 文字列、コメント、backtick 内の `:name` は参照にならない
3. 不正な名前と許可されない位置を拒否する
4. scalar を `STRING` / `NUMBER` へ解決する
5. list を `IN_LIST` へ解決し、順序と値を保持する
6. 同一パラメータの複数参照をすべて解決する
7. bind 後の AST に `PARAM_REF` が残らない

### 13.2 宣言・値検証

1. 未宣言参照、未使用宣言、重複宣言
2. 必須不足、default 適用、余剰入力、optional かつ default なしの宣言拒否
3. 全宣言型の正常値と型不一致
4. null / boolean / 非有限数 / 非整数 / 空配列 / 混在配列
5. scalar と list の位置不一致
6. LIMIT / OFFSET の 0、正整数、負数、非整数

### 13.3 保存クエリ

1. parameter 付き SELECT の保存・取得・一覧・実行
2. parameter 付き DML の保存・実行と既存承認ガード
3. profile override の既存制約が不変
4. 手編集で SQL / 宣言を不整合にしたカタログを実行時に拒否
5. version 1 読み込み、parameter なしの version 1 維持、parameter 初回保存時の version 2 移行、version 2 維持、旧コード相当 reader による version 2 拒否
6. バインド値に quote、semicolon、SQL キーワード相当文字列を含めても SQL 構造が変わらない
7. WHERE pushdown と FULL_SCAN の双方で既存リテラルと同じ結果になる

### 13.4 回帰

- parameter を持たない version 1 相当の保存クエリが従来どおり実行できる
- `ksql_query` / `ksql_mutate` / CLI / プラグインの入力仕様は変わらない
- readOnly / DML 分類、単文制約、DML 行数ガードが不変
- アプリメタデータキャッシュがバインド値ごとに分断されない

## 14. 受け入れ条件

1. 保存 SQL のテーブル、フィールド、演算子、文型を実行時 params で変更できない
2. すべての ParamRef は実行前に既存リテラル AST へ解決される
3. binder 後の AST が既存の検証、pushdown、評価、DML ガードを通る
4. 生の SQL 文字列置換、または AST のSQL文字列化を実行経路に使用しない
5. 宣言と参照の不一致、入力の過不足、型不一致を決定的に拒否する
6. `IN (:list)` 以外で list parameter を使用できず、空配列を拒否する
7. parameter を使わないカタログは version 1 を維持し、初回利用時だけ version 2 へ移行する。移行で既存クエリを失わず、旧コードによる parameters の黙った欠落を防ぐ
8. MCP の schema、description、get/list 出力が実装と同期し、smoke assertion で固定される
9. parameter を持たない既存保存クエリと既存実行経路に回帰がない

## 15. 実装前の未決事項

1. 対象リリースバージョン
2. version 2 初回書き込み時のバックアップファイル名と rollback 手順
3. AST 入口を共有する具体的な API 分割（parse / analyze / execute の責務境界）
4. `parameters` の並び順を宣言順で保持するか、SQL 初出順へ正規化するか
5. 1クエリ当たりのパラメータ数、list 要素数、文字列長の上限
6. `params` 省略と空 object を同義にするか（parameter なし、または全項目 default の場合）
