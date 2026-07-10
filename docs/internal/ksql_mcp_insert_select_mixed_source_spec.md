# SELECT-based DML のソース制限 最終解消(v1.7.0)仕様案

- 作成日: 2026-07-10
- ステータス: **レビュー済み・確定(codex R1〜R4)**。実装は実装計画に従う
- 実装計画: [ksql_mcp_insert_select_mixed_source_implementation_plan.md](ksql_mcp_insert_select_mixed_source_implementation_plan.md)
- 提案A: **INSERT_SELECT の混在ソース(APP + 一時テーブル)解禁** — ガード緩和のみ
- 提案B: **UPSERT_SELECT の temp / 混在ソース対応** — cteCache 配管(INSERT_SELECT 経路の鏡写し・4接点)
- 経緯: v1.5.0 U1(混在ソース拒否メッセージ)に対する「一時テーブルが混在に対応することは可能か」の調査(→ 提案A)と、続く「UPSERT_SELECT の temp/混在に対応できるか」の調査(→ 提案B)。両者を v1.7.0 に同梱し、SELECT-based DML のソース制限を最終解消する(同梱理由は §6-4)
- 対象バージョン: **v1.7.0**(機能追加のため minor バンプ)
- 関連: `docs/internal/ksql_mcp_insert_select_app_source_spec.md`(v1.5.0)、`docs/internal/ksql_mcp_upsert_select_unlock_spec.md`(v1.6.0)、`docs/ksql_batch_temp_table_spec.md` §7.3

---

## 1. 調査結果(混在はなぜ動くのか)

