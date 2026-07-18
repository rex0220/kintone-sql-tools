# B39 v1 IMPORT — CLI CSV ソースバインド仕様

- 作成日: 2026-07-18
- ステータス: **仕様 R2・codex レビュー前**（R1 の codex レビュー「要 R2」を反映＝①単文実行モデル②`analyzeBatch` の external seed 表現③bound table の完全 read-only④CSV 列は明示 string 型。アーキテクチャ＝CSV を一時テーブル相当へバインドして既存 DML 再利用は維持）
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 評価: [ksql_import_export_evaluation.md](ksql_import_export_evaluation.md)
- 関連: [B12 ON ERROR SKIP](ksql_validate_only_implementation_plan.md)・[B37 カスタムチェック](ksql_custom_check_spec.md)・[B14 型メタ伝播](ksql_temp_column_type_meta_spec.md)・[B24 Shift_JIS レシピ](../ksql_batch_recipes.md)

## 1. 目的・スコープ

ローカル CSV を kSQL の**一時テーブル相当ソース**として供給し、既存 DML（`INSERT/UPSERT … SELECT`・`UPDATE … FROM`・`ON ERROR SKIP`・B37 `CHECK`）で**検証・UPSERT・変換・不良行隔離付きの取込**を可能にする。**v1 は CLI 限定**。SQL に新しいファイル構文は追加しない（面非依存を維持）。

**v1 対象外（v2 以降）**: MCP（inline）・プラグイン（upload）・JSON ソース・複合型（サブテーブル/添付/ユーザー選択）・型推論・EXPORT の SQL 構文化・cwd を超えた path ガード。

## 2. CLI インターフェース

```
ksql --bind-csv <name>=<path> [--bind-csv <name2>=<path2> ...]
     [--csv-encoding <utf8|sjis>] [--csv-no-header]
     -e "<SQL>"  |  -f <file.sql>
```

- **`--bind-csv <name>=<path>`（繰り返し可）**: `<path>` の CSV を読み、**一時テーブル `#<name>` として登録**（SQL からは `FROM #<name>`）。`<name>` は `#` なしで指定（`sales` → `#sales`）。同名重複・不正名・パス不存在は起動時エラー。
- **`--csv-encoding <utf8|sjis>`**: 既定 `utf8`。全 `--bind-csv` 共通（v1）。
- **`--csv-no-header`**: ヘッダ行なし。列名 `c1, c2, …`。

例（数値比較は CAST・§4.4）:
```
ksql --bind-csv sales=./sales.csv --csv-encoding sjis -e "
  UPSERT INTO APP123 (顧客コード, 金額)
  SELECT 顧客コード, CAST(金額 AS NUMBER) FROM #sales
  ON DUPLICATE (顧客コード)
  CHECK WHEN CAST(金額 AS NUMBER) < 0 THEN CONCAT('金額が負: ', 金額)
  ON ERROR SKIP INTO #err;
  SELECT * FROM #err"
```

ローカル完結の SELECT も可（APP 不要）:
```
ksql --bind-csv src=./src.csv -e "SELECT COUNT(*) AS n FROM #src WHERE 区分 = 'A'"
```

## 3. CSV パース・エンコーディング・型（R2: 明示 string 型）

- **デコード**: `TextDecoder('shift_jis' | 'utf-8')`（Node 標準＝ICU 前提・追加依存なし）。先頭 BOM 除去。実行環境で `shift_jis` が使えない場合は起動時に明示エラー（環境契約を弱いままにしない）。
- **パース**: RFC 4180 準拠の**新規実装**（引用符囲み・`""` エスケープ・セル内の改行/カンマ・`CRLF`/`LF` 混在・末尾空行無視）。空 CSV（0 行）は列だけの空テーブル、ヘッダのみ CSV は 0 行。
- **列名**: ヘッダ行（`--csv-no-header` 時は `c1..cn`）。重複列名は起動時エラー。列名の大文字小文字は保持し、参照は kSQL の既存フィールド参照規則に従う。
- **型（明示 string）**: 全列を **`columnMeta` に明示的な文字列型（`SINGLE_LINE_TEXT` 相当）** を付けて供給する（メタなしのまま渡さない＝暗黙の型推論をしない契約を明確化）。値はすべて文字列（空セルは空文字）。**数値・日付比較や書込みは `CAST`/関数で明示**（`CAST(金額 AS NUMBER)`）、または書込み先フィールド型に委ねる（DML 検証＝型/範囲/桁/B29 が効く）。
- **行数上限**: `tempTableMaxRows`（既定 10000・`--temp-table-max-rows`）を**CSV パース段で適用**（map seed だけでは効かないため、行数超過はパース時エラー）。

## 4. バインドの注入（実装契約）

### 4.1 公開入力型

`MaterializedTable`（[execute.ts:251](../../src/execute.ts)）は非公開のため、CLI が構築できる**公開入力型**（`BoundTable { columns: string[]; rows: string[][]; }` 等）を定義し、内部で `MaterializedTable`（全列 string の `columnMeta` 付き）へ変換する。

### 4.2 単文・バッチ両対応の実行モデル（重大#1）

