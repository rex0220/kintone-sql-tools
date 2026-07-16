# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-16
- 現在の最新リリース: **v2.11.0**（npm publish 済み・latest）
- 目的: 課題・改善案・Issue の**進捗 / 効果 / リリースバージョン**を1か所で俯瞰する。個別の詳細は各文書へリンク。

## 運用ルール

- **本書は一覧（インデックス）**。仕様・診断・受入条件などの本文は各文書に置く。
- 各文書の先頭 `- ステータス:` 行が正（single source of truth）。本書はそれを集約する。
- 状態が変わったら **本書・各文書のステータス行・`CHANGELOG.md`・auto-memory** を揃えて更新する。
- リリース時は「§2 リリース済み履歴」に版数・効果を1行追記し、「§1 バックログ」から該当行を落とす。

## 凡例（状態区分）

| 記号 | 意味 |
|---|---|
| ✅ | リリース済み |
| 🚧 | 実装済み・リリース/実機確認待ち |
| 📋 | 仕様確定・実装待ち |
| 📝 | ドラフト / 評価 / 提案（仕様前 or 判断待ち） |
| ⏸ | 保留（対象外化の判断済み） |
| 🐞 | 残課題（未着手のバグ） |

効果の種別: **正しさ**（結果の整合・バグ修正） / **性能**（API 消費・速度） / **機能**（新機能） / **安全性**（誤操作・データ破損防止）

---

## 1. バックログ（未リリース・要対応）

進捗が動くのはここ。優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」で暫定。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B3 | バッチ変数 Phase 1a R4：配列展開 `IN (@list)` | 改善 | 📋 仕様追記済・実装は codex レビュー後 | 機能 | 中 | [spec](internal/ksql_batch_variables_phase1a_spec.md) |
| B4 | 保存クエリのパラメータ化 `:name` | 改善 | 📝 評価確定・実装計画待ち | 機能 | 中 | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
| B5 | KLIKE 親レコード DML 解禁 | 改善 | 📝 改善案（検索打ち切り検出が前提・v2.10.0 で整備済） | 機能 | 中 | [v1 spec](internal/ksql_klike_native_search_spec.md) |
| B6 | KLIKE 外部結合 非 nullable 側の押し下げ解禁 | 改善 | 📝 改善案 | 性能 | 低 | [v2 spec](internal/ksql_klike_pushdown_v2_spec.md) |
| B7 | プラグインでの検索打ち切り検出（raw fetch 経路） | 改善 | 📝 改善案（プラグインは header 不可） | 安全性 | 低 | [issue](internal/ksql_search_abort_warning_issue.md) |
| B9 | 厳密 10 進比較（案B・`<=`/`>=` 押し下げ） | 改善 | ⏸ 保留（16 桁クラスは当面対象外） | 正しさ | 低 | [issue](internal/ksql_exact_decimal_compare_issue.md) |
| B10 | バッチ変数 後続：`NULL` 代入 / SELECT 列での `@var` 参照 | 改善 | 📝 提案（後続フェーズ） | 機能 | 低 | [1a spec](internal/ksql_batch_variables_phase1a_spec.md) |

---

## 2. リリース済み履歴（版数・効果）

新しい順。各機能の詳細は `CHANGELOG.md` と各文書を参照。

