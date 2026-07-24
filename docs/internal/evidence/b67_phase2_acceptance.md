# B67 Phase2 A（SUPERSET_PREFILTER）受入・証跡

- 対象: B67 Phase2 A（相対日付 exact leaf の prefilter 押し下げ＋残余 client 評価）
- 版: v3.21.0 予定（ブランチ `feat/b67-phase2-superset-prefilter`）
- 正: [Phase2 A 仕様 R2](../ksql_b67_phase2_superset_prefilter_spec.md)（§9 受入）／[実装計画](../ksql_b67_phase2_impl_plan.md)
- 実施日: 2026-07-25

## 1. 自動ゲート（Node）

- `npm test`: 159 suites / **4,242 tests green**（Phase2 A 追加ぶん＝decomposition planner 20＋guard 17＋execution 10＋explain/renderer 15＋acceptance 35 ほか）
- CLI subprocess: 2 suites / **26 tests green**
- snapshot: **22 不変**（純 exact 相対日付 EXPLAIN が byte 不変＝Phase1 挙動非回帰の証拠）
- `npm run build`: plugin / CLI / MCP / MCPB / engine 全面成功
- `npm run mcp:smoke`: ok（ビルド済み MCP サーバ）
- `npx tsc --noEmit`: 新規型エラー 0（既存 `src/ui/desktop.ts` の DOM 型 10 件のみ・本機能と無関係）

## 2. 受入 ID 対応（spec §9）

`src/__tests__/b67Phase2RelativeDateAcceptance.test.ts` に ID を明記して一対一で実装。

| 受入 ID | 内容 | 結果 |
|---|---|---|
| 9.1-1 | relative exact ＋ LENGTH を prefilter/residual へ分離 | PASS |
| 9.1-2 | 初回/後続 GET が relative base predicate 維持・相対評価0 | PASS |
| 9.1-3 | relative exact ＋通常 LIKE は LIKE を client residual | PASS |
| 9.1-4 | relative exact ＋ KLIKE ＋ LIKE：KLIKE は server・identity 維持 | PASS |
| 9.1-5 | 複数 relative leaf を全 push・residual から全除去 | PASS |
| 9.1-6 | relative-free OR residual 許可・OR node identity 維持 | PASS |
| 9.1-7 | Phase1 pure-exact 非回帰 | PASS |
| 9.2-1 | 相対日付が OR/NOT・非 exact operator/type/context は取得前拒否 | PASS |
| 9.2-2 | serialize 失敗・関数欠落・residual 残存は取得前拒否 | PASS |
| 9.2-3 | KORDER native/cursor ＋相対 exact＋非押し下げ残余は拒否・cursor 0 | PASS |
| 9.2-4 | **DML target 選択・SELECT-based DML source は拒否**（owner 決定 A）。mixed INSERT/UPSERT…SELECT source は API/confirm/mutation 0 で拒否。**pure-exact DML source は第1許可形で許可維持＝非回帰** | PASS |
| 9.2-5 | planner bypass は backstop throw | PASS |
| 9.2-6 | relative query の REST error は空 query/FULL_SCAN/client 評価へ retry せず伝播 | PASS |
| 9.3-1 | `TODAY()`/`NOW()`/`LOGINUSER()` 非回帰 | PASS |
| 9.3-2 | B32 capability/LIKE-only residual/safe-leaf/KLIKE-only 非回帰 | PASS |
| 9.3-3 | Node 実行と EXPLAIN の server prefilter query 一致（CLI/MCP は同一 core 共有）。**Firefox/Chrome 実機はユーザー実施**（§4） | PASS（Node/EXPLAIN）／browser 未 |
| 9.3-4 | maxRecords/complete-input/SearchAbortedError 非回帰 | PASS |

### owner 決定 A（DML source）

`INSERT/UPSERT … SELECT` の source SELECT は `executeSelect` を通り prefilter＋residual を正しく適用するため結果は正しい（over-insert バグではない）が、spec R2 §1.2/§6/§9.2-4 のスコープ（読み取り SELECT 限定）を尊重し **DML source への Phase2 適用は fail-closed**。実装は guard の `WalkCandidate.allowPhase2Prefilter` を DML の nested source SELECT だけ `false` にし、第1許可形（pure-exact）は不変（＝v3.20.0 の pure-exact DML source を非回帰）。

## 3. benchmark（回帰観測・意味論ゲートではない）

- `npm run benchmark:b67-phase2`（`scripts/b67-phase2-prefilter-benchmark.mjs`・依存なし Node・10,000 行・7 trials・exit 0）
- Phase2 server prefilter candidates: 7,500 ／ client residual output: 6,000 ／ relative-free FULL_SCAN baseline candidates: 10,000
- 相対日付 leaf の prefilter が候補集合を server 側で 25% 絞り、残余 client 評価が最終 6,000 を確定。時間は環境依存のため観測用。

## 4. 実機（ユーザー実施・release gate）

- Firefox / Chrome プラグイン実機 smoke（Node で代替しない）。fixture 既定候補（境界跨ぎで flaky にならない広い窓）:
  ```sql
  SELECT 都道府県, 更新日時 FROM APP730
  WHERE 更新日時 >= FROM_TODAY(-3650, DAYS) AND LENGTH(都道府県) > 0
  ```
- ビルド済み CLI / デプロイ済み MCP で代表正例（mixed prefilter）・拒否例（DML source / KORDER / OR）を実 kintone に対して確認。
- 送信 query・residual 結果・EXPLAIN（`where capability: SUPERSET_PREFILTER` / `server prefilter` / `client residual` / `relative date client evaluations: 0`）・browser clock 非参照を記録。
- 結果は [b67_phase2_browser_smoke.md](b67_phase2_browser_smoke.md) に追記。
