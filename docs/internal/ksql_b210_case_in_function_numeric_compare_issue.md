# B210 関数・集計の引数や UPDATE の SET に置いた `CASE` が、数値の項目の大小を辞書順で比べる（黙って誤る）

- 状態: 🚧 **実装済み・レビューとリリース待ち（2026-11-10・枝 `b210/dev`）**
- 種別: 正しさ（**黙って誤る**。エラーにならず値が違う。**UPDATE では誤った値を kintone に書く**）。**結果が変わる**
- 優先: 高（言語リファレンス §8 が勧める `SUM(CASE WHEN 売上 > 0 THEN 1 ELSE 0 END)` がこの形。`> 0` は正の数ならたまたま合うが、`> 5` のような比較で誤る）
- 版: minor（v3.94.0 の想定）。**規模 M**
- 見つけ方: kSQL アクションの次の事例（在庫・発注ロット）を試していて、`CAST(CASE … AS NUMBER)` を 2 列並べた再帰の結果が手計算と合わず、切り分けた（`work-link/ksql-case-in-function-probe.cjs`。エンジンのライブラリ 3.93.0 ＋ 型を持つ代役のアプリ）
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
| HAVING の集計 | `HAVING SUM(CASE WHEN 残数 > 5 …) >= 3` | A・B | **どちらも出ない** |
| GROUP BY の式 | `GROUP BY CONCAT('k', CASE WHEN 残数 > 5 …)` | 大 6・小 6 | **大 4・小 8** |
| ORDER BY の式 | `ORDER BY COALESCE(CASE WHEN 残数 > 5 THEN 0 ELSE 1 END, 9), 残数` | 6〜11 が先 | **6〜9 が先、10・11 は最後** |
| WHERE の関数（JS 側で評価） | `WHERE COALESCE(CASE WHEN 残数 > 5 …, 0) = 1` | 6 | **4** |
| ウィンドウの引数 | `LAG(CASE …)`・`SUM(CASE …) OVER (…)` | 5・6 | **4・4** |
| **UPDATE の SET** | `SET 文字 = CASE WHEN 残数 > 5 THEN '大' ELSE '小' END`（残数 10 の行） | 大 | **小（誤った値を書く）** |
| 同（関数の中・`UPDATE … FROM`） | `CONCAT('', CASE …)`・`UPDATE … FROM #s` | 大 | **小** |

正しかったもの: **SELECT の列そのものが CASE**（`CASE WHEN 残数 > 5 … END AS y`）、関数の中でも**等値**（`SUM(CASE WHEN 区分 = 'A' …)`）、集計の結果を比べる CASE（`CONCAT('', CASE WHEN COUNT(*) > 100 …)`）。

## 2. 原因

CASE の条件が数値で比べるか文字列で比べるかは、**項目の型の情報**（`FieldSemanticsResolver`）で決まる（値は見ない＝B171）。
**SELECT の列そのものが CASE のときだけ**その情報を渡していて、**ほかの評価の呼び出しは型を渡していなかった**（`undefined`）。渡されないと文字列で比べる。

- 集計の引数（`process.ts` の集計値の取り出し）、GROUP BY / ORDER BY の式のキー、ウィンドウの値の引数
- WHERE の関数（`evalWhere.ts` の `FUNC_FIELD`・`ARITH_VALUE` の関数）
- 集計のない SELECT（SIMPLE の道）は、型の情報を**列が `CASE_COL` のときだけ**作っていた
- UPDATE の SET（`evalCaseWhenValue`）は、関数の外の CASE でも型を渡していなかった

**B171・B208・B209 と同じ種類の残り**（型が分からない道で文字列に落ちる）。

## 3. 直したこと

**呼び出しを 1 つずつ直さず、文を実行する前に、その文の中のすべての CASE へ型の情報を結び付ける**（`bindCaseFieldResolvers`）。
CASE を評価するとき、呼び出しが型を渡さなければ、結び付けたものを使う（`caseFieldResolvers`）。十数か所の呼び出しを直しても、次に足す呼び出しでまた漏れるため。

