# B119 / B120 レビュー 1 回目（2026-08-05）

実装: codex（[依頼書](ksql_b119_b120_codex_request.md)）/ レビュー: Claude

## 結論

- **B119 = 合格。** 受入 7 点すべて実機で確認した
- **B120 = 差し戻し。** 実装は動いているが、**新たに「静かに間違う」欠陥を 2 件持ち込んでいる**。
  どちらもエラーが出ず、`npm test`（5271 通過）でも捕まらない

検証環境: v3.43.0 + 作業ツリー / `npm run build:cli` / dev / APP4149（20 件・`SUM(売上)` = 81,800,000）

---

## 1. 合格したもの

### B119（7/7）

| 確認 | 結果 |
|---|---|
| `COUNT(DISTINCT UPPER(会社名))` = `COUNT(DISTINCT 会社名)` | 10 = 10 ○ |
| `COUNT(UPPER(会社名))` = `COUNT(会社名)` | 20 = 20 ○ |
| `MAX(UPPER(会社名))` が文字列 | 篠村食品株式会社 ○ |
| `GROUP_CONCAT(DISTINCT UPPER(x))` | 提案中,内示,受注 ○ |
| `COUNT(DISTINCT COALESCE(商談フェーズ, '未選択'))` | 4 ○ |
| 回帰 `SUM(ROUND(売上))` / `SUM(LENGTH(会社名))` / `COUNT(DISTINCT 売上*1)` / `COUNT(DISTINCT CASE...)` | 81800000 / 241 / 18 / 9（すべて変更前と一致）○ |
| 回帰 `STDDEV_SAMP(UPPER(x))` が `ArgumentError` のまま | ○ |

`STRING_FUNC` を算術経路から外してスカラー経路へ落とす修正は、意図どおり。

### B120 の「壊してはいけないもの」（7 形 + 文面 2 本）

すべて変更前と同じ値・同じ文面で動作した。`UPPER(MIN(x))` / `LENGTH(MAX(x))` /
`ROUND(SUM(x), -3)` / `ROUND(AVG(x), 1)` / `GREATEST(SUM(x), 1)` / `COALESCE(MAX(x), 'x')` /
`SUM(CASE ... END)` / `CASE WHEN GROUPING(会社名) = 1 ...`（ROLLUP・合計行 81800000 も一致）。
エラー 2 文面も一字一句同じ。**ここは維持されている。**

### 既存の失敗 2 件

`src/cli/__tests__/logicalExecution.test.ts` の 2 件は **HEAD（変更なし）でも同じく失敗**することを
`git stash` で確認した。既知の [B115](ksql_b115_env_dependent_test_issue.md)（環境依存テスト）で、
今回の変更とは無関係。

---

## 2. 差し戻し① CASE の条件内で集計が**文字列比較**される

**数値の大小比較が壊れている。** エラーは出ない。

`SUM(売上)` = 81,800,000 / `COUNT(*)` = 20 に対して:

| SQL | 期待 | 実測 | 文字列比較なら |
|---|---|---|---|
| `CASE WHEN SUM(売上) > 100000000 THEN '大' ELSE '小' END` | 小 | **大** | `"81800000" > "100000000"` → `'8'>'1'` → true → 大 |
| `CASE WHEN SUM(売上) > 9 THEN '大' ELSE '小' END` | 大 | **小** | `"81800000" > "9"` → `'8'<'9'` → false → 小 |
| `CASE WHEN COUNT(*) > 3 THEN '多' ELSE '少' END` | 多 | **少** | `"20" > "3"` → `'2'<'3'` → false → 少 |

**GROUP BY 有りでも同じ**（`SUM(売上)` = 15,550,000 の会社で `> 9000000` が `小`）:

```
会社名                              売上       判定
株式会社キントーンシステムズ        15550000   小     ← 大 のはず
```

3 例すべてがコードポイント順の比較と一致する。**等値比較（`= 0`）は偶然正しく見える**ため、
依頼書の受入条件④（ゼロ除算ガード）は通ってしまった。**受入条件の穴でもある。**

### 原因の当たり

`materializeAggregateDependencies` が集計値を**文字列として**行に書き込み、
その後 `evalCaseWhen` が行の値を文字列として比較していると見られる。

```ts
outRow[key] = String(evalAggregate(ref.func, ref.distinct, ref.arg, ref.separator, rows, resolveAggSortKind));
```

`ARITH_AGG_COL` など既存の集計算術経路が数値比較をどう保っているかを確認し、
**CASE 条件の比較にも同じ型情報を渡すこと。** 集計の型（`COUNT`/`SUM`/`AVG` は数値、
`GROUP_CONCAT`/`MODE` は文字列、`MIN`/`MAX` は引数の型に従う）で比較意味論を決める必要がある。

---

## 3. 差し戻し② 別名の無い CASE 列のキーが固定文字列 `"case"` で衝突する

```sql
SELECT CASE WHEN COUNT(*) > 0 THEN 'あり' ELSE 'なし' END,
       CASE WHEN SUM(売上) > 100000000 THEN '大' ELSE '小' END
FROM APP4149
```
```
case	case
大	大        ← 列名が重複し、1 つ目の CASE の結果が失われている
```

GROUP BY 有りでも同じ（2 列とも `case` で、2 つ目の値が両方に入る）。

該当箇所は 3 つとも `col.alias ?? "case"` / `row["case"]` というフォールバック:

- `materializeAggregateColumns` の `outRow[col.alias ?? "case"]`
- `evaluateSelectColumnValue` の `row[column.alias ?? "case"]`
- `buildOrderByAliasEvaluator` の `row[alias] ?? row["case"]`

**別名を付ければ正しく動く**（`AS x` / `AS y` で確認済み）ため、既定キーの一意化だけの問題。
他の列種別が既定キーをどう作っているか（`scalarValueDefaultKey` など）に合わせること。
**列名そのものが `case` になる点も、変更前の出力と揃っているか確認が要る。**

---

## 4. テスト不足（次で埋めること）

`npm test` は 5271 通過・214 スイート中 213 成功だが、上の 2 件をどちらも捕まえられなかった。
追加すべき観点:

1. **CASE 条件内の集計の数値比較** — `>` `<` `>=` `<=` を、桁数の異なる境界で。
   桁が揃った値だけだと文字列比較でも通ってしまうので、**`20 > 3` のように
   文字列比較なら落ちる組み合わせ**を必ず入れる
2. `CASE` の THEN / ELSE に集計を置いた場合の型（`THEN SUM(x) ELSE 0`）
3. **別名の無い CASE 列が 2 つ以上**あるケース（列名と値の対応）
4. 別名あり / 無しの混在
5. `ORDER BY` で CASE 別名を参照する場合（集計入り / 無し両方）
6. GROUP BY 有り・無しの両方で 1〜5 を通す

---

## 5. リリース時の申し送り（欠陥ではない）

`src/types/ast.ts` の `CaseResult` に `AggregateRef | AggArithExpr` を足している。
必須プロパティの追加は避けられている（`FieldRef.aggregateRef?` は任意）が、
**union の拡張は、この型を網羅的に `switch` している下流を壊し得る**（engine ライブラリは
ksql-dashboard-pro が利用）。**B117 / B118 と同じく移行案内が要る版**として扱うこと。

---

## 6. 次のアクション

1. codex に②→①の順で修正を依頼（②は局所、①は型情報の引き回しが要る）
2. §4 のテストを追加し、**現行コードで落ちること**を確認してから直す
3. 再レビューでは §1 の合格分（B119 7 点・B120 の 7 形 + 文面 2 本）を**再度**通す
