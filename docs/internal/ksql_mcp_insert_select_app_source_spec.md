# ksql_mutate INSERT_SELECT(APP ソース)解禁 仕様案

- 対象バージョン: v1.5.0(機能追加のため minor バンプ)
- 現行バージョン: v1.4.1
- ステータス: **レビュー済み・確定(codex R1〜R2)**。実装は実装計画に従う
- 関連仕様: `docs/ksql_mcp_server_spec.md` §7.5〜§7.6.3、`docs/ksql_batch_temp_table_spec.md`(M4)
- 実装計画: [ksql_mcp_insert_select_app_source_implementation_plan.md](ksql_mcp_insert_select_app_source_implementation_plan.md)

## 1. 背景

### 1.1 現状の挙動(v1.4.1)

`INSERT INTO APPx (...) SELECT ...`(INSERT_SELECT)の `ksql_mutate` での扱いは、SELECT ソースの種類で決まる。

| ケース | 例 | 現状 | 判定箇所 |
| --- | --- | --- | --- |
| 単文・APP ソース | `INSERT INTO APP4149 (顧客No_) SELECT 顧客No_ FROM APP99` | 拒否 | `src/mcp/tools.ts:636-641` |
| バッチ内・APP のみソース | 上記 + 他の文 | 拒否 | `src/mcp/tools.ts:565-569` |
| バッチ内・一時テーブルのみソース | `CREATE TEMP TABLE #t AS SELECT ...; INSERT INTO APPx (...) SELECT ... FROM #t;` | 許可(v1.4.0 M4) | `tempOnlySource` 判定(`src/core/batch.ts:178-183`) |
| バッチ内・混在ソース(APP + 一時テーブル) | `INSERT ... SELECT ... FROM #t JOIN APP99 ...` | 拒否 | エンジン層 `src/execute.ts:388-397` |

なお、この制限は MCP 層のみのもの。プラグイン(確認ダイアログ付き)・CLI では単文 APP ソースの INSERT_SELECT は従来から実行可能であり、コアエンジン `executeInsertSelect()` は単文・バッチの両経路をサポート済み(`src/execute.ts:290`, `src/execute.ts:516`)。

### 1.2 当初の拒否根拠と失効状況

MCP 仕様書 §7.6 が挙げた拒否根拠は2つ。

1. **書き込み確認より前に source SELECT の API 読み取りが発生する**
2. **「現行 `executeInsertSelect` では `ExecuteOptions.confirm` が呼ばれない」ため `dmlMaxRows` ガードが効かない**

根拠 2 は **v1.4.0 で失効**。バッチ対応(M4)の実装で `executeInsertSelect()` に書き込み前 confirm フックが追加され(`src/execute.ts:1789-1793`)、source SELECT 実行後・POST 前に件数確定 → `dmlMaxRows` 判定が効く。仕様書 §7.6 の該当記述は実装と食い違ったまま残っている。

根拠 1 も MCP の利用実態では実質的な差がない。推奨されているバッチ形(`CREATE TEMP TABLE #t AS SELECT ...; INSERT ... FROM #t`)は、**同じ `ksql_mutate` 呼び出し・同じ承認(allowDml / confirmText / dmlMaxRows)の下で同じ APP 読み取りと書き込みを行う**。単文形を拒否してバッチ形へ誘導しても、確認前読み取りの防止にはなっていない。

### 1.3 目的

- APP ソースの INSERT_SELECT を `ksql_mutate` で実行可能にする(単文・バッチとも)
- 「単文 NG・temp ソースバッチ OK」という見かけ上の非対称を解消する
- 仕様書 §7.6 の stale な記述を現実装に合わせて更新する

## 2. 変更概要

### 2.1 解禁するもの

1. **単文の APP ソース INSERT_SELECT**(`src/mcp/tools.ts:636-641` の拒否を削除)
2. **バッチ内の APP のみソース INSERT_SELECT**(`src/mcp/tools.ts:565-569` の `tempOnlySource` 必須ガードを削除)