| バージョン | 内容 | 効果 | 文書 |
|---|---|---|---|
| **v2.11.0** | B1 CLI DML×`truncate` 暗黙部分書き込み防止（`error` 固定）／B2 空 `SELECT *` の列スキーマをパイプライン伝播（0 行 no-op 完走）／B8 `LIMIT>500` の安全な取得打ち切り（`ORDER BY` なし・KLIKE なし限定）＋`maxRecords` 意味論変更 | 安全性・正しさ・性能 | [B1](internal/ksql_cli_dml_on_limit_truncate_issue.md) / [B2](internal/ksql_empty_select_wildcard_pipeline_spec.md) / [B8](internal/ksql_limit_over_500_fetch_truncation_spec.md) |
| **v2.10.1** | SIMPLE SELECT の `LIMIT` > 500 が API エラーになる不具合を修正（案A ＝ `fetchAll` でページング） | 正しさ | [issue](internal/ksql_simple_select_limit_over_500_issue.md) |
| **v2.10.0** | 検索打ち切り（10 万件）検出＋`FROM` なし SELECT の実体化バグ修正。SELECT は警告 / DML・一時テーブル実体化は fail-closed | 正しさ・安全性 | [abort](internal/ksql_search_abort_warning_issue.md) / [fromless](internal/ksql_fromless_select_materialize_bug.md) |
| **v2.9.0** | KLIKE プレフィルタ押し下げ（v2）。FULL_SCAN でも KLIKE を安全 AND リーフとして kintone 押下・INNER JOIN 限定 | 性能 | [spec](internal/ksql_klike_pushdown_v2_spec.md) |
| **v2.8.0** | KLIKE / NOT_KLIKE（kintone ネイティブ `like` 素通し）。大規模キーワード検索の高速化 | 性能・機能 | [spec](internal/ksql_klike_native_search_spec.md) |
| **v2.7.0** | STATUS（ワークフロー状態）の IN 押し下げ（`status.json` 検証・型ベース判定） | 性能 | [spec](internal/ksql_status_in_pushdown_spec.md) |
| **v2.6.0** | 選択系 IN 押し下げ（4 型・optionOrder 実在検証）＋ `IN ('')` 空セル評価修正（案B） | 性能・正しさ | [pushdown](internal/ksql_selection_in_pushdown_spec.md) / [empty-in](internal/ksql_selection_empty_in_eval_issue.md) |
| **v2.5.0** | 型メタ付き `IN`/`NOT IN` 評価（複数値・ユーザーコード） | 正しさ | [spec](internal/ksql_fullscan_in_typed_eval_spec.md) |
| **v2.4.0** | バッチ変数 Phase 1c：`DECLARE @x = 既定値` 外部パラメータ注入（MCP/CLI） | 機能 | [spec](ksql_batch_variables_phase1c_spec.md) |
| **v2.3.0** | バッチ変数 Phase 1b：`SET @x=(SELECT ...)` スカラーサブクエリ代入 | 機能 | [spec](ksql_batch_variables_phase1b_spec.md) |
| **v2.2.0** | 述語押し下げの安全化と数値対応（案A ＝ `=`・strict `<`/`>`）＋空セル数値 −∞ 準拠 | 性能・正しさ | [numeric](internal/ksql_numeric_predicate_pushdown_spec.md) / [empty-num](internal/ksql_evalwhere_empty_cell_numeric_issue.md) |
| **v2.1.2** | 集計算術式（`SUM(a)-SUM(b) AS diff`）の alias 消失を修正 | 正しさ | [issue](internal/ksql_agg_arith_alias_dropped_issue.md) / [fix](internal/ksql_agg_arith_alias_dropped_fix_spec.md) |
| **v2.1.1** | 0 行 SELECT（明示列）の出力列欠落を修正。差分 0 件の空ソース INSERT/UPSERT が no-op 完走 | 正しさ | [issue](internal/ksql_empty_select_columns_issue.md) |
| **v2.1.0** | バッチ変数 Phase 1a：`SET @var`（スカラー式・時刻固定・DRY） | 機能 | [spec](internal/ksql_batch_variables_phase1a_spec.md) |
| **v2.0.0** | 全 `LIKE` を JS 評価へ統一・kintone 押し下げ全廃（`isLike` 統一・親 DML fail-closed） | 正しさ・安全性 | [spec](internal/ksql_like_js_default_optin_pushdown_spec.md) |
| **v1.14.0** | WHERE 右辺フィールド比較 / LIKE モード不一致の 2 バグ修正 | 正しさ | [issue](internal/ksql_where_rhs_field_and_like_mode_divergence_issue.md) / [fix](internal/ksql_where_rhs_field_and_like_fix_spec.md) |
| **v1.13.0–.2** | 論理アプリ参照 `LAPP_<NAME>`（CLI/MCP・プラグイン非対応）。.1 CLI エラー復元・.2 単文 dry-run 露出修正 | 機能 | [spec](internal/ksql_logical_app_id_mapping_spec.md) / [plan](internal/ksql_logical_app_id_mapping_impl_plan.md) |
| **v1.12.1** | `extractAppIds` がコメント/文字列内 `APPxxxx` を誤ってトークン要求する不具合を修正 | 正しさ | [issue](internal/ksql_extract_app_ids_comment_string_issue.md) |
| **v1.12.0** | `GROUP BY` なし集計は 0 件でも 1 行返却（SQL 標準準拠） | 正しさ | [plan](internal/ksql_ungrouped_aggregate_empty_result_implementation_plan.md) / [spec](internal/ksql_ungrouped_aggregate_empty_result_spec.md) |
| **v1.11.0** | 一時テーブル実体化行数上限 `tempTableMaxRows` を可変化（env / profile / プラグイン UI） | 機能 | [spec](internal/ksql_temp_table_max_rows_option_spec.md) / [plan](internal/ksql_temp_table_max_rows_option_implementation_plan.md) |
| **v1.10.0** | バッチ拡張 第1弾（`ASSERT` / CLI バッチ JSON 出力 / `requestGate` 設定公開） | 機能 | [spec](ksql_batch_enhancement_phase1_spec.md) / [proposals](ksql_batch_enhancement_proposals.md) |
| ～v1.9.0 | 初期リリース群（順次バッチ＋一時テーブル v1.4.0 / プラグイン DML バッチ v1.9.0 / MCP INSERT・UPSERT … SELECT / `dmlMaxRows` ソース読み取り v1.8.0 ほか） | 機能 | [temp-table](ksql_batch_temp_table_spec.md) / [plugin-dml](internal/ksql_plugin_dml_batch_spec.md) / [dml-read-limit](internal/ksql_mcp_dml_source_read_limit_issue.md) |

---

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| 厳密 10 進比較（案B・`<=`/`>=` 押し下げ） | ⏸ 保留 | ユーザー判断で 16 桁クラス数値アプリは当面対象外。案A の `Number.isSafeInteger` ゲートで 16 桁超は押し下げないため実害は低 | [issue](internal/ksql_exact_decimal_compare_issue.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](ksql_batch_temp_table_spec.md) |

---

## 関連文書

- リリース履歴の一次情報: [`CHANGELOG.md`](../CHANGELOG.md)
- 言語仕様: [`ksql_language_reference.md`](ksql_language_reference.md)
- バッチ実務レシピ: [`ksql_batch_recipes.md`](ksql_batch_recipes.md)
- リリース手順: auto-memory `release-procedure.md`
