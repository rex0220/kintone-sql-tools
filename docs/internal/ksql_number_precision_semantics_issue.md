# 課題: B29 kintone数値精度・丸め設定との整合

- 作成日: 2026-07-17
- ステータス: **課題R2。B9から分離（R2: 優先度を高→中へ降格・2026-07-17）**
- 関連: [B9 厳密10進比較](ksql_exact_decimal_compare_issue.md)

## 1. 問題

kintoneの数値・計算精度はフィールドごとではなく、[アプリ一般設定](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-general-settings/)の `numberPrecision` で決まる。

```text
numberPrecision.digits         全体の桁数（1〜30）
numberPrecision.decimalPlaces  小数部の桁数（0〜10）
numberPrecision.roundingMode   HALF_EVEN / UP / DOWN
```

設定は `GET /k/v1/app/settings.json` で取得でき、運用環境ではレコード閲覧権限または追加権限があればよい。

現状のkSQLはこの設定を数値のTier-0検証や算術結果の量子化へ使っていない。実測では、`VALIDATE ONLY`が15〜17桁をすべてvalidと判定した一方、実INSERTは設定上限超過を `CB_VA01` で拒否した。これは現在のTier-0契約には反しないが、`ON ERROR SKIP`でローカル合格後にバッチ全体がAPIエラーになる。

## 2. B9との境界

- **B9**: 既に存在する有限10進値を丸めず厳密に比較する
- **B29**: 入力・算術結果をアプリの桁数と丸め方式に照らして検証・量子化する

`decimalPlaces`と`roundingMode`は比較順を決める情報ではないためB9へ入れない。

## 3. 設計論点

- app settings取得を既存メタデータキャッシュへ統合するか
- INSERT / UPSERT / UPDATE / INSERT SELECT / UPSERT SELECTで同じ検証を使うか
- `VALIDATE ONLY` / `ON ERROR SKIP`をAPI拒否予測まで強化するか。強化する場合、従来のTier-0範囲拡大として明示する
- 算術式、集計、ROUND系関数、CALC由来値のどの時点で量子化するか
- `+ - * / %`と数値関数をbinary64のままにするか、任意精度10進評価へ移すか。B9は丸め済みJS値を復元できない
- `HALF_EVEN` / `UP` / `DOWN`の正負値・ちょうど中間値の意味
- CLI / MCP / プラグインで同じ設定取得経路を使えるか
- 設定取得失敗時に推測せずfail-closedにする範囲

## 4. 受入条件案

- digits 1/16/30、decimalPlaces 0/10、3 roundingModeの直積から境界ケースを選ぶ
- 正負それぞれで中間値・中間値の直前直後を検査する
- `HALF_EVEN`を`Math.round`で代用しない
- VALIDATE ONLY、ON ERROR SKIP、実INSERT/UPSERT/UPDATEの判定を比較する
- app settingsを取得できない経路で黙って既定精度を仮定しない

## 5. 優先度

**中（R2 で高から降格・2026-07-17）。** 事前検証と実書込みの結果が異なる正しさ・運用上の問題であることは変わらないが、①実書込みは kintone の fail-fast（CB_VA01）が部分成功・データ破壊を防いでおり、**偽合格が起きるのは VALIDATE ONLY / ON ERROR SKIP の事前検証経路に限られる**②既定 `digits`（16）を超える精度運用は B9 降格（d8066fc）と同じ頻度根拠で稀。B9とは別実装・別受入条件とする。**B9 の再昇格トリガー②（B29 実装着手時は同領域のため同時が安価）の関係は不変。**
