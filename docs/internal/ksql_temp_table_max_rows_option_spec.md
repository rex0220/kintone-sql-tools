# tempTableMaxRows オプション公開 仕様案

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R5(実機確認・ユーザー決定): レコード編集画面で一時テーブル上限が保持されない問題に対応 — R3 の「保存SQL レコード連携フィールド対象外」を撤回し、任意フィールド `一時テーブル上限行`(数値)との連携を追加(§4.5)。フィールドがないアプリでは従来どおり(ガード付き)
  - 2026-07-11 R4(実機確認で発覚): プラグインの一時テーブル上限入力のスピナーが 1, 1001, 2001... と刻まれる問題を修正 — `min="10000"` / `step="10000"` に変更(min がステップの整列基準のため既定値に揃える。§4.5)
  - 2026-07-11 R3(プラグイン対応の追加・ユーザー決定): §2.2 の「プラグイン見送り」を撤回し、**案A(実行画面の取得オプションパネルに実行ごと指定を追加)** を v1.11.0 に同乗させる(§4.5 新設)。選定理由: 既存 `maxRecords` のモデル(パネルで実行ごと自由変更・localStorage 永続・clamp なし)と一貫し、`maxRecords` 自体が既に無制限に引き上げ可能なため一時テーブルだけ統制しても防御にならない。管理者設定(案B)・二段構え(案C)は不採用(実行ごとの柔軟性欠如 / 新統制モデルの持ち込みで一貫性が崩れるため)。保存SQL の kintone レコード連携フィールドは対象外(アプリ側のフィールド追加が必要になるため)
  - 2026-07-11 R2(codex レビュー反映): ①§5.2 の自己矛盾を修正 — `run_saved_query` の `dmlMaxRows` describe は「tempTableMaxRows で調整可」ではなく「単文限定のため一時テーブル非対応」の明示に変更(存在しない入力をモデルに示唆しない)②§2.2 の「dmlMaxRows + 1 超〜tempTableMaxRows 以内の迂回幅」記述を撤回 — v1.8.0 案A 以降、SELECT-based DML のソース読み取りは runtime maxRecords 解決(`resolveMutateRuntimeMaxRecords`、`src/mcp/tools.ts:314-319`)であり `dmlMaxRows + 1` では絞られない ③§3.3・§7-6 に env(envInt が不正値を null で無視しフォールスルー)/ profile(検証なし)の扱いを明記 ④§6 に `ksql_mcp_server_spec.md` / `ksql_cli_console_spec.md` / README HELP_SYNC ブロックを必須更新対象として明示
  - 2026-07-11 R1: 初版(ドラフト)
- ステータス: **レビュー済み・確定(codex R1〜R2 反映、R3 で指摘なし)**。実装は実装計画に従う
- 対象バージョン: v1.11.0(機能追加のため minor バンプ)
- 現行バージョン: v1.10.0
- 関連仕様: `docs/ksql_batch_temp_table_spec.md` §5.6(一時テーブル行数上限)、`docs/internal/ksql_mcp_insert_select_app_source_spec.md` §3.4(読み取り上限の迂回路と限界)
- 実装計画: [ksql_temp_table_max_rows_option_implementation_plan.md](ksql_temp_table_max_rows_option_implementation_plan.md)

## 1. 背景

### 1.1 現状の挙動(v1.10.0)

一時テーブル1個の実体化行数上限は `TEMP_TABLE_MAX_ROWS = 10_000`(`src/execute.ts:348`)。エンジン層にはこれを上書きする `BatchExecuteOptions.tempTableMaxRows`(`src/execute.ts:355-356`)が**既に存在**し、実体化時に

```ts
maxRecords: options.tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS,
onLimitReached: "error",
```

として適用される(`src/execute.ts:527-531`)。エンジンテストも存在する(`src/__tests__/executeBatch.test.ts:443`)。

しかし **MCP・CLI・プラグインのどの本番経路も `tempTableMaxRows` を渡していない**(insert_select_app_source 仕様 §3.4 でコード裏取り済み)。結果、全経路で 10,000 行固定である。

### 1.2 解消したい不整合

`maxRecords` には上限がなく(MCP スキーマは `z.number().int().positive()`、CLI `--max-records` も正整数のみ検証)、$id カーソルページングにより 10,000 件超の取得は技術的に可能。一方、一時テーブルの実体化だけは 10,000 行固定のため、次の非対称が生じている。

| ケース | 現状 |
|---|---|
| `maxRecords: 50000` のバッチ内の素の SELECT | 50,000 件返せる |
| 同じ SELECT を `CREATE TEMP TABLE ... AS` に包む | 10,000 行で実行時エラー(回避手段なし) |
| 10,000 行超のソースを一時テーブル経由で DML | 非対応(insert_select_app_source 仕様 §3.4 の既知の制約) |

