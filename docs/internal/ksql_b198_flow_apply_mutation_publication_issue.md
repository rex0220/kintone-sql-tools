# B198 `/flow` の APPLY mutation の公開 — `allowApplyMutation` + `applyDetail`（確認を必須にする）

- 状態: ✅ **v3.88.0 でリリース（2026-10-28）**。公開面（型・約束・確認の詳細の写し）だけで、**実行経路は変えていない**。テスト `src/flow-library/__tests__/b198ApplyMutation.test.ts`（10 件）。B195 のテスト 1 件（型の穴の扱い）は本件の仕様へ差し替え
- 種別: 機能（公開 API の純加法追加）＋安全性（確認なしの不可逆な全置換を公開面から塞ぐ）
- 優先: **高**（kSQL アクションの「集計先のサブテーブルに書き戻す」のブロッカー。B200-2 の前提）
- 版: minor（v3.88.0 想定）。`allowApplyMutation` を渡さなければ今までどおり fail-closed
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261027-KJ5-サブテーブルの書き込み.md`（依頼 KJ-5。ファイル名は `ksql-action-engine-ask-subtable.md`）。回答は同じ場所の `kSQLエンジンからの回答-20261027-KJ5-サブテーブルの書き込み.md`
- 関連: [B195](ksql_b195_flow_dml_confirm_hook_issue.md)（確認フックの公開＝本件の土台）、[B200](ksql_b200_apply_append_values_issue.md)（`APPEND` の値。2 は本件に乗る）、[B199](ksql_b199_flow_subtable_import_publication_issue.md)（保留）

## 1. 何が足りないか

- 実行経路は完成している。`createExecutionContext` は型にないキーを `...executeOptions` でそのまま内部へ渡すので（`src/flow-library/index.ts:154-161`）、**`allowApplyMutation: true` は今でも実行経路まで届き、書き込みまで通る**。
- **そのとき確認は呼ばれない**（実測。work-link `ksql-action-kj5-apply-probe.mjs` の 2＝`status=success`・PUT 1 回・明細が置き換わる・`confirm` 0 回）。APPLY は不可逆（`irreversible: true`）で文がトランザクションでないため、**公開する以上は確認を必須にする**。
- `confirm` を渡すと `routeConfirm`（`src/flow-library/index.ts:342-364`）が `UnsupportedError: confirm does not cover APPLY or IMPORT detail` で止める（書込 0 回）。確認の詳細 `ApplyConfirmDetail`（`src/execute.ts:702-740`）は内部には揃っている。
- `execute.ts:829` の JSDoc が `dmlMaxSubtableRows` の既定を 100 と書いている（実際は `DEFAULT_APPLY_MAX_SUBTABLE_ROWS = 500`。`execute.ts:11449-11450`）。

## 2. 出すもの

1. `CreateExecutionContextOptions` に **`allowApplyMutation?: boolean`**（省略・`false` は今と同じ fail-closed）。
2. `FlowDmlConfirmContext` に **`applyDetail?: FlowApplyConfirmDetail`**（内部の `ApplyConfirmDetail` と同じ中身。`multiValues` は公開しない）。
3. **`allowApplyMutation: true` を `confirm` なしで渡したら `createExecutionContext` が `ArgumentError`**。
4. **多値 APPLY（値の集合を直す形）は `/flow` では引き続き `UnsupportedError`**。今のゲート（`execute.ts:2032`）は多値と UPSERT の分岐 APPLY も `allowApplyMutation` 1 つで見ているため、素直に公開すると多値まで開く。`statementHasMultiValueApply`（`src/core/applyPatchScope.ts:451`）を `/flow` の層で見て断る（`enableImport` のゲートと同じ形）。開けるのは**行の操作の APPLY**（`APPLY_PATCH` / `APPLY_INSERT` / `APPLY_UPSERT`）。
5. `routeConfirm` の `UnsupportedError` は **`applyDetail` を公開形で渡せる場合だけ**外す。`applyDiagnostic` は公開しない。**詳細の振り分けは 1 か所にまとめて書く**（B199 が後から来ても 1 か所の変更で済むように。KJ-6 の回答 §7）。
6. `dmlMaxRows` / `dmlMaxSubtableRows` の意味を README の `/flow` の節と言語リファレンス §27 に明記し、`execute.ts:829` の JSDoc を 500 に直す。

## 3. 受入基準

1. `allowApplyMutation: true` + `confirm` で `UPDATE … APPLY` が `/flow` で書ける。
2. `confirm` は**文に 1 回**・`count` は `plan.parentRows`・`applyDetail` が計画と一致（100 親ごとのチャンクでは増えない）。
3. 偽なら書込 0 回・`OperationCancelledError`。
4. 上限超過は最初の書込より前にエラー（prepare の中で全親を合計。`src/core/applyPatchPrepare.ts:112`）。
5. `allowApplyMutation` を渡さなければ今までどおり（`b195ConfirmHook.test.ts:131` はそのまま残す）。
6. 複数親でも 1〜4 が成り立つ（非トランザクションは `applyDetail.nonTransactional` で渡す）。
7. **親 0 件でも `count = 0`・空の `applyDetail` で確認が 1 回呼ばれ、書込 0 回で `success`**。
   → **2026-10-28 訂正**: KJ-5 の回答と当初の本書は「親 0 件では確認を呼ばない」と書いていたが、**誤り**。
   根拠にした実測（work-link `ksql-action-kj5-apply-probe.mjs` の 5）は `confirm` を渡していない回だったため、
   「confirm 0 回」は自明に成り立っていただけだった。実装時のテストで、複数親の経路は 0 件でも確認を呼ぶことを確認した
   （通常の UPDATE / DELETE と同じ＝依頼元の画面に特別な分岐は要らない）。`$id = <番号>` で親が無いときは `ArgumentError`（確認は呼ばれない）。
8. 多値 APPLY は `UnsupportedError`。UPSERT の分岐 APPLY は開く（確認は `applyBranches` 付きで 1 回）。

## 4. 規模と整合

- **規模 S〜M**（実績どおり）。型・`routeConfirm` の詳細の振り分け（`routeConfirmDetail` 1 か所に集約）・`ArgumentError` 1 本・多値 APPLY のゲート 1 本・文書・公開面テスト。実行経路は変えていない。
- 実装: `src/flow-library/publicTypes.ts`（`allowApplyMutation` / `FlowApplyConfirmDetail` / `FlowDmlConfirmContext.applyDetail`）、
  `src/flow-library/index.ts`（`createExecutionContext` の 2 本のゲート・`routeConfirmDetail`）、`src/execute.ts:829` の JSDoc 訂正、
  README の `/flow` の節に「APPLY の書込」、言語リファレンス §19.1 に `/flow` の行。
- `allowApplyMutation` は surface capability という位置づけ（`ksql_apply_block_impl_plan.md:202`）のまま。`/flow` も「確認を出せる面」として扱う整理。**MCP の fail-closed は変えない**。
- **純加法**。今エラーになる組み合わせが通るようになるのは「`allowApplyMutation` + `confirm`」だけで、これは公開の型に無かった組み合わせ。
