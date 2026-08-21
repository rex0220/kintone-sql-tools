# kSQL Flow ランナーからの依頼・質問（E-1〜E-6）— エンジン側起票文書

- ステータス: 📝 **B170 起票・codex による依頼書レビュー（事実主張の実測照合）中**（2026-08-21）。台帳: [ksql_issue_tracker.md](ksql_issue_tracker.md)
- 日付: 2026-08-21 ／ 差出: ksql-flow（Flow ランナー）
- 宛先: kintone-sql-tools（kSQL エンジン）担当 Claude Code
- 経緯: ランナー実装 M1〜M7 とコードレビュー往復（fix2 で BLOCKER / MAJOR / MINOR 0 件・テスト 87 件）が完了。実装調査（`ksql-flow/docs/flow_runner_survey_20260821.md` §3）で判明したエンジン側依存の残項目を正式に起票する。
- 前提: いずれも `/flow` 公式 API（semver 対象）への**追加的変更のみ**を依頼する。既存シグネチャの破壊的変更は不要・不可。対応後は申し送り文書（`ksql-flow/docs/` 宛て）で回答すること。

---

## 優先順位の提案

| 順 | 項目 | 種別 | 規模感 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | E-6 | 依頼（実質バグ） | 小 | dialect 1 スクリプトを `explainScript` できない。dialect 1 の提供機能が自己完結していない状態 |
| 2 | E-3 / E-4 / E-5 | 型公開・質問・確認 | 小（文書中心） | コード変更ほぼ不要。公開契約の明文化のみ |
| 3 | E-1 | 依頼 | 中 | ランナーの裁定 Q3（チェックポイント縮退の期限付き容認）の解消条件 |
| 4 | E-2 | 依頼 | 大 | 設計書 10.2 の差分プレビュー解禁。設計提案から始めて良い |

---

## E-6（依頼・優先 1）: `explainScript` に `asOf` / `timezone` オプションを追加

**事象**: dialect 1 の `@NOW()` / `@MONTH_START()` 等を含むスクリプトを `explainScript` に渡すと `ParseError: variable @as-of:NOW is not defined in this batch` で失敗する。as-of 変数が `createExecutionContext` でのみ注入されるため。

**依頼**: `ExplainScriptOptions` に `asOf?: Date` / `timezone?: string` を追加し、`createExecutionContext` と同じ規則（省略時は現在時刻・ホスト TZ）で as-of 変数を注入すること。

**受入基準**: dialect 1 受入サンプル（`monthly_sales_sync.sql`）が `explainScript(source, { client, apps, asOf, timezone })` でエラーなく推定を返す。

**参考**: ランナーは当面 `@` 関数をリテラルへテキスト置換してから explain する回避策で動作中（`ksql-flow/src/commands/dryrun.ts`）。対応後この回避策を撤去する。

## E-3(依頼・優先 2): `StatementResult.result` の DML 結果型の公開

**事象**: DML 実行時の `result` は実体として `{ type: "INSERT" | "UPDATE" | "UPSERT" | "DELETE", insertedCount, updatedCount, deletedCount }` を返すが、公開契約上は `unknown` 型。ランナーは `written_count` の集計にこれを使用中で、内部実装への事実上の依存になっている。

**依頼**: この形を公開型（例: `DmlResult`）として `/flow` の型定義と README に載せ、semver の対象にすること。

**受入基準**: `@rex0220/kintone-sql-tools/flow` から型が import でき、言語リファレンス §27 または README に記載がある。

## E-4（質問・優先 2）: `KsqlFlowError.code` の値域は公開契約か

`ExecutionContextDisposedError` 等の code 値の一覧と安定性（公開契約か・変わり得るか）を明示してほしい。ランナーのエラー分類は HTTP status ベースで実装済みのため必須ではないが、公開契約であれば表示・ログの安定化に利用する。**回答は文書（申し送り）で可**。

## E-5（確認・優先 2）: `StatementResult.metrics` の共有参照仕様の明文化

現実装の読解では `metrics` は**コンテキスト累積の共有参照**であり、文単位の値が必要な場合は利用側で前回値との差分を取る、と理解している。この理解で正しいかの確認と、公式ドキュメントへの明文化を依頼する（ランナーはこの前提で実装済み。仕様が異なる場合は要連絡 — ランナー側修正が必要になる）。

## E-1（依頼・優先 3）: 書込チャンクのキー値を観測する手段

**背景**: 設計書 5.1-2 / 8.2 は「100 件チャンクごとに最後に書き込んだキー値（`last_written_key`）を記録」と定めるが、現状の `/flow` にはキー値を観測する手段がない（metrics にもコールバックにも存在しない）。ランナーは裁定 Q3 により「`chunk:<書込チャンク数>` + 処理件数」への**期限付き縮退**で運用中（`ksql-flow/docs/reviews/decisions.md` 参照）。本依頼の解消が縮退解除の条件。

**依頼**（いずれかの方式。設計はエンジン側に委ねる）:

1. コールバック方式: `CreateExecutionContextOptions.onChunkWritten?: (info: { appId, statementIndex, records: number, lastKeyValue?: string }) => void`
2. metrics 方式: metrics への `lastWrittenKey` 追加（E-5 の共有参照仕様と整合させること）

**併せて確認**: DML の書込が**キー昇順に整列**されているか（設計書 5.1-2 の `last_written_key` 単調性の前提）。整列されていない場合はその旨の回答だけでも良い（ランナー側で設計書の前提を再裁定する）。

**受入基準**: 250 件の UPSERT で 3 回のチャンク書込が発生し、各チャンクのキー値（または最終キー値）がランナーから観測できる。

## E-2（依頼・優先 4）: dry-run（書込抑止）モード

**背景**: 設計書 10.2 の差分プレビュー（INSERT / UPDATE / DELETE 件数 + 変更サンプル）の実現に必要。現状 `executeStatement` に書込抑止オプションがなく、ランナーの `--dry-run` は「`validateScript` フル検証 + `explainScript` 推定表示」の縮退版で提供中。

**依頼**: `executeStatement`（または ExecutionContext 生成時）に書込抑止モードを追加し、書込 API を発行せずに差分（種別ごとの件数と、変更されるレコードのサンプル: キー値 + before/after）を返すこと。UPSERT が read-then-write 実装（申し送り 3.4）であることから、pre-read の結果を流用すれば差分算出の大部分は既存処理で賄える見込み、という点も設計材料として添える。

**進め方**: 規模が大きいため、実装前に**設計提案（API 形・差分の表現・サンプル件数の上限・API 消費の扱い）を文書で往復**してから着手すること。

---

## 回答方法

- 対応可否・バージョン・仕様を申し送り文書として `ksql-flow/docs/` へ返す（`kSQLエンジンからの申し送り-YYYYMMDD-vX.md` 形式、前回踏襲）。
- 対応したものは言語リファレンス §27 / README（エンジン × dialect 対応表）への反映も含めること。
- E-1 / E-2 の対応バージョンが出たら、ランナー側は Q3 縮退解除と dry-run 本実装を別タスクとして起票する。
