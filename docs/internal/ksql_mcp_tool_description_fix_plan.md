# MCP ツール説明文と実装の不整合 修正計画

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R1: 初版(Claude Desktop の「INSERT_SELECT 非対応」誤回答の原因調査に基づく)
  - 2026-07-10 R2(codex レビュー反映・Medium): D1・D3 の検証を smoke の目視確認から**機械的 assertion** に変更(D5 として独立ステップ化)。現行 `scripts/mcp-smoke.mjs` は tool 名と schema プロパティの存在確認のみで description を固定しておらず、目視では「実装は正しいがメタデータだけ古い」ズレの再発を防げないため
  - 2026-07-10 R3(実装完了): D1〜D5 実装済み(ブランチ `fix/mcp-tool-descriptions`)。リリース版番は **1.4.1** に確定(package.json bump 済み)。D5 は計画どおり assertion を先に追加し、旧 description のバンドルで smoke が失敗することを確認してから D1 を適用(regression テストとして機能する証明済み)。D4 は esbuild `define`(`__KSQL_VERSION__`)+ ts-jest 用 typeof フォールバック方式。D3 は「最低限」の範囲を広げ全入力スキーマに `.describe()` を付与(JSDoc コメントは削除し一本化)。検証: jest 594 件 / mcp:smoke / mcp:pack-smoke すべてパス
- ステータス: **実装済み(v1.4.1)**。残り: release/ 配布物の更新と npm publish(ユーザー操作)、Claude Desktop 実機確認(§4 仕上げ 4)
- 関連: [../ksql_batch_temp_table_spec.md](../ksql_batch_temp_table_spec.md)(M4: バッチ INSERT_SELECT 対応)

---

## 1. 背景(発端の事象)

Claude Desktop で以下のバッチ SQL を依頼したところ、ツールを**呼び出すことなく**「INSERT_SELECT は ksql_mutate で非対応」と回答され、SELECT + 個別 INSERT の遠回りな代替手順に切り替えられた。

```sql
CREATE TEMP TABLE #t AS SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN ('A');
INSERT INTO APP4149 (顧客No_) SELECT 顧客No FROM #t;
```

実装上、この SQL は **v1.4.0(M4)で対応済み**であり、`ksql_mutate` に送れば実行できる
(`src/mcp/tools.ts` の `mutateBatch` — INSERT_SELECT はソースが一時テーブルのみなら許可)。

## 2. 根本原因

MCP クライアント(Claude Desktop 等)の LLM は、ツールを呼ぶ前に**サーバーが公開する
ツール description を読んで「できること／できないこと」を判断**する。
`ksql_mutate` の description が M4 実装前の文言のまま

> Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls.
> **INSERT_SELECT and UPSERT_SELECT are rejected.**

と宣言しているため、モデルは試行すらせずに「非対応」と結論する。
コードとモデル向けメタデータ(description・エラーメッセージ・パラメータ説明)の不整合が原因であり、
配布済み `release/ksql-mcp.js` も同一文言(実装は M4 込みで最新、description のみ古い)。

## 3. 問題一覧(全ツール点検の結果)

