# B64 — 集計関数の引数に CASE 式（条件付き集計 `SUM(CASE WHEN … END)`）が指定不可

- ステータス: 📝 **【A: 評価・方向判断】起票（2026-07-23）**。集計関数の引数に `CASE` 式を書けず、条件付き集計（`SUM(CASE WHEN cond THEN 1 ELSE 0 END)` 等）が直接表現できない。回避策（CTE で CASE 列を作ってから集計）は存在。仕様前・実需/方針の確認待ち。
- 種別: 機能（式・集計）
- 優先: 中
- 関連: [B37 CHECK（CASE 相当の条件式）](ksql_custom_check_spec.md) / [B16 GROUP_CONCAT](ksql_group_concat_spec.md) / [B56 統計集約](ksql_b56_statistical_aggregates_spec.md) / 言語 §（集計関数・CASE 式）

## 1. 事象・再現

集計関数の引数に `CASE` 式を置くと `ParseError` になる。

```sql
-- ❌ ParseError: 算術式のオペランドには識別子・数値・括弧式を指定してください（位置 11、トークン: 「CASE」）
SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count FROM APP1
```

同様に `COUNT(CASE …)`・`AVG(CASE …)` など、**あらゆる集計関数の引数位置に CASE を書くと同じエラー**になる（`ksql_validate` で確認）。

**括弧で包んでも回避できない**（`ksql_validate` で確認）。「括弧式」は `( 算術式 )` の意味（識別子・数値を算術演算子で結んだ入れ子）であって、任意のスカラー式を受理する括弧ではないため、`CASE` は括弧の内側でも同じ位置で拒否される。

```sql
-- ❌ 括弧を足しても NG（位置 12・トークン「CASE」で同じ ParseError）
SELECT SUM((CASE WHEN status = 'done' THEN 1 ELSE 0 END)) AS done_count FROM APP1
SELECT SUM((CASE WHEN status = 'done' THEN 1 ELSE 0 END) + 0) AS done_count FROM APP1
```

一方、次はいずれも通る（`ksql_validate` で確認）。

```sql
-- ✅ CASE 式は SELECT のスカラー列としては受理される
SELECT CASE WHEN status = 'done' THEN 1 ELSE 0 END AS flag FROM APP1

-- ✅ 集計関数の引数が識別子・算術式なら受理される（括弧の入れ子も算術式なら可）
SELECT COUNT(*) AS c, SUM(amount) AS total FROM APP1
SELECT SUM((amount + 1) * 2) AS x FROM APP1
```

## 2. 原因（推定）— CASE 単独ではなく「集計引数＝算術式限定」の一般制約

エラーメッセージ「算術式のオペランドには識別子・数値・括弧式を指定してください」の通り、**集計関数の引数パーサが受理するのは「算術式」文法だけ**で、フルの「スカラー値式」文法を受理しない。`CASE` はこの制約の一例にすぎず、**スカラー式の層に属し算術式の層に無い構文はまとめて弾かれる**。

`ksql_validate` で境界を実測した結果:

**通る（算術式の文法＝オペランドは 識別子・数値・括弧式・スカラー関数呼び出し＋算術演算子）**

| 例 | 判定 |
|---|---|
| `SUM(amount)` / `SUM(amount + bonus)` / `SUM((amount + 1) * 2)` | ✅ |
| `SUM(ROUND(amount))` / `SUM(LENGTH(name))` / `SUM(CAST(name AS NUMBER))` | ✅ 関数呼び出しは可 |
| `GROUP_CONCAT(CONCAT(name, '!'))` | ✅ `CONCAT` 関数形は可 |
| `SUM(ABS(@rate))` | ✅ 関数の引数の中なら `@var` 可（文法 OK・未定義なら意味エラー止まり） |

**通らない（スカラー式の層にあり算術式の層に無いもの）**

| 例 | 判定 | エラー要点 |
|---|---|---|
| `SUM(CASE WHEN … END)` | ❌ | 算術式のオペランドに CASE 不可 |
| `GROUP_CONCAT(name \|\| '!')` | ❌ | `\|\|` 演算子は不可（→ `CONCAT` 関数形へ） |
| `SUM(@rate)` / `SUM(ROUND(amount) + @rate)` | ❌ | 裸の `@var` オペランドは不可（→関数に包む） |
| `SUM(amount > 0)` | ❌ | 比較演算子は不可（`「)」が必要です`） |

まとめると根本原因は共通で、**集計引数は算術式（識別子・数値・括弧式・関数呼び出し＋算術演算子）限定**であり、スカラー式層の `CASE`・`||` 演算子・裸の `@var`・比較/論理演算子は接続されていない。関数呼び出しは算術式のオペランドとして接続済みのため、`ROUND`/`LENGTH`/`CAST`/`CONCAT` は通る。