- **呼び出しが型を渡したとき（どちらか一方でも）はそちらを優先**（今までどおり。集計の後の CASE の列は集計の結果の型で比べる）
- 入れ子の SELECT（サブクエリ）の中へは降りない（その SELECT が自分の型で結ぶ）
- **値は見ない**（B171 の「実値推測禁止」はそのまま）。型が分からない項目は今までどおり文字列
- 結び付ける場所: SELECT の 3 つの道（SIMPLE・全件・CTE つき）で型の情報を作った直後、UPDATE（ふつう・`FROM` つき・検証の候補 2 つ）と APPLY の親の SET
- 付随: SIMPLE の道は、関数の中・ORDER BY の式の中に CASE があれば型の情報を作る。フォーム定義を取る判定（`selectCaseConditionsNeedFieldMetadata`）とステータスの順を引く判定に、GROUP BY / ORDER BY の式・列の関数の中を足した。WHERE の関数には、`evalWhere` が持っている型をそのまま渡す

**対象外（残り）**: サブテーブルの UPDATE の SET の CASE（項目の型の引き方が親と違う）。INSERT の VALUES の CASE は項目を参照しないので関係ない。

## 4. 試験（`src/flow-library/__tests__/b210CaseInFunctionNumericCompare.test.ts` 28 件）

上の表の置き場所をすべて固定した。**直す前のエンジンでは 28 件中 22 件が落ちる**（残る 6 件は「変えないこと」と、もともと正しかった集計の結果の比較）。
選択肢の項目（選択肢の順が辞書順と逆）も、関数の中の CASE が外に置いた CASE と同じ答えになることを固定した（直す前は関数の中だけ辞書順で 0 件）。
変えないこと: 文字列の項目は辞書順のまま（`文字 > '5'` は 4 件）、外に置いた CASE、関数の中の等値。

**既存の試験 1 件が、不具合の値を正解として固定していた**: `b148BareColumnGroupBy.test.ts` の「aggregate 内部は外側 dependency walk を停止する」
（`SUM(CASE WHEN 個数>10 THEN 個数 ELSE 0 END)`、v3.57.0 から）。米の個数は 5 なので正しい答えは 0 だが、期待値が "5"（辞書順で "5" > "10" が真）だった。
試験の目的は集計の境界で、比べ方ではなかったため、出た値をそのまま期待値にしたとみられる。0 に直し、理由を書き添えた。

全体の試験（Mac）: 落ちるのは main と同じ環境の差だけ（CLI の e2e 7 スイートと MCP の tools で 45 件、`--runInBand` の 2 スイートで 3 件。接続の設定ファイルが無いため）。
`npx tsc --noEmit` は既知の `src/ui/desktop.ts` だけ。`build:flow`・`flow:bundle-guard` は OK。`docs:check` は main と同じ 97 件（兄弟リポジトリへのリンク）。

## 5. 影響（結果が変わる）

- 上の表の置き場所で、**数値の項目の大小比較が数値になる**（今まで辞書順）。桁の違う値で答えが変わる。
- **UPDATE の SET の CASE が書く値が変わる**（今まで誤った値を書いていた）。
- 文字列の項目・等値・リテラルどうしの比較は不変。
- 選択肢の項目の大小は、外に置いた CASE と同じ規則（選択肢の順）になる。

## 6. 依頼元への影響（kSQL アクション）

- 公開中の記事の SQL で、関数の中の CASE は標準単価の事例だけで、比較はどれも `=` か `= ''`（2026-11-10 に原稿を grep）→ **当たらない**。
- kSQL Dashboard Pro のエンジン（3.85.0）も同じ作りのはず（確かめていない）。
- 実機（kintone）では確かめていない。代役のアプリの項目の形はエンジンが読む `fieldType` と同じ。
