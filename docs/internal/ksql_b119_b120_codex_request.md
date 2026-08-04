# B119 / B120 codex 実装依頼（2026-08-04）

このファイルの §2 以降をそのまま codex へ渡す。
実装は codex、レビューは Claude。**仕様の詳細は各 issue 文書が正**。

- [B119](ksql_b119_aggregate_string_function_arg_issue.md) 集計引数の文字列関数が 0 を返す
- [B120](ksql_b120_aggregate_position_diagnostics_issue.md) `CASE` の中の集計が集計として扱われない

> **注意（headless で回す場合）**: `codex exec` は MCP tool call の承認待ちで無言停止する。
> この依頼は MCP を使わずローカルのテストだけで完結する内容にしてある。
> **codex に kSQL MCP を叩かせないこと**（実機確認はレビュー側で行う）。

---

## 2. 依頼

kSQL エンジンの集計まわりに、**エラーを出さずに誤った結果を返す**欠陥が 2 件ある。
どちらも実測で再現・原因の当たりまで付いている。修正とテストをお願いしたい。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（現行 v3.43.0）

### 進め方

1. まず **B119 → B120 の順**で、それぞれ独立に修正する（依存関係は無い）
2. 各修正で**失敗するテストを先に書く**（現行コードで落ちることを確認してから直す）
3. `npm test` を通す
4. 実装後、変更点と判断（特に §5 で迷った箇所）を報告する

---

## 3. B119 集計関数の引数に文字列関数を書くと 0 / 空が返る

### 症状

```
COUNT(DISTINCT 会社名)        → 10   ○
COUNT(DISTINCT UPPER(会社名)) →  0   ✗   期待 10
COUNT(UPPER(会社名))          →  0   ✗   期待 20
MAX(UPPER(会社名))            →  0   ✗   期待 文字列
GROUP_CONCAT(DISTINCT UPPER(x)) → 空 ✗
COUNT(DISTINCT COALESCE(商談フェーズ, '未選択')) → 0 ✗
```

境界は**引数が数値を返すか**。`SUM(ROUND(売上))` `SUM(LENGTH(会社名))`
`COUNT(DISTINCT 売上 * 1)` `COUNT(DISTINCT CASE WHEN ... END)` は正常。

### 原因（特定済み）

`src/engine/process.ts` の `evalAggregate`（現行 495 行目付近）。

```ts
} else if (arg.type === "ARITH" || arg.type === "NUMBER" || arg.type === "STRING_FUNC") {
  // 算術式 / 関数: 数値として評価し NaN はスキップ
  const n = evalArithExpr(arg, row);
  if (isNaN(n)) continue;          // ← UPPER(会社名) は毎行ここで捨てられる
  strVal = String(n);
}
```

`STRING_FUNC` が算術式と同じ経路に入っており、`Number("株式会社…") = NaN` で全行が
`continue` される。収集値 0 件 → `COUNT` は 0、`GROUP_CONCAT` は空、`MIN`/`MAX` は
`comparableValues.length === 0` で `0` を返す（同ファイル 561 行目付近）。

`CASE_WHEN` / `CONCAT_OP` / `STRING` は下の `else` で `evalScalarValueExprNullable` を
通るため文字列のまま保たれる。**この非対称が本件。**

### 方針（案 A）

`STRING_FUNC` を `CASE_WHEN` などと同じスカラー経路へ移し、**文字列のまま収集**する。

- `SUM` / `AVG` / 統計 6 関数は**収集後**に `Number` 変換が入る（同ファイル 570 行目付近の
  `.map(Number)` と `numericValues`）ため、`SUM(LENGTH(会社名))` のような現行の正常系は維持される
- `MIN` / `MAX` / `MODE` の比較意味論（`resolveAggregateArgSemantics`）が `STRING_FUNC` に
  対して何を返すかを確認すること。文字列を返す関数なら `string` 比較が妥当。
  **ここは判断が要る箇所なので、選んだ根拠を報告に含めてほしい**
- `DISTINCT` の規約は変えない（既存 6 集計は文字列単位、統計 6 関数は数値同値単位）

### 受入条件

1. `COUNT(DISTINCT UPPER(会社名))` = `COUNT(DISTINCT 会社名)`（表記ゆれが無いデータで）
2. `COUNT(UPPER(会社名))` = `COUNT(会社名)`
3. `MAX(UPPER(会社名))` が文字列を返す（`0` ではない）
4. `GROUP_CONCAT(DISTINCT UPPER(x))` が連結文字列を返す
5. `COUNT(DISTINCT COALESCE(商談フェーズ, '未選択'))` が空セルを含む種類数を返す
6. **回帰**: `SUM(ROUND(売上))` / `SUM(LENGTH(会社名))` / `COUNT(DISTINCT 売上 * 1)` /
   `COUNT(DISTINCT CASE WHEN ... END)` が現行値のまま
7. **回帰**: 統計 6 関数の「非数値は `ArgumentError`」が維持される
   （`STDDEV_SAMP(UPPER(x))` はエラーのまま）

---

## 4. B120 `CASE` の中の集計が集計として扱われない

### 症状

**GROUP BY 無し — 集約されず全行が返る（エラー無し）**

```
SELECT CASE WHEN COUNT(*) = 0 THEN 'なし' ELSE 'あり' END FROM APP4149（20 件）
→ 20 行（期待 1 行）
```

比較（いずれも正しく 1 行）: `SELECT COUNT(*)` / `SELECT GREATEST(SUM(売上), 1)` /
`SELECT UPPER(MIN(会社名))`。**`CASE` を含む式だけ集計クエリと判定されていない。**

**GROUP BY 有り — 誤った診断**

