# UPSERT ガード doc-drift 修正(提案A)+ UPSERT_SELECT 解禁(提案B) 実装計画

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R4(提案B 実装完了): B1〜B5 実装済み(ブランチ `feat/mcp-upsert-select-app-source`)。B4 は計画どおり assertion を先に差し替え、v1.5.0 バンドルで smoke が失敗することを確認してから B3 を適用。description は確定文言の語順を一部調整(`for app sources only (temp-table sources are not supported); dmlMaxRows counts inserts + updates.` — temp 不可の掛かり先を UPSERT_SELECT に限定するため括弧内へ移動。キー文字列は維持)。テスト追加8本(単文5 + バッチ3。照合第1キー低選択性ケースを含む)
  - 2026-07-10 R3(codex レビュー完了): 追加指摘なし。進め方確定 — ①提案A を v1.5.0 ブランチに独立コミット → ②v1.5.0 を固める(PR・実機確認)→ ③提案B を v1.6.0 別ブランチで実装
  - 2026-07-10 R2(codex レビュー反映): A2 の mutateBatch コメント修正案に `REORDER` を追加(Low。`executeReorder` も confirm を呼ぶため、confirm 文種の列挙として一貫させる)。仕様案 §1.1 の R2 前表現の残存も同時修正(仕様 R4)
  - 2026-07-10 R1: 初版(仕様案 R3 確定を受けて作成)
- ステータス: **提案A・提案B とも実装済み**。残り: B6 実機確認(ユーザー実施)・npm publish
- 仕様: [ksql_mcp_upsert_select_unlock_spec.md](ksql_mcp_upsert_select_unlock_spec.md)(codex R1〜R3 レビュー済み・確定)
- 搭載先(仕様 §4 で確定):
  - **提案A**: v1.5.0 ブランチ `feat/mcp-insert-select-app-source` に独立コミットで同乗(コード変更なし。ドキュメント + 回帰テストのみ)
  - **提案B**: **v1.6.0**・新ブランチ `feat/mcp-upsert-select-app-source`(v1.5.0 の PR マージ後に main から分岐)

---

## 1. 概要

- **A(doc-drift 修正)**: UPSERT は実装上すでに confirm(insert + update 合計)経由で `dmlMaxRows` / `dmlTotalMaxRows` の対象。誤って「対象外」と記述しているドキュメント・コメントを実装準拠に直し、裏付けの回帰テストを追加する
- **B(UPSERT_SELECT 解禁)**: v1.5.0 の INSERT_SELECT と同型。**変更の本体はガード削除2箇所のみ**で、新規の安全機構はない。INSERT_SELECT との違いは「一時テーブルソースがエンジン未対応(迂回路なし)」「dmlMaxRows は insert + update 合計」「照合読み取りは第1キー検索(低選択性キーで安全側エラーになり得る)」の3点で、これらをメタデータ・ドキュメントに正確に反映することが実装の中心になる

## 2. 提案A のステップ(v1.5.0 ブランチ・独立コミット)

### A1: 回帰テストの追加(`src/mcp/__tests__/tools.test.ts`)

| 項目 | 内容 |
|---|---|
| テスト1 | 単文 UPSERT(VALUES): 照合結果の insert + update 合計が `dmlMaxRows` 超過なら書き込み前に `ArgumentError`。**`postRecords` / `putRecords` とも未呼び出し**をモックで検証(`makeMutateRuntimeDeps` の calls.post / calls.put) |
| テスト2 | バッチ: INSERT VALUES(静的加算)+ UPSERT(confirm 加算)の合計が `dmlTotalMaxRows` 超過で fail-fast。エラーメッセージの報告値が正しい合計であること(= 二重計上なしの証明。v1.5.0 の INSERT_SELECT テストと同型) |
| 設計メモ | UPSERT の confirm は operation `"UPDATE"` で呼ばれるため、超過メッセージは `UPDATE affected rows (N) exceed dmlMaxRows (M)` になる(仕様 §3.4 の表記課題。テストの期待値はこの文言)。モック注意: 照合(`resolveUpsertTargets`)は第1キーの `in (...)` クエリを発行するが、モック client はクエリを無視して全行返すため、**target アプリのデータ内容でヒット/非ヒットを作る**(v1.4.0 の教訓①) |
| 完了条件 | 2テストがグリーン(実装変更なしで通る = doc-drift の証明) |

### A2: ドキュメント・コメント修正

