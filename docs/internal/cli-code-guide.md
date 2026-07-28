# CLI コード解説

`src/cli/` 以下の実装を中心に、ksql CLI がどのように動くかをコードレベルで説明します。

---

## src/ ファイル別概要

`src/` 配下のファイルをディレクトリ・レイヤー別に解説します。

### src/types/

#### [src/types/ast.ts](../src/types/ast.ts)

SQL パーサーが生成する AST（抽象構文木）の型定義ファイルです。コードを生成せず、TypeScript の型だけを定義します。

- **`Statement`** — パーサーが返すトップレベルのユニオン型。`SelectStatement` / `InsertStatement` / `UpdateStatement` / `DeleteStatement` / `UpsertStatement` / `ReorderStatement` / `WithStatement` / `UnionStatement` / `ExplainStatement` / `ShowAppsStatement` / `DescribeStatement` の11種類
- **`SelectStatement`** — `SELECT distinct columns FROM table JOIN... WHERE... GROUP BY... HAVING... ORDER BY... LIMIT... OFFSET...` の全節を保持
- **`WhereExpr`** — WHERE/HAVING 式のユニオン型。`BinaryExpr` / `NullCheckExpr` / `LogicalExpr` / `NotExpr` / `GroupExpr` / `ExistsExpr` の6種類
- **`ArithNode`** — 算術式の再帰型。`FIELD_REF` / `NUMBER` / `ARITH`（ネスト）/ `STRING_FUNC` / `VARIABLE` の5種類。`VARIABLE` は実行・計画生成前に数値リテラルへ解決され、下流到達時は内部エラー
- **`SelectColumn`** — SELECT句の各カラム。ワイルドカード・フィールド・リテラル・集計・算術・CASE WHEN・文字列関数・スカラーサブクエリの8種類

この型定義が lexer → parser → converter → engine → execute の全レイヤーをつなぐ共通言語になっています。

---

### src/lexer/

#### [src/lexer/tokens.ts](../src/lexer/tokens.ts)

トークン種別の定義ファイルです。

- **`TokenKind`** — const enum で全トークン種別を定義（STRING / NUMBER / IDENT / BIDENT / キーワード群 / 演算子 / 記号 / EOF）
- **`KEYWORDS`** — 大文字に正規化したキーワード文字列 → `TokenKind` への `ReadonlyMap`。Lexer が識別子をキーワードに昇格させるときに参照する
- **`Token`** — `{ kind, value, pos }` の構造体。`pos` はデバッグ用エラーメッセージに使用

#### [src/lexer/lexer.ts](../src/lexer/lexer.ts)

SQL文字列をトークン列に変換する字句解析器です。

- **`Lexer` クラス** — `tokenize()` で `Token[]` を返す。内部で `nextToken()` を繰り返し呼ぶ
- 文字列リテラル（`'...'`）、バッククォート識別子（`` `...` ``）、`--` / `/* */` コメントをスキップ
- 識別子は ASCII英数字・`_`・`$`・日本語Unicode（U+3040〜U+9FFF）を許容
- `LexError` は位置と前後文字列を含むエラーメッセージを生成

---

### src/parser/

#### [src/parser/parser.ts](../src/parser/parser.ts)

トークン列をASTに変換する構文解析器です。再帰下降法で実装されています。

- **`Parser` クラス** — `parse()` が `Statement` を返す
- 演算子優先順位: `OR` < `AND` < `NOT` < 比較演算子 < 一次式
- SELECT / INSERT / UPDATE / DELETE / UPSERT / REORDER / WITH / UNION / EXPLAIN / SHOW APPS / DESCRIBE の11文を解析
- `ParseError` は期待トークンと実トークンの情報を含む

---

### src/execute.ts

[src/execute.ts](../src/execute.ts)

SQL文字列を受け取り、kintone API を呼び出して結果を返すメイン実行エンジンです。