| # | 事実 | 根拠 |
| --- | --- | --- |
| 1 | 一時テーブル参照を含む SELECT の実行器 `executeFullScanWithCte` は、FROM と各 JOIN を**個別に**「`cteName` あり → 実体化済み行を注入 / なし → APP から fetch」と分岐する。混在 JOIN は設計上そのまま動く | `src/execute.ts:1183-1230` |
| 2 | read-only バッチでは混在は**公式サポート済みのパターン**。バッチ仕様書の推奨例自体が `FROM APP100 a INNER JOIN #latest t ON ...`(相関サブクエリの回避) | `docs/ksql_batch_temp_table_spec.md:377-379` |
| 3 | `executeInsertSelect` は cteCache があれば source SELECT を `executeQueryWithCte`(= #1 の経路)で実行する。**混在ソースをブロックしているのは実行能力ではなく `executeBatch` のガード1箇所だけ**(`tempOnlySource` 要求) | `src/execute.ts:1777-1779` / ガード `src/execute.ts:388-397` |
| 4 | FULL_SCAN 経路の APP fetch は `maxRecords`(MCP では `dmlMaxRows + 1`)・`onLimit` で拘束され、メインテーブルには WHERE プッシュダウンも効く。JOIN 側はソースキーに基づく最適化 fetch(`tryFetchJoinRecordsBySourceKeys`)が使われ得る | `src/execute.ts:1245-1272`, `1207-1216` |
| 5 | サブクエリ内の一時テーブル参照も cteCache が引き継がれ解決される | `src/execute.ts:1169-1173` |
| 6 | バッチ EXPLAIN は混在の表示(FULL_SCAN + 参照 APP 一覧)に対応済み | `src/execute.ts:2790-2806` |

v1.5.0 で混在を除外したのは「エンジン仕様の変更はスコープ外」というスコープ制御(同仕様 §2.2)であって、技術的制約ではなかった。

### 1.1 追加調査: UPSERT_SELECT の temp / 混在対応の実現性(提案B の根拠)

| # | 事実 | 根拠 |
| --- | --- | --- |
| 7 | `UpsertSelectStatement.select` は `SelectStatement` 固定で `InsertSelectStatement.select` と同一形状。`executeQueryWithCte` にそのまま渡せる | `src/types/ast.ts:489, 501` |
| 8 | `executeUpsertSelect` 内で source に依存する処理は冒頭の `executeSelect(stmt.select, ...)` 直呼び**1箇所のみ**。後続の列数・キー検証、既存レコード照合(`resolveUpsertTargets` — 書き込み先アプリへの読み取り)、confirm、POST / PUT はすべて source の種類と無関係 | `src/execute.ts:2465` |
| 9 | バッチディスパッチの temp 参照分岐に UPSERT_SELECT の枝がなく、現状は「想定外」throw に落ちる(エンジンガードが先に拒否するため到達しない) | `src/execute.ts:508-512` |
| 10 | `tempOnlySource` は UPSERT_SELECT についても算出・報告済み(validate 出力は変更不要) | `src/core/batch.ts:178` |
| 11 | バッチ EXPLAIN の temp 参照プランは INSERT_SELECT のみヘッダ行を特別扱いしており、UPSERT_SELECT 用の行が必要(数行) | `src/execute.ts:2790-2806` |

つまり提案B は「INSERT_SELECT が M4 以来実戦投入している経路の鏡写しの配管」であり、新規アルゴリズムはない。

## 2. スコープ

### 2.1 提案A: バッチ内の混在ソース INSERT_SELECT を解禁(例):

```sql
CREATE TEMP TABLE #targets AS SELECT 顧客ID FROM APP100 WHERE ランク = 'A';
INSERT INTO APP400 (顧客ID, 顧客名)
SELECT t.顧客ID, b.顧客名 FROM #targets t INNER JOIN APP200 b ON t.顧客ID = b.顧客ID;
```

一時テーブルはバッチスコープのため、temp / 混在ソースは**構造上バッチでのみ書ける**(単文で `#t` を参照すると従来どおり `ParseError: temp table #t is not defined in this batch.`)。単文側の変更はない。

### 2.2 提案B: UPSERT_SELECT の temp / 混在ソースに対応(例):

```sql
CREATE TEMP TABLE #src AS SELECT 顧客コード, ランク FROM APP100 WHERE 更新日 >= '2026-07-01';
UPSERT INTO APP400 (顧客コード, ランク)
SELECT 顧客コード, ランク FROM #src ON DUPLICATE (顧客コード);
```

temp のみ・混在(`FROM #src JOIN APPx` 等)の両方を対象とする(source の実行経路は提案A と同一の `executeQueryWithCte`)。

### 2.3 変更しないもの(非スコープ)

| 項目 | 扱い | 理由 |
| --- | --- | --- |
| DML(UPDATE / DELETE / UPSERT)内の一時テーブル参照 | 従来どおり拒否 | エンジン未実装(`temp table references in X are not supported yet`) |
| confirm operation の `"UPSERT"` 化 | 現状維持(v1.6.0 仕様 §3.5-2 の判断を踏襲) | 将来の object 引数化とセット |
| プラグイン / CLI | 変更は共通エンジンのため自動で効く | プラグインは DML バッチ自体を受理しないため実質 MCP / CLI のみ |

## 3. 安全モデル(すべて既存機構)

**書き込み側のガード(書き込み前 confirm / `dmlMaxRows` / `dmlTotalMaxRows`)は、提案A は v1.5.0 の APP のみソース、提案B は v1.6.0 の APP ソース UPSERT_SELECT と同じ**。一方、**読み取り側の上限はソース種類ごとに異なる**(APP fetch は `dmlMaxRows + 1`、temp は実体化時の 10,000 行上限、UPSERT 系はこれに書き込み先 APP の照合読み取りが加わる)。R3。

1. source SELECT 実行時、APP テーブルの fetch は `maxRecords = dmlMaxRows + 1`・`onLimit = "error"` で拘束(調査結果 #4)。一時テーブル側は実体化済み(`TEMP_TABLE_MAX_ROWS` = 10,000 行上限)のメモリ注入で追加読み取りなし
2. 書き込み前 confirm: INSERT_SELECT は `confirm(rows.length, "INSERT")`(`src/execute.ts:1789-1793`)、UPSERT_SELECT は照合後に `confirm(toInsert + toUpdate, "UPDATE")`(`src/execute.ts:2509-2514`)→ `dmlMaxRows` 超過は**書き込みゼロ件**で ArgumentError
3. バッチ合算: confirm 経由で `dmlTotalMaxRows` に加算(既存)
4. 実行経路は read-only 混在 SELECT と同一のため、性能特性も同一(一時テーブルへの WHERE プッシュダウンなし・FULL_SCAN。公開ドキュメント §10 の既知制限のまま)
5. 提案B の既存レコード照合(第1キー `in (...)` 検索、v1.6.0 で文書化した低選択性キーの安全側エラー特性)は source の種類と無関係に従来どおり。temp ソースの UPSERT_SELECT は source 読み取りの追加 API コールがゼロになるため、v1.4.0 M4 が INSERT_SELECT に認めた「実体化済みで件数確定」の理屈がそのまま当てはまる

### 3.1 既知の制約(ドキュメントに明記する)

- **JOIN の APP 側 fetch も `dmlMaxRows + 1` に拘束される**ため、大きい APP を小さい `dmlMaxRows` で JOIN すると読み取り上限エラーになり得る(安全側の失敗)。`tryFetchJoinRecordsBySourceKeys` によるキー絞り込み fetch が効く形(JOIN キーがソース側で少数)なら回避されるが、常に効くわけではない
- 回避したい場合は **APP 側も一時テーブルに実体化**すれば temp のみソースになり、**source / JOIN 側の APP fetch** は実体化時(上限 10,000 行)に移る(v1.5.0 R1 のルールどおり **10,000 行上限を併記**して案内する)。ただし **UPSERT_SELECT では、temp のみソースにしても書き込み先 APP への既存レコード照合読み取り(`resolveUpsertTargets`)は残る**(§3-5 のとおり source 種類と無関係。第1キー低選択性の安全側エラーも回避されない)。回避策の案内は「source 側の読み取り上限の回避」に限定して書くこと(R3)。v1.6.0 で書いた「UPSERT_SELECT には temp 迂回路がない」という制約記述は、この限定付きで本対応により解消されるため、更新対象(§4.4)

## 4. 変更点一覧

### 4.1 エンジン(`src/execute.ts`)

| 箇所 | 提案 | 変更 |
| --- | --- | --- |
| ガード(`executeBatch` 冒頭、388-397) | A + B | INSERT_SELECT の `tempOnlySource` 要求を削除し、`if (s.statementType === "INSERT_SELECT" \|\| s.statementType === "UPSERT_SELECT") continue;` に緩和(**同一行の編集を両提案で共有**)。v1.5.0 U1 の混在拒否メッセージは不要になる(ternary の INSERT_SELECT 分岐を削除し、汎用の `temp table references in ${type} are not supported yet.` のみ残す — UPDATE 等には引き続き有効) |
| `executeUpsertSelect`(2458-) | B | 引数に `cteCache?: Map<string, ProcessRow[]>` を追加し、冒頭の source 実行を `executeInsertSelect` と同じ2行分岐(`src/execute.ts:1777-1779` の鏡写し)に変更 |
| ディスパッチ(508-512) | A + B | UPSERT_SELECT の分岐を追加(`tempTables` を渡す)。INSERT_SELECT のコメント「ソースが一時テーブルのみ」を「temp のみ / APP 混在とも」に修正 |
| バッチ EXPLAIN(2790-2806) | B | UPSERT_SELECT 用のヘッダ行を追加(INSERT_SELECT と同様の「実行時に件数確定 → dmlMaxRows 適用」表記)。対象アプリ除外フィルタ(2801)も UPSERT_SELECT に拡張 |
| `tempOnlySource`(`src/core/batch.ts`) | — | 判定・報告は**維持**(validate 出力の後方互換。ガードでの使用がなくなり情報提供のみになる旨をコメントに追記) |

### 4.2 MCP メタデータ

| 箇所 | 変更 |
| --- | --- |
| `src/mcp/index.ts`(ksql_mutate description) | 「the source may be apps or temp tables, but not both in one statement.」と「UPSERT INTO app ... SELECT is supported for app sources only (temp-table sources are not supported); ...」を統合し、SELECT-based DML 共通の記述へ。案: `INSERT/UPSERT INTO app ... SELECT is supported (single statement or batch); the source may be apps, temp tables, or a join of both. For UPSERT ... SELECT dmlMaxRows counts inserts + updates. The source SELECT reads at most dmlMaxRows + 1 records.`(文言はレビューで確定) |
| `src/mcp/schemas.ts`(`dmlMaxRows` describe、**mutate / runSavedQuery の両方**) | v1.6.0 文言の「caps the source SELECT read (at most dmlMaxRows + 1 records)」は temp / 混在ソース解禁後は**過大**(temp 側の行数は実体化上限 10,000 行で決まり dmlMaxRows と無関係)。「**APP ソースの読み取り**を dmlMaxRows + 1 で cap / temp テーブルは実体化上限 10,000 行 / UPSERT は inserts + updates 合計」が伝わる文言に更新する(R5。文言は実装時に確定) |
| `scripts/mcp-smoke.mjs` | 新能力キー(例: `"or a join of both"`)を追加し、廃止する文言のキー(`"INSERT INTO app ... SELECT is supported"` / `"UPSERT INTO app ... SELECT is supported"` は統合後文言に合わせて見直し、`"counts inserts + updates"` は維持)を差し替え。describe の変更に伴い `"caps the source SELECT read"` キーも新文言のキーに差し替え(R5)。**assertion 先行 → 旧バンドルで失敗確認 → description / describe 適用**(恒例の regression 証明手順)。注意: 旧文言「but not both in one statement」「for app sources only」は現行 smoke のキーに含まれていないため、**キー追加を先に行わないと退行検出できない** |

### 4.3 テスト

| 対象 | ケース |
| --- | --- |
| `src/__tests__/executeBatch.test.ts` | 既存の混在拒否テスト(`INSERT_SELECT: APP ソース混在(JOIN)は拒否`)を**成功テストに置換**(JOIN 結果の行数・内容と postRecords 内容を検証)/ temp ソース UPSERT_SELECT の成功と confirm(実体化行数)適用 |
| `src/mcp/__tests__/tools.test.ts` | 既存の混在拒否テスト(INSERT_SELECT)と temp ソース拒否テスト(UPSERT_SELECT)を成功テストに置換 / 混在 UPSERT_SELECT の成功(insert / update 混在)/ confirm 経由の dmlMaxRows・dmlTotalMaxRows(超過時ゼロ書き込み)/ JOIN の APP 側 fetch が読み取り上限で安全側に失敗するケース(§3.1)/ 回帰: temp のみ・APP のみソース(v1.5.0 / v1.6.0)、UPDATE の temp 参照拒否(汎用メッセージ) |
| モック注意 | JOIN の突き合わせはモックがクエリを無視するため、アプリ別のデータ内容でヒット/非ヒットを作る(恒例) |

### 4.4 ドキュメント

| ファイル | 変更 |
| --- | --- |
| `docs/ksql_batch_temp_table_spec.md` | §7.3 の「ソースに APP と一時テーブルの混在は不可」「UPSERT_SELECT の一時テーブルソースはエンジン未対応」を解禁に更新、§9 の混在エラー行・temp UPSERT_SELECT エラー行を削除(または「〜v1.6.0」注記)。更新履歴 Rn |
| `docs/ksql_mcp_server_spec.md` | §7.6 拒否リストを空に(または「なし」)し、許可側の記述を「SELECT-based DML は temp / APP / 混在ソースとも可」に統一。**v1.6.0 で書いた「UPSERT_SELECT には temp 迂回路がない」を撤回**し、§3.1 の制約(JOIN の APP 側読み取り上限と temp 実体化による回避 + 10,000 行併記)に置き換え |
| `docs/ksql_mcp_changes.md` | v1.7.0 の変更履歴 + §13 実測値更新 |
| 内部ドキュメント | 本仕様案・実装計画のステータス / Rn。`ksql_mcp_upsert_select_unlock_spec.md` の「迂回路なし」記述に v1.7.0 での解消を注記 |

## 5. 受け入れ基準

1. バッチ内の混在ソース INSERT_SELECT(`FROM #t JOIN APPx` / `FROM APPx JOIN #t` / サブクエリ内 temp 参照)が実行でき、JOIN 結果が正しく INSERT される
2. バッチ内の temp / 混在ソース UPSERT_SELECT が実行でき、insert / update が正しく振り分けられる
3. source 件数(UPSERT_SELECT は照合後の insert + update 合計)が `dmlMaxRows` 超過なら、**当該 INSERT_SELECT / UPSERT_SELECT 文では POST / PUT ゼロ件**で ArgumentError(confirm 経由)。DML バッチは非アトミックのため、前段で成功済みの文の書き込みは残る(既存仕様どおり。fail-fast で後続は skipped)
4. JOIN の APP 側 fetch が `dmlMaxRows + 1` 超過なら書き込み前に安全側エラー
5. temp のみ / APP のみソース(v1.5.0 / v1.6.0)・UPDATE 等の temp 参照拒否は回帰しない
6. description・仕様書に「混在不可」「UPSERT_SELECT は temp 不可 / 迂回路なし」の記述が残らない

## 6. 未決事項(R4 ですべて確定)

1. ~~対象バージョン・搭載先~~ → **v1.7.0 に A + B 同梱で確定**(R4。ガード緩和と description 改訂が一体のため)
2. ~~description の新文言~~ → **確定(R4、codex 案)**: `INSERT/UPSERT INTO app ... SELECT supports app sources, temp tables, or joins of both. For UPSERT, dmlMaxRows counts inserts + updates. The source SELECT reads at most dmlMaxRows + 1 app records; temp tables hold at most 10000 rows.`(混在可・UPSERT 合計・APP/temp 上限の3点を1回で伝える)
3. ~~§9 エラー表の廃止行の扱い~~ → **履歴注記で確定**(R4。現行エラーの表からは消し、「v1.5.0〜v1.6.0 の旧制限」として更新履歴/脚注に移す)
4. ~~UPSERT_SELECT の temp / 混在対応を別提案に切り出すか~~ → **同梱に変更(R2)**。理由: ①ガード緩和が同一行の編集で、別リリースだと二度手間+コンフリクト、②配管は M4 以来実戦投入済みの経路(`executeQueryWithCte`)の鏡写しでリスクが低い(§1.1)、③同梱で SELECT-based DML のソース制限が最終解消し、description の書き換えも1回で済む

## 更新履歴

- R5(2026-07-10、codex・Medium/Low、計画レビュー): ①(Medium)`dmlMaxRows` describe「変更不要」の判断を撤回 — 「caps the source SELECT read (dmlMaxRows + 1)」は temp / 混在ソースでは過大になるため、mutate / runSavedQuery の両 describe を「APP ソース読み取りの cap / temp は実体化 10,000 行 / UPSERT は合計」が伝わる文言に更新し、smoke キーも差し替え対象に追加(§4.2)。②(Low)受け入れ基準にあるサブクエリ内 temp 参照(`WHERE ... IN (SELECT ... FROM #t)`)の明示成功テストを実装計画 X1 に追加
- R4(2026-07-10、codex レビュー完了): 追加指摘なし。未決3点を確定(v1.7.0 に A+B 同梱 / description は codex 案 / §9 エラー表は履歴注記方式)。ステータスを「レビュー済み・確定」に変更し、実装計画ドキュメントを作成
- R3(2026-07-10、codex): ①(Medium)§3.1 の temp 実体化による回避策を「source / JOIN 側の APP fetch の回避」に限定 — UPSERT_SELECT は temp のみソースでも書き込み先 APP の照合読み取り(`resolveUpsertTargets`)が残るため。②(Low)§3 の「完全に同じガード」を「書き込み側ガードは同じ・読み取り側上限はソース種類ごとに異なる」に精密化。③(Low)受け入れ基準3の「書き込みゼロ件」を「当該文では POST / PUT ゼロ件」に限定(DML バッチは非アトミック・fail-fast の既存仕様と整合)
- R2(2026-07-10): 「UPSERT_SELECT の temp / 混在に対応できるか」の追加調査(§1.1)を反映し、提案B として同梱する構成に改訂(§6-4 の推奨を反転)。タイトルを「SELECT-based DML のソース制限 最終解消」に変更
- R1(2026-07-10): 初版(v1.6.0 実装完了後の「混在対応は可能か」調査に基づく。codex 未レビュー)
