# tempTableMaxRows オプション公開 実装計画

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R8(T9 実装完了): 取得オプションパネルに「一時テーブル上限(行)」入力(id: `ksql-temp-table-max-rows-input`・placeholder「10000（既定）」・注記付き)、`StoredFetchOptions` / SQL 履歴への `tempTableMaxRows?` 追加(旧形式後方互換)、`resolveRuntimeFetchOptions` の2段解決 + 保存SQL 等の未指定経路は `latestPanelTempTableMaxRows` フォールバック、`runBatchSql` → `executeBatch` 受け渡し(単文経路は不変)、オプションサマリ「/ 一時 N」(指定時のみ)、CSS `.ksql-fetch-note` 追加。空・不正値は undefined = 既定復帰(`sanitizeTempTableMaxRows`)。検証: tsc 10件基準(desktop.ts 以外エラーなし)・build:plugin 成功・prod/js/desktop.js に ASCII マーカー入り・UI テスト green。T9 のテスト方針を実態に修正(desktop.ts は kintone グローバル依存のため単体テスト対象外 — v1.9.0 慣例)
  - 2026-07-11 R7(プラグイン対応 T9 追加・ユーザー決定): 仕様 R3(案A: 実行画面の取得オプションパネル)を受けて T9 を追加。対象は `src/ui/desktop.ts` のみ — パネル入力(`ksql-temp-table-max-rows-input`)・localStorage(`FETCH_OPTIONS_KEY` 拡張・後方互換)・`resolveRuntimeFetchOptions`・`runSql`/`runBatchSql`/`executeBatch` 受け渡し(バッチ経路のみ)・SQL 履歴スナップショット・オプションサマリ。保存SQL レコード連携フィールドは対象外。prod/ 再ビルド + plugin zip はリリース時(T8-3)
  - 2026-07-11 R6(codex レビュー反映・Low): T8-2 の「`build:mcp` → dist-mcp + release/ksql-mcp.js」が実態と不一致だった — `build-mcp.mjs` の outfile は `dist-mcp/ksql-mcp.js` のみで release/ へは書き出さない(コードで裏取り)。T8-2 を dist 系の再生成のみに修正し、release/ へのコピーは T8-3 の「bump 後の明示手順」として分離(自動反映されないことを明記)
  - 2026-07-11 R5(codex 実装後レビュー反映): ①`prod/js/desktop.js`(T4 の EXPLAIN 文言によるバンドル差分)が未コミットだった → tracked バンドルはソースと同期させる方針でブランチにコミット(9534b3f。リリース時の bump 再ビルドで再更新される)②`release/ksql-mcp.js` / `.mcpb` の stale は**意図的な繰り延べ** — 今差し替えると VERSION.txt 1.10.0 の release/ に v1.11.0 機能入りバンドルという不整合が生じるため、慣例どおりリリース時にバージョン bump と同時に差し替える(T8-3)。npm publish は `prepack` が再ビルドするため release/ の古さは直撃しない(codex 確認と一致)
  - 2026-07-11 R4(実装完了): T1〜T7 実装済み(ブランチ `feat/temp-table-max-rows-option`、ステップごとにコミット)。T5 は計画どおり assertion 先行 → 旧バンドル(v1.10.0 dist-mcp)で `ksql_query.tempTableMaxRows input is missing.` の fail を確認してから T6 を適用(regression ガード証明済み)。テスト: runtime 解決チェーン5件 / MCP スキーマ・受け渡し・不変条件7件(10,001 行実体化の成功・未指定回帰・truncate 不適用・dmlMaxRows 独立)/ CLI パース・console 伝搬3件。jest 731 件パス(console.e2e の1件は既知の並列コールドラン・フレークで単独再実行 green)・tsc 既存10件のみ・`npm run build` 全成果物・mcp:smoke / mcp:pack-smoke / mcpb:verify ok・dist-cli 直実行でフラグ受理 + 新 EXPLAIN 文言を確認。テスト都合の変更: `buildReplExecArgv` を export(パターン: parseArgs 等のテスト用 export と同型)。残り: T8-4 実機確認(ユーザー実施)・PR 作成・リリース(バージョン bump はリリース時)
  - 2026-07-11 R3(codex レビュー反映): ①T8 — 成果物再生成を `npm run build` 全体に明示(`bin.ksql` は `dist-cli/ksql.js` を指すため T3 のフラグ追加は **build:cli 必須**。加えて T4 の EXPLAIN 文言変更で `src/execute.ts` → `prod/js/desktop.js` も変わるため、v1.7.0 の教訓どおりプラグイン zip の再パッケージ・release/ 同梱も対象)②T2 設計メモ — `resolveMutateRuntimeMaxRecords` の表現を R2 後の仕様に整合(「dmlMaxRows 連動」→「現行分岐を維持。SELECT-based DML では undefined = runtime maxRecords」)
  - 2026-07-11 R2(codex レビュー反映・仕様 R2 追従): ①T6 — `run_saved_query` の `dmlMaxRows` describe は「adjustable via tempTableMaxRows」に**しない**(存在しない入力の示唆防止。temp table 節を削除し単文限定を明示)②T3 — CLI ヘルプ変更時に README の HELP_SYNC ブロックを同時更新 ③T7 — `ksql_mcp_server_spec.md` / `ksql_cli_console_spec.md` / README HELP_SYNC を必須更新対象に明示
  - 2026-07-11 R1: 初版(仕様案 R1 ドラフトを受けて作成)