- **`KintoneClient` インターフェース** — `getRecords` / `postRecords` / `putRecords` / `deleteRecords` / `getApps` / `getFields` の6メソッドを規定する。実装はUI層（`kintoneClient.ts`）とCLI層（`nodeKintoneClient.ts`）で別々に提供
- **`execute(sql, client, options)`** — エントリポイント。パース後に文の種別でルーティング

| 文の種別 | API呼び出しパターン |
|---|---|
| SELECT（SIMPLE） | `getRecords` 1〜数回 |
| SELECT（FULL_SCAN） | `fetchAll` で全件取得 → JS処理 |
| INSERT | `postRecords` (100件バッチ) |
| UPDATE | `fetchAll`で`$id`取得 → 確認 → `putRecords`バッチ |
| DELETE | `fetchAll`で`$id`取得 → 確認 → `deleteRecords`バッチ |
| UPSERT | SELECT + INSERT/UPDATE の組み合わせ |

- **`ExecuteOptions`** — `confirm`（DML確認コールバック）/ `maxRecords` / `onLimitReached` / `cacheContext` を指定
- **`ExecuteResult`** — `SelectResult` / `InsertResult` / `UpdateResult` / `DeleteResult` / `UpsertResult` / `ReorderResult` のユニオン型

---

### src/core/

#### [src/core/index.ts](../src/core/index.ts)

UI層・CLI層に向けた公開APIのファサードです。`execute` / `parseSqlStatement` / `formatDisplayText` と主要な型を re-export します。実装ファイルへの直接依存を避けるため、上位層はこのファイルだけを import します。

#### [src/core/sql.ts](../src/core/sql.ts)

`parseSqlStatement(sql)` の薄いラッパーです。`new Lexer(sql).tokenize()` → `new Parser(tokens).parse()` の2ステップを1関数にまとめます。CLI での DMLガード判定など、`execute` を呼ばずに AST だけ欲しい場面で使います。

#### [src/core/displayFormat.ts](../src/core/displayFormat.ts)

`execute` が返す `ProcessRow` の各セル値を表示用テキストに変換します。

- **`formatDisplayText(v, opts)`** — セル値（文字列・数値・JSON等）を `DisplayOptions` に従って整形
- JSON文字列を検出してパース。ユーザーオブジェクト・添付ファイル・サブテーブル・配列の各フォーマットを適用
- `dateFormat: "local"` 指定時は UTC日時をローカルタイムゾーンに変換

#### [src/core/optimization/sharedPlanner.ts](../src/core/optimization/sharedPlanner.ts)

DML実行時の共有フェッチロジックです。`execute.ts` から呼ばれます。

- **`fetchRecordsForSharedPlan`** — `fetchAll` のラッパー。DML前の全件取得に使用
- **`resolveDmlTargetIds`** — `$id` フィールドのみ取得して UPDATE/DELETE の対象IDリストを解決

#### [src/core/optimization/wherePredicatePushdown.ts](../src/core/optimization/wherePredicatePushdown.ts)

JOIN クエリの最適化モジュールです。

- **`extractTableCondition(where, tableAlias)`** — `WHERE` 式から特定テーブルエイリアスだけを参照する条件を抽出する。抽出した条件は各テーブルの `getRecords` クエリに付与（プッシュダウン）し、全件取得前にサーバー側で絞り込む
- `AND` ノードは左右を個別に分解、`OR` / `NOT` / `GROUP` は全体が単一テーブル参照の場合のみプッシュダウン、`EXISTS` は常に null（プッシュダウン不可）を返す

---

### src/api/

#### [src/api/fetchAll.ts](../src/api/fetchAll.ts)

kintone の1リクエスト500件制限・offset上限10,000件制限を回避して全件取得するモジュールです。

