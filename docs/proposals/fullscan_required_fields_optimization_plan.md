# FULL_SCAN時の必要フィールド取得最適化 実装案

## 背景
現状の `FULL_SCAN` では `fetchAll(..., fields: [])` を使用しており、常に全フィールド取得になる。
JOIN / GROUP BY / HAVING / DISTINCT / ORDER BY を含むクエリでは全件取得が必要なケースが多いが、全フィールド取得は不要な通信量・メモリ使用・JS処理コストを増やす。

対象例:

```sql
SELECT a.顧客ランク AS 顧客ランク, FORMAT(SUM(b.合計費用),'#,##0') AS 合計
FROM APP89 AS a
INNER JOIN APP88 AS b ON a.顧客名 = b.顧客名
GROUP BY a.顧客ランク
```

この場合の必要フィールドは以下で十分。
- APP89(a): `顧客名`, `顧客ランク`
- APP88(b): `顧客名`, `合計費用`

## 目的
- FULL_SCAN時の取得フィールドを「クエリ実行に必要な最小集合」にする
- 結果互換性（既存SQLの実行結果）を維持する
- EXPLAIN表示を実取得フィールドと整合させる

## 非目的
- FULL_SCAN自体をSIMPLE化する最適化（JOIN/GROUP BYの実行方式変更）
- 相関サブクエリ対応の追加（現行仕様外）

## 期待効果
- レコード1件あたりのペイロード削減
- JSONパース、flatten、JOIN時のオブジェクト結合コスト削減
- メモリ使用量削減

注: 取得件数は変わらないため、APIページ数（呼び出し回数）は基本不変。

## 現状実装のボトルネック
- `src/execute.ts` の `fetchTableRecordsForFullScan()` で `fields: []` 固定
- `src/converter/selectToKintone.ts` の `selectToFetchAllParams()` が `fields: []` を返す
- `EXPLAIN` の FULL_SCAN表示が常に `(全フィールド)`

## 提案アーキテクチャ

### 1) テーブル別の必要フィールド収集器を追加
新規ヘルパー（例: `collectRequiredFieldsForFullScan(stmt)`）で、`alias -> RequiredFieldSet` を返す。

収集対象:
- SELECT列（FIELD/AGGREGATE/ARITH/STRFUNC/CASE）
- JOIN ON 左右キー
- WHERE
- GROUP BY
- HAVING
- ORDER BY
- DISTINCT評価で必要な列

ルール:
- `tableAlias` 付き参照はそのテーブルへ加算
- 非修飾参照は「主テーブル」へ加算（現行解決規則と整合）
- 重複は Set で排除

### 2) ワイルドカード時の安全フォールバック
以下を含む場合は最小化を無効化（当該テーブルは全取得）:
- `SELECT *`
- `SELECT a.*`（将来対応時）
- `SELECT _p.*`（サブテーブル親ショートカット全取得）

### 3) サブテーブル仮想テーブルの必須列を強制追加
`APPxx$subtable` を展開する場合、親取得時に最低限以下を含める。
- `$id`（`_pid` 生成に必須）
- `subtableCode` 本体（行展開に必須）
- `_p.xxx` 参照に必要な親列（`xxx`）

補足:
- `fetchAll()` は fields指定時に `$id` を自動追加するが、要件明示のため設計上も必須扱いにする。

### 4) サブクエリ / WITH への適用単位
- サブクエリは「独立SELECT」として個別に収集
- WITHは各SELECT単位で収集
- CTEインライン化後はインライン後SELECTに対して通常収集

## 実装ステップ

1. 収集ロジック追加
- 追加先候補: `src/converter/selectToKintone.ts` または `src/engine/` 新規ファイル
- AST走査ユーティリティを実装（WhereExpr, ArithNode, StringFuncExpr, AggOperand, CaseWhen）

2. FULL_SCAN取得呼び出しの差し替え
- `fetchTableRecordsForFullScan()` に `fields` 引数を渡す
- `main/join/subtable` それぞれテーブル別フィールドを適用

3. EXPLAIN更新
- FULL_SCAN時の `fields:` を `(全フィールド)` 固定から、実際の収集結果表示へ変更
- JOIN先も同様に表示

4. テスト追加
- 既存互換（結果一致）
- フィールド収集の単体ケース
- EXPLAIN出力の期待値更新

## 影響範囲
- `src/execute.ts`
- `src/converter/selectToKintone.ts`（または新規収集モジュール）
- `src/__tests__/execute.test.ts`
- `src/__tests__/explain.test.ts`
- 必要なら `docs/proposals/explain_spec.md`

## 互換性リスクと対策

### リスク1: 参照列取り漏れで結果不整合
対策:
- 走査対象を `SELECT/JOIN/WHERE/GROUP BY/HAVING/ORDER BY/DISTINCT` 全網羅
- ワイルドカード時は全取得フォールバック

### リスク2: サブテーブル展開壊れ
対策:
- `$id` + `subtableCode` を必須化
- `_p.xxx` の親列加算をテストで固定

### リスク3: EXPLAIN表示と実挙動の乖離
対策:
- 実行時と同じ収集関数をEXPLAINでも再利用

## テスト観点

1. JOIN + GROUP BY + 集計
- 取得fieldsが最小集合になる
- 実行結果が変更前と一致

2. WHERE/HAVING/ORDER BY参照列
- 対象列がfieldsに含まれる

3. サブテーブル
- `$id` / subtableCode 取得が保証される
- `_p.xxx` 参照が壊れない
- `_p.*` で全取得フォールバック

4. サブクエリ
- 外側と内側で独立して必要列収集

5. WITH
- CTE本体・mainの各SELECTで必要列収集

## 段階リリース案
- Phase 1: 通常テーブル（JOIN/GROUP BY/HAVING/ORDER BY）
- Phase 2: サブテーブル専用要件（`$id` / `_p` / `subtableCode`）
- Phase 3: EXPLAIN整合 + ドキュメント更新

## 成功条件
- FULL_SCAN時の `fields` が全取得固定でなくなる
- 代表クエリで結果互換を維持
- EXPLAINに実取得fieldsが表示される
- 既存テスト + 追加テストがすべて通過
