# 非グループ集計の 0 件時「1 行」返却 実装計画

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R3(S3 実施・メタデータ更新見送り): `src/mcp/schemas.ts` / `src/mcp/index.ts` を `no rows` / `1 row` / `aggregate` / `COUNT` / `ASSERT` で grep した結果、0 件集計の旧挙動(0 行)を前提にした記述は**なし**(ASSERT の description はゲート意味論のみ、スカラーサブクエリの行数要件への言及なし)。新挙動は標準 SQL でありモデルの既定想定と一致するため、追記も行わない(smoke assertion 変更なし)
  - 2026-07-11 R2(codex レビュー反映・2件反映 / 1件不採用): ①(高)S5-6 のリリース手順を「bump → **全成果物再ビルド** → verify → **バージョン整合確認** → release/ 差し替え」の順に修正 — dist-cli はバージョン埋め込み、プラグイン zip は zip 名・zip 内 manifest にバージョンが入るため bump 後の再ビルドが必須(R1 は bump 直後に release/ 差し替えへ進む記述で欠落)②(中)S3 手順 2 の「旧バンドル red 確認」を実行可能な手順に具体化 — `mcp-smoke.mjs:10` は実行対象を `dist-mcp/ksql-mcp.js` に固定しており release/ を直接指定できない(コードで裏取り)。実手順は「**再ビルド前の dist-mcp(直前リリースのバンドル)に対して smoke 実行**」(v1.11.0 T5 の実績方式)+ dist-mcp がない場合の一時コピー手順を明記 ③(中・**不採用**)「tsc 既存 10 件基準は誤り(現在 exit 0・0 件)」の指摘は、2026-07-11 に main(a897dea)で `npx tsc --noEmit` を実測した結果 **exit 2・エラー 10 件(すべて `src/ui/desktop.ts`)** で従来基準と一致したため反映しない(codex 側の実行環境差と推定。10 件基準を維持 — 0 件前提にすると desktop.ts の既存エラーで完了条件が恒久 fail になる)
  - 2026-07-11 R1: 初版(仕様 R2 確定を受けて作成)
- ステータス: **codex レビュー済み・R2 反映済み(反映を条件に実装着手可の判定)**
- 対象バージョン: **v1.12.0**(既定挙動の変更を含むため minor バンプ + CHANGELOG **Changed** 明記)
- 仕様: [ksql_ungrouped_aggregate_empty_result_spec.md](ksql_ungrouped_aggregate_empty_result_spec.md)(codex R2 反映済み・確定)
- 推奨ブランチ: `fix/ungrouped-aggregate-empty-result`(単一ブランチ・単一 PR)

---

## 1. 概要

エンジン層 `applyGroupBy`(`src/engine/process.ts:182-234`)に「空入力 + GROUP BY なし + 集計列あり」の場合に空の仮想グループを 1 つ挿入する 3 行(+集計列判定の共有ヘルパ抽出)を加え、GROUP BY のない集計 SELECT が 0 件でも常に 1 行を返すようにする(SQL 標準準拠化)。**値決定ロジックの新規実装はゼロ** — `evalAggregate` / `evalAggArithExpr` / `project` は空配列・空行に対応済みで、変更の本体は「合成条件の 1 箇所」と「回帰テスト・ドキュメントの同期」。

ASSERT の 1 行 1 列検証(`src/execute.ts:735-737`)・スカラーサブクエリ消費 4 箇所(仕様 §1.4)は**一切変更しない** — 集計クエリが 1 行を返すようになることで挙動だけが変わる。

### ステップ一覧と依存関係

| ステップ | 内容 | 依存 |
|---|---|---|
| S1 | エンジン修正本体 + process 単体テスト(仕様 §4.1・§7.1) | なし |
| S2 | execute 層回帰テスト — ASSERT 成立・スカラー 4 箇所・挙動反転の固定(仕様 §7.2) | S1 |
| S3 | モデル向けメタデータの grep 洗い出し + 必要時のみ更新(仕様 §5) | S1(文言確定後) |
| S4 | ドキュメント更新(仕様 §6) | S1〜S3 の確定後 |
| S5 | 検証・リリース準備 | S1〜S4 |

実装順は S1 → S2 → S3 → S4 → S5。各ステップ「テスト通過 → コミット」で進める(v1.10.0 以降の慣例)。

## 2. 実装ステップ

### S1: エンジン修正本体(仕様 §4.1)+ process 単体テスト(仕様 §7.1)

