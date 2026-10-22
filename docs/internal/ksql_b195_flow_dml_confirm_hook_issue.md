# B195 `/flow` の書込前の確認フック `confirm` の公開 — 期限・dispose と競わせ、書込 API の直前に確かめ直す

- 状態: ✅ **v3.86.0 でリリース（2026-10-22）**。Claude が直接実装（codex 未介在）。実装の commit は 23f94b8（作業ブランチ `b195/dev` から main へ）。公開型 `FlowDmlConfirm` / `FlowDmlConfirmContext` と `CreateExecutionContextOptions.confirm`、管理層の書込ゲートと確認の待ちの打ち切り。テスト `src/flow-library/__tests__/b195ConfirmHook.test.ts`（18 件）
- 種別: 機能（公開 API の純加法追加）＋安全性（期限切れ・dispose のあとに切り離された実行が書かない）
- 優先: **高**（kSQL ジョブ実行プラグインの「書き込みの前に確認する」と spike の関門 6 のブロッカー）
- 版: minor（v3.86.0 想定）。`confirm` を渡さなければ既定動作は変わらない（§5 の書込ゲートだけは常に効く）
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261022-KJ1-flow確認フック.md`（依頼 KJ-1）。回答は同じ場所の `kSQLエンジンからの回答-20261022-KJ1-flow確認フック.md`
- 関連: [B172](ksql_b172_flow_max_records_issue.md)（`/flow` の公開オプションの伝達漏れ）、[B178](ksql_b178_flow_import_source_materialized_receipt_issue.md)（IMPORT 通知のあとの期限の確かめ直し＝本件の 5 の元）

## 1. 何が足りなかったか

- 内部の `confirm`（`ExecuteOptions.confirm` と `DmlConfirmContext`）は、管理された実行（`executeManagedStatement`）の中で文の情報付きで呼ばれる配線まであった。ただし `CreateExecutionContextOptions` の型と export に無く、型に無いオプションとして素通しされていただけ。
- 渡る `targetAppId` は論理アプリの仮の ID（900,000,000 台。`src/core/logicalApps.ts` の `nextVirtualAppId`）のまま。
- `runWithDeadline` は期限で結果を返しても中の Promise を止めない。dispose も印を立ててカーソルを閉じるだけ。確認を待つ間に期限・dispose が来ても利用者のフックには伝わらず、後から真が返ると、期限切れの結果を返したあとに書込が始まりうる。`confirm` が無くても、`onChunkWritten` を待つ間に期限が来れば次のチャンクを書きうる。
- `previewStatement` は文の位置を進めるので確認に使えない。`dmlMaxRows` は APPLY 専用（依頼文のとおり）。

## 2. 実コードで測った事実（2026-10-22・v3.85.0 の main f07450f）

### 2.1 `options.confirm` の呼出し元（`src/execute.ts`。行は b195/dev）

| 呼出し元 | 件数 | operation | 0 件のとき |
|---|---|---|---|
| `executeUpdate`（10793 算術・10821 通常） | 対象レコード数 | UPDATE | **呼ぶ（0）**。WHERE が定数偽なら呼ばない |
| `executeUpdateFrom`（11432） | 一致したレコード数 | UPDATE | 呼ぶ（0） |
| `executeDelete`（11486） | 対象レコード数 | DELETE | 呼ぶ（0）。定数偽は呼ばない |
| `executeInsertSelect`（10688） | SELECT の行数 | INSERT | 呼ぶ（0） |
| `executeUpsert`（11587）・`executeUpsertSelect`（12226） | 追加＋更新 | UPDATE | **呼ばない** |
| `executeNativeUpsertRecords`（8108） | 行数（＝追加＋更新） | UPDATE | 呼ばない |
| `executeCheckedPlainDml`（10127。CHECK 付き INSERT / INSERT SELECT / UPDATE / UPSERT） | 書く行数（不合格が 1 行でもあれば確認の前に `DmlValidationError`） | INSERT 系は INSERT、ほかは UPDATE | 呼ばない |
| `executeOnErrorSkip`（9438。ON ERROR SKIP 付き） | 合格した行数 | 同上 | **呼ぶ（0）** |
| `executeReorder`（12050） | 対象の親レコード数 | UPDATE | 呼ぶ（0）。定数偽は呼ばない |
| `executeUpdateSubtable`（11748）・`executeDeleteSubtable`（11827） | 一致した**子の行**の数 | UPDATE / DELETE | 呼ぶ（0）。dialect 1 は実行時に `ArgumentError`（2605）で届かない |
| APPLY 系 4 か所（`executeApplyInsert` 9023・`executeApplyUpsert` 9055・`executeApplyPatchUpdate` 10956・`executeMultipleParentApplyPreflight` 11029） | 親レコード数＋`applyDetail` / `applyDiagnostic` | INSERT / UPDATE | — |
| IMPORT 系 3 か所（`executeImport` 10308・`executeCsvSubtableReplacement` 10474・`executeImportRecordNumberUpdate` 10591） | 書く行数＋`importDetail` | INSERT / UPDATE | — |

- **確認を通らない書込**: 素の INSERT VALUES（`executeInsert` 10154）、サブテーブルへの INSERT（`executeInsertSubtable` 11657。dialect 0 だけ）。
- 書込は文の中で直列（書込 API を `Promise.all` で並べる箇所は無い）。書込はすべて `executeBatchStatement` に渡した client を通る（`src/core/apply*ExecutePrepared.ts` を含む）。
- **APPLY の書込は `/flow` の公開面では動かない**: `allowApplyMutation !== true` で `UnsupportedError: APPLY mutation requires allowApplyMutation=true`（多値・UPSERT の APPLY は `createManagedStatementExecutionContext`、UPDATE / INSERT の APPLY は各実行関数で止まる）。`allowApplyMutation` は `CreateExecutionContextOptions` に無い。
- 偽が返ると各呼出し元が `OperationCancelledError`（name 付き。`error.code = "OperationCancelledError"`）を投げ、管理層は `aborted = "fail-fast"`＝後続は `skippedReason: "fail-fast"`。内部は `if (!ok)` なので、真っぽい値（`"yes"` など）は書いてしまう。
- `timeoutMs` は**実行コンテキスト全体**の期限（`deadline = startedAt + timeoutMs`）。文ごとの期限ではない。

## 3. 決めた契約（公開）

```ts
export interface FlowDmlConfirmContext {
  statementIndex: number; statementCount: number; statementType: string;
  targetAppId: number;            // 物理のアプリ ID
  logicalAppName?: string;        // LAPP_ の文だけ。"LAPP_" を除き NFC・大文字
  signal: AbortSignal;
}
export type FlowDmlConfirm = (count: number, operation: "UPDATE" | "DELETE" | "INSERT",
  context: FlowDmlConfirmContext) => boolean | Promise<boolean>;
