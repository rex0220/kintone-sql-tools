# B119 集計関数の引数に文字列関数を書くと、エラーなく 0 / 空が返る

- 起票: 2026-08-04
- ステータス: 🚧 **実装済み・リリース待ち**（2026-08-05）。案 A（`STRING_FUNC` をスカラー経路へ）で実装。
  **受入 7 点すべてを実機で確認**（[レビュー 1 回目](ksql_b119_b120_review_1.md) §1・[2 回目](ksql_b119_b120_review_2.md) §1 で計 3 回再走行）。
  `npm test` 5297 通過（失敗 2 件は既知の [B115](ksql_b115_env_dependent_test_issue.md)）。差し戻しは 0 回。
- 出典: `ksql-analytics`（Claude Code + MCP による分析プロジェクト）で表記ゆれ検出クエリを書いていて発見。
  `COUNT(DISTINCT TRIM(UPPER(会社名)))` が **0** を返し、`COUNT(DISTINCT 会社名)` は 10 を返した
- 関連: [B117](ksql_b117_date_add_month_end_issue.md)（`DATE_ADD` 月末）/ [B118](ksql_b118_function_call_diagnostics_issue.md)（関数呼び出しの診断）＝**いずれも「静かに間違う」形。本件は 3 例目**
- 影響コード: `src/engine/process.ts:495`（`evalAggregate` の引数評価分岐）

## 1. 症状（実測 2026-08-04・v3.43.0・dev / APP4149・20 件）

**集計関数の引数に「文字列を返す関数呼び出し」を書くと、全行がスキップされ 0 / 空が返る。
エラーも警告も出ない。**

| 式 | 期待 | 実測 | |
|---|---:|---:|---|
| `COUNT(DISTINCT 会社名)` | 10 | **10** | ○ |
| `COUNT(DISTINCT UPPER(会社名))` | 10 | **0** | ✗ |
| `COUNT(DISTINCT TRIM(会社名))` | 10 | **0** | ✗ |
| `COUNT(UPPER(会社名))` | 20 | **0** | ✗ |
| `COUNT(会社名)` | 20 | **20** | ○ |
| `MAX(会社名)` | 篠村食品株式会社 | **篠村食品株式会社** | ○ |
| `MAX(UPPER(会社名))` | 篠村食品株式会社 | **0** | ✗ |
| `GROUP_CONCAT(DISTINCT 商談フェーズ)` | 提案中,内示,受注 | **提案中,内示,受注** | ○ |
| `GROUP_CONCAT(DISTINCT UPPER(商談フェーズ))` | 提案中,内示,受注 | **0** | ✗ |
| `COUNT(DISTINCT COALESCE(商談フェーズ, '未選択'))` | 4 | **0** | ✗ |

正常に動くもの（比較のため）:

| 式 | 実測 | |
|---|---:|---|
| `SUM(ROUND(売上))` | 81800000（`SUM(売上)` と一致） | ○ |
| `SUM(LENGTH(会社名))` | 241 | ○ |
| `COUNT(DISTINCT 売上 * 1)` | 18（`COUNT(DISTINCT 売上)` と一致） | ○ |
| `COUNT(DISTINCT CASE WHEN 売上 > 0 THEN 会社名 ELSE '' END)` | 9 | ○ |

**境界は「引数が数値を返すか」**。`LENGTH` / `ROUND` は数値を返すので通り、
`UPPER` / `TRIM` / `COALESCE` は文字列を返すので全行スキップされる。
`CASE` 式・`||` 連結・算術式は別経路のため正常。

### 再現

```
ksql --profile dev -e "SELECT COUNT(DISTINCT 会社名) AS 素, COUNT(DISTINCT UPPER(会社名)) AS 関数 FROM APP4149"
→ 素=10 / 関数=0
```

## 2. なぜ重いか

- **エラーが出ない。** 利用者は 0 を「該当なし」と読む。分析レポートに誤った数字が載る
- **ユニーク数・最頻値・一覧の連結という、確認に使われる集計で起きる**。
  「表記ゆれは無い（0 件）」「該当は 0 件」という**安全側に見える誤り**を返すため疑われにくい
