# cli-ksql のしくみ（内部構成）

`cli-ksql` は、SQL文字列を AST に変換し、kintone API 実行計画へ落として実行する構成です。  
実装上は `src/cli`（CLI層）と `src/execute.ts`（実行エンジン）を中心に動きます。

## 全体構成

```mermaid
flowchart LR
  U["User (CLI / REPL)"] --> C["src/cli/index.ts\n引数解析・設定読込・ガード"]
  C --> P["normalizeSqlAppProfiles()\nAPP@profile 正規化"]
  P --> E["execute(sql, client, options)\nsrc/execute.ts"]

  E --> L["Lexer\nsrc/lexer/lexer.ts"]
  L --> R["Parser\nsrc/parser/parser.ts"]
  R --> A["AST (Statement)\nsrc/types/ast.ts"]

  A --> M["Select mode 判定\nresolveSelectMode()"]
  M --> S["SIMPLE path\nselectToKintone / whereToKintone"]
  M --> F["FULL_SCAN path\nfetchAll + runFullScan"]

  S --> K["KintoneClient\n(get/post/put/delete/getApps/getFields)"]
  F --> K

  K --> N["src/cli/nodeKintoneClient.ts\n/k/v1 or /k/guest/<id>/v1 呼び出し"]
  N --> API["kintone REST API"]

  E --> O["formatDisplayText()\n表示整形"]
  O --> OUT["table / json / jsonl / csv / --output"]
```

## SELECT 実行フロー

```mermaid
flowchart TD
  Q["SQL 入力"] --> X["parseSql()"]
  X --> Y{"FROM 省略?"}
  Y -- "yes" --> Z["executeNoFromSelect()\n例: SELECT 'ABC' as a;"]
  Y -- "no" --> W["resolveSelectMode()"]

  W --> T{"mode"}
  T -- "SIMPLE" --> S1["executeSimpleSelect()\n可能なら kintone クエリへ変換"]
  T -- "FULL_SCAN" --> F1["executeFullScanSelect()\n全件取得して JS 評価"]

  S1 --> G1["client.getRecords() / fetchAll()"]
  F1 --> G2["fetchAll() -> runFullScan()"]

  G1 --> R1["project/order/limit"]
  G2 --> R1
  Z --> R1
  R1 --> RES["SelectResult rows/columns"]
```

## モジュールごとの役割

- `src/cli/index.ts`
  - `parseArgs()` で引数を解析
  - config/profile を解決
  - `normalizeSqlAppProfiles()` で `APP@profile` を正規化
  - DML ガード（`--allow-dml`, `--allow-without-where`, `--dml-max-rows`）
- `src/execute.ts`
  - `execute()` が文種別ごとに処理をルーティング
  - `SELECT/UNION/WITH/INSERT/UPDATE/DELETE/UPSERT/REORDER/SHOW APPS/DESCRIBE/EXPLAIN` を処理
- `src/converter/*`
  - SQL AST を kintone API パラメータへ変換
- `src/engine/*`
  - FULL_SCAN 時の式評価、WHERE 評価、JOIN/GROUP BY/HAVING/ORDER BY 処理
- `src/api/fetchAll.ts`
  - ページングしながら全件取得
- `src/cli/nodeKintoneClient.ts`
  - Node.js から kintone REST API を呼び出す薄いクライアント

## `APP@profile` の流れ

1. CLI で SQL 中の `APP4148@dev` などを検出  
2. `@profile` を外した正規化SQLを実行エンジンへ渡す  
3. 実行時の app->profile 束縛を保持し、対応する接続先 client に振り分ける  
4. 同一SQL内で同一APPに複数profileが混在しても、内部仮想 appId で衝突回避

## まとめ

- CLI は「入力と実行環境の解決」
- execute は「SQLの意味解釈と実行制御」
- converter/engine は「kintone API に寄せる層」と「JSで補完する層」

という分担です。  
この分離によって、プラグインUIとCLIが同じコアロジックを共有できます。
