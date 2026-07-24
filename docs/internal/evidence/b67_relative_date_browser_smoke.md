# B67 Phase1 — Firefox / Chrome plugin 実ブラウザ smoke

- 状態: **PASS（ユーザー実施・報告 2026-07-24）**。同一 plugin ZIP（v3.20.0）で実ブラウザ smoke を実施し、SIMPLE 押し下げ・KORDER・負例拒否を確認。詳細記入欄は後追記可。あわせて CLI 実機テスト（下記）も PASS。

## CLI 実機テスト結果（dev kintone・APP730@dev・read-only・2026-07-24）

`node dist-cli/ksql.js`（v3.20.0）で実 kintone に対し確認。すべて期待どおり。

| # | クエリ | 結果 |
|---|---|---|
| 1 | `WHERE 更新日時 >= YESTERDAY()` | 押し下げ・`更新日時 >= YESTERDAY()`・rowCount=0（昨日以降更新なし＝サーバ評価が実データと整合） |
| 2 | `WHERE 更新日時 >= FROM_TODAY(-30, DAYS)` | 押し下げ・3行（岐阜県・2026-07-21 更新）＝サーバ相対評価が実データで動作 |
| 3 | `... >= YESTERDAY() AND LENGTH(都道府県) > 1` | 拒否 `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`（非exact→FULL_SCAN） |
| 4 | `WHERE 都道府県 = THIS_MONTH()` | 拒否 `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED`（非日付型） |
| 5 | `WHERE 更新日時 < TODAY()` | 3行・既存3関数 非回帰 |
| 6 | `... FROM_TODAY(-30, DAYS) KORDER BY $id LIMIT 3` | KORDER native 押し下げ・3行 |
| 7 | `WHERE 更新日時 BETWEEN FROM_TODAY(-30, DAYS) AND TODAY()` | `>= AND <=` 展開で押し下げ・3行 |
| 8 | `--dry-run`（拒否ケース） | `plan status: rejected` / `reason: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` / records・cursor・mutation API none |
- 実施者: ユーザー（Firefox / Chrome 実機）
- 自動検証との境界: Node / jsdom / build 成功はこの gate の代替ではない
- 使用物: **同一の plugin ZIP** を Firefox と Chrome の両方へ導入する

## 1. fixture

`APP_ID` は次のフィールドを持つ実アプリ ID に置換する。

| field | kintone type | 用途 |
|---|---|---|
| `日付` | DATE | 正例 |
| `件名` | SINGLE_LINE_TEXT | 非対応型の負例 |

同一 ZIP、同一 app、同一データで次を順に実行する。

