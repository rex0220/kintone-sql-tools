# ksql_mutate INSERT_SELECT(APP ソース)解禁 実装計画

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R3(実装完了): U1〜U6 実装済み(ブランチ `feat/mcp-insert-select-app-source`)。U5 は計画どおり assertion を先に差し替え、旧 description のバンドルで smoke が失敗することを確認してから U4 を適用(regression ガードとして機能する証明済み)。テスト追加: 単文 INSERT_SELECT 成功 / dmlMaxRows 超過(POST 未実行) / 読み取り上限(dmlMaxRows + 1)超過 / 承認欠落 / バッチ APP ソース成功 / 混在ソース実行前拒否 / dmlTotalMaxRows 合算(二重計上なしを (4) の報告値で証明)。残り: U7 実機確認(ユーザー実施)・npm publish
  - 2026-07-10 R2(codex レビュー反映・Medium): U1 の新メッセージが「迂回案内には 10,000 行上限を併記」ルール(§4)に自己矛盾していたため修正。`TEMP_TABLE_MAX_ROWS` 補間形式に変更(仕様 §4.2 も同時修正・仕様 R3)。codex 提案の「in MCP」限定は不採用 — エンジン共通メッセージであり、`tempTableMaxRows` を渡す本番経路が CLI / プラグインにもないため上限は全経路共通
  - 2026-07-10 R1: 初版(仕様案 R2 確定を受けて作成)
- ステータス: **実装済み(U1〜U6)**。残り: U7 実機確認(ユーザー実施)・npm publish
- 対象バージョン: **v1.5.0**(機能追加のため minor バンプ)
- 仕様: [ksql_mcp_insert_select_app_source_spec.md](ksql_mcp_insert_select_app_source_spec.md)(codex R1〜R2 レビュー済み・確定)
- 推奨ブランチ: `feat/mcp-insert-select-app-source`(単一ブランチ・単一 PR)

---

## 1. 概要

APP ソースの `INSERT INTO APPx (...) SELECT ...` を `ksql_mutate` で解禁する(単文・バッチとも)。
**新規の安全機構の実装はなく、変更の本体は 2 箇所のガード削除**(U2・U3)。残りはエラーメッセージ・
モデル向けメタデータ・ドキュメント・テストの同期である。安全モデルの根拠は仕様 §3 を参照。

### ステップ一覧と依存関係

| ステップ | 内容 | 依存 |
|---|---|---|
| U1 | エンジン層: 混在ソース拒否メッセージの改善 | なし |
| U2 | MCP: 単文 INSERT_SELECT 拒否の削除 | なし |
| U3 | MCP: バッチ `tempOnlySource` ガードの削除 | U1(混在ソースのテスト期待値が新メッセージに依存) |
| U4 | メタデータ更新(description / `.describe()`) | U2・U3(実装が先、宣言が後) |
| U5 | mcp-smoke assertion の差し替え | **U4 と同時**(順序制約あり、§U5 参照) |
| U6 | ドキュメント更新 | U1〜U5 の文言確定後 |
| U7 | 実機検証(任意 smoke + ユーザー確認) | U1〜U6 |

実装順は U1 → U2 → U3 → U5(assertion 先行)→ U4 → U6 → U7 を推奨。

## 2. 実装ステップ

### U1: エンジン層 — 混在ソース拒否メッセージの改善(仕様 §4.2)

| 項目 | 内容 |
|---|---|
| 変更 | `src/execute.ts:393` — `executeBatch` の validate-all-first で投げる INSERT_SELECT 用メッセージを変更 |
| 現行 | `ArgumentError: INSERT_SELECT in a batch must select from temp tables only. (statement N)` |
| 変更後 | `ArgumentError: INSERT_SELECT mixing app and temp table sources is not supported. Select from apps only, or materialize the app data into a temp table first (temp tables hold at most ${TEMP_TABLE_MAX_ROWS} rows). (statement N)` |
| 設計メモ | APP のみソースを解禁した後、「must select from temp tables only」は虚偽の制約になり、MCP クライアントの LLM に誤学習させるため(仕様 §4.2)。判定ロジック(`tempOnlySource` 要求)自体は変更しない — このメッセージに到達するのは「一時テーブル参照あり かつ APP 混在」のケースのみになる。迂回案内には実体化上限を必ず併記する(§4 のルール、R2)— 上限値はハードコードせず同一ファイルの `TEMP_TABLE_MAX_ROWS` を補間する。エンジン共通メッセージのため「in MCP」等の経路限定は書かない(`tempTableMaxRows` を渡す本番経路は CLI / プラグインにも存在せず、10,000 行は全経路で正しい) |
| テスト | 既存の期待値更新: `src/__tests__/executeBatch.test.ts`・`src/mcp/__tests__/tools.test.ts` の該当 assert(実装時に `must select from temp tables only` で grep して全箇所を洗い出す) |
| 完了条件 | 混在ソース INSERT_SELECT を含むバッチが**1文も実行されずに**新メッセージで拒否される |