- ステータス: **実装済み(T1〜T9 + 検証)**。残り: 実機確認(ユーザー実施)・PR・リリース
- 対象バージョン: **v1.11.0**(機能追加のため minor バンプ)
- 仕様: [ksql_temp_table_max_rows_option_spec.md](ksql_temp_table_max_rows_option_spec.md)
- 推奨ブランチ: `feat/temp-table-max-rows-option`(単一ブランチ・単一 PR)

---

## 1. 概要

エンジン層に既存の `BatchExecuteOptions.tempTableMaxRows`(`src/execute.ts:355-356`、実体化での適用は `:527-531`)を、MCP(`ksql_query` / `ksql_mutate`)・CLI・環境変数・プロファイル設定に公開する。**エンジン層の新規実装はゼロ**で、変更の本体は「入口での受け渡し」と「モデル向けメタデータ・ドキュメントの同期」。既定 10,000・超過時は常に error という §5.6 のセマンティクスは一切変えない。

### ステップ一覧と依存関係

| ステップ | 内容 | 依存 |
|---|---|---|
| T1 | ランタイム・設定型: 解決チェーン追加 | なし |
| T2 | MCP: スキーマ追加 + query/mutateBatch の受け渡し | T1 |
| T3 | CLI: フラグ追加 + 解決 + executeBatch 受け渡し + console 伝搬 | T1 |
| T4 | EXPLAIN 表示文言の修正(エンジン層、文言のみ) | なし |
| T5 | mcp-smoke assertion の差し替え | **T6 と順序制約あり**(assertion 先行) |
| T6 | メタデータ更新(describe / description) | T2(実装が先、宣言が後) |
| T7 | ドキュメント更新(仕様書 R 追記・CHANGELOG ほか) | T1〜T6 の文言確定後 |
| T8 | 実機検証(smoke + ユーザー確認)・npm publish 準備 | T1〜T7 |

実装順は T1 → T2 → T3 → T4 → T5(assertion 先行)→ T6 → T7 → T8 を推奨。

## 2. 実装ステップ