### 1.3 目的

- 既存のエンジンオプション `tempTableMaxRows` を MCP ツール引数・CLI フラグ・環境変数・プロファイル設定として公開し、10,000 行超の一時テーブルを**利用者の明示操作**で許可できるようにする
- §5.6 の設計意図(サイレント欠損の防止)は変えない: **既定 10,000・超過時は常に error(truncate 不可)を維持**する

## 2. 変更概要

### 2.1 やること

| 層 | 変更 |
|---|---|
| MCP | `ksql_query` / `ksql_mutate` の入力に `tempTableMaxRows`(optional・正整数)を追加し、バッチ実行(`executeBatch`)へ受け渡す |
| ランタイム | `createKsqlRuntime` に解決チェーン(引数 → `KSQL_TEMP_TABLE_MAX_ROWS` → `profile.query.tempTableMaxRows` → undefined)を追加 |
| CLI | `--temp-table-max-rows` フラグを追加(env / profile の解決は MCP と対称) |
| プラグイン(R3) | 実行画面の「取得オプション」パネルに「一時テーブル上限(行)」入力を追加(§4.5)。空欄 = 既定 10,000。localStorage 永続 + SQL 履歴スナップショット |
| メタデータ | `dmlMaxRows` describe 等の「temp tables hold at most 10000 rows」を「既定 10,000・変更可」に更新し、mcp-smoke assertion で固定 |
| EXPLAIN | `src/execute.ts:2961` の行数上限表示を「既定」と明示する文言に変更 |
| ドキュメント | `ksql_batch_temp_table_spec.md` §5.6 改訂(R 追記)、`ksql_mcp_changes.md`、CHANGELOG |

### 2.2 やらないこと(非スコープ)

| 項目 | 扱い | 理由 |
|---|---|---|
| 既定値の変更 | しない(10,000 のまま) | 既定挙動の互換維持。§5.6 の値の根拠(fetchAll 既定との整合)も不変 |
| 超過時 truncate の許可 | しない(常に error のまま) | 暗黙の欠損が後続文を静かに歪める(§5.6 の核心)。本オプションは**数値の天井のみ**を変える |
| 上限キャップ(最大値制限) | 設けない | `maxRecords` が無制限である以上、ここだけキャップすると非対称。メモリリスクは describe・仕様書の注記で伝える(§3.4) |
| プラグイン設定画面(管理者設定)への追加 | しない(R3 で案B 不採用) | 実行ごとの柔軟性がなく MCP/CLI とモデルが揃わない。実行画面パネルへの追加(§4.5)で対応 |
| 保存SQL レコード連携フィールドへの追加 | **する(R5 で R3 を撤回・ユーザー決定)** | レコード編集画面ではパネル設定の保持先がレコードフィールドしかなく(localStorage は一覧ページ限定)、「最大取得件数」と同様の保持が求められた。**フィールドコード `一時テーブル上限行`(数値)を任意フィールド**とし、なければ従来どおり(ガード付きで無害)。アプリテンプレートへのフィールド追加はリリース時課題 |
| `ksql_run_saved_query` への追加 | しない | `requireSingleStatement`(`src/mcp/tools.ts:746-752`)により保存クエリは単文限定で、一時テーブルが出現し得ない |
| `ksql_explain` / `ksql_validate` / `ksql_describe_app` / `ksql_show_apps` への追加 | しない | 実体化を行わない(explain のバッチプランは静的生成) |
| `buildBatchExplainPlans` のシグネチャ変更 | しない | SQL のみを受ける静的関数(実行時オプションを知らない)。表示文言の修正のみで対応(§4.4) |
| SELECT-based DML のソース読み取り上限 | 変更しない | v1.8.0 案A 以降、SELECT-based DML を含む `ksql_mutate` のソース読み取りは runtime `maxRecords` 解決に委ねられており(`resolveMutateRuntimeMaxRecords`、`src/mcp/tools.ts:314-319`)、`dmlMaxRows` では絞られない。本オプションはそれとは独立に**一時テーブル実体化上限 10,000 の可変化**のみを行う(R2) |

## 3. 仕様詳細

### 3.1 オプション定義