- **`fetchAll(fetcher, app, query, fields, options)`** — ページングを自動処理して `KintoneRecord[]` を返す
- **offset リセット戦略** — `offset >= 10,000` に達したら最後のレコードの `$id` をカーソルとして保持し、次ウィンドウのクエリに `$id > cursorId order by $id asc` を付与してoffsetを0にリセット
- **並列取得** — `parallel` オプションで複数ページを `Promise.all` で同時取得。offset上限を超えないよう取得数を自動制限
- **`FetchAllLimitError`** — `maxRecords` 超過時のエラークラス。`onLimit: "truncate"` 時はエラーの代わりに上限で切り捨てて返す
- **`buildCursorQuery`** / **`buildPageQuery`** — テスト可能なクエリ構築ヘルパー

---

### src/converter/

SQL ASTをkintone APIのパラメータ形式に変換するレイヤーです。

#### [src/converter/selectToKintone.ts](../src/converter/selectToKintone.ts)

`SelectStatement` AST をkintone GETリクエストのパラメータに変換します。

- **`resolveSelectMode(stmt)`** — `SIMPLE` / `FULL_SCAN` のどちらで実行するかを判定。JOIN・GROUP BY・DISTINCT・集計関数・WHERE内関数が存在すると `FULL_SCAN` になる
- **`selectToKintoneParams(stmt)`** — SIMPLE モード時に `{ app, query, fields }` を生成
- **`selectToFetchAllParams(stmt)`** — FULL_SCAN モード時に全件取得用のパラメータを生成
- サブテーブル（`APP100$明細`）への参照も処理

#### [src/converter/whereToKintone.ts](../src/converter/whereToKintone.ts)

`WhereExpr` AST をkintoneクエリ文字列に変換します。

- **`whereToKintone(expr)`** — `BinaryExpr` / `NullCheckExpr` / `LogicalExpr` / `NotExpr` / `GroupExpr` を再帰的に変換
- `NOT` は `pushDownNot()` でド・モルガン則を適用してリーフまで押し下げてから変換
- `EXISTS` はkintoneクエリに変換不可のため `KintoneQueryError` をスロー
- `IS NULL` → `field = ""`、`IS NOT NULL` → `field != ""` に変換（kintone構文）

#### [src/converter/dmlToKintone.ts](../src/converter/dmlToKintone.ts)

INSERT / UPDATE / DELETE の AST をkintone APIリクエスト形式に変換します。

- **`insertToPostBatches(stmt, fieldTypeMap)`** — INSERT VALUES を100件単位のバッチに分割して `KintonePostParams[]` を生成
- **`updateToGetQuery(stmt)`** — UPDATE の WHERE 節からkintoneクエリ文字列を生成（$id取得用）
- **`updateToPutBatches(ids, stmt, fetchedRecords, fieldTypeMap)`** — 取得済みのIDリストから PUT バッチを生成。算術式（`SET 金額 = 金額 * 1.1`）の場合はフェッチしたレコード値を使って計算
- **`deleteToGetQuery`** / **`deleteToDeleteBatches`** — DELETE の2フェーズ処理
- **`KintoneRecord`** — `Record<string, KintoneFieldValue>` 型。フィールド値は `{ value: string | string[] | ... }` の構造

#### [src/converter/subtableAdapter.ts](../src/converter/subtableAdapter.ts)

親レコードのサブテーブルフィールドを仮想レコード配列に展開するアダプターです。

- **`expandSubtableRecords(parents, subtableCode)`** — 各サブテーブル行を独立したレコードに変換し、`_pid`（親ID）/ `_rid`（行ID）/ `_idx`（行インデックス）の3つの仮想フィールドを付与。親レコードのフィールドは `_p.<フィールドコード>` として参照可能

---

### src/engine/

kintone から全件取得したレコードをJavaScriptで処理するエンジン層です。FULL_SCAN モード時に使用されます。

#### [src/engine/process.ts](../src/engine/process.ts)

FULL_SCAN モードの後処理パイプラインです。