| 箇所 | 修正 |
|---|---|
| `docs/ksql_batch_temp_table_spec.md` §7.3 | 「**UPSERT の影響行数は対象外**(単文 ksql_mutate の挙動と同等。将来課題)」→「UPSERT は confirm(insert + update 合計)経由で実行時加算され、`dmlMaxRows` / `dmlTotalMaxRows` の**対象**」。更新履歴に Rn 追記(根拠: `src/execute.ts:1997-2002`、初回コミットから存在) |
| `src/mcp/tools.ts` mutateBatch のコメント | 「バッチ合計の影響行数(INSERT は静的、UPDATE / DELETE は confirm で加算)」→「(INSERT(VALUES)は静的、confirm を呼ぶ文種 = UPDATE / DELETE / UPSERT / INSERT_SELECT / REORDER は実行時加算)」(R2: REORDER も `executeReorder` が confirm を呼ぶ — `src/execute.ts:2389-2391`) |
| 完了条件 | `対象外` の記述が仕様書から消え、コメントが confirm 実装と一致する |

コミットは A1 + A2 で1つ(`docs+test(mcp): UPSERT の dmlMaxRows/dmlTotalMaxRows ガードを実装準拠に文書化` 等)。
v1.5.0 の検証結果(`ksql_mcp_changes.md` §13)のテスト件数が変わるため、同コミットで実測値を更新する。

## 3. 提案B のステップ(v1.6.0・新ブランチ)

実装順は **B1 → B2 → B4(assertion 先行)→ B3 → B5 → B6** を推奨(v1.5.0 U ステップと同じ考え方)。

### B1: 単文 UPSERT_SELECT 拒否の削除 + テスト

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts` mutate 単文経路の `UPSERT_SELECT is not supported by ksql_mutate yet.` throw を削除 |
| 設計メモ | 削除後は既存の単文 DML 経路に乗るだけ(新規コードなし)。ランタイム `maxRecords = dmlMaxRows + 1`・`onLimit = "error"` が source SELECT と照合 fetch の両方に効く。confirm は `executeUpsertSelect` が照合後・書き込み前に呼ぶ(`src/execute.ts:2509-2514`) |
| テスト | ① 成功: `insertedCount` / `updatedCount` の検証(target に一部キー一致行を置き、insert と update が混在するデータで)/ ② 合計件数 > dmlMaxRows: `ArgumentError`(`UPDATE affected rows` 文言)かつ **POST・PUT とも未実行** / ③ source 行数 > dmlMaxRows + 1: 読み取り上限で失敗 / ④ **照合読み取り上限(仕様 R2)**: source 1行・target の第1キー一致行が dmlMaxRows + 1 超 → 書き込み前に `FetchAllLimitError` / ⑤ 承認3点セット欠落 |
| モック注意 | ④ は「第1キーの `in (...)` クエリをモックが無視して target 全行を返す」性質をそのまま利用できる(target アプリに dmlMaxRows + 2 行置くだけで再現)。②〜④ の期待値作りはすべて WHERE ではなくアプリ別データ内容で行う |
| 完了条件 | 仕様 §3.7-1・2・2b |

### B2: バッチの UPSERT_SELECT 拒否の削除 + テスト

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts` mutateBatch 静的ガードの `UPSERT_SELECT is not supported by ksql_mutate yet.` throw を削除 |
| 設計メモ | 一時テーブルソースはエンジン層の validate-all-first が `temp table references in UPSERT_SELECT are not supported yet.` で実行前拒否する(メッセージは正確で誤誘導がないため**変更しない**。v1.5.0 U1 のような文言変更は不要) |
| テスト | ① バッチ内 APP ソース UPSERT_SELECT 成功 / ② `dmlTotalMaxRows` 合算(INSERT VALUES 静的 + UPSERT_SELECT confirm。二重計上なしを報告値で証明)/ ③ **一時テーブルソースはエンジン層メッセージで実行前拒否**(`calls.get === 0`)/ ④ 回帰: INSERT_SELECT(v1.5.0)・UPSERT(VALUES)・WHERE なし UPDATE/DELETE |
| 完了条件 | 仕様 §3.7-3・4・5 |

### B4: mcp-smoke assertion の差し替え(B3 より先)

| 項目 | 内容 |
|---|---|
| 変更 | `scripts/mcp-smoke.mjs` mutateKeys の `"UPSERT ... SELECT is rejected"` を削除し、新キーに差し替え。案: `"UPSERT INTO app ... SELECT is supported"` / `"counts inserts + updates"` |
| 順序制約 | **B3 より先に assertion を差し替え、旧バンドルで smoke が失敗することを確認してから B3 を適用・再ビルド**(v1.5.0 U5 / R4 と同じ regression 証明手順) |
| 追加 | `dmlMaxRows` describe の既存キー `"caps the source SELECT read"` は維持(文言更新後も含まれること)。UPSERT の合計カウントを表すキー(`"inserts + updates"` 等)を **mutate / runSavedQuery の両ツール**の describe assertion に追加(v1.5.0 codex R4 の教訓: runSavedQuery を忘れない) |
| 完了条件 | 旧文言バンドルで smoke が落ち、B3 適用後のバンドルで通る |

