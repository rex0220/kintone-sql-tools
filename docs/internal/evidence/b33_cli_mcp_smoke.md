# B33 実機 smoke 記録: CLI / MCP（KORDER_CURSOR 順序照合）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev ドメイン・APP730=D2郵便番号 618,525 件・read-only）
- 対象: [B33 実装計画](../ksql_korder_cursor_implementation_plan.md) Phase 4 Step 4-4 の CLI/MCP 分（release blocker）
- 方法: **raw Cursor API で同一 query を直接読んだ `$id` 系列**と、working tree ビルド（dist-cli/dist-mcp・2026-07-18 09:32）の kSQL 出力系列を全件照合
- Chromium / Firefox plugin smoke は本記録の対象外（codex/ユーザー分担・未実施）

## 順序照合（7/7 完全一致）

| # | ケース | 結果 |
|---|---|---|
| T1 | 10,001 件・`郵便番号 ASC, $id ASC`（**21 ページ連結**） | ✓ 10,001 件完全一致 |
| T2a | 1,501 件・**同値群（都道府県K）が 500 件境界をまたぐ**・`$id` なし ASC | ✓ 完全一致 |
| T2b | 同上・`$id ASC` あり | ✓ 完全一致 |
| T2c | 同上・**DESC** + `$id ASC` | ✓ 完全一致 |
| T3 | `LIMIT 501`（cursor 切替の最小境界） | ✓ 完全一致 |
| T4 | `LIMIT 100 OFFSET 700`（ページ中間の読み飛ばし） | ✓ 一致（raw 701〜800 件目と一致） |
| T5 | `LIMIT 500`＝`KORDER_NATIVE` 非回帰 | ✓ raw 先頭 500 件と一致 |

- **release blocker「複数ページの順序・同値安定性」は CLI 面で解消**（kSQL のページ連結は raw Cursor API の連続読みと完全同一）
- 7 ケース連続実行＝**早期 DELETE 直後の再 Create も毎回成功**（受入 §16-7/8 の実機裏付け）
- warnings は全ケース空（cleanup 警告なし）

## その他の確認

- EXPLAIN（CLI）: `order plan: KORDER_CURSOR` / `fetch API: POST/GET/DELETE records/cursor.json` / `cursor page size: 500` / `cursor concurrency: N per domain (process-local)` / `scan rows` / kintone query に LIMIT/OFFSET なし — 仕様 §13 どおり
- 負例: 既定 `maxRecords=500` で `LIMIT 10001` → `KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS(scanRows=10001, maxRecords=500)` の planning error（対処 3 案の案内付き）
- MCP（dist-mcp を stdio 直接起動）: `ksql_query` で `LIMIT 501`＋`maxRecords:501` → ok・501 件・先頭/末尾 `$id` が raw と一致

## 発見した不具合（→ 2026-07-18 修正済み・下記追記参照）

1. **[P2] MCP `ksql_explain` に `maxRecords` 入力がなく、KORDER_CURSOR の EXPLAIN が取得不能**。KORDER_CURSOR は定義上 `scanRows > 500` のため、profile 既定 500 では**すべての cursor クエリの EXPLAIN が planning error**になる（`ksql_query` は `maxRecords` を受けて実行できるのに、同じクエリの計画を確認できない非対称）。修正＝`explainInputSchema` へ optional `maxRecords` を追加し `createKsqlRuntime`/EXPLAIN へ配線（`cursorMaxActive` と同じ経路）
2. **[P3] CLI の非 dry-run 経路で EXPLAIN の `cursor concurrency` 表示が常に既定 2**。`--cursor-max-active 4` を指定しても、単文実行（`-e "EXPLAIN …"`）とバッチ経路の `ExecuteOptions` に `cursorMaxActive` が渡っていない（cli/index.ts の `executeBatch` オプションと非 dry-run `execute` オプションの 2 箇所）。実効値は client→lease 経由で正しく反映されるため**表示のみの乖離**。dry-run 経路（`--dry-run`）は配線済み

## 修正確認（2026-07-18・Claude 実機再確認・build 09:48）

- **P2 解消**: MCP `ksql_explain` へ `maxRecords: 501` + `cursorMaxActive: 3` を渡して stdio 再実行 → `ok: true`・`order plan: KORDER_CURSOR`・`cursor concurrency: 3 per domain (process-local)`・`scan rows: 501`
- **P3 解消**: CLI `--cursor-max-active 4` の単文 `-e "EXPLAIN …"` → `cursor concurrency: 4` と実効値一致。単文・バッチ両経路の `ExecuteOptions` へ `cursorMaxActive` が配線されたことをコードでも確認
- **CLI / MCP の release blocker（順序・同値安定性・EXPLAIN 整合）はすべて解消。残る release blocker は Chromium / Firefox の plugin smoke のみ**
