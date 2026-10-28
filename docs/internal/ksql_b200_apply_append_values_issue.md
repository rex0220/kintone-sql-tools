# B200 `APPLY` の `APPEND` の値 — 1: as-of 関数を許す ／ 2: `APPEND (…) SELECT …` ／ 3: ソースに一時テーブル

- 状態: **1 = ✅ v3.88.0 でリリース（2026-10-28）／2 = ✅ v3.88.0 でリリース（2026-10-28 に保留解除して同日実装・規模 M は実績どおり）／3 = 📝 起票のみ（実需が出たら）**。テストは `src/flow-library/__tests__/b200AppendSelect.test.ts`（20 件）と `src/core/__tests__/b200AppendSelectScope.test.ts`（14 件）
- 種別: 機能（文法の純加法）
- 優先: 中
- 版: minor（v3.88.0 想定）。1 と 2 のどちらも、今エラーになる形が通るようになるだけ（純加法）
- 上流の依頼（正）: kintone-plugin の work-link `ksql-action-engine-ask-subtable.md`（依頼 KJ-5 の 5b）と `kSQLエンジンへの依頼-20261027-KJ6-APPEND_SELECT.md`（依頼 KJ-6＝2 の着手依頼）。回答は同じ場所の `kSQLエンジンからの回答-20261027-KJ5-サブテーブルの書き込み.md` §5 と `kSQLエンジンからの回答-20261028-KJ6-APPEND_SELECT.md`
- 関連: [B198](ksql_b198_flow_apply_mutation_publication_issue.md)（`/flow` で使うための前提）、[B199](ksql_b199_flow_subtable_import_publication_issue.md)（2 が選ばれて保留になった道）

## 1. B200-1 — as-of 関数を `APPEND … VALUES` でも書けるようにする（規模 S）

- 今は as-of 関数（`@NOW()` など）が書けるのは**素の `INSERT … VALUES` だけ**（`src/parser/parser.ts:4064` が `allowAsOf = true`）。**`UPSERT … VALUES` も不可**（`:4137`）、**`APPEND … VALUES` も不可**（`:4717`）。`CASE WHEN … THEN NOW() END` で逃げることもできない（実測＝`フィールド名またはテーブル名が必要です` で parse エラー）。
- 実装は `parser.ts:4717` の `allowAsOf` を `true` にし、`AppendOperation.values` の型を `LiteralInsertRow[]` から `InsertRow[]` へ広げるだけ。**実行時には届かない**（`resolveBatchVariableReferences`（`src/execute.ts:3279`）が文の AST を丸ごと歩いて VARIABLE をリテラルに置き換えるので、APPLY ブロックの中も先に解決される）。
- **`UPSERT … VALUES` の as-of は今回も開けない**（§27.5 の方針どおり）。`APPEND` だけ `INSERT … VALUES` と揃い、`UPSERT … VALUES` だけ不可のままになる**非対称は文書に明記する**。

## 2. B200-2 — `APPEND (f1, …, fn) SELECT …`（規模 M）

### 2.1 文法

1. `APPEND (…)` の後ろで `VALUES` の代わりに `SELECT` を受ける（`parser.ts:4717` の分岐を 1 つ増やし `parseSelect()` を呼ぶ。SELECT の文法そのものは再利用で、新設は無い）。
2. **`UPDATE … APPLY` の中だけ。** `INSERT … VALUES … APPLY (…)`・`UPSERT … ON INSERT/ON UPDATE APPLY (…)` の中では parse エラー（既存の「`INSERT INTO ... SELECT` は APPLY に対応していません」と同じ出し方）。
3. **1 ブロックに 1 つまで。同じブロックは `REMOVE ALL ROWS` + `APPEND … SELECT` の形だけ**（`REMOVE ALL ROWS` は必須。`PATCH` / 選択子つき `REMOVE` / `APPEND … VALUES` との同居は断る）。必須にする理由＝無しで許すと再実行で行が積み増しになり、dialect 1 が素の INSERT に KSQL1305 を出しているのと同じ非冪等になる。**緩めるのは純加法**なので、実需が出てからにする。
4. 複数の APPLY ブロック（複数テーブル）は可。各ブロックの SELECT は**文に 1 回ずつ**解決する。

### 2.2 意味論