| 項目 | 内容 |
|---|---|
| 変更 1 | `src/engine/process.ts` — 集計列判定ヘルパ `hasAggregateColumns(columns)` を追加(export)。`runFullScan:801-805` の既存インライン述語(`AGGREGATE` / `ARITH_AGG_COL` / 集計入り `STRFUNC_COL`)をそのまま関数化し、`runFullScan` 側を呼び出しに置き換える(**挙動不変のリファクタ**) |
| 変更 2 | `applyGroupBy`(`:182-234`)— グループ Map 構築後(`:194` 直後)に仮想グループ挿入: `if (groups.size === 0 && groupByKeys.length === 0 && hasAggregateColumns(columns)) { groups.set("", []); }`(コメントは仕様 §4.1 の文案どおり: SQL 標準準拠の趣旨・SUM 等 0 の根拠・集計列条件が関数単独契約のためであること) |
| 変更 3 | `const outRow = { ...groupRows[0] }`(`:199`)— 空仮想グループでは `groupRows[0]` が undefined でスプレッドが `{}` になることをコメントで明示(仕様 §4.1。**暗黙依存の言語化のみ、コード変更なし**) |
| 設計メモ | 変更 1 と 2 は同一コミット(ヘルパは変更 2 のためにある)。`src/execute.ts` / `src/converter/` / 入出力層は触らない(仕様 §4.2) |
| テスト(`src/engine/__tests__/process.test.ts`) | 仕様 §7.1 の 10 項目: ① 空入力 + `COUNT(*)` → `"0"` の 1 行 / ② `COUNT(f)` / `COUNT(DISTINCT f)` / `SUM` / `AVG` / `MAX` / `MIN` → すべて `"0"` / ③ `ARITH_AGG_COL`(`SUM(a) - SUM(b)` → `"0"`、0 除算は既存 NaN 挙動) / ④ 集計入り `STRFUNC_COL`・集計 + 非集計 FIELD 混在(FIELD は空文字) / ⑤ GROUP BY あり + 空入力 → 0 行(不変条件 2) / ⑥ **非集計列のみ**の直接呼び出し → 0 行(不変条件 7・R2) / ⑦ `runFullScan` 統合: WHERE 全滅 + `COUNT(*)` → 1 行 + columns に列名(§3.2) / ⑧ `HAVING COUNT(*) > 0` + 空入力 → 0 行 / ⑨ 合成行への `LIMIT 0` → 0 行・`OFFSET 1` → 0 行 / ⑩ 既存テスト全件 green(不変条件 1) |
| 完了条件 | 上記テスト green + 既存 process テスト無変更で green |

### S2: execute 層回帰テスト(仕様 §7.2)

エンジン変更は S1 で完了しているため、このステップは**テスト追加のみ**(発端パターンと挙動反転の固定)。

| 項目 | 内容 |
|---|---|
| 変更 1(`src/__tests__/executeAssert.test.ts`) | ① `ASSERT (SELECT COUNT(*) FROM APPn WHERE 異常条件) = 0` が空該当で**成立**(発端パターン・仕様 §7.2-1) / ② 既存 `:126-130`(非集計 0 行プローブの AssertError)が**無変更で green** であることを確認(不変条件 4 — 書き換え不要の見込みは仕様 §3.4 で裏取り済み) |
| 変更 2(`src/__tests__/execute.test.ts` ほか該当ファイル) | ③ WHERE スカラー: `WHERE f = (SELECT COUNT(*) FROM 空)` → `0` と比較 / ④ SELECT 列スカラー・UPDATE SET サブクエリ: 0 件集計が `0` に解決 / ⑤ `CREATE TEMP TABLE #t AS SELECT COUNT(*) FROM 空` → 1 行実体化 + 後続 `SELECT * FROM #t` 参照可(`executeBatch.test.ts`) / ⑥ バッチ: 言語リファレンス CLI 例と同形の ASSERT ゲート成立 → 後続文実行 |
| 変更 3(挙動反転の固定 — 仕様 §7.2-7・R2) | ⑦ `WHERE EXISTS (SELECT COUNT(*) FROM 空)` → 全行 true 側(false からの**反転**) / ⑧ `WHERE f IN (SELECT COUNT(*) FROM 空)` → `f = "0"` の行が一致 / ⑨ `INSERT INTO app (...) SELECT COUNT(*) FROM 空` → **1 行書き込み** + confirm / dmlMaxRows の件数判定に 1 行として乗る(不変条件 6) |
| 設計メモ | テストデータは SIMPLE モードの WHERE 押し下げに注意(モックはクエリを無視して絞らない) — **アプリ別のデータ内容で 0 件を構成**する(空アプリ or 集計側だけ空のアプリを分ける。v1.9.0 実装時の教訓)。事前 grep で「0 件集計 → 0 行」を期待する既存テストがないことは確認済み(`toEqual([])` / `toHaveLength(0)` 全ヒットが API 呼び出し回数の検証のみ — 2026-07-11 時点) |
| 完了条件 | 仕様 §8-1・§8-5 に対応するテストが green |

