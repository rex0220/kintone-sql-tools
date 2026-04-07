# Docs Index

現在の公開仕様は Ver.1 です。

このディレクトリは次の方針で管理します。

1. 現行仕様は `docs/` 直下に置く
2. 一般公開向けでない仕様案・最適化案は `docs/proposals/` に置く
3. 実装手順は `docs/implementation/` に置く
4. チェックリストは `docs/checklists/` に置く
5. 補助資料・検討メモは `docs/others/` に置く
6. 過去フェーズの記録・リリース履歴は `docs/archive/` に置く
7. 新規ドキュメントは原則「現行で使うか」を先に判定して配置する

## 現行ドキュメント（主要）

- `kintone_sql_plugin_spec.md`
- `ksql_language_reference.md`
- `ksql_cli_console_spec.md`
- `implementation/cli_dml_phase1_spec.md`
- `proposals/select_update_shared_optimization_spec.md`

## 実装手順（implementation）

- `implementation/cli_implementation_steps.md`
- `implementation/public_release_procedure.md`
- `implementation/public_license_guide.md`

## チェックリスト（checklists）

- `checklists/cli_dml_phase1_acceptance_checklist.md`
- `checklists/cli_operation_start_checklist.md`
- `checklists/cli_test_acceptance_criteria.md`
- `checklists/cli_live_e2e_checklist.md`

## アーカイブ

- `archive/cli_mvp_completion_criteria.md`
- `archive/release_notes_v0.1.0.md`
- `archive/ksql_v2_features.md`
- `archive/ksql_v3_features.md`
- `archive/ksql_v4_features.md`
- `archive/ksql_v5_features.md`
- `archive/ksql_v6_features.md`
- `archive/APP_4141_KSQL-20260404-1808.md`
- `archive/APP_4141_KSQL-20260404-2142.md`

## 仕様案（proposals）

- `proposals/complex_field_dml_spec.md`
- `proposals/explain_spec.md`
- `proposals/fullscan_required_fields_optimization_plan.md`
- `proposals/option_popup_tab_spec.md`
- `proposals/record_fetch_parallel_spec.md`
- `proposals/record_list_app_filter_spec.md`
- `proposals/scalar_subquery_spec.md`
- `proposals/sqlid_auto_numbering_spec.md`
- `proposals/subtable_virtual_table_spec.md`
- `proposals/table_rowcount_popup_spec.md`
- `proposals/update_set_scalar_subquery_spec.md`

## 補助資料（others）

- `others/cli_live_e2e_checklist.md`
- `others/development_folder_structure.md`
- `others/ksql_mechanism_overview.md`
- `others/subtable_virtual_table_implementation_guide.md`

## 運用ルール

1. 仕様変更時は「現行ドキュメント」を優先更新する
2. 履歴資料は内容を書き換えず、必要なら注記を追記する
3. 参照リンクを追加する場合は `docs/README.md` にも追記する
