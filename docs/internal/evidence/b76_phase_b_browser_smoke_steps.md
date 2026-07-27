# B76 Phase B Firefox / Chrome プラグイン実機 smoke 手順

- 対象: 次回リリース候補の同一 plugin zip を読み込んだ Firefox / Chrome
- 目的: 第5-W / 第5-L の許可、複数 alias、`LOGINUSER()`、拒否 reason、EXPLAIN と実行可否の一致を両ブラウザで確認する
- 本ファイルは手順書。実施結果はリリース owner がブラウザ名・plugin version・日時・結果件数とともに追記する

## 1. アプリ前提

標準スペースに、plugin から閲覧できる次の2アプリを用意する。両アプリへ同じ plugin を設定し、
plugin 設定のアプリトークン / 閲覧権限で両方のレコードを取得できるようにする。

| 論理名 | 例の app ID | 必須フィールド |
|---|---:|---|
| 注文 | `APP100` | `結合キー`（文字列1行・重複禁止推奨）、`日付`（日付）、`件名`（文字列1行） |
| 担当 | `APP200` | `結合キー`（文字列1行・重複禁止推奨）、`作成者`（作成者） |

各アプリに、同じ `結合キー` を持つレコードを少なくとも2組作る。注文側は今月1件・先月1件とし、
`件名` は2文字以上にする。担当側の1件以上は smoke 実施ユーザーが作成する。
実 app ID が異なる場合は、以下の `APP100` / `APP200` だけを置換する。

## 2. 第5-W（single-alias whole-WHERE exact）

まず `EXPLAIN` で次を実行する。

```sql
EXPLAIN
SELECT a.結合キー, a.日付
FROM APP100 a
INNER JOIN APP200 b ON a.結合キー = b.結合キー
WHERE a.日付 = THIS_MONTH() OR a.日付 = LAST_MONTH()
```

確認点:

- `plan status: rejected` がない
- `allow form: JOIN_SERVER_FUNCTION_EXACT (whole-WHERE)`、対象 alias `a`、
  `pushdown applied`、`client residual: (none)`、`relative date client evaluations: 0` がある
- EXPLAIN 中の records / cursor / mutation API は0

`EXPLAIN` を外して実行し、今月・先月の結合対象だけが返ることを確認する。

## 3. 第5-L（複数 alias＋client residual）

```sql
EXPLAIN
SELECT a.結合キー, a.日付, b.作成者
FROM APP100 a
INNER JOIN APP200 b ON a.結合キー = b.結合キー
WHERE a.日付 = THIS_MONTH()
  AND b.作成者 in (LOGINUSER())
  AND LENGTH(a.件名) > 1
```

確認点:

- alias `a` の `日付 = THIS_MONTH()` と alias `b` の
  `作成者 in (LOGINUSER())` が、それぞれの APP の `pushdown applied` に出る
- client residual は `LENGTH(a.件名) > 1` だけ
- `relative date client evaluations: 0` と `kintone function client evaluations: 0` が両方ある

`EXPLAIN` を外して実行し、今月・実施ユーザー作成・件名2文字以上をすべて満たす結合行だけが返ることを確認する。

## 4. 拒否形と reason

cross-alias `OR` を実行する。

```sql
SELECT a.結合キー
FROM APP100 a
INNER JOIN APP200 b ON a.結合キー = b.結合キー
WHERE a.日付 = THIS_MONTH() OR b.作成者 in (LOGINUSER())
```

確認点:

- 実行は `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で失敗し、結果行を返さない
- 同じ SQL の `EXPLAIN` は throw せず `plan status: rejected`、reason、
  `client evaluation: forbidden`、実行 API なしを表示する

KLIKE を含む non-exact `OR` も確認する。

```sql
SELECT a.結合キー
FROM APP100 a
INNER JOIN APP200 b ON a.結合キー = b.結合キー
WHERE a.日付 = THIS_MONTH()
   OR (a.件名 KLIKE '確認' AND LENGTH(a.件名) > 1)
```

この形は KLIKE の静的エラーではなく、実際の阻害要因である関数側の
`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で拒否されることを確認する。

## 5. 両ブラウザの記録

Firefox と Chrome のそれぞれで、上記4 SQLについて次を記録する。

| ブラウザ | plugin version | 第5-W 実行 / EXPLAIN | 第5-L 実行 / EXPLAIN | cross-alias OR reason | KLIKE OR reason |
|---|---|---|---|---|---|
| Firefox |  |  |  |  |  |
| Chrome |  |  |  |  |  |

両ブラウザで、許可形の実行と EXPLAIN がともに許可、拒否形の実行が拒否かつ
EXPLAIN が `plan status: rejected` であることを release gate とする。