### T1: ランタイム・設定型 — 解決チェーン追加(仕様 §3.2・§4.1)

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/node/config.ts:26-30` — `query` 設定型に `tempTableMaxRows?: number` を追加 |
| 変更 2 | `src/node/runtime.ts:28-38` — `CreateKsqlRuntimeInput` に `tempTableMaxRows?: number` |
| 変更 3 | `src/node/runtime.ts:40-49` — `KsqlRuntime` に `tempTableMaxRows?: number`(**undefined 許容**) |
| 変更 4 | `src/node/runtime.ts:74-77` 付近 — `const tempTableMaxRows = input.tempTableMaxRows ?? envInt("KSQL_TEMP_TABLE_MAX_ROWS") ?? profile.query?.tempTableMaxRows;` を追加し戻り値に含める |
| 設計メモ | 最終段を undefined のままにし `?? 10_000` を書かない — 既定値の定義箇所を `src/execute.ts:348` の1箇所に保つ(仕様 §3.2)。env / profile 値の追加検証は `maxRecords` の前例に合わせて行わない(§3.3) |
| テスト | ランタイム解決の優先順(引数 > env > profile > undefined)。既存の runtime テストファイルに追加 |
| 完了条件 | `createKsqlRuntime` が4段の解決を行い、未指定時に undefined を返す |

### T2: MCP — スキーマ追加 + バッチ受け渡し(仕様 §4.2)

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/mcp/schemas.ts` — 共有定義 `tempTableMaxRows`(`z.number().int().positive().describe(仕様 §5.1).optional()`)を `maxRecords`(`:8-10`)の隣に追加し、`queryInputSchema` / `mutateInputSchema` に組み込む。**`runSavedQueryInputSchema` には追加しない**(単文限定のため。仕様 §2.2) |
| 変更 2 | `src/mcp/tools.ts:461-479` — query バッチ: `createRuntime` 入力に `tempTableMaxRows: input.tempTableMaxRows` を追加し、`executeBatchSql` オプションに `tempTableMaxRows: runtime.tempTableMaxRows` を追加 |
| 変更 3 | `src/mcp/tools.ts:565-598` — mutateBatch: 同上 |
| 設計メモ | 単文経路(query `:503-521`、mutate 単文)は変更しない — 単文入力の一時テーブルはパーサ/validate が拒否済みで到達しない。mutateBatch の `maxRecords` は `resolveMutateRuntimeMaxRecords` の**現行分岐を維持**(SELECT-based DML を含む場合は `undefined` = runtime `maxRecords` 解決、それ以外は `dmlMaxRows + 1`。`src/mcp/tools.ts:314-319`)— いずれの場合も実体化時はエンジンが `tempTableMaxRows ?? TEMP_TABLE_MAX_ROWS` で **maxRecords を上書きする**(`src/execute.ts:529`)ため干渉しない(R3) |
| テスト(`src/mcp/__tests__/tools.test.ts`) | ① query バッチ: `tempTableMaxRows` 指定で 10,000 超の実体化が成功(モックで行数を制御) / ② 未指定: 10,001 行で従来どおりエラー(**回帰**) / ③ `onLimit: "truncate"` + 実体化超過: error のまま(**不変条件 §3.5-2**) / ④ mutateBatch: temp ソース DML で受け渡しが効き、`dmlMaxRows` / `dmlTotalMaxRows` 判定が不変(**§3.5-4**) / ⑤ zod: 0・負数・非整数の拒否 / ⑥ env `KSQL_TEMP_TABLE_MAX_ROWS` / profile `query.tempTableMaxRows` の解決(ツール引数優先) |
| 完了条件 | 仕様 §7-1〜§7-4・§7-6 |

### T3: CLI — フラグ追加(仕様 §4.3)

| 項目 | 内容 |
|---|---|
| 変更 1 | ヘルプ(`src/cli/index.ts:73` 付近): `--temp-table-max-rows <n>  Max rows per temp table (default: 10000, always errors on overflow)`。**README の `BEGIN_HELP_SYNC`〜`END_HELP_SYNC` ブロック(`README.md:109-168`)も同一コミットで同期更新**(R2) |
| 変更 2 | args 型(`:177` 付近)に `tempTableMaxRows: number | null`、初期値(`:227` 付近)に `null` |
| 変更 3 | パーサ(`:355-358` の `--max-records` パターンを踏襲): 正整数チェック + `ArgumentError: --temp-table-max-rows must be a positive integer.` |
| 変更 4 | `pushOpt`(`:924`): `pushOpt(argv, "--temp-table-max-rows", base.tempTableMaxRows)` — **REPL console 子実行への伝搬(見落とし注意)** |
| 変更 5 | 解決(`:1533` 付近): `const tempTableMaxRows = args.tempTableMaxRows ?? envInt("KSQL_TEMP_TABLE_MAX_ROWS") ?? profile.query?.tempTableMaxRows ?? undefined;` |
| 変更 6 | `executeBatch` 呼び出し(`:1904-1919`)に `tempTableMaxRows` を追加。単文 `execute` 経路(`:1923-1931`)には渡さない |
| テスト(CLI テスト) | ① フラグのパース(正常・0/負数/非整数拒否) / ② バッチ実行への受け渡し / ③ console 子実行 argv への伝搬(`pushOpt` の出力検証) / ④ env / profile フォールバック |
| 完了条件 | 仕様 §7-5 |

### T4: エンジン層 — EXPLAIN 表示文言の修正(仕様 §4.4)

| 項目 | 内容 |
|---|---|
| 変更 | `src/execute.ts:2961` — `上限 ${TEMP_TABLE_MAX_ROWS} 行、超過はエラー` → `既定上限 ${TEMP_TABLE_MAX_ROWS} 行、tempTableMaxRows で変更可、超過はエラー` |
| 設計メモ | `buildBatchExplainPlans(sql)` は静的関数で実行時オプションを知らないため実効値は出せない。「既定」と明示して虚偽表示を避ける(シグネチャ変更は非スコープ。仕様 §2.2) |
| テスト | EXPLAIN プラン文字列の期待値更新(実装時に `実体化前のため不明` で grep して既存 assert を洗い出す) |
| 完了条件 | バッチ EXPLAIN の表示が新文言になる |