- スカラー式を実装している経路: SELECT スカラー列（B37 CHECK 条件でも CASE 相当の条件式は評価可能・B38 で `||`／関数引数の `@var` を受理）。
- 未接続の経路: 集計関数の引数（`SUM(...)`/`COUNT(...)`/`AVG(...)`/`GROUP_CONCAT(...)` 等の `(...)`）の**算術式オペランド位置**。

**部分的回避策**: `||`→`CONCAT` 関数形、裸 `@var`→関数に包む、で個別に回避可能。ただし `CASE` と比較/論理式には関数形の回避が無く、**CTE 経由（§4）が唯一の一般解**。

## 3. 固有価値（なぜ欲しいか）

**条件付き集計（conditional aggregation）は SQL の定番イディオム**で、1 回のスキャンで「条件別のカウント・合計」を横持ち（ピボット）で得る標準手段。

```sql
-- 状態別の件数を 1 行で（本来欲しい書き方）
SELECT
  SUM(CASE WHEN status = 'done'        THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS wip,
  SUM(CASE WHEN status = 'todo'        THEN 1 ELSE 0 END) AS todo,
  COUNT(*) AS total
FROM APP1
```

kSQL では JOIN が単一等値・派生テーブル非対応・`GROUP BY` と横持ち集計を 1 文で書きづらいという制約があるため、**条件付き集計が書けると「状態別・カテゴリ別の集計を 1 クエリで横持ち」が素直に表現できる**。ダッシュボード用の集計・区分別の売上/件数などで需要が想定される。

## 4. 回避策（現状で可能）

CASE 式は SELECT スカラー列としては通るため、**CTE で CASE 列を作ってから外側で集計**すれば等価に実現できる（`ksql_validate` で受理を確認）。

```sql
-- ✅ 回避策: CTE で CASE 列 → 外側で SUM
WITH t AS (
  SELECT CASE WHEN status = 'done' THEN 1 ELSE 0 END AS flag FROM APP1
)
SELECT SUM(flag) AS done_count FROM t
```

複数区分の横持ちも同様に、CTE 側で区分ごとの CASE 列を作り外側でそれぞれ SUM すればよい。ただし**冗長**（列数ぶん CASE を CTE に並べる必要があり、区分が増えると読みにくい）で、標準 SQL 経験者の期待（`SUM(CASE …)` を直接書く）とはズレる。

## 5. 設計案（たたき台）

集計関数の引数パーサを、算術式限定から**スカラー式（CASE を含む）受理**へ広げる。

- 集計関数の引数を、SELECT スカラー列で使っている**スカラー式評価器へ委譲**（`CASE`・`||`/`CONCAT`・関数・算術・`@var` を含む）。CTE 回避策が既に成立している以上、評価器の再利用で意味論は担保できる見込み。
- 適用範囲の論点: `SUM`/`COUNT`/`AVG`/`MIN`/`MAX` 等どこまで許すか。`COUNT(CASE WHEN … THEN 1 END)`（ELSE 省略＝NULL は非カウント）の**NULL / 空セルの数え方**を CASE の NULL 意味論・既存の空セル規約と整合させる必要（B56 統計集約の完全入力・空セル規約との整合を確認）。
- `DISTINCT`（`COUNT(DISTINCT CASE …)`）や `GROUP_CONCAT`/統計集約（B56）へ波及させるかは段階化。
- パーサ変更のため、既存の「算術式のみ」を前提にした fixture・drift guard・特性化テストへの影響を確認。

## 6. 論点

- **需要の強さ**: 回避策（CTE）で機能的には満たせるため、「直接書けること」の価値をどう見るか（可読性・標準 SQL 親和性 vs 実装/テストコスト）。
- **意味論の一貫性**: CASE の NULL・空セル・型（数値/文字列混在）を集計の型メタ経路（B14/B56 系）とどう整合させるか。
- **範囲**: Phase1 を `SUM`/`COUNT` の CASE 引数に絞るか、スカラー式全般（`||`/関数/算術）を一括で開けるか。
- **エラー体験**: 開けるまでの間、`SUM(CASE …)` の ParseError メッセージに**回避策（CTE）を案内**するだけでも UX 改善になる（軽量な暫定対応の是非）。

## 7. 次アクション

1. 実需の確認（条件付き集計を直接書きたい場面の具体化・区分数の規模）。
2. 方向判断: フル対応（パーサ拡張）／暫定対応（エラーメッセージに CTE 回避策を案内）／据え置き（回避策で足りる）のいずれか。
3. 方向が定まれば Phase1 仕様 R1 →（既存フロー）codex レビュー → R2 → 実装。
