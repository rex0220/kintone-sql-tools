# v2.1.2 プラグイン実機テスト SQL

- 作成日: 2026-07-15
- 対象: kintone プラグイン（v2.1.2 ビルド `dist/ksql-plugin-v2.1.2.zip`）
- 前提アプリ（例）: APP4149（案件: `案件No_` / `案件名` / `商談フェーズ` / `売上` / `顧客No_`）
  - **`売上` は数値フィールド**、**`商談フェーズ` はグルーピング用のカテゴリ**（ドロップダウン等）として使う。
  - ご自身のアプリの**数値フィールド 1 つ**（＋任意でカテゴリ 1 つ）に読み替えてください。数値フィールドが 2 つある場合は `SUM(a) - SUM(b)` 形（A-1 の補足）でも確認できます。
- 関連: 課題 [ksql_agg_arith_alias_dropped_issue.md](ksql_agg_arith_alias_dropped_issue.md) / 仕様 [ksql_agg_arith_alias_dropped_fix_spec.md](ksql_agg_arith_alias_dropped_fix_spec.md)

**v2.1.2 の修正**: **集計算術式の末尾（や中間）が集計関数でも `AS alias` が保持される**バグ修正。従来は `SUM(x) / COUNT(*) AS 平均` の `AS 平均` が静かに捨てられ、出力列名・`HAVING`/`ORDER BY`/後段参照が合成名（`SUM(x)/COUNT(*)`）になっていた。プラグインは実行エンジンをバンドルするため、この挙動はプラグイン上で確認できる。加えて、式の途中に置いた不正な alias（`SUM(x) AS y - COUNT(*)`）を **ParseError** で拒否するようになった。

> **すべて read-only**（SELECT のみ）なので確認ダイアログ・書き込みは発生しません。プラグインは**最後に結果を返した文だけ**を表示します（単文で実行してください）。
>
> **修正前（v2.1.1 以前）との差**: A/B/C の alias（`平均` 等）が**出力列ヘッダに出る／`HAVING`・`ORDER BY`・後段で引ける**ようになります。v2.1.1 では同じ SQL が合成名ヘッダになり、`HAVING 平均` が全落ち・`ORDER BY 平均` が無並び替えになります。

---

## A. alias が保持される（末尾が集計関数）

### A-1. 末尾が集計関数の集計算術式に alias

```sql
SELECT 商談フェーズ, SUM(売上) / COUNT(*) AS 平均, SUM(売上) - COUNT(*) AS 差
FROM APP4149
GROUP BY 商談フェーズ
ORDER BY 商談フェーズ
```

期待: 出力列ヘッダが **`商談フェーズ` / `平均` / `差`**（合成名 `SUM(売上)/COUNT(*)` ではない）。各フェーズごとに `SUM(売上) ÷ 件数` と `SUM(売上) − 件数` が出る。

> **数値フィールドが 2 つある場合**（例 `売上` と `原価`）は、末尾も集計関数の純粋な形で:
> ```sql
> SELECT 商談フェーズ, SUM(売上) - SUM(原価) AS 粗利 FROM APP4149 GROUP BY 商談フェーズ ORDER BY 商談フェーズ
> ```
> 期待: ヘッダが `粗利`（従来は `SUM(売上)-SUM(原価)`）。

### A-2. DISTINCT・括弧・単項マイナス配下でも alias 保持

```sql
SELECT 商談フェーズ,
       SUM(DISTINCT 売上) - COUNT(*) AS d,
       COUNT(*) + (SUM(売上) - COUNT(*)) AS nested,
       COUNT(*) + -COUNT(*) AS negated
FROM APP4149
GROUP BY 商談フェーズ
ORDER BY 商談フェーズ
```

期待: ヘッダが `商談フェーズ / d / nested / negated`。`negated` は各行 `件数 + (−件数) = 0`。括弧内・単項マイナス配下の集計オペランドでも alias を横取りしない。

---

## B. HAVING / ORDER BY が alias で解決される

### B-1. HAVING で alias 参照

```sql
SELECT 商談フェーズ, SUM(売上) - COUNT(*) AS 差
FROM APP4149
GROUP BY 商談フェーズ
HAVING 差 > 0
ORDER BY 差 DESC
```

期待: `差 > 0` のフェーズだけが残り、`差` の**降順**に並ぶ。
**v2.1.1 以前**: `差` が合成名のため `HAVING 差` は空参照で**常に偽 → 全落ち（0 行）**、`ORDER BY 差` は**全行同値扱いで並び替わらない**。v2.1.2 で正しく絞り込み・並び替えされることを確認する。

---

## C. CTE / サブクエリ後段から alias 参照

### C-1. CTE 後段で alias 参照

```sql
WITH g AS (
  SELECT 商談フェーズ, SUM(売上) - COUNT(*) AS 差
  FROM APP4149
  GROUP BY 商談フェーズ
)
SELECT 商談フェーズ, 差 FROM g WHERE 差 > 0 ORDER BY 差 DESC
```

期待: 後段の `SELECT … 差` が値を返す（**v2.1.1 以前は `差` 列が無く空**）。

---

## D. エラー系（中間 alias の拒否・メッセージ確認）

> いずれも **kintone へ問い合わせる前（パース時）にエラー**になります。

### D-1. 左端直後の中間 alias → ParseError

```sql
SELECT SUM(売上) AS x - COUNT(*) FROM APP4149
```

期待: **ParseError**（式の途中に `AS` は置けない。単独集計列として `AS x` を読んだ後、余剰の `- COUNT(*)` で構文エラー）。**v2.1.1 以前は誤って受理**され、`AS x` は無視されていた。

### D-2. 括弧内オペランドの中間 alias → ParseError

```sql
SELECT COUNT(*) + (SUM(売上) AS x - COUNT(*)) AS d FROM APP4149
```

期待: **ParseError**（括弧内で `SUM(売上)` の後に `)` を期待するが `AS` を検出）。

### D-3. 文字列関数引数内の中間 alias → ParseError

```sql
SELECT FORMAT(SUM(売上) AS x, '#') AS y FROM APP4149
```

期待: **ParseError**（関数引数内の集計式の後に `,`/`)` を期待するが `AS` を検出）。

> **回避策（正しい書き方）**: 集計算術式全体に 1 つだけ alias を付ける。`FORMAT(SUM(売上) - COUNT(*), '#') AS y` は有効。

---

## 判定サマリ

| # | 期待 |
|---|------|
| A-1 | ヘッダが `平均` / `差`（合成名でない）。値は SUM÷件数・SUM−件数 |
| A-2 | `d` / `nested` / `negated` の alias が出る。`negated` は 0 |
| B-1 | `HAVING 差 > 0` で絞り込み、`ORDER BY 差 DESC` で降順（v2.1.1 は全落ち・無並び） |
| C-1 | CTE 後段 `SELECT 差` が値を返す（v2.1.1 は空） |
| D-1〜D-3 | いずれも ParseError（中間 alias 拒否。v2.1.1 は誤受理） |

> **確認の勘所**: v2.1.1 以前と v2.1.2 で **B-1 / C-1 の差**（前者は 0 行・空列、後者は正しく解決）が最も分かりやすい。手元に旧版があれば同じ SQL で挙動差を比較すると確実。