- 現状、temp map を注入するのは `executeBatchStatement`（[execute.ts:1031](../../src/execute.ts)）だけで、単文 `execute()`（[execute.ts:396](../../src/execute.ts)）は temp map を渡さない。CLI は文数≥2 のみ batch 判定（[cli/index.ts:1603](../../src/cli/index.ts)）。
- **R2 方針**：`execute()`（および単文ルーティング [execute.ts:617](../../src/execute.ts)）が **bound table を options で受け取り**、SELECT/INSERT_SELECT/UPSERT_SELECT/UPDATE FROM の temp-aware 関数（[execute.ts:4446](../../src/execute.ts)/[5282](../../src/execute.ts)/[4514](../../src/execute.ts)）へ**bound を seed した temp map を渡す**。これで単文 `SELECT FROM #csv` も成立し、既存の単文出力契約を維持する。
- **bind-only SELECT（APP なし）を許可**：CLI が「APP なし」で拒否する箇所（[cli/index.ts:1713](../../src/cli/index.ts)）を、bind 参照のみの SELECT では通す（ローカル SELECT を許可）。

### 4.3 `analyzeBatch` の external seed 表現（重大#2）

- `analyzeBatch`（[core/batch.ts:169](../../src/core/batch.ts)）に**明示引数 `analyzeBatch(statements, { boundTableNames })`** を追加。`defined`（現 `Map<name, 作成文index>`・[batch.ts:204](../../src/core/batch.ts)）は **`Map<name, number | null>`**（bound=null）へ、または SQL-created と externally-bound を別集合で管理。
- **bound 参照は存在確認のみ**で、参照時に `dependsOn` へ index を足さない（[batch.ts:275](../../src/core/batch.ts) の分岐で bound は skip）。→ 架空依存を漏らさない。
- **解析3経路すべてに同じ bound names を渡す**：CLI 事前解析（[cli/index.ts:1610](../../src/cli/index.ts)）・`executeBatch`（[execute.ts:770](../../src/execute.ts)）・batch dry-run/EXPLAIN（[execute.ts:5731](../../src/execute.ts)）。
- **`MAX_TEMP_TABLES=16` に bound を算入**（実行ストア総数の上限として妥当）。

### 4.4 完全 read-only（重大#3）

bound 名 `#<name>` への次を、**通常の重複/schema 判定より先に**、専用 read-only エラーで拒否する：

- `CREATE TEMP TABLE #<name>`（[batch.ts:312](../../src/core/batch.ts)）
- `DROP TEMP TABLE #<name>`（現状は defined なら許可・削除 [batch.ts:330](../../src/core/batch.ts)/[execute.ts:1014](../../src/execute.ts)）
- `ON ERROR SKIP INTO #<name>` / `VALIDATE ONLY INTO #<name>`（既存表追記分岐 [batch.ts:287](../../src/core/batch.ts)/[execute.ts:3842](../../src/execute.ts)）

## 5. 既存機構の再利用

`#<name>` は一時テーブルと同格（全列 string メタ）で、`SELECT`/`INSERT・UPSERT … SELECT`/`UPDATE … FROM`/`ON ERROR SKIP`/`VALIDATE ONLY`/B37 `CHECK` が**そのまま効く**。**比較・書込みで数値/日付が要る列は `CAST` する**（§3・§4.4）。

## 6. セキュリティ・面

- v1 は CLI の cwd 基準の相対/絶対パスを許容。将来 `--allow-path` は v2。
- プラグイン/MCP には `--bind-csv` が無く、未束縛 `#<name>` 参照は従来の「temp table is not available」（[execute.ts:4272](../../src/execute.ts)）＝面依存の明示的制限。エラー文言は経路（解析/実行）で異なり得るため、v1 は「未束縛＝未作成扱い」で統一的に説明。

## 7. 受入条件（テスト化）

- **単文/バッチ**: 単文 `SELECT … FROM #csv`（APP なし・ローカル完結）／バッチ `INSERT/UPSERT … SELECT FROM #csv`／`UPDATE … FROM #csv`。
- **型（明示 string・重大#4）**: `#csv` の列は文字列。`WHERE 金額 < '5'` は文字列比較（`"10" < "5"` が真）・**`WHERE CAST(金額 AS NUMBER) < 5` は数値比較**。`"10"/"2"/"-1"` を含む固定テストで暗黙数値推論が無いことを固定。B37 `CHECK` も同様（数値は CAST）。
- **read-only（重大#3）**: `CREATE TEMP TABLE #csv`・`DROP TEMP TABLE #csv`・`ON ERROR SKIP INTO #csv`・`VALIDATE ONLY INTO #csv` が専用 read-only エラー。
- **analyzeBatch（重大#2）**: bound 参照が `dependsOn` を汚さない（EXPLAIN/依存に架空 index が出ない）・3経路（CLI/executeBatch/dry-run）で一致・bound を含めて `MAX_TEMP_TABLES` 超過でエラー。
- **エンコーディング**: `sjis`（日本語）・`utf8`（既定）・BOM 除去・`shift_jis` 非対応環境で起動時エラー。
- **CSV パース**: 引用符・`""`・セル内改行/カンマ・CRLF/LF・空 CSV・ヘッダのみ・末尾空行・列名重複エラー・`--csv-no-header`（`c1..`）。
- **行数上限**: `tempTableMaxRows` 超過でパース時エラー。
- **取込×処分**: 型エラー行が `ON ERROR SKIP` で `#err`・`REJECT LIMIT`・B37 `CHECK` 発火（CAST 併用）。
- **面**: プラグイン/MCP で未束縛 `#<name>` 参照は従来の未作成エラー（回帰なし）。
- 非回帰: `--bind-csv` 無しの既存 CLI・単文・バッチ挙動不変。

## 8. SemVer・文書

- **minor**（CLI フラグ追加・SQL 構文追加なし・既存挙動不変）。
- CLI help・言語リファレンス（`#<name>` バインドの CLI 節・数値は CAST）・レシピ集（CSV 取込レシピ）・CHANGELOG・台帳 B39 を同期。