### S3: モデル向けメタデータ — grep 洗い出し + 必要時のみ更新(仕様 §5)

| 項目 | 内容 |
|---|---|
| 手順 1 | `src/mcp/schemas.ts` / `src/mcp/index.ts` を `no rows` / `1 row` / `aggregate` / `COUNT` で grep し、0 件集計の旧挙動(0 行)を前提にした記述を洗い出す |
| 手順 2 | **更新が必要な場合のみ**: 仕様 §5 の文言案(「Aggregate SELECT without GROUP BY always returns exactly one row ...」)で describe / description を更新し、`scripts/mcp-smoke.mjs` の assertion に新フレーズを追加。**assertion 先行 → 旧バンドル red 確認 → 実装適用**の順(v1.4.1 以来の regression ガード方式)。旧バンドル red 確認の実行手順(R2): `mcp-smoke.mjs:10` は実行対象を **`dist-mcp/ksql-mcp.js` に固定**しており release/ を直接指定できないため、①assertion 差し替え後・**`build:mcp` 実行前**に `npm run mcp:smoke` を実行する(手元の dist-mcp には直前リリース = v1.11.0 のバンドルが残っており、これが旧バンドルとして機能する — v1.11.0 T5 の実績方式)②dist-mcp が存在しない・作り直してしまった場合は `release/ksql-mcp.js` を `dist-mcp/ksql-mcp.js` へ一時コピーして実行(検証後の `build:mcp` で上書きされるため後始末不要) |
| 手順 3 | 更新不要と判断した場合はその旨を本計画の更新履歴に記録する(「grep 結果ゼロのため見送り」等 — 判断の痕跡を残す) |
| 設計メモ | 現時点の把握では ASSERT describe は「1 行 1 列要求」の一般論のみで集計 0 件の特記はない見込み(仕様 §5)。ただし v1.10.0 の教訓(ksql_query description への ASSERT 反映漏れ)があるため、**grep による網羅確認を省略しない** |
| 完了条件 | grep 結果ゼロ、または更新 + smoke green(旧バンドル red の証明付き) |

### S4: ドキュメント更新(仕様 §6)

| ファイル | 内容 |
|---|---|
| `docs/ksql_language_reference.md` §8(集計関数) | 「0 件時の挙動」小節を追加: GROUP BY なし集計は常に 1 行(COUNT → 0、SUM/AVG/MIN/MAX → 0。**標準 SQL の NULL と異なる**こと、「対象なし」と「合計 0」の区別には COUNT 併用を明記)。GROUP BY ありは 0 行 |
| `docs/ksql_language_reference.md` ASSERT 節 | 「0 行を NULL 扱いにしません」の段落に v1.12.0 の変更を追記(集計サブクエリは 0 件でも 1 行 → `= 0` 型健全性チェックが成立。0 行エラーは非集計プローブ・HAVING で行が消えた場合に発生)。サブクエリ節(「1 行 1 列を返す必要」)も同様に更新 |
| `docs/ksql_batch_enhancement_phase1_spec.md` | §2.2 エラー表に注記 + 更新履歴 R 追記(0 行エラーは v1.12.0 以降、非集計プローブ等に限られる) |
| `docs/ksql_batch_temp_table_spec.md` | ASSERT エラー表に同上の注記 + 0 件集計ソースの temp table が 1 行実体化になる点(仕様 §3.3)+ R 追記 |
| `docs/ksql_mcp_changes.md` | v1.12.0 エントリ(MCP 経由で観測可能な挙動変更) |
| `CHANGELOG.md` | v1.12.0 追加。**Changed** として仕様 §3.3 の表の要点を列挙 — 特に `EXISTS (SELECT COUNT(*)...)` の false → true と `INSERT ... SELECT 集計` の 1 行書き込みは個別に言及(リリース日は「未リリース」でリリース時確定 — 慣例) |
| 洗い出し | 利用者向けドキュメントを `0 行` / `no rows` / `1行1列` で grep し、旧挙動前提の記述の取りこぼしを確認(v1.7.0 R5 の教訓: 公開ドキュメント追従は言語リファレンス含め grep で網羅確認) |