2 は 1 と不可分。単文だけ解禁すると「単文 OK・同じ文がバッチだと NG」という逆向きの非対称が生じるため、セットで行う。

### 2.2 変更しないもの(非スコープ)

| 項目 | 扱い | 理由 |
| --- | --- | --- |
| `UPSERT_SELECT` | 単文・バッチとも従来どおり拒否 | insert/update 件数が既存レコード照合後まで確定せず、`dmlMaxRows` の意味が曖昧(仕様書 §7.6.2 のとおり別フェーズ) |
| 混在ソース(APP + 一時テーブル)の INSERT_SELECT | 従来どおり拒否(エンジン層 `src/execute.ts:390` が `tempOnlySource` を要求) | エンジン仕様の変更は本件のスコープ外。エラーメッセージのみ改善(§4.2) |
| DML(UPDATE 等)内の一時テーブル参照 | 従来どおり拒否 | 同上 |
| プラグイン / CLI | 変更なし | 従来から実行可能 |
| `ksql_validate` / `ksql_explain` | 変更なし | `tempOnlySource` の報告・INSERT_SELECT のプラン生成(`buildInsertSelectPlan`)は実装済み |

### 2.3 新フラグは追加しない(設計判断)

仕様書 §7.6.2 は将来案として `allowSelectBasedDml: true` の追加を挙げていたが、**追加しない**ことを提案する。

- フラグ案は「confirm 未実装で `dmlMaxRows` が効かない」時代の前提に立った危険操作の明示化だった。confirm フック実装済みの現在、INSERT_SELECT は他の DML と同じガード(静的検証 + 実行時 confirm)の下にあり、追加の承認レイヤが守るものがない
- `allowDml: true` + `confirmText: "yes"` + `dmlMaxRows` で書き込み承認は既に明示されている
- MCP クライアント(LLM)にとって入力仕様の分岐が増えることは誤用・誤学習の温床になる(v1.4.1 でツール説明文の誤学習対策を行った経緯と同方向)

代替案としてフラグを採用する場合は `mutateInputSchema` に optional boolean を追加し、未指定時は従来どおり拒否とする(本仕様案では不採用)。

## 3. 安全モデル

解禁後の APP ソース INSERT_SELECT に効くガードを整理する。**新規実装はなく、すべて既存機構**である点が本提案の要点。

### 3.1 実行フロー(単文)

1. `requireDmlApproval`: `allowDml: true` / `confirmText: "yes"` / `dmlMaxRows`(正整数)を検証(`src/mcp/tools.ts:341-357`)
2. `validate()`: パース・分類(validate-all-first)。INSERT_SELECT は `insertValuesCount = null` のため静的件数チェックの対象外
3. ランタイム生成: `maxRecords = dmlMaxRows + 1`、`onLimit = "error"`(`src/mcp/tools.ts:652-659`)
4. `executeInsertSelect()`:
   1. source SELECT を実行(読み取りは `maxRecords` 上限下。超過は実行時エラーで書き込み前に中断)
   2. 列数チェック(SELECT 列数 = INSERT フィールド数)
   3. **confirm フック**: `confirm(rows.length, "INSERT")` → `rows.length > dmlMaxRows` なら `ArgumentError`、POST は一切行われない(`src/execute.ts:1789-1793`)
   4. フィールド型取得 → 型変換 → 100 件ごとに POST

### 3.2 実行フロー(バッチ)

- 静的ガード(validate-all-first): 1文でも違反すればバッチ全体を実行前に拒否(既存)
- 実行時: `executeInsertSelect` の confirm が `mutateBatch` の confirm 実装に届き、文単位の `dmlMaxRows` 判定と `totalAffected` への加算 → `dmlTotalMaxRows` 判定が行われる(`src/mcp/tools.ts:608-619`)。INSERT VALUES は静的加算・INSERT_SELECT は confirm 加算のため二重計上はない(`executeInsert` は confirm を呼ばない)
- DML バッチは常に fail-fast(既存仕様を維持)

### 3.3 リスク評価(仕様書 §7.6.1 の再評価)

