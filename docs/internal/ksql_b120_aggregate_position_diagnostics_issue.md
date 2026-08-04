# B120 `CASE` 式の中の集計関数が集計として扱われない（行が集約されない／誤診される）

- 起票: 2026-08-04（**2026-08-04 に切り分けを訂正**。当初「スカラー式に集計を書けない」と書いたが誤りで、実際は `CASE` 固有だった）
- ステータス: ✅ **完了（v3.44.0 でリリース）**（2026-08-05・npm publish 済み・**MCP 実機で確認**＝`CASE WHEN COUNT(*) = 0 ...` が 1 行）。案 A（`CASE` の条件・THEN・ELSE を集計検出の走査対象に追加）で実装。**レビューで 3 件差し戻し**〔①CASE 条件内の集計が文字列比較 ②無名 CASE 列のキーが固定 `case` で衝突 ③`MIN`/`MAX` が GROUP BY 無しで文字列比較〕、いずれも解消。**②の残り（`HAVING` の無言 0 行の診断）は未実装**＝[B122](ksql_b122_having_aggregate_expression_issue.md) で `HAVING` の集計式は評価されるようになったため、残るのは「SELECT に無い集計を書いた場合の診断」のみ。実需が出たら再起票する。
- 出典: [B119](ksql_b119_aggregate_string_function_arg_issue.md) の調査中に併発して観測（`ksql-analytics` で受注率のゼロ除算ガードを書こうとして発見）
- 関連: [B118](ksql_b118_function_call_diagnostics_issue.md)（診断が弱く利用者が別の結論に誘導される形）/ [B119](ksql_b119_aggregate_string_function_arg_issue.md)（同日発見・同じ集計引数まわり）

---

## 1. ① `CASE` の中の集計が集計として認識されない（本体・正しさ）

### GROUP BY 無し — **集約されず、全行が返る**

```sql
SELECT CASE WHEN COUNT(*) = 0 THEN 'なし' ELSE 'あり' END AS 判定 FROM APP4149
```

- 期待: **1 行**（§8「GROUP BY のない集計クエリは、対象が 0 件でも常に 1 行を返します」）
- 実測: **20 行**（レコード数ぶん `あり` が並ぶ）。エラーも警告も無し

比較（いずれも正しく 1 行を返す）:

| 式 | 行数 | |
|---|---:|---|
| `SELECT COUNT(*) FROM APP4149` | 1 | ○ |
| `SELECT GREATEST(SUM(売上), 1) FROM APP4149` | 1 | ○ |
| `SELECT UPPER(MIN(会社名)) FROM APP4149` | 1 | ○ |
| `SELECT CASE WHEN COUNT(*) = 0 THEN 'なし' ELSE 'あり' END FROM APP4149` | **20** | ✗ |

**`CASE` を含む式だけが集計クエリと判定されていない。**

### GROUP BY 有り — 誤った診断で止まる

```sql
SELECT 会社名, CASE WHEN SUM(売上) = 0 THEN 'ゼロ' ELSE 'あり' END AS 判定
FROM APP4149 GROUP BY 会社名
```
```
ArgumentError: unknown field code(s): SUM(売上) (APP4149)
```

`SUM(売上)` はフィールド名ではない。利用者は「フィールド名を間違えた／`売上` が無い」と読み、
原因（`CASE` の中に集計を書けない）に辿り着けない。

### 正常に動くもの（**制約は `CASE` 固有**。実装時に壊さないこと）

| 式 | GROUP BY 無し | GROUP BY 有り |
|---|---|---|
| `UPPER(MIN(会社名))` / `LENGTH(MAX(会社名))` | ○ | ○ |
| `ROUND(SUM(売上), -3)` / `ROUND(AVG(売上), 1)` | ○ | ○ |
| `GREATEST(SUM(売上), 1)` | ○ | ○ |
| `COALESCE(MAX(会社名), 'x')` | ○ | — |
| `SUM(CASE WHEN 売上 > 0 THEN 売上 ELSE 0 END)`（集計の**引数**としての CASE） | — | ○ |

**スカラー関数の引数に集計を書くこと自体は許されている。** 問題は `CASE` 式だけ。

### 期待する挙動

`CASE` の条件部・THEN / ELSE に集計関数が現れたら、**その式を集計式として扱う**。

- GROUP BY 無し → 1 行に集約する
- GROUP BY 有り → グループごとに評価する（`unknown field code(s)` を出さない）

実装が重いなら、**最低限「静かに間違う」を消す**こと。GROUP BY 無しで 20 行返す挙動は、
利用者からは誤りと分からない。取得前に「`CASE` の中に集計関数は書けません」と
明示エラーにするだけでも被害は止まる（§4 案 B）。

---

## 2. ② `HAVING` の集計が SELECT に無いとき、無言で 0 行になる（診断）

```sql
SELECT 会社名, COUNT(*) AS 件数 FROM APP4149 GROUP BY 会社名 HAVING SUM(売上) > 0
→ 0 行（エラー無し）

SELECT 会社名, COUNT(*) AS 件数, SUM(売上) AS 売上合計 FROM APP4149 GROUP BY 会社名 HAVING SUM(売上) > 0
→ 8 行（`SUM(売上)` が 0 の 2 社を除いた全社。評価されている）
```

> 訂正（2026-08-05）: ここを当初「10 行」と書いていたが実測は 8 行。主張（SELECT に無い集計は
> 無言で 0 行になる）は変わらない。なお `HAVING` の**数値比較そのものが壊れている**ことが
> 別途判明した → [B121](ksql_b121_having_numeric_comparison_issue.md)。