1. **順番**: ①親を検出（2 件で打ち切る）→ ②2 件以上ならエラー（**SELECT は実行しない**）→ ③0 件なら SELECT も実行せず確認も呼ばず `success`（書込 0 回）→ ④SELECT を解決 → ⑤計画・post-image 検証・上限 → ⑥確認 1 回 → ⑦PUT 1 回。
2. **単一親**は実行時の判定。専用のエラー名 **`ApplyAppendSelectMultipleParentsError`**（`toBatchStatementError`（`src/execute.ts:3167`）が `name` を `/flow` の `error.code` に写すので、依頼元が文面を出し分けられる）。静的な形の制限はしない（`顧客コード = @cust` が 1 件に決まるかは静的に分からない）。
3. **列と型の対応は `INSERT … SELECT` と同じ規則**（位置対応・同型自動変換・列数が合わなければエラー）。違いは 2 点＝**書いていない子項目は `appendDefaultValue`（`src/core/applyPatchPlanner.ts:565`）で埋まる**／**検証は post-image 検証**。`FILE` と書けない項目は対象にできない（今と同じ）。
4. **並びは APPEND の順＝テーブルの行順**（`postImageRows = [...survivorRows, ...appended]`。`src/core/applyPatchPlanner.ts:397`。`REMOVE ALL ROWS` 必須なので survivor は常に空）。`ORDER BY` が無いときはエンジンの既定の順。
5. **件数**は確認の前に確定。`dmlMaxSubtableRows` は既存行 + SELECT の行数（今の数え方のまま。全親・全テーブルの合計）。SELECT の読取は `maxRecords`（既定 10,000）に従う。
6. **0 行**ならテーブルが空になり、親は書かれる。**VALIDATE ONLY** でも SELECT を解決する（読取のみ）。
7. **単一親なので PUT は 1 回**＝部分成功は起きない（`nonTransactional` は従来どおり立つ）。
8. **validate の warning を 1 件新設**＝**`KSQL1307`**（親の `WHERE` が一意でない項目の等値のとき）。KSQL1303 と同じ `Dialect1SchemaResolver` でフォーム定義の `unique` を見る。`DiagnosticCode`（`src/core/diagnostics.ts`）と `src/flow-library/publicTypes.ts:9` の union に 1 件追加（純加法）。
9. **EXPLAIN** は `buildUpdateApplyPlan`（`src/execute.ts:15403`）に `[source SELECT]` の節を足すだけ（`buildInsertSelectPlan`（`:15316`）と同じ形）。**行数の見積もりはしない**（依頼元が要らないと明言）。
10. **公開面に新しいオプションは増やさない。** `/flow` は B198 の `allowApplyMutation` + `confirm`。MCP は fail-closed のまま。

### 2.3 触る場所と難所（実装後の訂正つき）

- `APPEND` の `values` を読んでいるのは **6 か所**＝`applyPatchPlanner.ts:534`（`buildApplyAppendRows`）、`applyPatchScope.ts:284・382`、`applyDiagnostic.ts:181・340`、`applyInsertPrepare.ts:110`。ほかに AST の型・パーサー 1 か所・`execute.ts` の APPLY UPDATE の 2 経路（`executeApplyPatchUpdate`（`:10908`）／`executeMultipleParentApplyPreflight`（`:11053`））・EXPLAIN 1 か所・文書・テスト。
- **確認の件数確定は既存の鎖で足りる**（`execute.ts:9239-9244` が診断の操作の件数から `appendRows` を作るので、計画に行が入れば自動で正しくなる）。KJ-5 で L と見たときの「確認の件数確定」「バッチ解析」は要らなくなった。
- **バッチ解析（`execute.ts:2041-2048`）には触らない。** 参照の収集（`src/core/batch.ts:138-151`）が AST を丸ごと歩くので、**一時テーブルを書いた場合は文法を足しても既定で止まる**（実測＝UPDATE の入れ子に `#d` を置くと `ArgumentError: temp table references in UPDATE are not supported yet.`）。
- **2026-10-28 訂正（実装して分かったこと）**: 起票時に「難所」と書いた carve-out は**要らなかった**。`assertSafeApplyNode`（`src/core/applyPatchScope.ts:530`）が「APPLY の中にサブクエリ・集計・ウィンドウ・非決定的関数を書かせない」を当てているのは**部分木の全体ではなく `operation.values` / `operation.assignments` / 子の選択子だけ**（呼び出しは 283-307・381-382 行）なので、新しい `operation.select` は最初から対象外で、通常の SELECT の検査（`nestedSelects` 経由）に乗る。
  **fail-closed を担っているのは carve-out ではなく capability のフラグ**＝`appendSelect`（既存の全 phase は false。新しい `phase16a` だけ true）と、ブロックの形の検査（`assertAppendSelectBlockShape`）。既存の phase が確かに断ることは `b200AppendSelectScope.test.ts` で固定した。