// CreateExecutionContextOptions.confirm?: FlowDmlConfirm
```

1. **物理のアプリ ID と論理名**: `flow-library/index.ts` の `routeConfirm` が bindings で直す（`onChunkWritten` と同じ対応）。`targetAppId` が決まらない（`null`）・`signal` が無い確認は、フックを呼ばずに `InternalError`（書かない）。
2. **件数の意味**: §2.1 の表のとおり（今の内部の動きをそのまま約束にする）。`count = 0` で呼ばれる文がある（0 件なら書込は起きない）。
3. **呼ばれない文**: 素の INSERT VALUES、対象 0 件の UPSERT、CHECK 付きで対象 0 行、WHERE が定数偽の UPDATE / DELETE / REORDER、VALIDATE ONLY、dialect 0 のサブテーブル INSERT。CHECK・ON ERROR SKIP 付きの INSERT VALUES は呼ばれる。
4. **true だけが承認**: `true` 以外（`false`・`undefined`・真っぽい値）は取消＝その文の書込 API 0 回・`OperationCancelledError`。reject はその code の error・書込 0 回。
5. **書込 API の直前の確かめ直し（confirm の有無によらない）**: 管理層が文ごとに `wrapClientWithWriteGate`（`postRecords` / `putRecords` / `deleteRecords` / `upsertRecords`）で包む。置き場所は `onChunkWritten` の包みの内側（実際の client に近い側）。dispose 済みなら `ExecutionContextDisposedError`、期限切れ（`runWithDeadline` の打ち切り、または `Date.now() >= deadline`）なら `BatchTimeoutError`（`error.code = "TimeoutError"`）。読取と Cursor の後始末は止めない。IMPORT 通知のあとの確かめ直しも同じ関数にした（dispose も見るようになった）。
6. **確認を期限・dispose と競わせる**: `awaitManagedConfirm` が、答えの前に一度確かめ（期限・dispose が過ぎていればフックを呼ばない）、待つ間は文の打ち切り（`runWithDeadline` の onTimeout で `abandoned` を中止）と dispose（`disposeController`）を見張る。先に来たほうで `signal` を中止し（`reason.name` = `TimeoutError` / `ExecutionContextDisposedError`）、答えを待たずに文を終える。答えのあとにもう一度確かめる。dispose のときは `executeStatement` が `status: "error"`・`error.code: "ExecutionContextDisposedError"` を**返す**（投げない）。
7. **対象外は止める**: IMPORT を含むスクリプトに `confirm` を渡すと `createExecutionContext` が `ArgumentError`。APPLY / IMPORT の詳細が付いた確認（型に無い `allowApplyMutation` で APPLY を通した場合など）は、フックを呼ばずに `UnsupportedError`（書かない）。

依頼からの変更: `applyDetail` / `applyDiagnostic` は公開しない（§2.1 の最後。APPLY は公開面で動かず、試験できない約束になるため）。フックは同期の `boolean` も返せる。`true` 以外を取消にする。

## 4. 実装（b195/dev）

- `src/execute.ts`: `DmlConfirmContext.signal?`、`ManagedStatementExecutionContext.disposeController`、`executeManagedStatement` の書込ゲートと確認の包み・`runWithDeadline` の onTimeout で `abandoned.abort()`、`disposeManagedStatementExecutionContext` で `disposeController.abort()`、新しい関数 `assertManagedStatementWritable` / `wrapClientWithWriteGate` / `awaitManagedConfirm`。
- `src/flow-library/publicTypes.ts`: `FlowDmlConfirmContext`・`FlowDmlConfirm`・`CreateExecutionContextOptions.confirm`。
- `src/flow-library/index.ts`: `confirm` を取り出して検査（関数でなければ `TypeError`、IMPORT と併用なら `ArgumentError`）、`routeConfirm`、export。
- `README.md`: `/flow` の節に確認フックの説明と件数の表。
- 内部の `executeBatch`（CLI / MCP / プラグイン）は変えていない。

## 5. テスト

- 新規 `src/flow-library/__tests__/b195ConfirmHook.test.ts` 18 件: 依頼の受入基準 1〜6 と 8 の公開面版、ON ERROR SKIP / CHECK 付き INSERT VALUES、APPLY が公開面で止まる・型に無い `allowApplyMutation` でもフックを呼ばない、確認の前に期限切れならフックを呼ばない、confirm なしの書込ゲート（期限・dispose）、IMPORT との併用・関数でない `confirm` の拒否。書込ゲートを外すと confirm なしの 2 件が落ちることを確かめた。実測（confirm なし・250 行の UPSERT・`timeoutMs: 30`・最初の `onChunkWritten` で 80ms 待つ）: main（v3.85.0）は `TimeoutError` を返したあとも POST が 3 回、b195/dev は 1 回。
- `/flow` の既存 7 スイート 137 件はそのまま通る（受入基準 7）。`npm run build:flow` と `flow:bundle-guard` が通り（受入基準 8）、出来た d.ts を strict・`skipLibCheck: false` の利用側ファイルで型検査して通る。
- 全体（Mac・2026-10-22）: jest 309 スイート中 301 が通る。落ちる 8 スイート 45 件と `--runInBand` の 3 件は、main（変更前）でも同じ件数で落ちる＝手元の `ksql.config.json`（git 管理外）の `prod` / `dev` profile を前提にした CLI / MCP のテストで、この Mac には無い。`docs:check` も main と同じ 97 件（Windows の絶対パスと、この Mac に無い兄弟リポジトリへのリンク）。`tsc --noEmit` は main と同じ 10 件（`src/ui/desktop.ts`）で、増えていない。

## 6. 対象外・残り

- 内部の `executeBatch` の `timeoutMs` にも、期限切れのあとに切り離された実行が書く同じ穴がある（CLI は終了するが MCP は残る）。実需が出たら別に起票。
- 書込 API の送信中の 1 回は止められない（client に AbortSignal が無い）。その `onChunkWritten` は `executeStatement` の結果より後に届くことがある。
- APPLY の `/flow` 公開（`allowApplyMutation` と確認の詳細）、INSERT VALUES も確認を通す形、`createExecutionContext` の AbortSignal、`previewStatement` で文の位置を進めない形は、依頼元から別の依頼が来たら扱う。