### S5: 検証・リリース準備

1. `npm test` 全 green(現行 731 件基準 + 本件追加分。console/dml_guard e2e の並列コールドラン・フレークは再実行で確認)
2. `tsc --noEmit` — **件数比較(既存 10 件基準)**で新規エラーなし(基準は 2026-07-11 に main a897dea で実測再確認: exit 2・10 件・すべて `src/ui/desktop.ts` — R2。0 件前提にしないこと)
3. **`npm run build` で全成果物を再生成**: `src/engine/process.ts` は core 経由で**全成果物に入る** — `build:cli` → `dist-cli/ksql.js` / `build:mcp` → `dist-mcp/ksql-mcp.js` / `build:mcpb` / **`build:plugin` → `prod/js/desktop.js`(prod/ が変わるためプラグイン zip 再パッケージ対象 — v1.7.0 の教訓。pack 失敗はビルドを止めないので `dist/ksql-plugin-vX.zip` の生成を必ず確認)**。`mcp:verify` / `mcpb:verify` green
4. **ビルド成果物の実機実行**(v1.10.0 の教訓: 単体テストは run 関数のゲートを通らない): `dist-cli/ksql.js` 直実行で発端パターン `ksql -e "ASSERT (SELECT COUNT(*) FROM APPn WHERE 異常条件) = 0"` が該当 0 件で exit 0 / 1 件以上で `assertion failed (actual: n)` になることを確認
5. 実機確認(ユーザー実施): MCP(/mcp reconnect で dist-mcp 直指し入れ替え)・プラグインの少なくとも一方で、0 件集計 SELECT が「0 の 1 行」を表示すること + ASSERT ゲートバッチの成立
6. リリース時は次の順を厳守する(R2 — bump 後の再ビルドなしに release/ へ進まない):
   1. **version bump**: **package.json / package-lock / prod/manifest.json** の 3 点(v1.9.0 の教訓: manifest 忘れ)
   2. **全成果物の再ビルド**: `npm run build` — dist-cli はバージョン埋め込み、プラグイン zip は zip 名(`dist/ksql-plugin-v1.12.0.zip`)と zip 内 manifest にバージョンが入るため、**bump 前のビルド成果物(手順 3)は release/ に使えない**。pack 失敗はビルドを止めないので zip 生成を必ず確認
   3. **verify**: `mcp:verify` / `mcpb:verify` green
   4. **バージョン整合確認**: `dist-cli/ksql.js --version` = 1.12.0、`dist/ksql-plugin-v1.12.0.zip` の存在、zip 内 manifest.json version = 1.12.0(v1.11.0 リリースと同じ確認項目)
   5. **release/ 差し替え**(明示手順 — ビルドでは自動反映されない): dist-mcp/dist-mcpb のコピー + プラグイン zip 同梱 + VERSION.txt / README.txt 更新
   6. PR → codex レビュー → マージ → タグ v1.12.0 → **gh release create / upload まで**(v1.7.0 の教訓: 配布は GitHub Releases 経由がセット)→ CHANGELOG リリース日確定 → npm publish(ユーザー操作)

## 3. リスクと対策

| リスク | 対策 |
|---|---|
| 既定挙動の変更が既存利用を壊す | 影響経路は仕様 §3.3 の表で全列挙済み・§9 で影響評価済み(主要パターンは診断メッセージの改善方向)。CHANGELOG **Changed** で EXISTS 反転・INSERT 書き込み変化を個別告知。発動条件が「空入力 かつ GROUP BY なし かつ 集計列あり」に閉じており、非空入力・GROUP BY あり・非集計クエリへの影響経路がない(仕様 §9) |
| 既存テストが旧挙動(0 件集計 → 0 行)を前提にしている | 事前 grep で該当なしを確認済み(S2 設計メモ)。万一 S1 で fail した場合は「テストが非標準挙動を固定していた」ケースなので、仕様 §3.3 と突き合わせて期待値を更新し、変更理由をコミットメッセージに記録 |
| メタデータとコードの乖離(LLM 誤学習) | S3 の grep 網羅確認を必須化(v1.10.0 で ksql_query description の反映漏れが再発した教訓)。更新時は assertion 先行方式 |
| SIMPLE モード経路の見落とし | 集計は常に FULL_SCAN(`src/converter/selectToKintone.ts:59-74` で裏取り済み — 仕様 §1.1)。converter は無変更のため経路追加なし |
| 行番号ずれ | 本計画の行番号は v1.11.0(main a897dea)時点。実装時は grep で再特定する |