### T9: プラグイン実行画面 — 取得オプションパネルに一時テーブル上限を追加(仕様 §4.5・R7)

| 項目 | 内容 |
|---|---|
| 変更 1 | `buildFetchOptionsPanel` — 「一時テーブル上限(行)」入力(id: `ksql-temp-table-max-rows-input`、placeholder「10000（既定）」)+ 注記「空欄 = 既定 10,000。超過は常にエラー（『打ち切って続行』は適用されません）」。onChange コールバックに `tempTableMaxRows?: number` を追加 |
| 変更 2 | `loadFetchOptions` / `saveFetchOptions` — `tempTableMaxRows?` を追加(不正値は undefined。旧形式後方互換) |
| 変更 3 | `resolveRuntimeFetchOptions` — 戻り値に `tempTableMaxRows?` を追加(タブ表示中 = DOM 現在値、非表示 = フォールバック引数) |
| 変更 4 | `runSql` 末尾に optional 引数 `tempTableMaxRows?` を追加し、`runBatchSql` オプション経由で `executeBatch` に渡す(単文 `execute` 経路は渡さない) |
| 変更 5 | SQL 履歴(`SqlHistoryItem` / `saveHistory` / `parseHistoryItem` / 履歴ドロップダウン再実行)に `tempTableMaxRows?` をスナップショット |
| 変更 6 | オプションサマリ(`refreshOptSummary`)— 指定時のみ付記 |
| 設計メモ | 空欄・不正値は **undefined = エンジン既定に復帰**(`sanitizeMaxRecords` の 3000 フォールバックとは異なる)。保存SQL レコード連携(`最大取得件数` 等のフィールド)には追加しない — 未指定として実行時にパネル現在値へフォールバック。DML バッチの `onLimitReached: "error"` 固定(desktop.ts の containsDml 分岐)には触れない |
| テスト | desktop.ts は kintone グローバル依存でモジュールロード時に `kintone.events.on` を実行するため、**既存慣例(v1.9.0)どおり単体テスト対象外**。検証は ①tsc 件数基準(既存10件から増えない)②`build:plugin` 成功 + prod/js/desktop.js に ASCII マーカー `ksql-temp-table-max-rows-input` が入ること(日本語文字列は minify 後の Grep でヒットしないことがあるため ASCII id で確認 — v1.9.0 の教訓)③実機確認(ユーザー) |
| 完了条件 | 仕様 §7-8・§7-9(§7-8 の localStorage/履歴は実機確認で検証) |

### T5: mcp-smoke assertion の差し替え(仕様 §5.3)

v1.4.1 以来の方式: **assertion を先に差し替え、旧バンドル(`release/ksql-mcp.js`)で smoke が red になることを確認してから T6 を適用する**(regression ガードとして機能する証明)。

| 項目 | 内容 |
|---|---|
| 変更 1 | `scripts/mcp-smoke.mjs:105` — 固定フレーズを新文言(`by default (adjustable via tempTableMaxRows)` を含む形)に差し替え |
| 変更 2 | `scripts/mcp-smoke.mjs:127-129` — described リストの `ksql_query` / `ksql_mutate` に `"tempTableMaxRows"` を追加 |
| 完了条件 | 旧バンドルで red → T6 + バンドル再生成後に green |