| ステップ | 関数 | 処理内容 |
|---|---|---|
| 1 | `flatten` | `KintoneRecord` → `ProcessRow`（フラットな文字列マップ）に変換。JOINがある場合はキーに `alias.` を付与 |
| 2 | join | INNER / LEFT / RIGHT JOIN を実行 |
| 3 | filter | `evalWhere` でJS側WHERE適用 |
| 4 | `groupBy` | GROUP BY + COUNT / SUM / AVG / MAX / MIN 集計 |
| 5 | having | HAVING フィルタ |
| 6 | distinct | DISTINCT 重複除去 |
| 7 | `applyOrderBy` | ORDER BY ソート（数値フィールドは数値比較） |
| 8 | `applyLimit` | LIMIT / OFFSET 適用 |
| 9 | `project` | SELECT列のプロジェクション・エイリアス付与 |

- **`runFullScan(stmt, tables, ...)`** — 上記パイプライン全体を実行するエントリポイント
- **`ProcessRow`** — `Record<string, string>` 型。全フィールド値は文字列で統一

#### [src/engine/evalWhere.ts](../src/engine/evalWhere.ts)

`WhereExpr` AST をJavaScript側で評価します。JOIN後フィルタや関数を含むWHEREで使用されます。

- **`evalWhere(expr, row)`** — `ProcessRow` を受け取りbooleanを返す
- サブクエリ（`IN (SELECT ...)` / `EXISTS (...)`）は `execute.ts` 側で事前実行され、`ResolvedSubqueryInList` / `ResolvedExistsExpr` として `resolved` フィールドに結果が格納された状態で渡される
- LIKE演算は `%` を `.*` に変換した正規表現で評価

#### [src/engine/evalFunc.ts](../src/engine/evalFunc.ts)

算術式・文字列関数の評価ロジックです。`process.ts` と `evalWhere.ts` 両方から使われるため、循環参照を避ける目的で独立したモジュールとして分離されています。

- **`evalArithExpr(expr, row)`** — `ArithNode` を再帰的に評価して数値を返す
- **`evalStringFunc(expr, row)`** — UPPER / LOWER / SUBSTRING / CONCAT / COALESCE / ROUND / YEAR / DATE_FORMAT 等30種超の関数を評価
- **`resolveFieldRef(row, field)`** — テーブルエイリアス付き/なしでフィールド値を解決

#### [src/engine/pushDownNot.ts](../src/engine/pushDownNot.ts)

NOT式をド・モルガン則でリーフまで押し下げます。`whereToKintone.ts`（kintoneクエリ変換）と `evalWhere.ts`（JS評価）の両方で使用します。

- **`pushDownNot(expr)`** — `NOT (A AND B)` → `(NOT A OR NOT B)`、`NOT (A OR B)` → `(NOT A AND NOT B)` に変換。二重否定（`NOT NOT x`）は `x` に展開

---

### src/ui/

kintone プラグインとして動作するUI層です（CLI とは独立）。

#### [src/ui/desktop.ts](../src/ui/desktop.ts)

kintone プラグインのデスクトップ画面エントリポイントです。`kintone.events.on` でUIイベントを登録し、`execute()` を呼び出してSQL実行・結果表示を行います。ゲストスペース対応（URL から guestSpaceId を抽出）も担います。

#### [src/ui/kintoneClient.ts](../src/ui/kintoneClient.ts)

`kintone.api()` を `KintoneClient` インターフェースに適合させるアダプターです。Node.js の `fetch` の代わりに `kintone.api()` を使う点が `nodeKintoneClient.ts` との違いです。

#### [src/ui/renderResult.ts](../src/ui/renderResult.ts)

`ExecuteResult` をHTML文字列に変換するレンダラーです。SELECT結果はHTMLテーブルとして、DML結果は件数表示としてレンダリングします。`DisplayOptions` を受け取り、ユーザーフィールドや日付フィールドの表示形式を制御します。

#### [src/ui/config.ts](../src/ui/config.ts)

プラグイン設定画面のエントリポイントです。現バージョンでは設定項目がなく、キャンセルボタンのハンドラ登録のみを行います。

---

### レイヤー依存関係まとめ