- `ksql_validate` は通る。構文としては妥当なため、実行するまで分からない
- 文書上、`COUNT(DISTINCT 関数(列))` を禁じていない。むしろ §8 は
  「引数を取る全 12 集計関数に、従来のフィールド・算術式・**関数呼び出し**に加えて…指定できます」
  と**使えると読める**。数値評価される旨は `MODE(COALESCE(...))` の 1 行にしかない
  （「`MODE(COALESCE(フィールド, '未選択'))` は算術式扱いで数値評価されるため…」）。
  **`MODE` 固有の注意に見えるが、実際は全集計に効いている**

## 3. 原因

`src/engine/process.ts` の `evalAggregate`。引数の型で評価経路が分かれており、
`STRING_FUNC` が**算術式と同じ経路**に入っている。

```ts
} else if (arg.type === "ARITH" || arg.type === "NUMBER" || arg.type === "STRING_FUNC") {
  // 算術式 / 関数: 数値として評価し NaN はスキップ
  const n = evalArithExpr(arg, row);
  if (isNaN(n)) continue;          // ← UPPER(会社名) は毎行ここで捨てられる
  strVal = String(n);
}
```

`UPPER(会社名)` は `evalArithExpr` で `Number("株式会社サイボウズ商事") = NaN` となり、
**全行が `continue` で捨てられる**。結果、収集値が 0 件になり

- `COUNT` → `eff.length` = **0**
- `GROUP_CONCAT` → 空
- `MIN` / `MAX` → `comparableValues.length === 0` で **`0` を返す**（`process.ts:561`）

一方 `CASE_WHEN` / `CONCAT_OP` / `STRING` は下の `else` で
`evalScalarValueExprNullable` を通るため**文字列のまま保たれる**。この非対称が本件。

## 4. 対応案

**案 A（推奨）**: `STRING_FUNC` を `CASE_WHEN` などと同じスカラー経路へ移し、文字列のまま収集する。
数値化が要る集計（`SUM` / `AVG` / 統計 6 関数）は**収集後に既存の `Number` 変換**
（`process.ts:570` の `.map(Number)`、統計は `numericValues`）が効くため、
`SUM(LENGTH(会社名))` のような現行の正常系は維持される。

- 確認が要る点: `MIN` / `MAX` / `MODE` の比較意味論（`resolveAggregateArgSemantics`）が
  `STRING_FUNC` に対して何を返すか。文字列関数なら `string` 比較が妥当
- `DISTINCT` は既存 6 集計が文字列単位、統計 6 関数が数値同値単位という規約を変えない

**案 B**: 現状の数値評価を仕様として維持し、**文字列を返す関数を引数に書いたら明示エラー**にする。
静かな誤りは消えるが、`COUNT(DISTINCT UPPER(x))` という自然な書き方が使えないままになる。

**案 C**: 文書に注記だけ追加する。**推奨しない**（B117・B118 と同じ「静かに間違う」を残す）。

## 5. 受入条件（案 A の場合）

1. `COUNT(DISTINCT UPPER(会社名))` が `COUNT(DISTINCT 会社名)` と同数（表記ゆれが無い場合）
2. `COUNT(UPPER(会社名))` = `COUNT(会社名)`
3. `MAX(UPPER(会社名))` が文字列を返す（`0` ではない）
4. `GROUP_CONCAT(DISTINCT UPPER(x))` が連結文字列を返す
5. `COUNT(DISTINCT COALESCE(商談フェーズ, '未選択'))` が空セルを含めた種類数を返す
6. **回帰**: `SUM(ROUND(売上))` / `SUM(LENGTH(会社名))` / `COUNT(DISTINCT 売上 * 1)` /
   `COUNT(DISTINCT CASE WHEN ... END)` が現行値のまま
7. 統計 6 関数の「非数値は `ArgumentError`」が維持される（`STDDEV_SAMP(UPPER(x))` はエラー）
8. `MODE` の §8 注記（`MODE(COALESCE(...))` は数値評価）を、案 A 後の実挙動に合わせて改訂

## 6. 文書側の宿題

- §8「集計関数の引数に式を指定（v3.16.0）」に、関数呼び出し引数の**評価規則を明記**する
  （現状は `MODE` の 1 行にしか書かれていない）
- 修正後は「関数呼び出しは値の型のまま集計される」と書ければ、注意書き自体が不要になる