| # | 深刻度 | 箇所 | 問題 |
|---|---|---|---|
| 1 | **High** | `src/mcp/index.ts:92`(ksql_mutate description) | 「INSERT_SELECT and UPSERT_SELECT are rejected」が M4 実装と矛盾。複文 DML バッチ+一時テーブル対応(v1.4.0 の目玉)にも一切触れておらず、正しい書き方をモデルが選べない |
| 2 | **High** | `src/mcp/index.ts:86`(ksql_query description) | 対応文の列挙(SELECT, WITH, UNION, EXPLAIN, SHOW APPS, DESCRIBE)に **CREATE/DROP TEMP TABLE と複文バッチが含まれない**。CREATE TEMP TABLE は read-only 扱い(`src/core/dmlGuard.ts:37-38`)で read-only バッチは実行可能(`src/mcp/tools.ts` query バッチ分岐)なのに、「DML is rejected」と併せて「CREATE は非対応」と誤判定されるリスクが高い(#1 と同じ構図) |
| 3 | **Medium** | `src/mcp/tools.ts:634-635`(単文 INSERT_SELECT 拒否) | エラーメッセージ「INSERT_SELECT is not supported by ksql_mutate yet.」が、対応済みの代替経路(CREATE TEMP TABLE を挟むバッチ)を案内しない。ツールを呼んだモデルにも「やはり非対応」と誤学習させる |
| 4 | **Medium** | `src/mcp/schemas.ts` 全般 | Zod スキーマに `.describe()` が無く、パラメータ説明が JSDoc コメント(TypeScript コメント)のみ → **MCP 経由ではモデルに一切渡らない**。特にバッチ専用の `continueOnError` / `maxTotalRecords`(query)・`dmlTotalMaxRows`(mutate)は、説明が付けば「バッチ対応である」ことの傍証にもなる |
| 5 | **Low** | `src/mcp/index.ts:65`(McpServer version) | サーバー申告バージョンが `"1.0.0"` 固定(package.json は 1.4.0)。誤判定は起こさないが、ユーザー環境のサーバー新旧の切り分け時に紛らわしい |

### 点検済み・問題なし

- `ksql_validate` / `ksql_explain`: バッチ対応済みで description に虚偽の否定なし
- `ksql_save_query` / `ksql_run_saved_query`: バッチは `requireSingleStatement` で拒否されるが、
  エラーメッセージ(`batch SQL (multiple statements) is not supported by ... yet.`)が明確で自己修正可能
- MCPB マニフェスト(`build-mcpb.mjs:59-69`): 短い汎用文で虚偽なし(実行時はサーバーの live description が使われる)
- 単文 CREATE TEMP TABLE の拒否メッセージ(`src/core/batch.ts:147`
  「requires a batch (temp tables are batch-scoped)」): 行動可能な良い文言
- `docs/ksql_mcp_server_spec.md` ほか公開ドキュメント: description の英文をミラーしておらず追従不要

## 4. 実装計画

独立にマージ可能な 5 ステップ。D1・D2 が本命(誤判定の直接原因)、D3・D4 は同梱推奨、
D5 は D1・D3 の再発防止ガード(R2 で追加)。

### D1: ツール description の実態合わせ(問題 #1・#2)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/index.ts:86,92` の description を書き換え |
| ksql_query 案 | `Execute read-only kSQL: SELECT, WITH, UNION, EXPLAIN, SHOW APPS, DESCRIBE. Supports multi-statement batches with temp tables (CREATE TEMP TABLE #t AS SELECT ...; SELECT ... FROM #t;). DML is rejected.` |
| ksql_mutate 案 | `Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. Supports multi-statement DML batches with temp tables. INSERT INTO app ... SELECT is allowed in a batch when it selects only from temp tables (CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t;). Standalone INSERT_SELECT and UPSERT_SELECT are rejected.` |
| 設計メモ | description は「何ができるか」→「制約」の順で書く。SQL 例を1つ埋め込むとモデルが構文を再現しやすい(今回の誤判定の再発防止に最も効く)。文言は英語のまま(既存方針踏襲) |
| テスト | **D5 の smoke assertion で機械的に検証**(R2 で目視確認から変更。既存ユニットテストは description を検証しておらず、目視では今回と同種の「実装は正しいがメタデータだけ古い」ズレを再発させるため) |
| 完了条件 | D5 の assertion が通ること + Claude Desktop(再起動後)で発端の SQL を依頼し、ksql_mutate バッチが一発で選択されること(実機確認はユーザー実施) |

### D2: 単文 INSERT_SELECT 拒否メッセージに代替経路を案内(問題 #3)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts:634-635` — INSERT_SELECT の場合のみメッセージ末尾にヒントを追加。案: `ArgumentError: INSERT_SELECT is not supported by ksql_mutate as a single statement. Wrap it in a batch: CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t;` |
| 設計メモ | UPSERT_SELECT は代替経路が無い(バッチでも拒否)ため従来文言のまま分岐を分ける。CLI 側(`src/core/dmlGuard.ts` 等)に同種の単文拒否メッセージがあれば同時に点検(console はバッチ対応済みのため同じヒントが有効) |
| テスト | `src/mcp/__tests__/tools.test.ts:268` の `/INSERT_SELECT is not supported/` は前方一致で通る想定だが、文言確定後に正規表現を新メッセージの検証に更新 |
| 完了条件 | 単文 INSERT_SELECT のエラーにバッチへの誘導が含まれる |

### D3: 入力スキーマへの `.describe()` 追加(問題 #4)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/schemas.ts` — 主要パラメータに `.describe()` を追加し、JSDoc コメントの内容をモデル向けに移す。最低限: `continueOnError`(read-only バッチ専用・既定 fail-fast)、`maxTotalRecords`(バッチ返却合計行数上限)、`dmlTotalMaxRows`(DML バッチ合計影響行数上限・DML バッチは常に fail-fast)、`dmlMaxRows`(文ごとの影響行数上限)、`profile` / `maxRecords` / `fetchParallel` / `onLimit` / `timeout`(共通) |
| 設計メモ | 文言は英語。JSDoc コメントは重複になるため `.describe()` へ一本化(コメント削除)。zod の `.describe()` が MCP SDK により JSON Schema の `description` へ変換されることは D5 の assertion が担保 |
| テスト | **D5 の smoke assertion で機械的に検証**(R2 で変更) |
| 完了条件 | tools/list のスキーマに全パラメータの説明が含まれ、D5 の assertion が通る |

### D4: サーバー申告バージョンの同期(問題 #5)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/index.ts:63-66` — `"1.0.0"` 固定を package.json の version に同期。esbuild バンドル(`release/ksql-mcp.js`)で確実に解決できるよう `require("../../package.json").version` ではなく、ビルド時定数(esbuild `define`)またはバンドルに含まれる形の import を採用(ビルド構成を確認して決定) |
| テスト | `ksql-mcp` 起動 → initialize 応答の serverInfo.version が 1.4.x であること(D5 の assertion に含める) |
| 完了条件 | 申告バージョンが package.json と一致 |

### D5: smoke へのメタデータ regression assertion 追加(R2 で新設)

| 項目 | 内容 |
|---|---|
| 変更 | `scripts/mcp-smoke.mjs` — 現行の `assertSchemas`(プロパティ存在確認のみ)に加え、tools/list のメタデータを機械的に固定する assertion 群を追加 |
| assertion 内容 | ① `ksql_mutate.description` に `temp tables`・`SELECT ... FROM #t`・`Standalone INSERT_SELECT and UPSERT_SELECT are rejected` が含まれる / ② `ksql_query.description` に `multi-statement batches with temp tables` が含まれる / ③ D3 対象パラメータ(`continueOnError`・`maxTotalRecords`・`dmlTotalMaxRows`・`dmlMaxRows` 等)の `inputSchema.properties.*.description` が非空文字列で存在する / ④ initialize 応答の `serverInfo.version` が package.json の version と一致(D4) |
| 設計メモ | description 全文の完全一致は文言調整のたびに壊れるため、**「実装能力を表すキーとなる部分文字列」のみ**を固定する(バッチ+一時テーブル対応の宣言と、単文拒否の限定表現)。smoke は `dist-mcp/ksql-mcp.js`(ビルド成果物)に対して走るため、「src は直したがバンドルが古い」ズレも同時に検出できる。D1・D3 の文言が確定してから assertion の期待値を最終化する |
| テスト | assertion 追加後、旧 description のバンドルに対して smoke が**失敗する**ことを確認してから D1 を適用(regression テストとして機能する証明) |
| 完了条件 | description・パラメータ説明・バージョンのいずれかが実装と乖離したら smoke が落ちる |

### 仕上げ(全ステップ共通)

1. `npm test`(既存全テスト)+ `scripts/mcp-smoke.mjs`
2. リリースバンドル再ビルド(`release/ksql-mcp.js`)と MCPB 再パッケージ(`build-mcpb.mjs`)
3. `docs/ksql_mcp_changes.md` に変更履歴を追記
4. ユーザー実機確認: Claude Desktop で MCP サーバー再起動 → 発端の SQL を再依頼し、
   ksql_mutate バッチが選択されること(description はツール一覧取得時に読まれるため再起動必須)

## 5. リスクと留意点

- **description の変更はモデルの挙動に直結する**。長くしすぎるとコンテキスト消費が増え、
  他ツールとの相対的な選択にも影響し得るため、1〜3文+SQL 例1つ程度に抑える
- D2 のメッセージ変更はエラー文字列に依存するクライアント(正規表現マッチ等)に影響し得るが、
  `ArgumentError:` 接頭辞と `code` 抽出(`toErrorPayload`)の形式は不変のため実質影響なし
- v1.4.0 リリース済みバンドルに対する修正のため、リリース版番は **1.4.1** に確定(R3)