### U2: MCP — 単文 INSERT_SELECT 拒否の削除(仕様 §2.1-1)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts:634-641` — 単文 INSERT_SELECT の throw と誘導コメントを削除 |
| 設計メモ | 削除後は既存の単文 DML 経路(`tools.ts:652` 以降)に乗るだけで新規コードなし。ランタイムは `maxRecords = dmlMaxRows + 1`・`onLimit = "error"`、書き込み前の件数判定は `executeInsertSelect` の confirm フック(`src/execute.ts:1789-1793`)が担う。`UPSERT_SELECT` の拒否(`tools.ts:642-644`)は**変更しない** |
| テスト(`src/mcp/__tests__/tools.test.ts`) | ① 既存の単文拒否テスト(`tools.test.ts:270` 付近)を成功テストに置換 / ② 成功: insertedCount と `postRecords` 呼び出し内容の検証 / ③ source 件数 > dmlMaxRows: `ArgumentError` かつ **`postRecords` 未呼び出し**をモックで検証 / ④ source 件数 > dmlMaxRows + 1: 読み取り上限(onLimit=error)で書き込み前に失敗 / ⑤ `allowDml` / `confirmText` / `dmlMaxRows` 欠落時の既存拒否が INSERT_SELECT でも効く |
| 完了条件 | 仕様 §6-1・§6-2(単文実行成功、超過時ゼロ書き込み) |

### U3: MCP — バッチ `tempOnlySource` ガードの削除(仕様 §2.1-2)

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts:563-569` — `mutateBatch` 静的ガードの INSERT_SELECT 分岐(throw とコメント)を削除 |
| 設計メモ | 混在ソースの拒否はエンジン層 `executeBatch` の validate-all-first(`src/execute.ts:388-397`)が実行前に担うため、MCP 層に静的ガードを残す必要はない。`dmlTotalMaxRows` は既存実装のままで機能する: INSERT VALUES は静的加算(`staticInsertTotal`)、INSERT_SELECT は confirm 経由で `totalAffected` に加算され(`tools.ts:608-619`)、`executeInsert`(VALUES)は confirm を呼ばないため二重計上なし(仕様 §3.2) |
| テスト(`src/mcp/__tests__/tools.test.ts`) | ① バッチ内 APP のみソース INSERT_SELECT: 成功 / ② `dmlTotalMaxRows`: INSERT VALUES(静的)+ INSERT_SELECT(confirm)の合算で超過時に中断、二重計上がないこと / ③ 混在ソース: エンジン層の U1 新メッセージで実行前拒否(validate-all-first) / ④ 回帰: temp のみソースのバッチ(v1.4.0 M4 経路)が引き続き成功 / ⑤ 回帰: `UPSERT_SELECT` 単文・バッチ拒否、WHERE なし UPDATE/DELETE 拒否 |
| 完了条件 | 仕様 §6-3・§6-4・§6-5 |

### U4: メタデータ更新 — description / `.describe()`(仕様 §4.3)

v1.4.1 の教訓どおり、**モデルに見えるメタデータはコードと同時に更新し、U5 の assertion で固定する**。

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/mcp/index.ts:97`(ksql_mutate description)。案: `Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. Supports multi-statement DML batches with temp tables. INSERT INTO app ... SELECT is supported (single statement or batch); the source may be apps or temp tables, but not both in one statement. The source SELECT reads at most dmlMaxRows + 1 records. UPSERT ... SELECT is rejected.` |
| 変更 2 | `src/mcp/schemas.ts:62-63`(dmlMaxRows の `.describe()`、**必須** — 仕様 §4.3-3)。案: `Per-statement cap on affected rows. The call fails before writing if any statement would exceed it. For INSERT ... SELECT this also caps the source SELECT read (at most dmlMaxRows + 1 records).` |
| 変更 3(任意) | `src/mcp/schemas.ts:56`(sql の `.describe()`)に単文 INSERT_SELECT 例を追記 |
| 設計メモ | description は「何ができるか」→「制約」の順・1〜3文+例1つの既存方針を踏襲。**「一時テーブルなら解決」と読める文言は書かない**(実体化も 10,000 行上限のため。仕様 §3.4)。読み取り上限の案内は dmlMaxRows describe 側に置き、description 側は1文に留める |
| テスト | U5 の smoke assertion で機械的に検証 |
| 完了条件 | tools/list の description・パラメータ説明に「単文 INSERT_SELECT 非対応」を示唆する文言が残っていない(仕様 §6-6) |

### U5: mcp-smoke assertion の差し替え(仕様 §4.5)

