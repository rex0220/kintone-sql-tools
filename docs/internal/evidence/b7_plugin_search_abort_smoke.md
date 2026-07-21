# B7-P3 実機証跡 — プラグイン検索打ち切り検出

- 実施日: 2026-07-21
- 対象: B7（プラグインの検索打ち切り検出・raw fetch＋urlForGet＋4KB POST override）
- ビルド: v3.10.0（`dist/ksql-plugin-v3.10.0.zip`・commit `62574d3`・B7-P1＋B7-P2 反映）
- 環境: 通常 space・実ブラウザ・本番 kintone
- 対象アプリ: **APP730（郵便番号・住所データ・618,525 レコード）**
- 判定: **PASS**（B47 の KLIKE 全 surface 解禁を有効化してよい）

## 事前確認（MCP/Node）

`都道府県K KLIKE 'ケン'` が 10 万件打ち切りを起こすことを MCP（Node クライアント・打ち切り検出済み）で確認。warnings に「検索が 10 万件で打ち切られ、結果が欠落した可能性があります。」が出た。`都道府県K` はカタカナ都道府県で「ケン（県）」を含むものが大多数のため 10 万件を超える。900 件の `レコード番号 IN (...)` も kintone が受理（900 行返却・警告なし）することを確認。

## 実機結果（プラグイン）

### ① 打ち切り検出（GET 経路・最重要）

```sql
SELECT レコード番号 FROM APP730 WHERE 都道府県K KLIKE 'ケン'
```

- 表示: **「検索が 10 万件で打ち切られ、結果が欠落した可能性があります。」**＋「表示件数が多いため、先頭 3000 件のみ表示しています。」・3000 件。
- 判定: **PASS**。旧プラグイン（`kintone.api()`）では読めなかった `X-Cybozu-Warning` を、raw fetch 化した `getRecords` が読み取り、実行エンジンの警告として表示できた。**B7 の本質（プラグインでの打ち切り検出）が実ブラウザ・本番 kintone で成立**。

### ② 対照（打ち切りが出ないこと）

```sql
SELECT レコード番号 FROM APP730 WHERE 都道府県 = '東京都'
```

- 表示: 「表示件数が多いため、先頭 3000 件のみ表示しています。」のみ。**打ち切り警告なし**。
- 判定: **PASS**。`=`（非 like）では打ち切り警告が出ない＝誤検出なし。

### ③ 大規模取得が壊れないこと（POST override・URL >4KB）

```sql
SELECT レコード番号 FROM APP730 WHERE レコード番号 IN (1..500)
```

- 表示: 500 件返却。**414 エラーなし**。
- 判定: **PASS**。生成 URL が 4KB を超えたため POST override（`X-HTTP-Method-Override: GET`＋JSON body）に自動切替され、大規模取得が壊れないことを確認。urlForGet 委譲＋POST override 設計が実機で機能。

## 残る未検証（記録・リリースノート反映対象）

1. **POST override 経路での打ち切り同時検出**: ①（GET＋打ち切り）と③（POST override＋非打ち切り）を個別に PASS したが、「>4KB クエリ *かつ* 10 万件 like 打ち切り」の同時条件は直接組めず未実施。ヘッダー読取りコードは GET/POST 経路共通のため実務リスクは小。**B47-P4（KLIKE DML 解禁後）で KLIKE の >4KB prefilter を当てて補完**する。
2. **guest space**: 未実施（対象 guest アプリなし）。リリースノートに「guest space 未検証」と明記。

## 結論

- B7-P3 の受入ゲート（プラグインでの打ち切り検出＝ヘッダー露出）を **通常 space・実ブラウザ・本番 kintone で PASS**。
- したがって **B47 は KLIKE / NOT KLIKE を全 surface（CLI/MCP/plugin）で解禁**する（面ゲートなし）。上記残 2 点はリリースノートに明記。
