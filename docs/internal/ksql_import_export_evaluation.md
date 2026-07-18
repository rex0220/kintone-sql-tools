# B39 IMPORT / EXPORT 機能の評価と v1 仕様スケッチ

- 作成日: 2026-07-18
- ステータス: **評価 R1・提案（着手は実需確認後）**
- 分担: Claude=評価/仕様・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 関連: [B12 VALIDATE ONLY / ON ERROR SKIP](ksql_validate_only_implementation_plan.md)・[B37 カスタムチェック](ksql_custom_check_spec.md)・[B24 Shift_JIS 変換レシピ](../ksql_batch_recipes.md)・[RDB 比較評価](ksql_sql_feature_comparison_evaluation.md)

## 1. 現状のカバー範囲

| 操作 | 現状 |
|---|---|
| **EXPORT（クエリ→ファイル）** | **CLI 実装済み**：`SELECT … --format csv --output file.csv`（json/jsonl/markdown も・`--output <path>`）。プラグインは結果表示のみ、MCP はデータ返却。 |
| **アプリ間コピー** | `INSERT/UPSERT … SELECT`・`UPDATE … FROM #temp/APP` で実装済み（kSQL 内で完結）。 |
| **IMPORT（ローカルファイル→kintone）** | **全面的に無し**。ローカル CSV/JSON を kSQL のデータソースにできない。 |
| **kintone 純正** | kintone UI にレコードの CSV 一括入出力が標準搭載（列マッピング＋基本検証止まり）。 |

→ **EXPORT は CLI で概ね充足**。真の隙間は **IMPORT（外部ファイル/データを kSQL のソースにする）**。

## 2. IMPORT の価値（kintone 純正 CSV 取込との差分）

純正取込にない **SQL の力**：

- 業務キー **UPSERT**（`ON DUPLICATE (顧客コード)`）・**変換**（SELECT 式・関数・`||`/`CONCAT`）・**既存データと JOIN**。
- **Tier-0 検証＋不良行隔離**（`ON ERROR SKIP INTO #err REJECT LIMIT n`）。
- **B37 カスタムチェック**（`CHECK WHEN … THEN …` で業務ルール検証しながら取込）。

→ **「CSV を読み込み、業務ルールで検証し、不良行を `#err` に隔離して、業務キーで UPSERT する」**は純正取込にできない。**B12/B37 と相性が抜群**で最大の売り。

## 3. 最大の障害：面ごとの非対称

ファイル入出力は面で手段が違う。**「同じ SQL が 4 面で動く」原則**を壊さないため、**SQL に `IMPORT '…csv'`（ファイルパス）を入れない**。

| 面 | IMPORT 手段 | EXPORT 手段 |
|---|---|---|
| CLI | ファイルパス（`--bind-csv`） | `--output`（実装済み） |
| MCP | インライン data 引数 | 返却 |
| プラグイン | ブラウザのファイル選択 `<input type=file>` | ダウンロード（現状どちらも未実装） |

## 4. 推奨設計：外部ソースのバインド方式

SQL にファイルキーワードを足さず、**名前付き外部ソースを面ごとに供給**し、SQL は一時テーブルのように参照する。**既存 DML 機構（`INSERT…SELECT`/`UPSERT`/`ON ERROR SKIP`/`CHECK`）を再利用**し、SQL 自体は面非依存に保つ。

- CLI：`--bind-csv <name>=<path>` でファイルを読み、`<name>` を一時テーブル相当のソースにする。
- MCP：ツール入力でインライン rows/CSV を `<name>` に供給。
- プラグイン：アップロードダイアログで選んだファイルを `<name>` に供給。
- EXPORT は各面が結果を面相応に出す（CLI=ファイル・MCP=返却・プラグイン=ダウンロード）＝**新 SQL 構文は不要**、既存 SELECT のまま。

## 5. v1 仕様スケッチ（CLI 先行）

```
ksql --bind-csv sales=./sales.csv [--csv-encoding sjis|utf8] [--csv-no-header] -e "
  UPSERT INTO APP123 (顧客コード, 金額)
  SELECT 顧客コード, CAST(金額 AS NUMBER) FROM sales
  ON DUPLICATE (顧客コード)
  CHECK WHEN 金額 < 0 THEN '金額が負'
  ON ERROR SKIP INTO #err;
  SELECT * FROM #err"
```