```
src/ui/         (kintoneプラグイン)
src/cli/        (Node.js CLI)
     ↓ どちらも
src/core/       (公開APIファサード)
     ↓
src/execute.ts  (実行エンジン)
     ↓ 使う
src/converter/  (AST → kintone API パラメータ変換)
src/engine/     (JS側処理エンジン)
src/api/        (全件取得)
     ↓ どれも使う
src/types/ast.ts  (AST型定義)
src/lexer/        (字句解析)
src/parser/       (構文解析)
```

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| [src/cli/index.ts](../src/cli/index.ts) | CLIエントリポイント。引数解析・設定読込・実行フロー全体 |
| [src/cli/nodeKintoneClient.ts](../src/cli/nodeKintoneClient.ts) | Node.js向け kintone REST API クライアント |

---

## 全体フロー

```
process.argv
  └─ parseArgs()          引数をParseArgs構造体に変換
       └─ run()            メイン実行関数
            ├─ loadConfig()               ksql.config.json 読込
            ├─ normalizeSqlAppProfiles()  APP@profile 構文を正規化
            ├─ parseSqlStatement()        SQL → AST (core層)
            ├─ DMLガード検査              --allow-dml / --allow-without-where
            ├─ createNodeKintoneClient()  HTTPクライアント生成
            └─ execute()                 実行エンジン (core層)
                 └─ buildOutput()        結果をテキスト整形して stdout へ
```

コンソールモード（`--console`）の場合は `run()` の代わりに `runConsole()` が起動します。

---

## 引数解析: `parseArgs()`