### B3: メタデータ更新(description / describe)

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/mcp/index.ts`(ksql_mutate description): 「UPSERT ... SELECT is rejected.」を仕様 §4-4 の確定文言に置換: `UPSERT INTO app ... SELECT is supported for app sources only; dmlMaxRows counts inserts + updates. Temp-table sources are not supported.` |
| 変更 2 | `src/mcp/schemas.ts` の `dmlMaxRows` describe(**mutate / runSavedQuery の両方**): INSERT/UPSERT 共通の source read cap 表現に更新し、UPSERT ... SELECT は insert + update 合計を数える旨を追記。案: `Per-statement cap on affected rows. The call fails before writing if any statement would exceed it. For INSERT/UPSERT ... SELECT this also caps the source SELECT read (at most dmlMaxRows + 1 records); for UPSERT it counts inserts + updates.` |
| 禁止事項 | **「一時テーブルに逃がす」案内を書かない**(仕様 §3.4-1。UPSERT_SELECT では temp ソースがエンジン未対応のため嘘になる)。description 側で `Temp-table sources are not supported.` と明示するのはこのため |
| 完了条件 | tools/list に「UPSERT_SELECT 非対応」の宣言が残らず、B4 の assertion が通る |

### B5: ドキュメント更新

| ファイル | 変更 |
|---|---|
| `docs/ksql_mcp_server_spec.md` | §7.6 許可リストに `UPSERT_SELECT`(APP ソースのみ)を追加、拒否リストを「temp / 混在ソースの SELECT-based DML」に整理。§7.6.1 リスク表の UPSERT 行(照合コスト・件数の曖昧さ)を解消済みに更新。§7.6.2 段階対応 5 を「済(v1.6.0)」に。§7.6.3「UPSERT_SELECT 対応時の想定フロー」を実装済みフロー(照合後 confirm・operation は "UPDATE" のまま)に書き換え |
| `docs/ksql_batch_temp_table_spec.md` | §7.3 の SELECT-based DML 記述を v1.6.0 状態に更新(A2 の修正の上に積む)。§9 のエラー表は temp ソース UPSERT_SELECT のメッセージ(変更なし)を明記 |
| `docs/ksql_mcp_changes.md` | §11.8(v1.6.0)を追加: 挙動変化(従来エラー → 書き込み発生)、第1キー低選択性の安全側エラー特性、temp ソース非対応(迂回路なし)を明記。§13 検証結果を v1.6.0 実測値に更新 |
| 内部ドキュメント | 仕様案・本計画のステータス / 更新履歴(Rn) |

### B6: 実機検証

| 項目 | 内容 |
|---|---|
| 任意 | `scripts/mcp-kintone-smoke.mjs` に UPSERT_SELECT ケースを任意追加 |
| ユーザー実施 | Claude Desktop で MCP サーバー再起動 → `UPSERT INTO APPx (...) SELECT ... FROM APPy ON DUPLICATE (...)` を依頼し、ksql_mutate が一発で選択・成功すること。insert / update が混在する結果の件数報告も確認 |

## 4. 仕上げ(提案B のリリース手順)

1. `npm test`(全件。基準は A 反映後の件数から更新)
2. `tsc --noEmit` は**件数比較**(既存 10 件基準。`src/ui/desktop.ts`)
3. `package.json` を **1.6.0** に bump(serverInfo.version は esbuild define で自動同期・smoke が担保)
4. `npm run build` → `mcp:verify`(smoke + pack-smoke)→ `npm audit --omit dev` → `git diff --check`
5. `release/ksql-mcp.js` / `ksql-mcp.mcpb` 差し替え、`VERSION.txt` / `README.txt` 更新(MCP のみ更新の形式)
6. npm publish(ユーザー操作)

## 5. リスクと留意点

- **挙動変化**: 従来 `ArgumentError` だった UPSERT_SELECT 呼び出しが書き込みを行うようになる(changes に明記)。既存成功ケースの挙動・レスポンス形式は不変
- **エラー表記**: 超過時のメッセージが `UPDATE affected rows ...` になる(operation "UPDATE"。仕様 §3.5-2 で現状維持と確定)。テスト期待値・ドキュメント例はこの文言で書く
- **prod/js/desktop.js**: 提案B はエンジン変更なしのため、プラグインバンドルの再生成差分は原則発生しない想定。`npm run build` 後に差分が出た場合は内容を確認してから含める
- **B4 の順序制約**(assertion 先行 → 旧バンドル失敗確認 → B3 適用)を守らないと regression ガードの機能証明が取れない
- 提案A を先に v1.5.0 へ入れてから B のブランチを切ること(B5 のバッチ仕様書更新が A2 の修正の上に積まれる前提のため、順序が逆だとコンフリクトする)
