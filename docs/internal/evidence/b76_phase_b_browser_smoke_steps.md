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


---

## 【実機・CLI 面】v3.28.0 / devenxyfi / APP4147・APP4148（2026-07-27）

ブラウザ smoke に先立ち、**ローカル v3.28.0 ビルドの CLI で実 kintone に対して**先行検証した。
プロファイル `dev`（devenxyfi.cybozu.com・ログインユーザー Alex2013）。

- **APP4147** 活動履歴: `顧客No`(NUMBER)、`対応日付`(DATE)、`会社名`/`タイトル`(TEXT)、
  `対応者`(USER_SELECT)、`作成者`(CREATOR)、`所属組織`(ORGANIZATION_SELECT)
- **APP4148** 顧客: `顧客No`(RECORD_NUMBER)、`更新日時`(UPDATED_TIME)
- 結合: `a.顧客No = t.顧客No`
- データは 2025-08〜2025-10 の 18 件。今日（2026-07-27）基準では `THIS_MONTH()` が 0 件になるため、
  **`LAST_YEAR()` を使う形**に組み替えている

### 期待値の三点固定

| 形 | 件数 |
|---|---:|
| 単一表 `対応日付 = LAST_YEAR()` | 18 |
| JOIN ＋ リテラル日付 `>= 2025-01-01 and <= 2025-12-31` | 18 |
| **JOIN ＋ `LAST_YEAR()`（v3.28.0 の新規許可）** | **18** |

**v3.27.0 では同じ JOIN ＋ `LAST_YEAR()` が `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で
拒否される**ことも、デプロイ済み MCP v3.27.0 で確認済み（before / after の対比）。

### 実行結果

| # | 形 | 結果 |
|---|---|---|
| ① | 第5-W 同一 alias OR（`LAST_YEAR() OR THIS_YEAR()`） | **18** |
| ② | 第5-L ＋ client 残余 `LENGTH(a.会社名) > 1` | **18** |
| ③ | 第5-L 複数 alias（`a.対応日付 = LAST_YEAR() AND t.更新日時 <= NOW()`） | **18** |
| ④ | `a.対応者 in (LOGINUSER())` 併用 | **0**（後述・データ由来で正） |
| ⑤ | cross-alias OR | **拒否** `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` |
| ⑥ | LEFT JOIN | **拒否** 同上 |
| ⑦ | `所属組織 in (LOGINUSER())` | **拒否** `WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED` |

### 0 件になった 2 形を追跡した結果（いずれもデータ由来・不具合ではない）

- `LENGTH(a.タイトル) > 1` が 0 件 → **`タイトル` が全レコード空**。
  単一表でも 0、JOIN ＋ リテラル日付でも 0 で三者一致し、`LENGTH(a.会社名) > 1` は 18 件。
  **residual は正しく評価されている。**
- `対応者 in (LOGINUSER())` が 0 件 → 全 18 件の `対応者` は `rex0220` だが、
  CLI プロファイルのログインユーザーは `Alex2013`。**サーバー側で正しく解決された結果の 0 件。**

### EXPLAIN（実機）

許可形:

```text
allow form: JOIN_SERVER_FUNCTION_EXACT (leaf)
pushdown applied: 対応日付 = LAST_YEAR()
relation: exact
function leaf relation: function-leaf-exact
consumption: leaf
client residual: LENGTH(a.会社名) > 1
relative date client evaluations: 0
```

拒否形（LEFT JOIN）はエラー終了せず次を表示する。

```text
relative date function: LAST_YEAR
plan status: rejected
reason: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN
client evaluation: forbidden
records/cursor/mutation API during EXPLAIN: none
```

**CLI 面は実機 PASS。**

## 【実機・プラグイン面】v3.28.0（2026-07-27・オーナー実施）

ブラウザ プラグイン `ksql-plugin-v3.28.0.zip` で上記 SQL を実施し、**オーナーが PASS を確認**した。

これにより **CLI 面・プラグイン面・デプロイ済み MCP（v3.27.0 での拒否＝before）** の
3 面で B76 Phase B の挙動を実データで確認したことになる。