- 実装で**もう 1 か所**触った: `src/core/optimization/relativeDatePushdownGuard.ts`。UPDATE + APPLY は APPLY の部分木にある相対日付関数をすべて FORBIDDEN にするため、ソースの SELECT の `WHERE 受注日 >= @TODAY()` まで巻き込んで拒否していた。SELECT のソースは `nestedSelects` が通常の SELECT として分類するので、APPLY 全体の走査からは外した（`applyNodesWithoutAppendSelectSources`）。

### 2.4 受入基準（依頼 KJ-6 §5）

1. 親が 1 件に決まる `WHERE` の `UPDATE … APPLY <テーブル> (REMOVE ALL ROWS; APPEND (…) SELECT …)` が `/flow`（`allowApplyMutation` + `confirm`）で書ける。
2. `confirm` が 1 回・`count` が親レコード数（= 1）・`applyDetail.tables[].appendRows` が SELECT の行数・`removeRows` が既存行数。
3. 偽なら書込 0 回・`OperationCancelledError`。
4. SELECT が 0 行ならテーブルが空になる（親は書かれる）。
5. 親が 2 件以上なら最初の書込より前にエラー（`error.code` が固定）。
6. `dmlMaxSubtableRows` 超過は最初の書込より前にエラー（既存行 + SELECT の行数）。
7. `ORDER BY` の並びでテーブルの行が並ぶ（**別名で書く**こと。§2.6）。
8. 既存の `APPEND (…) VALUES (…)` の動きは変わらない。

### 2.5 保留解除の経緯（2026-10-28）

KJ-5 の回答 §5.2 では保留（規模 L・B199 で目的が達成できる）。KJ-6 で依頼元が **(a)** B199 の道はプラグイン側が許可文の固定表を 2 種類ぶんゆるめることになると設計の段で確定した（`exportSinkStatus` が全文の実行まで `incomplete` なので一時テーブルで渡す逃げ道も無い。`src/flow-library/exportSinks.ts:89-99`）、**(b)** 依頼から一時テーブル・複数親・相関参照・操作の組み合わせ・`INSERT`/`UPSERT` 形・EXPLAIN を落とす、と出してきた。(b) をコードで確かめたところ**「いちばん重い」と書いたバッチ解析には当たらず、しかも落としても安全側のまま**だったため、条件 1 の前倒しを認めて解除した。

### 2.6 実装で見つけた既存の制限（依頼元へ申し送り済み）

`ORDER BY SUM(金額) DESC` のように**集計式そのものを ORDER BY のキーに書くと実行時に止まる**
（`ArgumentError: ORDER BY key has no canonical comparison contract (reason=ORDER_KEY_UNRESOLVED)`）。
**これは `APPEND … SELECT` 固有ではなく、素の `INSERT … SELECT` でも同じ**（実測で確認）。
回避策は別名を付けて `SUM(金額) AS 金額 … ORDER BY 金額 DESC` と書くこと。文書に明記し、[B201](ksql_b201_order_by_aggregate_expression_issue.md) として起票した。

## 3. B200-3 — `APPEND … SELECT` のソースに一時テーブル（`FROM #x`）

- 📝 **起票のみ**（2026-10-28）。B200-2 を入れたあとも、一時テーブルをソースにする形は `execute.ts:2041-2048` が止める（`ArgumentError: temp table references in UPDATE are not supported yet.`）。
- 開けるには「どの文型が一時テーブルを読めるか」の表に手を入れることになる（KJ-5 の回答 §5.2 の 4 で「いちばん重い」と書いた部分）。**実需が出てから**。依頼元は「元アプリを 2 回読むのは許容」として要求を落としている。