- 名前: `tempTableMaxRows`(エンジン層の既存名をそのまま全層で使う。CLI は `--temp-table-max-rows`)
- 型: 正の整数。optional
- 意味: **バッチ内の一時テーブル1個あたり**の実体化行数上限。`CREATE TEMP TABLE ... AS SELECT` の実体化のみに効き、素の SELECT の取得上限(`maxRecords` / `onLimit`)とは独立
- 既定: 未指定時は `TEMP_TABLE_MAX_ROWS`(10,000)
- 超過時: 常に実行時エラー(`FetchAllLimitError`)。`onLimit` / `onLimitReached` の指定値に**かかわらず** error(既存挙動 `src/execute.ts:530` を維持)

### 3.2 解決順序(優先度の高い順)

`maxRecords`(`src/node/runtime.ts:74-77`・`src/cli/index.ts:1533`)と対称にする。

| 優先 | MCP | CLI |
|---|---|---|
| 1 | ツール引数 `tempTableMaxRows` | フラグ `--temp-table-max-rows` |
| 2 | 環境変数 `KSQL_TEMP_TABLE_MAX_ROWS` | 同左 |
| 3 | プロファイル `query.tempTableMaxRows` | 同左 |
| 4 | undefined(エンジン既定 10,000 が適用) | 同左 |

最終段を「undefined を渡してエンジン既定に委ねる」形にするのは、既定値 10,000 の定義箇所を `src/execute.ts:348` の1箇所に保つため(`?? 10_000` を各層に複製しない)。

### 3.3 バリデーション

- MCP: `z.number().int().positive()`(zod が拒否)
- CLI: `--max-records` と同じ正整数チェック(`src/cli/index.ts:355-358` のパターン)。エラーメッセージ: `ArgumentError: --temp-table-max-rows must be a positive integer.`
- env 値: `envInt` は正整数以外(0・負数・非整数・非数値)を null として**無視し、次段へフォールスルー**する(`src/node/config.ts:77-83`・`src/cli/index.ts:459-465`)。エラーにはしない
- profile 値(`query.tempTableMaxRows`): **検証しない**(JSON の値をそのまま流す)。`maxRecords` の前例(`profile.query?.maxRecords` も無検証)に合わせた設計判断。不正値の拒否を保証するのは zod(ツール引数)と CLI パーサ(フラグ)のみ(R2)

### 3.4 メモリリスクの注記(ドキュメント・describe に明記する)

一時テーブルはバッチ内に**同時最大16個**(§5.6)実体化され、参照は常にインメモリ FULL_SCAN。`tempTableMaxRows` を引き上げると「16 × 指定値」行がメモリに滞留し得る。describe / 仕様書には次を明記する:

- 既定 10,000 のまま使うことを推奨し、必要なバッチでのみ引き上げる
- 超過時は truncate を選べず常にエラーであること(黙って欠けたテーブルを後続文に参照させないため)

### 3.5 不変条件(レビュー時のチェックリスト)

1. `tempTableMaxRows` 未指定のとき、v1.10.0 と完全に同一挙動(既定 10,000・常に error)
2. `onLimit: "truncate"` を指定しても一時テーブルの実体化は error(素の SELECT のみ truncate)
3. 素の SELECT の取得上限は従来どおり `maxRecords` / `onLimit` が支配し、`tempTableMaxRows` の影響を受けない(逆も同様)
4. `ksql_mutate` の書き込みガード(`dmlMaxRows` / `dmlTotalMaxRows`)は本オプションと独立に機能する(実体化は読み取りのみで、confirm フックの件数判定は不変)
5. 単文入力の CREATE/DROP TEMP TABLE 拒否・一時テーブル参照拒否(§5 の既存仕様)は不変

## 4. 変更点一覧

### 4.1 src/node(ランタイム・設定)

- `src/node/runtime.ts:28-38` `CreateKsqlRuntimeInput` に `tempTableMaxRows?: number` を追加
- `src/node/runtime.ts:40-49` `KsqlRuntime` に `tempTableMaxRows?: number` を追加(undefined 許容)
- `src/node/runtime.ts:74-77` 付近に解決チェーン(§3.2)を追加
- `src/node/config.ts:26-30` `query` 設定型に `tempTableMaxRows?: number` を追加

### 4.2 src/mcp(スキーマ・ツール)

- `src/mcp/schemas.ts` 共有定義として `tempTableMaxRows` を追加(`maxRecords` の隣。describe 案は §5.1)し、`queryInputSchema` と `mutateInputSchema` に組み込む
- `src/mcp/tools.ts:461-479`(query バッチ): `createRuntime` 入力と `executeBatchSql` オプションに `tempTableMaxRows` を受け渡し
- `src/mcp/tools.ts:565-598`(mutateBatch): 同上
- 単文経路(`tools.ts:503-521` ほか)は変更なし(単文に一時テーブルは出現しない)

### 4.3 src/cli