**挙動そのものは仕様どおり**。§9 に明記がある。

> 直接記述した集計関数は、**同じ集計が SELECT 列にも存在する場合に限り**評価できます。
> SELECT にない集計を HAVING 専用で追加計算はしません。

問題は「評価できない」ときに何も言わず全行を落とすこと。
利用者からは「条件に合うグループが 1 つも無かった」と区別がつかない。
標準 SQL では書ける形なので、経験のある利用者ほど疑わない。

**案**: 評価できない集計が `HAVING` にあればレコード取得前にエラーにし、
「その集計を SELECT 列に出すか、SELECT の別名で参照してください」と対処を案内する。
§9 の規則は変えず、診断だけを足す。

---

## 3. 問題ではないと確認したもの（実装時の混乱を避けるため）

調査中に紛らわしいエラーを 2 つ踏んだが、**いずれも診断が的確で、仕様として妥当**。

```sql
-- 集計算術式のオペランドにスカラー関数を混ぜた
SELECT 会社名, SUM(売上) * 100.0 / GREATEST(SUM(売上), 1) FROM APP4149 GROUP BY 会社名
→ 集計算術式には集計関数または数値が必要です（位置 30、トークン: 「GREATEST」）

-- 同じものを ROUND の引数に入れた
SELECT 会社名, ROUND(SUM(売上) / GREATEST(SUM(売上), 1), 1) FROM APP4149 GROUP BY 会社名
→ ROUND の引数構文が不正です。スカラー値式に集約関数は使用できません（位置 18、トークン: 「SUM」）
```

「集計算術式は集計関数と数値だけで構成する」「スカラー関数(集計) は後段で 1 回適用する」
という 2 経路の分離が設計。**混ぜられないこと自体は妥当で、文面も原因を指している。**

ただし副作用として、**ゼロ除算のガードが現状どうやっても書けない**。

- `CASE WHEN SUM(x) = 0 THEN '' ELSE ... END` → ①のエラー
- `GREATEST(SUM(x), 1)` を分母に → 上記のエラー
- `NULLIF(SUM(x), 0)` → 空文字は `Number('') = 0` で結局 `NaN`（§5 に明記）

回避は `HAVING` によるグループごと除外のみ。**①を直せば `CASE` で書けるようになる**ため、
①の副次的な価値としてここに記録する。

---

## 4. 対応案

**案 A（推奨・①）**: `CASE` 式の中の集計関数を集計として検出する。
集計クエリ判定（GROUP BY 無しで 1 行に畳む判定）と、GROUP BY 時のグループ単位評価の両方で、
`CASE` の条件部・THEN・ELSE を走査対象に加える。

- 既存の `SUM(CASE ... END)`（集計の引数としての CASE）と混同しないこと。
  外側が集計か、内側に集計があるかで経路が違う
- `GROUPING(会社名)` を `CASE` の条件に書く形は既に動いている（§8 の ROLLUP 例）。
  その実装が参考になる可能性が高い

**案 B（最低限・①）**: 検出だけ行い、`CASE` の中に集計があれば**取得前にエラー**にする。
「静かに間違う」は消えるが、ゼロ除算ガードは書けないまま。

**案 C（②）**: `HAVING` の評価不能な集計を取得前にエラーにする（診断のみ・規則は不変）。

## 5. 受入条件

### ①（案 A の場合）

1. `SELECT CASE WHEN COUNT(*) = 0 THEN 'なし' ELSE 'あり' END FROM APP4149` が **1 行**を返す
2. 0 件のとき `'なし'` を返す（`WHERE` で 0 件に絞った場合）
3. `SELECT 会社名, CASE WHEN SUM(売上) = 0 THEN 'ゼロ' ELSE 'あり' END FROM ... GROUP BY 会社名` が
   グループごとに評価され、`unknown field code(s)` を出さない
4. ゼロ除算ガード
   `CASE WHEN SUM(b) = 0 THEN '' ELSE ROUND(SUM(a) * 100.0 / SUM(b), 1) END` が書ける
5. **回帰（壊してはいけない）**: §3 の 2 形のエラー文面は変えない。
   `UPPER(MIN(x))` / `ROUND(AVG(x), 1)` / `GREATEST(SUM(x), 1)` / `COALESCE(MAX(x), 'x')` が
   GROUP BY の有無どちらでも従来どおり動く
6. **回帰**: `SUM(CASE WHEN ... END)`（B64・v3.16.0）が従来どおり動く
7. **回帰**: `CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END`（B65 の ROLLUP）が従来どおり

### ①（案 B の場合）

1. `CASE` の中に集計があればレコード取得前にエラー。文面は原因（`CASE` 内の集計）と
   対処（集計の引数として書く／`HAVING` を使う）を示す
2. `unknown field code(s)` を名乗らない
3. 回帰は案 A の 5〜7 と同じ

### ②

1. `... GROUP BY 会社名 HAVING SUM(売上) > 0`（SELECT に `SUM(売上)` 無し）が
   0 行ではなくエラーになり、対処を案内する
2. **回帰**: SELECT に出している場合・別名参照（`HAVING 売上合計 > 0`）は従来どおり
3. **回帰**: `HAVING COUNT(*) >= 3` / `HAVING GROUPING(会社名) = 1` /
   `HAVING SUM(CASE WHEN ... END) > n`（SELECT にある場合）が従来どおり

## 6. 実測環境

v3.43.0 / dev プロファイル / APP4149（案件管理・20 件）。2026-08-04。
