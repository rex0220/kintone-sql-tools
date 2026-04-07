# レコード取得 並列化仕様（案）

## 1. 目的
- レコード取得の待ち時間を短縮する（特に `fetchAll` 経由の大量取得）。
- 並列化後も結果順序とソート結果の再現性を維持する。

## 2. 適用範囲
- `fetchAll` を利用する全取得処理。
  - `SELECT`
  - `UPDATE` / `DELETE` の対象取得
  - `FULL_SCAN` 用テーブル取得
- kintone API 制約（1 リクエスト最大 500 件）は維持する。

## 3. 取得方式
- 先頭ページを取得後、残ページを `offset` 単位で並列取得する。
- 並列度は `parallel` オプションで指定する。
  - 既定値: `1`（互換維持）
  - 推奨運用値: `3`〜`5`
- `maxRecords` を厳守する。
- 取得ページは `offset` 順に再結合し、順序を安定化する。

## 4. ソート仕様（重要）
- 並列化時は `ORDER BY` を JavaScript 側で実行する。
- 適用順序:
  1. `WHERE` / `HAVING`
  2. `ORDER BY`（JS）
  3. `LIMIT` / `OFFSET`
- 同値時の順序は安定化する（元順維持、または `$id` を最終タイブレークに利用）。

## 5. 選択肢項目のソート仕様
- 対象:
  - `DROP_DOWN`
  - `RADIO_BUTTON`
  - `CHECK_BOX`
  - `MULTI_SELECT`
- 比較キーはフォーム定義の `options[].index` を利用する。
- ルール:
  - `DROP_DOWN` / `RADIO_BUTTON`: 単一値の `index` で比較
  - `CHECK_BOX` / `MULTI_SELECT`: `min(index)` を主キーに比較（同値時は文字列比較）
  - 未定義値は末尾扱い（十分大きい `index` とみなす）

## 6. 計算項目（CALC）のソート仕様
- 計算項目はフィールド設定に応じて比較方式を切り替える。
- ルール:
  - `CALC.format = NUMBER` または `NUMBER_DIGIT`: 数値比較
  - 上記以外の `CALC`: 文字列比較
- 補足:
  - `NUMBER` / `RECORD_NUMBER` も数値比較として扱う。
  - sort 種別はフィールドメタデータから取得し、`ORDER BY` の `FIELD_NAME` 比較に適用する。

## 7. メタデータ取得とキャッシュ
- 各アプリのフィールド定義から選択肢順情報を取得する。
- 形式:
  - `fieldCode -> optionOrderMap`
  - `fieldCode -> sortKind(number|string)`
- JOIN など複数アプリ参照時はアプリ単位でキャッシュする。

## 8. エラー処理・制御
- 429 / 5xx は指数バックオフでリトライする。
- 途中失敗時は処理全体を失敗として返却する（部分成功は返さない）。
- `onLimit=truncate` は既存仕様を維持し、警告を返却する。

## 9. 互換性
- `parallel=1` で現行同等動作とする。
- SQL 構文・ユーザー操作は変更しない。

## 10. 実装フェーズ
1. `fetchAll` 並列化（ページ再結合順保証を含む）
2. JS ソート統一（`SIMPLE` / `FULL_SCAN` 共通化）
3. 選択肢順ソート対応とテスト追加