- ヘルプ(`src/cli/index.ts:73` 付近)に `--temp-table-max-rows <n>` を追加
- args 型(`:177` 付近)・初期値(`:227` 付近)・パーサ(`:355-358` のパターン)に追加
- `pushOpt`(`:924`)に追加 — **REPL console 子実行への伝搬**(見落としやすい)
- 解決(`:1533` 付近)に §3.2 のチェーンを追加
- `executeBatch` 呼び出し(`:1904-1919`)に `tempTableMaxRows` を追加(単文 `execute` 経路には渡さない)

### 4.4 src/execute.ts(表示文言のみ)

- `:2961` の EXPLAIN プラン行を変更
  - 現行: `` rows: 実体化前のため不明（上限 ${TEMP_TABLE_MAX_ROWS} 行、超過はエラー） ``
  - 変更後: `` rows: 実体化前のため不明（既定上限 ${TEMP_TABLE_MAX_ROWS} 行、tempTableMaxRows で変更可、超過はエラー） ``
  - `buildBatchExplainPlans` は SQL のみを受ける静的関数のため実効値は表示できない。「既定」と明示することで虚偽表示を避ける(実効値表示が必要になったらシグネチャ変更を別提案)

### 4.5 src/ui/desktop.ts(プラグイン実行画面。R3)

- **取得オプションパネル**(`buildFetchOptionsPanel`): 「最大取得件数」の下に「一時テーブル上限(行)」の数値入力を追加(id: `ksql-temp-table-max-rows-input`)。placeholder は「10000（既定）」、注記に「空欄 = 既定 10,000。超過は常にエラー（『打ち切って続行』は適用されません）」を表示
- **スピナー刻み**(R4): `min="10000"` / `step="10000"` — number input のステップは min を整列基準にするため、既定値と同じ 10000 に揃える(空欄から ▲ で 10000 に入り、以降 20000, 30000...)。当初の `min="1"` / `step="1000"` は空欄 → 1 → 1001 → 2001... となり実用に反した。10000 未満はスピナーでは選べないが手入力は可能(`sanitizeTempTableMaxRows` が受理)
- **値の意味**: 空欄・不正値(0以下・非整数)は `undefined` = エンジン既定に復帰(`sanitizeMaxRecords` の「3000 に戻す」とは異なり、既定復帰が正しい挙動)
- **永続化**: `FETCH_OPTIONS_KEY` の localStorage 形式に `tempTableMaxRows?: number` を追加(旧形式は undefined 扱いで後方互換)
- **実行時解決**: `resolveRuntimeFetchOptions` が「取得」タブ表示中は DOM 現在値、非表示時は呼び出し元フォールバック値を使う(maxRecords と同じ2段構え)
- **レコードページの保持**(R5): 保存SQL アプリの任意フィールド **`一時テーブル上限行`(数値)** と連携 — `mountRecordPanel` が `parseTempTableMaxRowsFromRecord` で復元して `initialTempTableMaxRows` として渡し、`syncRecordFieldsFromSpacePanel`(submit 時)がパネル値を書き戻す(未指定 = 空欄)。フィールドがないアプリでは従来どおり保持されない(`if (record["一時テーブル上限行"])` ガード)。change イベント購読にも追加(フィールドがなければ発火しないだけで無害)
- **受け渡し**: バッチ経路(`runBatchSql` → `executeBatch`)のみに渡す。単文経路は一時テーブルが出現しないため変更なし
- **SQL 履歴**: `SqlHistoryItem` に `tempTableMaxRows?` をスナップショット保存し、履歴からの再実行時に復元(undefined 許容)
- **オプションサマリ表示**(`refreshOptSummary`): 指定時のみ「/ 一時 20000」のように付記(未指定時は非表示 = 既定)
- **不変条件**: DML バッチの `onLimitReached: "error"` 固定(v1.9.0 §3.6)とは独立・無干渉。一時テーブル実体化はエンジン層で常に error(パネルの「上限到達時」ラジオの対象外)

## 5. モデル向けメタデータ(v1.4.1 の教訓: コードと同時に更新し smoke で固定)

### 5.1 新規 describe 案(`src/mcp/schemas.ts` 共有定義)

> Per-temp-table cap on materialized rows for CREATE TEMP TABLE ... AS SELECT (default 10000). Overflow always errors — 'truncate' never applies to temp tables, so downstream statements never see silently truncated data. Raising this increases memory use (up to 16 temp tables per batch); prefer narrowing the SELECT with WHERE.

### 5.2 既存文言の更新