| §7.6.1 のリスク | 解禁後の評価 |
| --- | --- |
| 確認前の API 読み取り | `ksql_mutate` 呼び出し自体が承認(allowDml / confirmText)。temp テーブル経由のバッチ形と読み取りタイミング・量は同等 |
| INSERT_SELECT の confirm 不足 | v1.4.0 で解消済み(書き込み前 confirm 実装済み) |
| MCP 側 preflight の二重実行 / TOCTOU | preflight を行わない方式(エンジン内 confirm)のため発生しない。SELECT 結果を実体化してから POST するため、confirm 時点の件数と書き込み件数は一致する |
| 大量読み取り | source SELECT は `maxRecords = dmlMaxRows + 1`・`onLimit = "error"` の下で実行され、読み取り増幅は書き込み上限に拘束される |

### 3.4 既知の制約(ドキュメントに明記する)

source SELECT の読み取り上限が `dmlMaxRows + 1` であるため、**集計・JOIN で「読み取りは多いが結果行は少ない」ソース**は読み取り上限エラーになり得る。迂回路と限界は次のとおり(R1)。

- 読み取り行数が `dmlMaxRows + 1` 超〜 `TEMP_TABLE_MAX_ROWS`(10,000 行、`src/execute.ts:317`)以内: 一時テーブル経由のバッチ形で回避可能。ただし `CREATE TEMP TABLE` の実体化も `maxRecords = tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS`・`onLimitReached: "error"` 固定で実行され(`src/execute.ts:479-483`)、かつ `mutateBatch` は `tempTableMaxRows` を渡さないため **MCP 経由では 10,000 行上限を変更できない**
- 読み取り行数が 10,000 行超(例: 10 万行を GROUP BY して 50 行を INSERT): **一時テーブル経由でも読み取り上限エラーになり非対応**。source SELECT 読み取り上限の分離(§7-3)までは要件外とする

エラーメッセージ・ツール説明文で迂回路を案内する際は、「一時テーブルなら解決」と読める表現を避け、上記の上限(10,000 行)を併記する(MCP クライアントの LLM に誤った回避策を学習させないため。v1.4.1 の教訓と同方向)。

## 4. 変更点一覧

### 4.1 src/mcp/tools.ts

1. **単文拒否の削除**(`tools.ts:634-641`): `INSERT_SELECT is not supported by ksql_mutate as a single statement.` の throw と誘導コメントを削除。以降は既存の単文 DML 経路(confirm 付き `executeSql`)に乗る
2. **バッチガードの削除**(`tools.ts:563-569`): `INSERT_SELECT in a batch must select from temp tables only.` の throw を削除。混在ソースはエンジン層の validate-all-first(`executeBatch` 冒頭)が実行前に拒否するため、MCP 層の静的ガードとしての役割は残らない

### 4.2 src/execute.ts(エラーメッセージのみ)

`src/execute.ts:393` のメッセージを実態に合わせて変更する。

- 現行: `ArgumentError: INSERT_SELECT in a batch must select from temp tables only. (statement N)`
- 変更案: `ArgumentError: INSERT_SELECT mixing app and temp table sources is not supported. Select from apps only, or materialize the app data into a temp table first (temp tables hold at most ${TEMP_TABLE_MAX_ROWS} rows). (statement N)`

「temp tables only」のままだと、APP のみソースを解禁した後に混在ソースで失敗した利用者(および MCP クライアントの LLM)へ誤った制約を学習させるため。迂回案内には §3.4 のルールどおり実体化上限を併記する(R3)。上限値はハードコードせず同一ファイルの `TEMP_TABLE_MAX_ROWS` を補間する。このメッセージはエンジン層(`executeBatch`)のもので CLI / プラグインからも到達するが、`tempTableMaxRows` を渡す本番経路は存在しない(テストのみ)ため、上限 10,000 行は全経路で正しく、「MCP では」等の経路限定は書かない。

### 4.3 ツール説明文・スキーマ(MCP クライアント誤学習対策)