```
SELECT 会社名, CASE WHEN SUM(売上) = 0 THEN 'ゼロ' ELSE 'あり' END FROM APP4149 GROUP BY 会社名
→ ArgumentError: unknown field code(s): SUM(売上) (APP4149)
```

`SUM(売上)` はフィールド名ではない。原因（`CASE` の中に集計を書けない）に辿り着けない文面。

### 方針

**案 A（推奨）**: `CASE` の条件部・THEN・ELSE を**集計検出の走査対象に加える**。

- 集計クエリ判定（GROUP BY 無しで 1 行に畳む判定）
- GROUP BY 時のグループ単位評価

`CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END`（B65 の ROLLUP）は
**既に動いている**ので、その実装が参考になるはず。まずそこを読むこと。

**案 B（案 A が重すぎる場合）**: 検出だけ行い、`CASE` の中に集計があれば
**レコード取得前にエラー**にする。文面は原因（`CASE` 内の集計）と対処
（集計の引数として書く／`HAVING` を使う）を示し、`unknown field code(s)` を名乗らない。

**案 A と案 B のどちらを採るかは、実装量を見て判断してよい。**
ただし**「GROUP BY 無しで 20 行返る」は必ず消すこと**（利用者から誤りと分からないため）。
案 B を選んだ場合は理由を報告に書くこと。

### 壊してはいけないもの（**制約は `CASE` 固有**）

スカラー関数の引数に集計を書くこと自体は許されている。以下は GROUP BY の有無を問わず正常:

```
UPPER(MIN(会社名))   LENGTH(MAX(会社名))   ROUND(SUM(売上), -3)   ROUND(AVG(売上), 1)
GREATEST(SUM(売上), 1)   COALESCE(MAX(会社名), 'x')
SUM(CASE WHEN 売上 > 0 THEN 売上 ELSE 0 END)   ← 集計の「引数」としての CASE（B64）
CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END   ← B65 ROLLUP
```

次の 2 つのエラー文面も**変えないこと**（診断として妥当と確認済み）:

```
SUM(受注額) * 100.0 / GREATEST(SUM(売上), 1)
  → 集計算術式には集計関数または数値が必要です（位置 30、トークン: 「GREATEST」）
ROUND(SUM(受注額) / GREATEST(SUM(売上), 1), 1)
  → ROUND の引数構文が不正です。スカラー値式に集約関数は使用できません（位置 18、トークン: 「SUM」）
```

### 受入条件（案 A）

1. `SELECT CASE WHEN COUNT(*) = 0 THEN 'なし' ELSE 'あり' END FROM APP` が **1 行**
2. 0 件に絞った場合 `'なし'` を返す
3. `SELECT 会社名, CASE WHEN SUM(売上) = 0 THEN 'ゼロ' ELSE 'あり' END ... GROUP BY 会社名` が
   グループごとに評価され、`unknown field code(s)` を出さない
4. `CASE WHEN SUM(b) = 0 THEN '' ELSE ROUND(SUM(a) * 100.0 / SUM(b), 1) END` が書ける
5. **回帰**: 上の「壊してはいけないもの」7 形すべて
6. **回帰**: 上の 2 エラー文面が不変

### 受入条件（案 B）

1. `CASE` 内の集計を取得前にエラーにし、原因と対処を示す（`unknown field code(s)` を名乗らない）
2. 回帰は案 A の 5・6 と同じ

---

## 5. テストの方針（毎回同じ）

- **新規テストは B 番号を冠したファイルへ**。既存の命名に合わせる
  （例 `src/engine/__tests__/b119AggregateStringFuncArg.test.ts`）。
  B119 は engine 層が中心、B120 は parser / core / engine にまたがる可能性がある。
  既存の `b64AggregateScalarArg.test.ts` が parser / converter / engine の 3 層に分かれているのが参考になる
- **既存テストの書き換えは「意味が変わるか」で線引きする。**
  - 表現の調整（期待値の書式・ヘルパの共通化）→ 変えてよい
  - **その挙動が正しいと主張している期待値を変える → 変えてはいけない**。
    もし既存テストが今回の誤った挙動（`COUNT(DISTINCT UPPER(x))` = 0 など）を
    正として固定していたら、**書き換えずに報告すること**。仕様判断が必要になる
- **公開型に必須プロパティを足すのは破壊的変更**。必要になったら任意プロパティにするか、
  報告して判断を仰ぐこと
- テストは**現行コードで落ちること**を確認してから実装に入る

## 5.5 運用制約（headless で回すときの約束）

- **git 操作は一切しない。** `git add` / `git commit` / `git checkout` / ブランチ操作すべて禁止。
  コミットは Claude 側で行う（sandbox は `.git` への書き込みを拒否するため失敗もする）
- **ビルドしない。** `npm run build*` は不要。検証は `npm test` だけで完結させる
- **MCP ツールを呼ばない。** kSQL MCP への接続は不要。実機確認はレビュー側で行う
- **`CHANGELOG.md`・`package.json` の版数・`docs/ksql_issue_tracker.md` は触らない**
- 作業対象は `src/` 配下と、必要なら issue 文書 2 本のステータス行だけ

## 6. 完了の定義

1. `npm test` が通る（`version:check` を含む）
2. B119・B120 の受入条件を満たすテストがある
3. 変更点・採用した案・迷った判断（特に B119 の `MIN`/`MAX`/`MODE` 比較意味論、
   B120 の案 A/B 選択）を報告する
4. **`CHANGELOG.md` と版数は触らない**（リリース時にこちらで行う）
5. issue 文書（`docs/internal/ksql_b119_*.md` / `ksql_b120_*.md`）のステータス行は
   実装完了時に「🚧 実装済み・リリース待ち」へ更新してよい。台帳（`docs/ksql_issue_tracker.md`）は触らない
