# SELECT-based DML ソース制限 最終解消(v1.7.0) 実装計画

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R4(実装完了): X1〜X5 実装済み(ブランチ `feat/mcp-select-dml-mixed-sources`。v1.6.0 は PR #6 でマージ済み)。X4 は計画どおり assertion を先に差し替え、v1.6.0 バンドルで smoke が失敗することを確認してから X3 を適用。テスト: エンジン層6本(混在 INSERT_SELECT / サブクエリ temp 参照 / temp・混在 UPSERT_SELECT / confirm ゼロ書き込み / EXPLAIN)+ MCP 層5本(置換2 + 新規3)。サブクエリテストは SIMPLE モードの WHERE 押し下げ(教訓①)を踏まえ FROM を temp にして in-memory 評価で観測する形に調整
  - 2026-07-10 R3(codex レビュー完了): 追加指摘なし。describe 両ツール更新 + smoke キー差し替え、サブクエリ temp 参照テストの追加を確認済み。進め方確定 — v1.6.0 を main に入れてから v1.7.0 ブランチを切る
  - 2026-07-10 R2(codex 計画レビュー反映): ①(Medium)X3 の `dmlMaxRows` describe「変更不要」を撤回 — temp / 混在解禁後は「caps the source SELECT read (dmlMaxRows + 1)」が過大になるため、mutate / runSavedQuery 両方の describe を「APP ソース読み取り cap / temp 実体化 10,000 行 / UPSERT 合計」の文言に更新し、X4 の smoke キー(`"caps the source SELECT read"` → `"caps app-source reads"`)も差し替え対象に追加(仕様 R5 と同期)。②(Low)X1 テストにサブクエリ内 temp 参照(`WHERE ... IN (SELECT ... FROM #t)`)の明示成功テストを追加(受け入れ基準 §5-1 の固定)
  - 2026-07-10 R1: 初版(仕様案 R4 確定を受けて作成)
- ステータス: **実装済み(X1〜X5)**。残り: X6 実機確認(ユーザー実施)・npm publish
- 仕様: [ksql_mcp_insert_select_mixed_source_spec.md](ksql_mcp_insert_select_mixed_source_spec.md)(codex R1〜R4 レビュー済み・確定)
- 対象バージョン: **v1.7.0**
- 推奨ブランチ: `feat/mcp-select-dml-mixed-sources`
- **前提**: v1.6.0 ブランチ(`feat/mcp-upsert-select-app-source`)の PR マージ後に main から分岐する(未マージのまま進める場合は同ブランチに積む — description・smoke・仕様書の変更が重なるため、独立ブランチを並行させないこと)

---

## 1. 概要

- **提案A(INSERT_SELECT 混在解禁)**: ガード緩和のみ。実行経路(`executeQueryWithCte` → `executeFullScanWithCte`)は read-only バッチで実戦投入済み
- **提案B(UPSERT_SELECT temp / 混在対応)**: `executeUpsertSelect` への cteCache 配管4接点(INSERT_SELECT 経路の鏡写し)
- ガード緩和は同一行の編集を両提案で共有するため、X1 でまとめて行う
- v1.5.0 / v1.6.0 と同じく、**読み取り側の実装は変更せず**、書き込み側ガード(confirm / dmlMaxRows / dmlTotalMaxRows)は既存のまま

実装順: **X1(エンジン)→ X2(MCP テスト)→ X4(smoke assertion 先行)→ X3(メタデータ)→ X5(ドキュメント)→ X6(実機)**。

## 2. 実装ステップ

### X1: エンジン変更一式 + エンジン層テスト

| 項目 | 内容 |
|---|---|
| 変更1: ガード緩和(`src/execute.ts:388-397`) | DML 文の temp 参照チェックを `if (s.statementType === "INSERT_SELECT" \|\| s.statementType === "UPSERT_SELECT") continue;` に緩和。v1.5.0 U1 の混在拒否メッセージ(ternary の INSERT_SELECT 分岐)は不要になるため削除し、汎用の `temp table references in ${type} are not supported yet.` のみ残す(UPDATE / DELETE / UPSERT には引き続き有効) |
| 変更2: cteCache 配管(`executeUpsertSelect`、2458-) | 引数に `cteCache?: Map<string, ProcessRow[]>` を追加し、冒頭の source 実行を `executeInsertSelect` と同じ2行分岐(`src/execute.ts:1777-1779` の鏡写し)に変更 |
| 変更3: バッチディスパッチ(508-512) | `UPSERT_SELECT` の分岐を追加(`tempTables` を渡す)。INSERT_SELECT のコメント「ソースが一時テーブルのみ」を「temp のみ / APP 混在とも」に修正。「ここに来るのは想定外」throw は UPDATE 等のために残す |
| 変更4: バッチ EXPLAIN(2790-2806) | UPSERT_SELECT 用ヘッダ行(「実行時に件数確定 → dmlMaxRows 適用」表記)を追加し、対象アプリ除外フィルタ(2801)を UPSERT_SELECT にも拡張 |
| テスト(`src/__tests__/executeBatch.test.ts`) | ① 既存の混在拒否テスト(`INSERT_SELECT: APP ソース混在(JOIN)は拒否`)を**成功テストに置換**(JOIN の突き合わせ結果と postRecords 内容を検証)/ ② temp ソース UPSERT_SELECT: 成功(insert / update 振り分け)+ confirm(実体化行数ベースの合計)適用・超過時は当該文ゼロ書き込み / ③ 混在ソース UPSERT_SELECT: 成功 / ④ **サブクエリ内 temp 参照の成功系を1本明示**: `INSERT INTO APPx (...) SELECT ... FROM APPy WHERE ... IN (SELECT ... FROM #t)`(受け入れ基準 §5-1 の「サブクエリ内 temp 参照」の固定。cteCache 貫通は S4 で繰り返し修正してきた領域のため明示テストで守る。R2)/ ⑤ 回帰: UPDATE の temp 参照が汎用メッセージで拒否 |
| テスト(`src/__tests__/explain.test.ts`) | temp 参照 UPSERT_SELECT のバッチ EXPLAIN がヘッダ行 + FULL_SCAN 表記を返す |
| モック注意 | JOIN・照合ともモックはクエリを無視するため、アプリ別のデータ内容でヒット/非ヒットを作る(恒例)。照合(`resolveUpsertTargets`)は書き込み先アプリの行を返すモックで insert / update の振り分けを制御する |
| 完了条件 | 仕様 §5-1・2・4(エンジン層)・5 |

### X2: MCP 層テスト(`src/mcp/__tests__/tools.test.ts`)

| 項目 | 内容 |
|---|---|
| 置換 | 既存の「混在ソース INSERT_SELECT はエンジン層で実行前に拒否」→ 成功テスト / 「一時テーブルソースの UPSERT_SELECT はエンジン層で実行前に拒否」→ 成功テスト |
| 新規 | ① 混在 INSERT_SELECT: `dmlMaxRows` 超過で当該文 POST ゼロ件 / ② temp ソース UPSERT_SELECT: 成功(insertedCount / updatedCount)と `dmlTotalMaxRows` 合算 / ③ 混在ソースの JOIN APP 側 fetch が読み取り上限(`dmlMaxRows + 1`)で書き込み前に安全側エラー(仕様 §3.1) |
| 回帰 | temp のみ / APP のみソース(v1.5.0 / v1.6.0 の既存テスト群)がそのまま通ること |
| 完了条件 | 仕様 §5-1〜5 |

### X4: mcp-smoke assertion の差し替え(X3 より先)

| 項目 | 内容 |
|---|---|
| 変更 | `scripts/mcp-smoke.mjs` mutateKeys を新 description(仕様 §6-2 確定文言)のキーに差し替え。現行キー `"INSERT INTO app ... SELECT is supported"` / `"UPSERT INTO app ... SELECT is supported"` は新文言(`INSERT/UPSERT INTO app ... SELECT supports ...`)にマッチしなくなるため置換が必須 |
| 新キー案 | `"supports app sources, temp tables, or joins of both"` / `"counts inserts + updates"`(維持)/ `"temp tables hold at most 10000 rows"` / describe 用: `"caps app-source reads"`(旧 `"caps the source SELECT read"` の差し替え。mutate / runSavedQuery の両ツール。R2) |
| 順序制約 | **X3 より先に assertion を差し替え、v1.6.0 バンドルで smoke が失敗することを確認してから X3 を適用・再ビルド**(恒例の regression 証明手順)。旧文言「but not both in one statement」「for app sources only」はキーに含まれていないため、キー差し替えを先行させないと退行検出できない(仕様 §4.2) |
| 完了条件 | 旧文言バンドルで smoke が落ち、X3 適用後のバンドルで通る |

### X3: メタデータ更新

| 項目 | 内容 |
|---|---|
| `src/mcp/index.ts`(ksql_mutate description) | 確定文言(仕様 §6-2)に置換: `Execute DML kSQL with explicit allowDml, confirmText, and dmlMaxRows safety controls. Supports multi-statement DML batches with temp tables. INSERT/UPSERT INTO app ... SELECT supports app sources, temp tables, or joins of both. For UPSERT, dmlMaxRows counts inserts + updates. The source SELECT reads at most dmlMaxRows + 1 app records; temp tables hold at most 10000 rows.` |
| `src/mcp/schemas.ts` | `dmlMaxRows` describe(**mutate / runSavedQuery の両方**)を更新(R2 で「変更不要」を撤回 — 「caps the source SELECT read (at most dmlMaxRows + 1 records)」は temp / 混在ソースでは過大)。案: `Per-statement cap on affected rows. The call fails before writing if any statement would exceed it. For INSERT/UPSERT ... SELECT it also caps app-source reads (at most dmlMaxRows + 1 records; temp-table sources are bounded by materialization, max 10000 rows); for UPSERT it counts inserts + updates.` sql の describe の例示は現行のまま有効 |
| 禁止事項 | temp 実体化による回避の案内を書く場合は「source 側の読み取り上限の回避」に限定し 10,000 行上限を併記する(仕様 §3.1 R3。UPSERT の target 照合読み取りは回避されない) |
| 完了条件 | tools/list に「混在不可」「app sources only」の宣言が残らず、X4 の assertion が通る |

### X5: ドキュメント更新

| ファイル | 変更 |
|---|---|
| `docs/ksql_batch_temp_table_spec.md` | §7.3: 「混在は不可」(INSERT_SELECT)と「一時テーブルソースはエンジン未対応・迂回路なし」(UPSERT_SELECT)を解禁に更新。§9: 混在 INSERT_SELECT 行と temp UPSERT_SELECT 行を現行エラー表から外し、**「v1.5.0〜v1.6.0 の旧制限」として履歴注記**(仕様 §6-3)。更新履歴 Rn |
| `docs/ksql_mcp_server_spec.md` | §7.6: 拒否リストを「なし(SELECT-based DML は temp / APP / 混在ソースとも可)」に。v1.6.0 で書いた「temp 迂回路がない」を撤回し、§3.1 の限定付き回避策(source 側のみ回避可・target 照合は残る・10,000 行併記)に置き換え。§7.6.1 リスク表・§7.6.2 達成状況に v1.7.0 を追記 |
| `docs/ksql_mcp_changes.md` | §11.9(v1.7.0)追加: 挙動変化、読み取り側上限のソース種類別整理(仕様 §3)、JOIN APP 側 fetch の上限特性。§13 実測値更新 |
| 内部ドキュメント | 本計画・仕様案のステータス / Rn。`ksql_mcp_upsert_select_unlock_spec.md` の「迂回路なし」記述に「v1.7.0 で source 側は解消(target 照合は残る)」を注記 |

### X6: 実機検証(ユーザー実施)

- Claude Desktop で MCP サーバー再起動 → ①混在ソース INSERT_SELECT バッチ、②temp ソース UPSERT_SELECT バッチを依頼し、ksql_mutate が一発で選択・成功すること
- 任意: `scripts/mcp-kintone-smoke.mjs` に混在ソースケースを追加

## 3. 仕上げ(リリース手順)

1. `npm test`(全件。console e2e は並列実行でフレークすることがある — 失敗時は単独再実行で切り分け)
2. `tsc --noEmit` は**件数比較**(既存 10 件基準。`src/ui/desktop.ts`)
3. `package.json` を **1.7.0** に bump
4. `npm run build` → `mcp:verify` → `npm audit --omit dev` → `git diff --check`(全角括弧・行末空白に注意)
5. **今回はエンジン変更があるため `prod/js/desktop.js`(プラグインバンドル)に実差分が出る** — 内容がエンジン変更由来のみであることを確認してコミットに含める(プラグインは DML バッチを受理しないため機能影響なし・zip は v1.4.0 のまま)
6. `release/ksql-mcp.js` / `ksql-mcp.mcpb` 差し替え、`VERSION.txt` / `README.txt` 更新
7. npm publish(ユーザー操作)

## 4. リスクと留意点

- **挙動変化**: 従来エラーだった混在 INSERT_SELECT / temp・混在 UPSERT_SELECT が書き込みを行うようになる(changes に明記)
- **読み取り側の上限はソース種類ごとに異なる**(仕様 §3 R3)— ドキュメント・エラー案内で「temp に逃がせば全部解決」と読める表現を書かない(UPSERT の target 照合読み取りは残る)
- **X4 の順序制約**(assertion 先行 → 旧バンドル失敗確認 → X3 適用)を守らないと regression ガードの機能証明が取れない
- cteCache 配管は鏡写しとはいえエンジン変更のため、X1 のテストは書き込み内容(postRecords / putRecords の引数)まで検証する
- 受け入れ基準の「ゼロ書き込み」は**当該文限定**(DML バッチは非アトミック。仕様 §5-3)