v1.4.1 の説明文修正(PR #4)と同様、実装と説明文の同期を必須とする。

1. `src/mcp/index.ts:97`(ksql_mutate description):
   - 現行: `INSERT INTO app ... SELECT is allowed in a batch when it selects only from temp tables (...). Standalone INSERT_SELECT and UPSERT_SELECT are rejected.`
   - 変更案: `INSERT INTO app ... SELECT is supported (single statement or batch); sources may be apps or temp tables, but not both in one statement. UPSERT ... SELECT is rejected.`
2. `src/mcp/schemas.ts:56`(mutateInputSchema.sql の describe): 例示はそのままで可。必要なら単文 INSERT_SELECT 例を追記
3. `src/mcp/schemas.ts:62-63`(dmlMaxRows の describe): INSERT_SELECT では source SELECT の読み取り上限(dmlMaxRows + 1)を兼ねる旨を追記する(**必須**。R1 で任意から格上げ。§3.4 の制約は describe に書かれていない限りクライアントから観測できないため)

### 4.4 ドキュメント

| ファイル | 変更内容 |
| --- | --- |
| `docs/ksql_mcp_server_spec.md` §7.5 | 許可する文に `INSERT_SELECT` を追加、「初期実装で拒否する文」から削除(`UPSERT_SELECT` のみ残す) |
| 同 §7.6 | 「現行 `executeInsertSelect` では confirm が呼ばれない」等の stale 記述を削除し、v1.4.0 で confirm フック実装済み・v1.5.0 で解禁済みと書き換え |
| 同 §7.6.1〜§7.6.3 | リスク表を §3.3 の再評価内容で更新。§7.6.2 の段階対応リストに達成状況を注記(1: v1.4.0 済 / 3: 不採用(§2.3) / 4: v1.5.0 本件 / 5: 未着手)。§7.6.3 の confirm hook 拡張案(object 引数化)は UPSERT_SELECT 対応時の課題として残す |
| `docs/ksql_mcp_changes.md` | v1.5.0 の変更履歴を追加 |
| `README.md` | ksql_mutate の対応 SQL 一覧に記載があれば更新 |

### 4.5 テスト

| 対象 | ケース |
| --- | --- |
| `src/mcp/__tests__/tools.test.ts` | 既存の単文拒否テスト(`tools.test.ts:270` 付近)を「成功する」テストに置換 |
| 同上(新規) | 単文 APP ソース INSERT_SELECT: 成功(insertedCount 検証)/ source 件数が dmlMaxRows 超過で `ArgumentError`・POST 未実行 / allowDml・confirmText 欠落で拒否 |
| 同上(新規) | バッチ内 APP のみソース INSERT_SELECT: 成功 / `dmlTotalMaxRows` 超過で中断(INSERT VALUES との合算) |
| 同上(新規) | 混在ソース INSERT_SELECT バッチ: エンジン層の新メッセージで実行前拒否 |
| 同上(回帰) | temp のみソースのバッチ(M4 経路)が引き続き成功 / `UPSERT_SELECT` が単文・バッチとも拒否 |
| `src/__tests__/executeBatch.test.ts` | 4.2 のメッセージ変更に伴う期待値更新 |
| `scripts/mcp-smoke.mjs` | **description / schema の regression assertion のみ**(§4.3 の新説明文の文言固定。dmlMaxRows describe の追記も対象)。API なし smoke のため DML 実行は追加しない(R1)。任意で `ksql_validate` の単文 INSERT_SELECT ケース(パースのみで API 不要)を追加可 |
| `scripts/mcp-kintone-smoke.mjs` | 実機での単文 INSERT_SELECT 実行ケースを任意で追加(実 kintone 接続前提の smoke のためこちらに寄せる。R1) |

## 5. 互換性

- **後方互換**: 従来 `ArgumentError` で失敗していた呼び出しが成功するようになる方向の変更のみ。既存の成功ケースの挙動・レスポンス形式は不変
- エラーメッセージ文言の変更(§4.2)があるため、メッセージに依存するテスト・クライアントは追随が必要
- `ksql_validate` の出力スキーマは不変(`tempOnlySource` フィールドは情報提供として維持)

## 6. 受け入れ基準

1. `ksql_mutate` で単文 `INSERT INTO APPx (...) SELECT ... FROM APPy ...` が実行でき、挿入件数が返る
2. source SELECT の結果件数が `dmlMaxRows` を超える場合、**1件も書き込まれずに** `ArgumentError` で失敗する
3. 同じ文をバッチに含めても同様に動作し、`dmlTotalMaxRows` の合算対象になる
4. 混在ソースの INSERT_SELECT は実行前に新メッセージで拒否される
5. temp のみソースのバッチ(v1.4.0 M4)・`UPSERT_SELECT` 拒否・WHERE なし UPDATE/DELETE 拒否は回帰しない
6. ツール説明文・仕様書に「単文 INSERT_SELECT 非対応」の記述が残っていない

## 7. 未決事項(R2 ですべて確定)

1. ~~`allowSelectBasedDml` フラグを追加しない判断でよいか~~ → **追加しない**(R2 で確定)
2. ~~§4.3-3 の `dmlMaxRows` describe への読み取り上限の追記を行うか~~ → **行う**(R1 で確定、§4.3-3 に反映済み)
3. ~~source SELECT の読み取り上限を `dmlMaxRows + 1` から分離するか~~ → **v1.5.0 では現状維持、将来課題**(R2 で確定)

## 更新履歴

- R5(2026-07-11、v1.11.0 追従): §3.4 の「MCP 経由では 10,000 行上限を変更できない」が v1.11.0 で失効 — `tempTableMaxRows` が MCP `ksql_query`/`ksql_mutate` の tool input・CLI・env・profile として公開された(既定 10,000・超過は常に error は不変)。仕様は `docs/internal/ksql_temp_table_max_rows_option_spec.md`。本文 §3.4 は歴史的経緯として当時のまま(v1.5.0 時点の記述)
- R4(2026-07-10、codex・Medium、実装後レビュー): `ksql_run_saved_query` の `dmlMaxRows` describe が読み取り上限に追従していなかった点を修正。DML 保存クエリ経路は `mutate()` 委譲(`src/mcp/tools.ts` runSavedQuery)のため保存済み INSERT_SELECT にも `dmlMaxRows + 1` の source 読み取り上限が効く。describe に同文言を追記し、smoke の dmlMaxRows assertion を `ksql_mutate` / `ksql_run_saved_query` の両ツールに拡張(§4.3・§4.5 の対象漏れ)
- R3(2026-07-10、codex・Medium): §4.2 の混在ソース拒否メッセージが §3.4 のルール(迂回案内には実体化上限を併記)に自己矛盾していたため修正。`materialize the app data into a temp table first (temp tables hold at most ${TEMP_TABLE_MAX_ROWS} rows)` 形式に変更し、定数補間・経路非依存の注記を追加(`tempTableMaxRows` を渡す本番経路がないことをコードで裏取り済み)
- R2(2026-07-10、codex レビュー完了): 追加指摘なし。未決事項3点を確定(フラグ不採用 / dmlMaxRows describe 追記必須 / 読み取り上限分離は将来課題)。ステータスを「レビュー済み・確定」に変更し、実装計画ドキュメントを作成
- R1(2026-07-10、codex): §3.4 の迂回路説明を修正 — 一時テーブル経由も実体化が `TEMP_TABLE_MAX_ROWS = 10,000` 行・error 固定(`src/execute.ts:479-483`)かつ MCP からは上限変更不可のため、「一時テーブルなら解決」ではなく 10,000 行以内に限る旨を明記し、10 万行例を非対応側に移動。§4.5 の `mcp-smoke.mjs` 計画を撤回 — 同 smoke は API なし(stdio 起動 + description/schema assertion のみ)のため DML 実行を追加せず、実行系は `tools.test.ts`(DI)・実機は `mcp-kintone-smoke.mjs` に寄せる。§4.3-3(dmlMaxRows describe への読み取り上限追記)を任意から必須へ格上げ。