- `src/mcp/schemas.ts:63`(ksql_mutate `dmlMaxRows`): 「temp tables hold at most 10000 rows」→「temp tables hold at most 10000 rows by default (adjustable via tempTableMaxRows)」
- `src/mcp/schemas.ts:125`(ksql_run_saved_query `dmlMaxRows`): **同形に揃えない**(R2)。このツールに `tempTableMaxRows` 入力は存在しないため(§2.2)、「adjustable via tempTableMaxRows」と書くとモデルが存在しない入力を使おうとする。代わりに temp table 節を削除し「Saved queries are single-statement, so temp tables do not apply here.」形に変更する(オプション名は出さない)
- `src/mcp/index.ts` の `ksql_query` / `ksql_mutate` description に同上の phrasing があれば同時更新(実装時に `hold at most` で grep して全箇所を洗い出す)。原則: **`tempTableMaxRows` に言及してよいのは、その入力を実際に受け付けるツール(`ksql_query` / `ksql_mutate`)のメタデータのみ**

### 5.3 mcp-smoke assertion(`scripts/mcp-smoke.mjs`)

- `:105` の固定フレーズ `"temp tables hold at most 10000 rows"` → 新文言(`"by default (adjustable via tempTableMaxRows)"` を含む形)に差し替え
- `:127-129` の described パラメータリスト: `ksql_query` / `ksql_mutate` に `"tempTableMaxRows"` を追加
- 順序制約: **assertion を先に差し替え、旧バンドルで smoke が失敗することを確認してから実装を当てる**(insert_select_app_source 実装計画 U5 と同じ regression ガード方式)

## 6. ドキュメント更新

| ファイル | 内容 |
|---|---|
| `docs/ksql_batch_temp_table_spec.md` | §5.6 の表を「10,000(既定。`tempTableMaxRows` で変更可、超過は常に error)」に改訂 + 更新履歴に R 追記(v1.11.0)。§3.4 のメモリ注記(16 × 指定値)も追加 |
| `docs/internal/ksql_mcp_insert_select_app_source_spec.md` | §3.4 の「MCP 経由では 10,000 行上限を変更できない」が失効するため、本仕様への参照を追記(履歴 R 追記) |
| `docs/ksql_mcp_server_spec.md` | `ksql_query` / `ksql_mutate` の入力スキーマ表に `tempTableMaxRows` を追加(R2) |
| `docs/ksql_cli_console_spec.md` | CLI オプション表に `--temp-table-max-rows` を追加。console 子実行への伝搬(`pushOpt`)にも言及(R2) |
| `README.md` | `BEGIN_HELP_SYNC`〜`END_HELP_SYNC` ブロック(`:109-168`)に `--temp-table-max-rows` 行を追加 — **CLI ヘルプ(`src/cli/index.ts:73` 付近)と同時に更新**する(R2) |
| `docs/ksql_mcp_changes.md` | v1.11.0 エントリ追加 |
| `docs/ksql_language_reference.md` ほか利用者向け | 一時テーブル上限に言及する箇所を grep(`10,000` / `一時テーブル`)して「既定」と明示 |
| `CHANGELOG.md` | v1.11.0 追加 |

## 7. 受け入れ条件

1. `ksql_query` バッチで `tempTableMaxRows: 20000` を指定すると 10,001〜20,000 行の一時テーブルが実体化できる
2. 同バッチで未指定なら従来どおり 10,001 行目でエラー(メッセージは既存の `FetchAllLimitError` 形式)
3. `onLimit: "truncate"` + 一時テーブル超過の組み合わせで、素の SELECT は truncate されつつ実体化は error
4. `ksql_mutate` バッチ(temp ソース DML)で `tempTableMaxRows` が効き、`dmlMaxRows` / `dmlTotalMaxRows` の判定は不変
5. CLI `--temp-table-max-rows` / env `KSQL_TEMP_TABLE_MAX_ROWS` / profile `query.tempTableMaxRows` が §3.2 の優先順で解決される(console 子実行にも伝搬)
6. `tempTableMaxRows: 0` / 負数 / 非整数は zod(ツール引数)/ CLI パーサ(フラグ)で拒否される。**env は不正値を無視してフォールスルー、profile 値は検証対象外**(§3.3。`maxRecords` の前例どおり)
7. mcp-smoke が新メタデータで green(旧バンドルでは red)
8. プラグイン(R3): 取得オプションパネルで一時テーブル上限を指定したバッチ実行が `executeBatch` に値を渡す。空欄なら undefined(既定 10,000)。localStorage への保存・復元、履歴スナップショットからの復元が機能する
9. プラグイン(R3): 「上限到達時: 打ち切って続行」を選んでいても一時テーブルの実体化超過はエラー(§3.5-2 と同じ不変条件が UI 経路でも成立)