### T6: メタデータ更新 — describe / description(仕様 §5.1・§5.2)

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/mcp/schemas.ts` — 新共有定義の describe(仕様 §5.1 の文案)。T2 と同一コミットで良い |
| 変更 2 | `src/mcp/schemas.ts:63`(ksql_mutate `dmlMaxRows`)— `temp tables hold at most 10000 rows` → `temp tables hold at most 10000 rows by default (adjustable via tempTableMaxRows)` |
| 変更 3 | `src/mcp/schemas.ts:125`(ksql_run_saved_query `dmlMaxRows`)— **変更 2 と同形にしない**(R2・仕様 §5.2)。temp table 節を削除し `Saved queries are single-statement, so temp tables do not apply here.` 形に変更(このツールに `tempTableMaxRows` 入力は存在しないため、オプション名を出すとモデルが存在しない入力を使おうとする) |
| 変更 4 | `src/mcp/index.ts` の `ksql_query` / `ksql_mutate` description — `hold at most` で grep して同 phrasing があれば同時更新 |
| 設計メモ | 「一時テーブルなら解決」と誤読させない・上限併記のルール(insert_select_app_source 仕様 §3.4 / R3)を維持。上限が可変になったため「by default」の明示が必須。原則: **`tempTableMaxRows` に言及してよいのは、その入力を実際に受け付けるツールのメタデータのみ**(R2) |
| テスト | T5 の smoke assertion で機械的に検証 |
| 完了条件 | tools/list のメタデータに「10,000 固定」を示唆する文言が残っていない |

### T7: ドキュメント更新(仕様 §6)

| ファイル | 内容 |
|---|---|
| `docs/ksql_batch_temp_table_spec.md` | §5.6 の表改訂(「10,000(既定。`tempTableMaxRows` で変更可、超過は常に error)」)+ メモリ注記(同時最大16個 × 指定値)+ 更新履歴 R 追記(v1.11.0・本仕様への参照) |
| `docs/internal/ksql_mcp_insert_select_app_source_spec.md` | §3.4 の「MCP 経由では 10,000 行上限を変更できない」の失効を履歴 R で追記(本仕様参照) |
| `docs/ksql_mcp_server_spec.md` | `ksql_query` / `ksql_mutate` の入力スキーマ表に `tempTableMaxRows` を追加(R2) |
| `docs/ksql_cli_console_spec.md` | CLI オプション表に `--temp-table-max-rows` を追加 + console 子実行への伝搬に言及(R2) |
| `README.md` | HELP_SYNC ブロックの更新は T3 で実施済みであることを確認(R2) |
| `docs/ksql_mcp_changes.md` | v1.11.0 エントリ |
| 利用者向けドキュメント | `10,000` / `一時テーブル` で grep し、上限に言及する箇所へ「既定」を明示 |
| `CHANGELOG.md` | v1.11.0 追加(リリース日はリリース時に確定) |

### T8: 実機検証・リリース準備

1. `npm test` 全 green
2. **`npm run build` で全成果物を再生成**(R3・R6): `build:cli` → `dist-cli/ksql.js`(**npm 版 CLI の実体。`package.json` の `bin.ksql` が指すため、ここが古いと `--temp-table-max-rows` が npm 版に入らない**)/ `build:mcp` → `dist-mcp/ksql-mcp.js`(**release/ へは書き出さない** — `build-mcp.mjs` の outfile は dist-mcp のみ)/ `build:mcpb` → `dist-mcpb/ksql-mcp.mcpb` / `build:plugin` → `prod/js/desktop.js`(T4 の EXPLAIN 文言変更が core 経由で反映される)。`mcp:verify` / `mcpb:verify` green
3. **リリース時(bump 後)の release/ 差し替えは明示手順**(R3・R5・R6 — ビルドでは自動反映されない): ①`dist-mcp/ksql-mcp.js` → `release/ksql-mcp.js`、`dist-mcpb/ksql-mcp.mcpb` → `release/ksql-mcp.mcpb` を手動コピー ②**prod/ が変わるため v1.7.0 の教訓どおり `dist/ksql-plugin-vX.zip` の生成確認 → release/ へ zip 同梱**(manifest.json の version bump も忘れない)③`release/VERSION.txt` / `README.txt` を更新
4. 実機(ユーザー実施): 10,000 行超のアプリで `ksql_query` バッチ + `tempTableMaxRows` を指定し、実体化成功と未指定時エラーの両方を確認。CLI は **`dist-cli/ksql.js` 直実行**で `--temp-table-max-rows` を確認(v1.10.0 の教訓: 単体テストは run 関数のゲートを通らないことがあり、ビルド成果物の実機実行で漏れが見つかる)
5. PR 作成 → codex レビュー → マージ → タグ・GitHub Release・npm publish(ユーザー操作)

## 3. リスクと対策

| リスク | 対策 |
|---|---|
| メモリ枯渇(16 テーブル × 大きな指定値) | describe・仕様書で明記(仕様 §3.4)。キャップは設けない設計判断のため、文書での注意喚起が唯一のガード |
| 既定挙動の意図しない変化 | 不変条件チェックリスト(仕様 §3.5)をテストで固定。特に「未指定 = v1.10.0 と同一」「truncate 不適用」の回帰テスト(T2-②③) |
| console 子実行への伝搬漏れ | T3-④ で argv 検証テストを必須化 |
| メタデータとコードの乖離(LLM 誤学習) | T5 の assertion 先行方式で機械的に防止 |
| 行番号ずれ | 本計画の行番号は v1.10.0(main 0680bab)時点。実装時は grep で再特定する |