| ID | 種別 | SQL | 期待 plan / reason |
|---|---|---|---|
| BR-SIMPLE | SIMPLE records GET | `SELECT 日付 FROM APP_ID WHERE 日付 >= FROM_TODAY(-7, DAYS) LIMIT 1` | `SIMPLE` / `EXACT_PUSHDOWN` |
| BR-KNATIVE | KORDER native | `SELECT 日付 FROM APP_ID WHERE 日付 >= FROM_TODAY(-7, DAYS) KORDER BY $id LIMIT 1` | `KORDER_NATIVE` |
| BR-KCURSOR | KORDER cursor | `SELECT 日付 FROM APP_ID WHERE 日付 >= FROM_TODAY(-7, DAYS) KORDER BY $id LIMIT 501` | `KORDER_CURSOR` |
| BR-FULLSCAN | client再評価が必要な負例 | `SELECT 日付 FROM APP_ID WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1` | `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` |
| BR-TYPE | 非対応型の負例 | `SELECT 件名 FROM APP_ID WHERE 件名 = YESTERDAY()` | `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED` と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` |

正例の完全な送信 query 期待byteは次のとおり。

| ID | expected query byte |
|---|---|
| BR-SIMPLE | `日付 >= FROM_TODAY(-7, DAYS) order by $id asc limit 1` |
| BR-KNATIVE | `日付 >= FROM_TODAY(-7, DAYS) order by $id asc limit 1` |
| BR-KCURSOR | `日付 >= FROM_TODAY(-7, DAYS) order by $id asc` |

各ブラウザのNetwork request payload / URLをそのままevidence表へ貼り、
このbyteおよびFirefox / Chrome間で一致させる。同じbuildのEXPLAIN表示とも照合する。

## 2. 同一 build の準備

1. `package.json` の version を記録する。
2. source map 付きの plugin smoke build を1回だけ生成する。PowerShell 例:

   ```powershell
   $env:KSQL_PLUGIN_ID = "<plugin id>"
   node build.mjs --watch
   ```

3. `dist/ksql-plugin-v<version>.zip` の生成を確認したら watch を停止する。
4. その**同じ ZIP byte**を Firefox / Chrome の両環境へ導入する。再buildした別ZIPを混ぜない。
5. ZIP名、manifest version、`prod/js/desktop.js` 内の version、ブラウザ拡張画面の
   versionを記録する。

`--watch` は inline source map を含む smoke 用 build にするための手順であり、
Node testをブラウザ実機の代替にするものではない。

## 3. client evaluator 0 の計測

両ブラウザで DevTools の Sources / Debugger から inline source map の
`src/engine/evalWhere.ts` を開き、export `evalWhere` の先頭へ停止しない
conditional breakpoint / logpoint を設定する。

```js
window.__b67EvalWhereCalls = (window.__b67EvalWhereCalls || 0) + 1, false
```

各 fixture の直前に Console で次を実行する。

```js
window.__b67EvalWhereCalls = 0
```

実行後の `window.__b67EvalWhereCalls` を記録する。BR-SIMPLE / BR-KNATIVE /
BR-KCURSOR はすべて `0` 必須。BR-FULLSCAN / BR-TYPE も API 前拒否のため `0`
必須。EXPLAIN の `client evaluation: forbidden` 表示だけで 0 回を代用せず、
この breakpoint counter を evidence に残す。

## 4. Network 計測

DevTools の Network で Preserve log を有効にし、fixtureごとにログを消してから実行する。

- BR-SIMPLE: records GET 1経路。送信 query byteを記録。
- BR-KNATIVE: records GET 1経路。plan `KORDER_NATIVE` と query byteを記録。
- BR-KCURSOR: Cursor POST / GET / DELETE。plan `KORDER_CURSOR` と Cursor作成時の
  query byteを記録。
- BR-FULLSCAN / BR-TYPE: records 0、Cursor 0、POST / PUT / DELETE mutation 0。
  confirm UI 0。表示reasonを記録。

各正例では kintone server が返した record / totalCount / error をそのまま記録する。
ローカル時計から「今日」「7日前」等を計算して結果を置換・補正しない。

## 5. evidence 貼付欄

### Firefox

| ID | SQL | full query byte | plan kind / reason | server result / error | evalWhere calls | records | Cursor P/G/D | mutation | version |
|---|---|---|---|---|---:|---:|---|---:|---|
| BR-SIMPLE | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-KNATIVE | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-KCURSOR | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-FULLSCAN | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-TYPE | ユーザー実施待ち |  |  |  |  |  |  |  |  |

### Chrome

| ID | SQL | full query byte | plan kind / reason | server result / error | evalWhere calls | records | Cursor P/G/D | mutation | version |
|---|---|---|---|---|---:|---:|---|---:|---|
| BR-SIMPLE | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-KNATIVE | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-KCURSOR | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-FULLSCAN | ユーザー実施待ち |  |  |  |  |  |  |  |  |
| BR-TYPE | ユーザー実施待ち |  |  |  |  |  |  |  |  |

## 6. 完了条件

- Firefox / Chrome の両表が埋まり、同じ version / ZIP / SQL / query byteである。
- 3正例のclient evaluatorが0で、server結果をローカル日付計算で補正していない。
- 2負例がAPI前に規定reasonで拒否され、records / Cursor / mutation / confirmが0。
- 両ブラウザの実測が揃うまで **browser release gate は未完了** とする。
