# B210 関数・集計の引数や UPDATE の SET に置いた `CASE` が、数値の項目の大小を辞書順で比べる（黙って誤る）

- 状態: ✅ **v3.94.0 で公開済み（2026-11-10）**＝npm latest 3.94.0・GitHub Release。公開した tarball の dist-flow で再現スクリプト（`work-link/ksql-case-in-function-probe.cjs` ほか）が全部正しい値になることを確かめた
- 種別: 正しさ（**黙って誤る**。エラーにならず値が違う。**UPDATE / DELETE では誤った行・誤った値を書く**）。**結果が変わる**
- 優先: 高（言語リファレンス §8 が勧める `SUM(CASE WHEN 売上 > 0 THEN 1 ELSE 0 END)` がこの形。`> 0` は正の数ならたまたま合うが、`> 5` のような比較で誤る）
- 版: minor（v3.94.0）。**規模 M**
- 見つけ方: kSQL アクションの次の事例（在庫・発注ロット）を試していて、`CAST(CASE … AS NUMBER)` を 2 列並べた再帰の結果が手計算と合わず、切り分ける途中で見つけた（`work-link/ksql-case-in-function-probe.cjs`。エンジンのライブラリ 3.93.0 ＋ 型を持つ代役のアプリ）。**その再帰の誤りの本体は別の不具合だった**（別名の無い関数の列の既定名が重なる＝[B211](ksql_b211_function_column_default_key_collision_issue.md)。公開した v3.94.0 で確かめ直して分かった）
- 関連: [B171](https://github.com/rex0220/kintone-sql-tools/releases/tag/v3.72.0)（型 provenance 方式・実値推測禁止）、[B208](ksql_b208_assert_scalar_field_numeric_issue.md) / [B209](ksql_b209_variable_numeric_provenance_issue.md)（同じ種類の残りを `ASSERT` で直した）、[B141](ksql_b141_doc_sql_unverified_issue.md)（文書の例）

## 1. 現象（v3.93.0 の実測）

`残数` は NUMBER で 0〜11 の 12 件。`残数 > 5` は数値なら 6 件（6〜11）、辞書順なら 4 件（"6"〜"9"）。

| 置き場所 | 式 | 正しい答え | v3.93.0 |
|---|---|---|---|
| SELECT の列（関数の中） | `COALESCE(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 9)` の合計 | 6 | **4** |
| 同 | `CAST(CASE WHEN 残数 > 5 … AS NUMBER)`・`ROUND(CASE …)`・`CONCAT('x', CASE …)` | 6 | **4** |
| 集計の引数 | `SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END)` | 6 | **4** |
| 同 | `SUM(CASE WHEN 残数 < 5 …)` | 5 | **7** |
| 同 | `COUNT(CASE WHEN 残数 > 5 THEN 1 END)`・`MAX(CASE …)` | 6・11 | **4・9** |
| 同（一時テーブルに写した NUMBER） | `SUM(CASE WHEN 残数 > 5 …) FROM #t` | 6 | **4** |
| 同（GROUP BY ごと） | `区分, SUM(CASE WHEN 残数 > 5 …) … GROUP BY 区分` | A 3・B 3 | **A 2・B 2** |
| 同（`$id`） | `SUM(CASE WHEN $id > 9 …)` | 3 | **0** |
| 集計を含む CASE の条件 | `CASE WHEN 残数 > 9 THEN COUNT(*) ELSE 0 END … GROUP BY 残数` | 10・11 が 1 | **すべて 0** |
| HAVING の集計 | `HAVING SUM(CASE WHEN 残数 > 5 …) >= 3` | A・B | **どちらも出ない** |
| GROUP BY の式 | `GROUP BY CONCAT('k', CASE WHEN 残数 > 5 …)` | 大 6・小 6 | **大 4・小 8** |
| ORDER BY の式 | `ORDER BY COALESCE(CASE WHEN 残数 > 5 THEN 0 ELSE 1 END, 9), 残数` | 6〜11 が先 | **6〜9 が先、10・11 は最後** |
| WHERE の関数（JS 側で評価） | `WHERE COALESCE(CASE WHEN 残数 > 5 …, 0) = 1` | 6 | **4** |
| ウィンドウの引数 | `LAG(CASE …)`・`SUM(CASE …) OVER (…)` | 5・6 | **4・4** |
| **UPDATE の SET** | `SET 文字 = CASE WHEN 残数 > 5 THEN '大' ELSE '小' END`（残数 10 の行） | 大 | **小（誤った値を書く）** |
| 同（関数の中・`UPDATE … FROM`） | `CONCAT('', CASE …)`・`UPDATE … FROM #s` | 大 | **小** |
| **サブテーブルの UPDATE / DELETE**（`_rid = '12'`、明細の値 10） | `WHERE _rid = '12' AND 数値_0 > 7`・`SET 数値_0 = CASE WHEN 数値_0 > 7 …` | 当たる・1 | **当たらない・0** |

正しかったもの: **SELECT の列そのものが CASE**（`CASE WHEN 残数 > 5 … END AS y`）、関数の中でも**等値**（`SUM(CASE WHEN 区分 = 'A' …)`）、集計の結果を比べる CASE（`CONCAT('', CASE WHEN COUNT(*) > 100 …)`）。
サブテーブルは **`_rid IN (…)` を書いたときだけ**たまたま正しかった（IN の候補があるときだけ型を引いていたため）。

## 2. 原因

CASE の条件が数値で比べるか文字列で比べるかは、**項目の型の情報**（`FieldSemanticsResolver` / `FieldTypeResolver`）で決まる（値は見ない＝B171）。
**SELECT の列そのものが CASE のときだけ**その情報を渡していて、**ほかの評価の呼び出しは型を渡していなかった**（`undefined`）。渡されないと文字列で比べる。

- 集計の引数（`process.ts` の集計値の取り出し）、GROUP BY / ORDER BY の式のキー、ウィンドウの値の引数
- 集計を含む CASE の列は、集計の結果の型だけを渡していた（GROUP BY の項目の型が落ちる）
- WHERE の関数（`evalWhere.ts` の `FUNC_FIELD`・`ARITH_VALUE` の関数）
- 集計のない SELECT（SIMPLE の道）は、型の情報を**列が `CASE_COL` のときだけ**作っていた
- UPDATE の SET（`evalCaseWhenValue`）は、関数の外の CASE でも型を渡していなかった
- サブテーブルの DML は、型を **`IN` の候補があるときだけ**引いていた（`buildSubtableFieldTypeResolver`）

**B171・B208・B209 と同じ種類の残り**（型が分からない道で文字列に落ちる）。

## 3. 直したこと

**呼び出しを 1 つずつ直さず、その文の行の型の情報を「評価の文脈」（`EvaluationContext.caseFieldResolvers`）に載せる**。
CASE を評価するとき（`evalCaseWhen` / `evalCaseWhenNullable` / `evalCaseWhenValue`）、**呼び出しが渡した型を先に使い、それで分からない項目だけ文脈の型で補う**（`caseFieldResolvers`）。
評価の文脈はほぼすべての評価の呼び出しに渡っているので、十数か所の呼び出しを直さずに済み、次に足す呼び出しでも漏れない。

- **文脈は実行ごとに作る**（AST には付けない）ので、同じ文を別の実行で同時に動かしても型が混ざらない
- 入れ子の SELECT（サブクエリ・CTE・UNION の枝）は、それぞれの実行の道で自分の文脈を作る
- **集計を含む CASE**: 集計の結果は集計の型、GROUP BY の項目は行の型で比べる（呼び出しが渡す集計の型で分からない項目を、文脈の行の型で補う）
- **値は見ない**（B171 の「実値推測禁止」はそのまま）。型が分からない項目は今までどおり文字列
- 文脈を作る場所: SELECT の 3 つの道（SIMPLE・全件・CTE つき）で型の情報を作った直後、UPDATE（ふつう・`FROM` つき・検証の候補 2 つ）と APPLY の親の SET。UPDATE は SET に CASE が無ければフォーム定義を取らない
- **サブテーブルの DML**: 型を `IN` の候補の有無にかかわらず引く（フォーム定義はキャッシュされる）。WHERE の大小と SET の CASE が項目の型で比べる。REORDER の WHERE も同じ関数を通る
- 付随: SIMPLE の道は、関数の中・ORDER BY の式の中に CASE があれば型の情報を作る。フォーム定義を取る判定（`selectCaseConditionsNeedFieldMetadata`）とステータスの順を引く判定に、GROUP BY / ORDER BY の式・列の関数の中・隠れたウィンドウを足した。WHERE の関数には、`evalWhere` が持っている型をそのまま渡す。GROUP BY は B65 の唯一の口（`normalizeGroupingSpec`）を通して読む

**当たらない形**: `UPDATE … FROM` の SET の CASE は、元（FROM）の列を参照できない（構文の検査で「ソース列は SET の直接値としてのみ参照できます」で止まる）ので、対象アプリの型だけでよい（試験で固定）。INSERT / UPSERT の VALUES の CASE は項目を参照しない。

## 4. 試験（39 件）

- `src/flow-library/__tests__/b210CaseInFunctionNumericCompare.test.ts`（33 件）: 上の表の置き場所、選択肢の項目（選択肢の順が辞書順と逆）、集計を含む CASE の条件、`$id`、**同じ文を型の違う 2 つの実行で同時に動かす**形、`UPDATE … FROM` の CASE が元の列で止まること
- `src/__tests__/b210SubtableCase.test.ts`（6 件）: サブテーブルの UPDATE の WHERE・SET の CASE、DELETE の WHERE。`_rid IN (…)` の形と `_rid = '…'` の形

**直す前のエンジン（main）では 39 件中 30 件が落ちる**（残る 9 件は「変えないこと」と、もともと正しかった形）。
1 回目の実装（文の中の CASE に WeakMap で結び付ける形。コミット `dbabcede`）では 5 件が落ちる（集計を含む CASE の条件 2 件と、サブテーブルの `_rid =` の形 3 件）。
変えないこと: 文字列の項目は辞書順のまま（`文字 > '5'` は 4 件）、外に置いた CASE、関数の中の等値。

**既存の試験 1 件が、不具合の値を正解として固定していた**: `b148BareColumnGroupBy.test.ts` の「aggregate 内部は外側 dependency walk を停止する」
（`SUM(CASE WHEN 個数>10 THEN 個数 ELSE 0 END)`、v3.57.0 から）。米の個数は 5 なので正しい答えは 0 だが、期待値が "5"（辞書順で "5" > "10" が真）だった。
試験の目的は集計の境界で、比べ方ではなかったため、出た値をそのまま期待値にしたとみられる。0 に直し、理由を書き添えた。

全体の試験（Mac）: 落ちるのは main と同じ環境の差だけ（CLI の e2e 7 スイートと MCP の tools で 45 件、`--runInBand` の 2 スイートで 3 件。接続の設定ファイルが無いため）。
`npx tsc --noEmit` は既知の `src/ui/desktop.ts` だけ。`build:flow`・`flow:bundle-guard` は OK。`docs:check` は main と同じ 97 件（兄弟リポジトリへのリンク）。

## 5. 影響（結果が変わる）

**上の表の置き場所の CASE の条件が、外に置いた CASE と同じ規則で比べるようになる**（今までは型が無く、全部を文字列で比べていた）。具体的には:

- 数値の項目（NUMBER・数値の計算の項目・`$id`）の**大小**が数値になる。**等値・`IN`** も数値の規則になる（数値として等しい表記は等しい）
- 選択肢の項目の大小は選択肢の順、ステータスの大小はプロセスの順になる
- 比べられない型の項目（外に置いた CASE でエラーになる型）は、これらの置き場所でも同じエラーになる（今までは文字列として比べて通っていた）
- **UPDATE の SET の CASE が書く値、サブテーブルの UPDATE / DELETE の WHERE が当たる行が変わる**（今まで誤っていた）
- 変わらないもの: 文字列の項目、日付・日時・時刻（もともと文字列の規則）、`LIKE`、リテラルどうしの比較

試験で固定したのは、数値の大小・`$id`・選択肢の順・文字列の項目・等値（選択肢）まで。数値の等値と `IN`、ステータスの順、比べられない型のエラー、REORDER の WHERE は、コードを読んだうえでの見立て（Codex の指摘と同じ）で、試験はしていない。

## 6. 依頼元への影響（kSQL アクション）

- 公開中の記事の SQL で、関数の中の CASE は標準単価の事例だけで、比較はどれも `=` か `= ''`（2026-11-10 に原稿を grep）→ **当たらない**。
- kSQL Dashboard Pro のエンジン（3.85.0）も同じ作りのはず（確かめていない）。
- 実機（kintone）では確かめていない。代役のアプリの項目の形はエンジンが読む `fieldType` と同じ。

## 7. Codex レビュー（2026-11-10。BLOCKER 0 / MAJOR 4 / MINOR 3）

依頼文と結果は work-link の `codex-review-b210-prompt.md`・`codex-review-b210-2026-11-10.md`。

| # | 指摘 | 処置 |
|---|---|---|
| MAJOR 1 | `UPDATE … FROM` の SET の CASE が元（FROM）の列を、対象アプリの型で比べる | **当たらない**。元の列は CASE の中で参照できず構文の検査で止まる（v3.93.0 も同じ）。試験で固定 |
| MAJOR 2 | 集計を含む CASE は写されるので結び付けが外れ、呼び出しが渡す集計の型だけになり、GROUP BY の項目の型を失う | 直した。型の情報を評価の文脈に移し、呼び出しが渡した型で分からない項目を文脈の行の型で補う。試験 2 件 |
| MAJOR 3 | サブテーブルの UPDATE を対象外にしている | 直した。調べると WHERE の大小も同じ穴（`_rid IN` のときだけ正しい）で、DELETE も同じ。型をいつも引く。試験 6 件 |
| MAJOR 4 | 同じ AST を 2 つの実行で同時に動かすと、WeakMap の結び付けが上書きし合う | 直した。結び付けをやめ、実行ごとの評価の文脈に持たせた。試験 1 件 |
| MINOR 1 | 隠れたウィンドウの中のステータスの順を引かない | 直した（`collectOrderedFields` に隠れたウィンドウを足した）。試験は無し |
| MINOR 2 | 変わるのは「数値・選択肢の大小」だけではない（等値・`IN`・`$id`・ステータス・比べられない型のエラー） | §5 を書き直した（外に置いた CASE と同じ規則にそろう、と書いた）。`$id` の試験を足した |
| MINOR 3 | CASE の無い文でも AST 全体をたどる | 直した（結び付けをやめたので、たどらない） |
