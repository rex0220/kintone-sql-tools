# B66 Phase1 仕様 R1 — codex 起草ブリーフ

- 作成日: 2026-07-23（Claude=仕様/観点）
- 目的: codex が **B66 Phase1 仕様 R1（read-only ライブラリ公開）** を起草するための scope と判断論点の枠組み。
- 出力先: `docs/internal/ksql_b66_engine_library_phase1_spec.md`（R1 本体）
- 分担: **codex 起草 → Claude レビュー → R2**。git 操作は Claude 側。仕様は実装せず**文書のみ**。
- 参照: [B66 評価](ksql_b66_engine_library_evaluation.md)／[B53 Phase1 spec](ksql_b53_recursive_cte_cycle_phase1_spec.md)（章立ての手本）／実コード: `src/execute.ts:194`（`KintoneClient` インターフェース）・`src/execute.ts:680`（`execute(sql, client, options)`）・`src/ui/kintoneClient.ts`（`kintone.api` アダプタ）・`src/cli/nodeKintoneClient.ts`（Node アダプタ）・`package.json`（現状 `exports`/`main` なし・公開は dist-cli/dist-mcp/dist-mcpb のみ）

## スコープ（Phase1・read-only のみ）

- **read-only ライブラリの公開 API を切り出す**（ダッシュボード用途）。対象文＝ SELECT / WITH / UNION[ALL] / SHOW APPS / DESCRIBE / EXPLAIN。**DML（INSERT/UPDATE/UPSERT/DELETE/APPLY/IMPORT）と保存クエリ書込みは Phase1 対象外**（Phase2 `runMutation`）。
- エンジン本体（`execute()`・`KintoneClient`）は**改変しない**。公開 API・ビルド target・型配布・read-only 強制の梱包が主体。
- 配布は「ビルド時 npm 依存 or UMD」。プラグイン間ランタイム共有は kintone 仕様上不可＝各プラグインが取り込む共通ライブラリ、という前提を明記。
- 既存 plugin/CLI/MCP のビルドと SQL 挙動は不変（純加法）。

## 必要セクション（B53 Phase1 spec の構成を踏襲）

1. スコープ（対象/対象外） 2. 公開 API 面（型と関数） 3. read-only 強制の意味論 4. 配布・ビルド（exports/UMD/.d.ts） 5. クライアント供給（kintone.api アダプタ/BYO client） 6. 面・非回帰 7. 受入条件（テスト化） 8. Phase2 引き継ぎ（DML） 9. 論点・要判断 10. 工数見積り

## R1 で確定すべき判断論点（曖昧にしないこと）

1. **【最重要・安全性】read-only の二重強制**。①**parse 段階で非 read 文を拒否**（MCP の read-only 強制と同思想・DML/IMPORT/保存書込みを statement type で fail-closed）＋②**read-only client**（post/put/delete を持たない `ReadonlyKintoneClient` を公開し、書込み API を物理的に呼べない）。両方を必須とし、どちらか片方に依存しない。
2. **公開 API の粒度**。薄い `execute()` 直出しではなく、目的別ラッパー `runQuery(sql, options)` を公開面にする（安全既定と型を用途別に固定できる）。戻り値は内部 `ExecuteResult` union をそのまま出さず、**安定した公開結果型**（rows・columns・型メタの必要分・metrics の一部）に絞る。EXPLAIN は `explainQuery(sql, options)` 等で別関数化するか要判断。
3. **クライアント供給**。`createKintoneClient()`（`src/ui/kintoneClient.ts` の kintone.api アダプタを公開）と、その read-only 版 `createReadonlyKintoneClient()` を提供。加えて**利用者が独自 `KintoneClient` を渡す BYO** も契約に含めるか（ゲストスペース・特殊 route 対応）を確定。
4. **配布物**。npm の `exports` サブパス（例 `@rex0220/kintone-sql-tools/engine`）で ESM＋CJS を出すか、UMD（`window.ksql`）も二本立てにするか。`package.json` の `files`/`exports`/型定義（`.d.ts`）の追加範囲。既存 bin（ksql/ksql-mcp）と衝突しない構成。
5. **型凍結の範囲（semver 契約）**。どの型/関数を公開面として凍結するか（`KintoneClient`・公開結果型・options の公開サブセット）。**内部 execute.ts 型を全 re-export しない**（版間変更が破壊的になる）。公開面とその後方互換ポリシーを明記。
6. **ライブラリ target の中身**。MCP instructions・言語リファレンス埋め込み・カタログ等、read-only 実行に不要な資産を**ライブラリ build から除外して軽量化**するか。Node 専用依存がブラウザ/UMD 経路に混入しないこと（tree-shaking/条件分岐の確認）。
7. **options の公開サブセット**。`maxRecords`・`cacheContext`・`fetchParallel`・KORDER/cursor 関連・EXPLAIN 用など、read-only で意味のある `ExecuteOptions` のどれを公開し、どれを内部既定に固定するか。
8. **エラー契約**。ParseError・SearchAbortedError（B7 の10万件打ち切り fail-closed）・fetch 上限超過を公開 API でどう表現するか（例外型 or 結果 envelope）。

## 受入条件に必ず入れる例

- ブラウザで `kintone.api` から `createReadonlyKintoneClient()` → `runQuery('SELECT ... JOIN ... GROUP BY ...')` が結果行を返す（ダッシュボード想定）。
- **DML/IMPORT/保存書込みを渡すと read-only 強制で fail-closed**（parse 段階拒否＋client に書込みメソッド無し）。
- BYO client（独自 `KintoneClient` 実装）で同一結果。
- EXPLAIN が record API 0 回で plan を返す。
- SearchAborted（10万件打ち切り）が公開エラー契約どおりに伝播。
- 既存 plugin/CLI/MCP のビルド・SQL 挙動・テストが非回帰。
- 公開 `.d.ts` が最小 public 面のみを型として出す（内部型の漏れなし）。

## 制約

- git 操作は Claude 側。仕様は実装せず文書のみ。
- エンジン本体（`execute()`・`KintoneClient`・parser）は改変しない前提で、梱包・公開 API・ビルド・read-only 強制に限定。
- 配布形態はプラグイン間ランタイム共有不可を前提にする（ビルド時 npm/UMD）。