| 項目 | 内容 |
|---|---|
| 変更 | `scripts/mcp-smoke.mjs:90-94` — `mutateKeys` の旧キー `"Standalone INSERT_SELECT and UPSERT_SELECT are rejected"` を削除し、新 description のキー部分文字列に差し替え。加えて `dmlMaxRows` describe のキー部分文字列 assert を追加 |
| 新キー案 | `"INSERT INTO app ... SELECT is supported"` / `"UPSERT ... SELECT is rejected"`(mutateKeys)、`"caps the source SELECT read"`(dmlMaxRows describe) |
| 順序制約 | **U4 より先に assertion を差し替え、旧バンドル(`dist-mcp`)で smoke が失敗することを確認してから U4 を適用・再ビルドする**(v1.4.1 D5 と同じ regression 証明手順)。逆順だと「assertion が新旧どちらの文言でも通る」書き方になっていても気づけない |
| 任意追加 | `ksql_validate` の単文 INSERT_SELECT ケース(パースのみで API 不要。`statementType: "INSERT_SELECT"`・`isDml: true` を assert) |
| 禁止事項 | DML の**実行**は追加しない — mcp-smoke は API なし smoke(stdio 起動 + メタデータ assertion)であり、実行系は tools.test.ts(DI)と U7 に寄せる(仕様 §4.5、codex R1) |
| 完了条件 | 旧文言バンドルで smoke が落ち、U4 適用後のバンドルで通る |

### U6: ドキュメント更新(仕様 §4.4)

| ファイル | 変更内容 |
|---|---|
| `docs/ksql_mcp_server_spec.md` §7.5 | 許可する文に `INSERT_SELECT` を追加。「初期実装で拒否する文」を `UPSERT_SELECT` のみに |
| 同 §7.6 | 「現行 `executeInsertSelect` では confirm が呼ばれない」等の stale 記述を削除し、v1.4.0 で confirm フック実装済み・v1.5.0 で解禁済みに書き換え |
| 同 §7.6.1〜§7.6.3 | リスク表を仕様 §3.3 の再評価で更新。§7.6.2 の段階対応に達成状況を注記(1: v1.4.0 済 / 3: 不採用 / 4: v1.5.0 本件 / 5: 未着手)。§7.6.3 の confirm hook 拡張案は UPSERT_SELECT 対応時の課題として残す |
| `docs/ksql_mcp_changes.md` | v1.5.0 の変更履歴を追加(従来 `ArgumentError` だった呼び出しが書き込みを行うようになる挙動変化を明記) |
| `README.md` | ksql_mutate の対応 SQL 記述があれば更新(実装時に `INSERT_SELECT` / `INSERT ～ SELECT` で grep) |
| 仕様案・本計画 | ステータスと更新履歴(Rn)を更新 |

### U7: 実機検証

| 項目 | 内容 |
|---|---|
| 任意 | `scripts/mcp-kintone-smoke.mjs` に単文 INSERT_SELECT の実行ケースを追加(実 kintone 接続前提の smoke のためこちらに置く) |
| ユーザー実施 | Claude Desktop で MCP サーバー再起動(description はツール一覧取得時に読まれるため必須)→ 単文 `INSERT INTO APPx (...) SELECT ... FROM APPy` を依頼し、ksql_mutate が一発で選択・成功すること。v1.4.1 の発端事象の逆パターン(今度は「単文でも通る」ことの確認) |

## 3. 仕上げ(リリース手順)

1. `npm test`(全テスト)— 既存基準は v1.4.1 時点 594 件+本件追加分
2. `tsc --noEmit` — `src/ui/desktop.ts` に**既存エラー 10 件**があるため、件数比較(10 件基準)で新規エラーの有無を判定する(除外フィルタは使わない)
3. `package.json` を **1.5.0** に bump(D4 の仕組みにより serverInfo.version は自動同期 — smoke assertion が担保)
4. `dist-mcp` 再ビルド → `mcp:smoke` / `mcp:pack-smoke` パス
5. `release/ksql-mcp.js` 差し替え・MCPB 再パッケージ(`build-mcpb.mjs`)
6. npm publish(ユーザー操作)

## 4. リスクと留意点

- **後方互換**: 従来エラーだった呼び出しが成功(=書き込み発生)する方向の変化。既存の成功ケースの挙動・レスポンス形式は不変だが、`ksql_mcp_changes.md` に挙動変化として明記する(U6)
- **エラーメッセージ変更**(U1): 文字列依存のクライアントに影響し得るが、`ArgumentError:` 接頭辞と `code` 抽出形式(`toErrorPayload`)は不変
- **description 文言**: 長くしすぎない(1〜3文+例1つ)。「一時テーブルなら解決」と読める迂回案内は 10,000 行上限の併記なしには書かない(仕様 §3.4)
- **テストのモック注意**(v1.4.0 の教訓): SIMPLE モードの WHERE は REST に押し下げられるため、クエリを無視するモックでは絞り込まれない。INSERT_SELECT の source 件数テストは WHERE に頼らず**アプリ別のデータ内容**で件数を作る
- U5 の順序制約(assertion 先行 → 失敗確認 → U4 適用)を守らないと、regression ガードとして機能する証明が取れない
