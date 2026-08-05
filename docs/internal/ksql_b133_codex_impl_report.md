# B133 codex 実装報告（2026-08-05）

## 結果

**完了。** R2 に従い、`ksql_run_saved_query` への `variables` 配線と、read-only 保存クエリの複文対応を一体で実装した。

- `npm test`: **成功**
  - 通常スイート: **224 suites / 5,417 tests / 22 snapshots** 全件成功
  - CLI e2e: **2 suites / 26 tests** 全件成功
  - version sync: v3.47.0 の全 pin 同期を確認
- B133 対象テスト: `savedQueries.test.ts` / `tools.test.ts` **136 tests** 全件成功
- テスト先行の証跡: 実装前は `runSavedQuery` 入力に `variables` が無く、`SavedQuerySafety` が単文用のままなので TypeScript compile error で失敗。実装後に成功した
- `npm run build:mcp`: 成功
- `npm run mcp:smoke`: **B133 の schema / description assertion 通過後、B133 外の既存不整合で失敗**
  - 実装側: `src/mcp/docsResources.ts` は recipes の有効範囲を `r1..r14` と返す
  - smoke 側: `scripts/mcp-smoke.mjs:521` は旧期待値 `r1..r13` のまま
  - 依頼の「既存テストを書き換えない」に従い、この無関係な期待値は変更していない

git 操作および kSQL MCP ツール呼び出しは行っていない。認証用環境変数はテストプロセス内でのみ解除した。

## 変更ファイルと内容

| ファイル | 変更内容 |
|---|---|
| `src/mcp/schemas.ts` | 保存 SQL の複文説明へ更新。`runSavedQueryInputSchema` に既存 query/mutate と同形の optional `variables` を追加。read-only 保存バッチの一時テーブルはエンジン既定上限を使う旨へ更新 |
| `src/mcp/tools.ts` | `requireSingleStatement` を関数ごと削除。save/run の両方で batch-aware safety を適用。read-only 実行時に `variables` を `query()` へ渡し、mutate 委譲にも同じ入力を配線 |
| `src/mcp/savedQueries.ts` | 安全判定を `statementCount` / `canRunWithQueryTool` / `requiresMutationTool` ベースへ変更。`readOnly: false` の複文を Phase 1 非対応として明示拒否 |
| `src/mcp/index.ts` | save/run の tool description を read-only 複文・DECLARE 注入対応へ更新 |
| `src/mcp/__tests__/savedQueries.test.ts` | variables schema、安全判定、複文＋改行＋コメントの SQL 完全一致 round-trip を追加 |
| `src/mcp/__tests__/tools.test.ts` | DECLARE 注入、SET 非注入、temp table バッチエンベロープ、同時実行、VALIDATE ONLY＋SELECT、save/run 二重防御、単文・複文 DML の query 経路漏れ防止を追加 |
| `scripts/mcp-smoke.mjs` | `ksql_run_saved_query.variables` の schema assertion を追加。保存クエリ単文限定という古い assertion を、非公開 `tempTableMaxRows` は既定上限を使うという現契約へ形式追従 |
| `docs/internal/ksql_mcp_changes.md` | read-only 複文、バッチエンベロープ、DECLARE 専用 variables、SET の既存拒否、一時テーブル既定上限を記載 |
| `docs/internal/ksql_mcp_server_spec.md` | 保存・実行条件と variables 契約を記載 |
| `dist-mcp/ksql-mcp.js` | `npm run build:mcp` により生成物を更新 |

既存テストの意味や期待結果は変更していない。形式的追従は次の 2 点のみ。

1. `SavedQuerySafety` の公開内部シグネチャ変更に合わせ、既存 unit test の入力 object を新しい analysis shape へ更新
2. smoke の保存クエリ schema assertion を、B133 の `variables` 追加と read-only 複文対応へ更新

## R2 §3 受入確認

### §3.1 実需の形

- `DECLARE` を含む複文を `readOnly: true` で保存: **成功**
- 既定値で実行: 既存 batch executor 経路を維持
- `variables: { Min: "200" }` の大文字小文字を区別しない上書き: **成功**。結果行で注入を確認
- `SET` だけの保存 SQL に `variables` を渡す: **注入されない**。既存 `ksql_query` と同じく `injected variable @min is not declared` で拒否されることを固定
- 未定義変数: 同じ既存 executor validation を通るため、新規規約は追加していない

### §3.2 複文の許可・拒否

- `CREATE TEMP TABLE ...; SELECT ...`: 保存・実行成功、**バッチエンベロープ**を確認
- `INSERT ... VALIDATE ONLY; SELECT ...`（`readOnly: true`）: `canRunWithQueryTool === true` として保存・query 経路実行成功
- 実書き込み DML 混在＋`readOnly: true`: save で拒否
- DML バッチ＋`readOnly: false`: Phase 1 非対応メッセージで拒否
- 手編集カタログ: run 時に単文 readOnly DML、複文 readOnly DML、`readOnly: false` DML バッチをすべて実行前に拒否
- 単文 SELECT / 単文 DML: 全体回帰テスト成功
- 同じ temp table 保存クエリの `Promise.all` 2 並行実行: 両方成功、衝突なし

### §3.3 カタログ往復

- 複文・改行・行コメント・ブロックコメントを含む SQL を保存・再読込し、文字列の完全一致を確認

### §3.4 回帰

1. 既存単文保存クエリ: 全体テスト成功
2. `ksql_list_queries` が SQL を返さない既存 test: 成功
3. `ksql_get_query` / delete / profile override / DML approval inputs: 全体テスト成功、実装変更なし
4. 保存クエリ schema を直接照合する smoke: **1 本**（`scripts/mcp-smoke.mjs`）。B133 assertion は通過。smoke 全体は前述の recipes r13/r14 不整合で未完了
5. 実書き込み DML の query 経路漏れ: 手編集カタログの単文・複文双方で executor 呼び出し 0 回を確認

## 仕様と違えた箇所

なし。

`SET` への `variables` 指定が未宣言変数エラーになる点は新しい意味論ではなく、R2 が要求する「既存 `ksql_query` と同じ挙動」を保存クエリ経路でも維持したもの。

## 仕様が決まっていなかった箇所（R2 §5）

1. `assertSavedQuerySafety` は `{ statementCount, canRunWithQueryTool, requiresMutationTool, statementType? }` を受ける形にした。許可判定は `canRunWithQueryTool`、単文 DML の従来互換は `requiresMutationTool`、複文拒否は `statementCount` で表す
2. `readOnly: false` の複文は save/run 共通の `ArgumentError: DML batches are not supported by saved queries in Phase 1.` とした
3. 保存クエリ入力 schema を直接照合する既存 smoke は **1 本**（`scripts/mcp-smoke.mjs`）だった

## 既存テストへの影響・未実施

- `npm test` は全件成功。既存 assertion の意味変更なし
- `mcp:smoke` は B133 関連チェック通過後、既存の recipes `r1..r13` / `r1..r14` 不整合で停止。B133 の依頼範囲外かつ既存テスト変更禁止のため未修正
- kSQL MCP 実機確認は運用制約に従い未実施
- ブラウザ／実 kintone 確認は本依頼の対象外で未実施