[src/cli/index.ts:158](../src/cli/index.ts#L158)

`process.argv.slice(2)` の文字列配列を受け取り、`ParsedArgs` オブジェクトを返します。

- フラグ系（`--dry-run`, `--no-header` 等）は `out.xxx = true` で記録
- 値付きオプション（`-e`, `--format` 等）は `i++` でインデックスを進めて次トークンを値として読む
- 値が不正な場合は `new Error("ArgumentError: ...")` をスローし、呼び出し元の `run()` が終了コード 2 を返す

```typescript
// 例: --format の解析
if (a === "--format") {
  const normalized = normalizeOutputFormat(v ?? "");
  if (normalized) out.format = normalized;
  else throw new Error("ArgumentError: --format must be table|json|jsonl|csv|markdown|md.");
  i++;
  continue;
}
```

`ParsedArgs` は全フィールドに明示的なデフォルト（`null` / `false` / `{}`）が設定されており、後段の設定マージで上書きされます。

---

## 設定の優先順位

`run()` 内でオプションを決定する際、次の順で先勝ちします。

```
CLIフラグ > 環境変数 > ksql.config.json プロファイル > ハードコードデフォルト
```

例（`maxRecords`）:

```typescript
const maxRecords = args.maxRecords          // --max-records
  ?? envInt("KSQL_MAX_RECORDS")            // 環境変数
  ?? profile.query?.maxRecords             // config.json
  ?? 500;                                  // デフォルト
```

環境変数ヘルパーは `envString()` / `envInt()` / `envBool()` / `envFormat()` / `envOnLimit()` / `envAuth()` の6種類が定義されています（[index.ts:607-643](../src/cli/index.ts#L607-L643)）。

---

## APP@profile 構文: `normalizeSqlAppProfiles()`

[src/cli/index.ts:525](../src/cli/index.ts#L525)

SQL内の `APP100@prod` のような `@profile` サフィックスを解析し、プロファイルごとに異なる kintone 環境へルーティングするための前処理です。

### 処理ステップ

1. **`collectAppProfileTokens()`** — SQL文字列をスキャンし、文字列リテラル・バックティック・コメントをスキップしながら `APP<数字>[@<profile>]` トークンを収集
2. **`tryParseAppProfileToken()`** — 1トークンの解析。`@profile` がなければ `profile: null` を返し、呼び出し元でデフォルトプロファイルを補完
3. **仮想AppId割当** — 同一AppIdに複数プロファイルが指定された場合、900,000,000〜の仮想IDを割り当てて SQL を書き換える
4. **`appBindingByMappedApp`** — `仮想AppId → {realAppId, profile}` のマッピングを返す。後段のクライアントルーティングで使用

```typescript
// SQL: SELECT * FROM APP100@prod JOIN APP100@stg ON ...
// 結果: APP100 → 仮想APP900000000 (prod), APP100 → 仮想APP900000001 (stg)
```

`@profile` が一切ない場合はSQLを変換せず、`hasProfileSyntax: false` を返します。

---

## HTTP クライアント: `createNodeKintoneClient()`

[src/cli/nodeKintoneClient.ts:22](../src/cli/nodeKintoneClient.ts#L22)

Node.js の `fetch()` を使って kintone REST API を呼び出す `KintoneClient` 実装です。

### 認証

`TokenResolver.auth` で2種類の認証に対応します。

| `auth.type` | HTTPヘッダ |
|---|---|
| `token` | `X-Cybozu-API-Token: <resolveToken(appId)の返り値>` |
| `userpass` | `X-Cybozu-Authorization: Base64(user:pass)` |

トークン認証では `resolveToken(appId)` コールバックを毎リクエストで呼び出します。これにより、アプリIDごとに異なるトークンを動的に返すマルチトークン構成が実現されます。

### CB_IL02 エラーへの自動リトライ

[src/cli/nodeKintoneClient.ts:85](../src/cli/nodeKintoneClient.ts#L85)

kintone の `CB_IL02`（ソートキー不正）エラーが発生した場合、クエリ先頭に `order by レコード番号 asc` を付加して自動リトライします。これは ORDER BY なしの offset ページングで一部環境が返すエラーへの対策です。

### ゲストスペース対応

`guestSpaceId` が指定された場合、API パスを `/k/v1` から `/k/guest/<id>/v1` に切り替えます。

---

## マルチプロファイルのクライアントルーティング

`run()` 内でプロファイルごとに `createNodeKintoneClient()` を生成し、`profileClientMap` に格納します。

外側の `client` オブジェクトは各メソッドで `appBindingByMappedApp` を参照し、仮想AppIdから実AppIdとプロファイルを逆引きしてプロファイル別クライアントに委譲します。

```typescript
client = {
  getRecords: (params) => {
    const binding = appBindingByMappedApp.get(params.app)
      ?? { appId: params.app, profile: profileName.toLowerCase() };
    const routed = profileClientMap.get(binding.profile)!;
    return routed.getRecords({ ...params, app: binding.appId });
  },
  // putRecords / postRecords / deleteRecords / getFields も同様
  getApps: () => defaultClient.getApps(),
};
```

---

## DML ガード

DML文（INSERT / UPDATE / DELETE / UPSERT）は複数のガードを通過する必要があります。

| 条件 | エラー内容 | 回避オプション |
|---|---|---|
| `--allow-dml` なし | DMLは無効 | `--allow-dml` |
| UPDATE/DELETE で WHERE なし | WHERE なしは禁止 | `--allow-without-where` |
| INSERT の値行数 > dmlMaxRows | 行数超過 | `--dml-max-rows <n>` |
| 存在しないフィールドコード | フィールド検証失敗 | (修正が必要) |
| `--yes` なし | インタラクティブ確認プロンプト | `--yes` |

`--yes` なしの場合、`promptDmlConfirm()` がTTYで確認プロンプトを表示します。非TTY環境（パイプ等）ではエラーになります。

`parseConfirmAnswer()` は `"yes"` のみ承認します。ただし一部端末でキー入力が重複する事象（`"yyeess"` 等）に対応するため、連続する同一文字を1つに縮めた上で判定します（[index.ts:782](../src/cli/index.ts#L782)）。

---

## 出力フォーマット: `buildOutput()`

[src/cli/index.ts:791](../src/cli/index.ts#L791)

`SelectResult` を指定フォーマットの文字列に変換します。

| フォーマット | 内容 |
|---|---|
| `table` | タブ区切り（デフォルト） |
| `json` | `{columns, rowCount, warnings, rows}` の JSON オブジェクト |
| `jsonl` | 1行1レコードの JSON Lines |
| `csv` | RFC 4180準拠のCSV（`"` を `""` でエスケープ） |
| `markdown` | GFM テーブル（`\|` と改行を `<br>` でエスケープ） |

DML結果は `buildMutationOutput()` で同様のフォーマットに変換されます。

`DisplayOptions`（`userFormat` / `arrayFormat` / `tableFormat` / `dateFormat` / `attachmentFormat`）は `formatDisplayText()` (core層) に渡され、フィールド種別ごとの表示形式を制御します。

---

## インタラクティブコンソール: `runConsole()`

[src/cli/index.ts:1235](../src/cli/index.ts#L1235)

`--console` フラグで起動するREPLモードです。

### イベント処理

`createConsoleEventQueue()` が `readline` の `line` / `SIGINT` / `close` イベントを非同期キューに変換します。これにより SQL実行中でも入力イベントをロストせず、`await queue.next()` でイベントを順次処理できます。

### 複数行入力

`;` で終わらない行は `buffer` に蓄積され、`;` が来た時点でSQLとして実行されます。プロンプトが `ksql>` → `... ` に変わります。

### Ctrl+C の挙動

- バッファに入力中 → バッファをクリア
- 空バッファで1回目 → 「もう一度で終了」を表示
- 空バッファで2回目 → 終了

### メタコマンド（`:` プレフィックス）

`parseConsoleMetaCommand()` が `:profile`, `:format`, `:history`, `:save`, `:edit` 等のメタコマンドを解析します。`:edit` は `KSQL_EDITOR` / `VISUAL` / `EDITOR` 環境変数のエディタを起動してバッファを編集します。

### SQLの実行方式

コンソールモードでは各SQLを `buildReplExecArgvWithProfile()` で引数配列に変換し、`runWithArgvCapture()` 経由で `run()` を再帰呼び出しします。これにより通常の `-e` モードと完全に同じコードパスを通り、動作の一貫性が保たれます。

---

## コンソールのSQLヒストリー

- ファイルパス: `~/.ksql_history`
- 最大保持: 200件（`loadHistory(maxItems = 200)`）
- 実行のたびに `appendHistory()` で追記
- `:history` / `:history <n>` / `:history find <keyword>` で参照
- `:rerun <n>` でヒストリーから再実行

---

## ドライランモード

`--dry-run` 指定時:

1. `createDryRunClient()` が生成される。全メソッドが `DryRunError` をスローするスタブ
2. SQL に `EXPLAIN` プレフィックスを付加して `execute()` を呼び出す
3. API呼び出しが発生しないため、認証情報なしで実行計画だけ確認できる

---

## 診断モード: `--diag-record-id`

`--app <id> --diag-record-id <id>` で `/k/v1/record.json?app=&id=` を直接 GET し、レスポンスをそのまま stdout に出力します。SQL実行エンジンを経由しないため、接続・認証の疎通確認に使います。

---

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1 | 一般エラー（APIエラー等） / `--exit-on-empty` でrow=0 |
| 2 | 引数エラー（`ArgumentError:`） / DMLキャンセル |
| 3 | 認証エラー（`AuthError:`） |

`toExitCodeFromError()` がエラーメッセージのプレフィックスからコードを決定します。

---

## エントリポイント判定: `isDirectCliRun()`

[src/cli/index.ts:1916](../src/cli/index.ts#L1916)

```typescript
function isDirectCliRun(): boolean {
  const argv1 = process.argv[1] ?? "";
  return /dist-cli[\\/]+ksql\.js$/i.test(argv1)
    || /src[\\/]cli[\\/]index\.ts$/i.test(argv1);
}
```

`run()` はテストからも `import` して呼べるよう関数として公開されており、CLIとして直接起動された時だけ `run()` を実行します。これにより `runWithArgv()` による再帰呼び出しと、テストからのインポートが安全に共存します。