- **`--bind-csv name=path`（複数可）**：CSV を読み、`name` を **read-only の一時テーブル相当ソース**として登録。SQL からは通常の `FROM name` で参照。
- **列と型**：v1 は**ヘッダ行を列名**にし、値は**文字列**として供給（型は SELECT 側で `CAST`/関数で確定、または書込み先フィールド型に委ねる＝既存 DML 検証が効く）。`--csv-no-header` 時は `c1,c2,…`。
- **エンコーディング**：`--csv-encoding`（既定 utf8・kintone 由来は `sjis`）。
- **行数上限**：既存 `tempTableMaxRows`（既定 10000）を流用。超過はエラー。
- **セキュリティ**：CLI の作業ディレクトリ基準の相対/絶対パスを許容（v1）。将来 `--allow-path` 等のガードは要検討。
- **v1 非対応**：サブテーブル・添付ファイル・ユーザー選択などの複合型（CSV で表現困難）、JSON ソース、MCP/プラグイン供給、EXPORT の SQL 構文化。
- **既存機構の再利用**：`INSERT/UPSERT … SELECT`・`ON ERROR SKIP`・`REJECT LIMIT`・`CHECK`（B37）・`UPDATE … FROM name` が**そのまま効く**（バインドソースは一時テーブルと同格）。

## 6. 実装の難所

- 文字コード（Shift_JIS が主流・BOM・改行コード）。
- CSV パース（引用符・エスケープ・改行入りセル）。
- 型・ヘッダ・列マッピング（v1 は文字列供給＋`CAST`/フィールド型委譲で回避）。
- 複合型の非対応明記。
- セキュリティ（ローカルファイル読取の path 範囲）。
- 面ごとの配管（CLI=fs・MCP=inline・プラグイン=upload/download）＝それなりの工数。

## 7. 実需確認（2026-07-18・ユーザー回答）

1. **面の役割**：CLI=**バッチ処理**／プラグイン=**暫定（ad-hoc）処理**／MCP=**生成 AI がらみ**。→ **CSV 一括取込は本質的にバッチ＝CLI の役割と完全一致**。CLI 先行 v1 は使われ方に合致。プラグイン取込は「暫定」＝優先低、MCP inline は「AI が扱うデータ供給」として v2 で意味を持つ。
2. **ローカル CSV 取込の実需**：**不明**（v3.4.0 リリース直後で実績少）。ただし **npm ダウンロード ~4,500** で利用者基盤は存在。→ 実需は未検証だが下地はある。
3. **欲しい機能**：**検証・UPSERT・変換・不良行隔離すべて**。→ **既存 `INSERT/UPSERT…SELECT`＋`ON ERROR SKIP`＋B37 `CHECK` の再利用で 4 つとも即提供**できる（ソースバインド方式の最大の後押し）。
4. **エンコーディング**：**Shift_JIS と UTF-8 の両方**。→ Node/ブラウザとも `TextDecoder('shift_jis')` が標準対応（**追加依存なしで両対応可能**）。

### 判断への含意
- **アーキ適合が強い**：バッチ=CLI の役割に CSV 取込が一致。
- **実装レバレッジが高い**：欲しい 4 機能が既存 DML の再利用で無料。新規部分は「CSV パース＋エンコーディング decode＋一時テーブル相当へのバインド＋CLI フラグ」に限定＝**中規模・低リスク**（SJIS も依存なし）。
- **弱点は実需未検証**：純正 CSV 取込で足りている可能性。ただし低コストなら試す価値。

## 8. 総合評価・提言

| 項目 | 評価 |
|---|---|
| **EXPORT（SQL 構文として）** | **非推奨**。CLI `--format --output` で充足・面非対称で SQL 化の価値薄。プラグインの download は UI 改善として別途小さく検討可。 |
| **IMPORT（ソースバインド方式・CLI 先行）** | **条件付き推奨・優先中**。純正取込にない「検証・UPSERT・変換・不良行隔離・B37 チェック付きの賢い取込」。B37/B12 との相乗効果が大きい。面ごと配管の工数と、CLI 先行がプラグイン層に届かない点が留意。 |

**提言（§7 の実需回答を反映）**：EXPORT は新規機能化しない。**IMPORT は「CLI `--bind-csv` によるソースバインド」の最小 v1** が、①バッチ=CLI の役割適合②欲しい 4 機能を既存 DML 再利用で無料提供③SJIS/UTF-8 とも依存なし、で**低コスト・低リスク・高レバレッジの賭け**。唯一の弱点は実需未検証。

→ **選択肢**：
- **(A) 最小 v1 を作る**：`--bind-csv name=path`＋`--csv-encoding sjis|utf8`＋ヘッダ列名・値は文字列供給。既存 `INSERT/UPSERT…SELECT`/`ON ERROR SKIP`/`CHECK`/`UPDATE…FROM` を全再利用。複合型/添付/JSON/MCP/プラグインは v2。低コストで出して実績で需要を測る。
- **(B) 待つ**：実需の具体シグナル（要望・問い合わせ）が出るまで評価のまま保留。

低コスト・高適合のため **(A) 寄り**を推奨。MCP（inline）・プラグイン（upload/download）は実績を見て v2。
