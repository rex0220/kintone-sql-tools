# B39 IMPORT v2 評価 — JSON ソース＋サブテーブル

- 作成日: 2026-07-19
- ステータス: **評価 R1**（v1＝フラット CSV は [IMPORT 文 R4](ksql_import_statement_spec.md) で実装着手可）。本書は v2 の可否と方向。
- 分担: Claude=評価/仕様・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 前提: [IMPORT 文 仕様 R4](ksql_import_statement_spec.md)（§13＝共通 `materializeDmlSource → MaterializedTable`・フラット CSV）

## 1. 問い

1. **JSON 形式を IMPORT 可能にできるか。**
2. **サブテーブル IMPORT（v2）の仕様。**

この 2 つは独立ではない。**JSON のネスト配列はサブテーブルを自然に表現**でき（CSV の `*` マーカーより素直）、v2 の第一候補ソースになる。

## 2. JSON の適合性（可能・v1 より素直な面もある）

- **形式**: レコード配列 `[{...}, {...}]`。各オブジェクトのキー = フィールドコード、値 = トップレベル値。**サブテーブルはネスト配列** `"明細": [{"品名":"X","数量":"3"}, …]`。
  ```json
  [
    { "顧客コード": "A001", "金額": "1000",
      "明細": [ {"品名":"りんご","数量":"3"}, {"品名":"みかん","数量":"5"} ] }
  ]
  ```
- **対応はキー名（位置でなく）**: `IMPORT INTO app (fields) FROM JSON <source>` は JSON キー → フィールドコードを**名前で対応**。CSV の位置対応・`COLUMNS`・`NO HEADER` は不要。
- **実装容易性**: `JSON.parse`（ネイティブ・外部ライブラリ不要）で構造を得る。RFC4180 の引用符・セル内改行・エンコーディング差・`*` グルーピングといった CSV 固有の難所が無い。**フラット JSON（サブテーブル無し）は v1 の上に小さく載る**（源 union に `{kind:"JSON"}` 追加＋名前対応で `MaterializedTable{columns,rows}` を作る）。
- **型**: JSON の string/number をどう扱うか。kintone は最終的に文字列 value。**v2 でも「値は文字列に正規化し書込み先フィールド型に委ねる」方針を維持**（数値/日付の明示は不要か、CSV 同様 `CAST`/射影を許すかは §6 で確定）。JSON の `null`/真偽/ネスト object（サブテーブル以外）の扱いも要定義。

## 3. サブテーブル v2 の可否（可能・IMPORT が payload を直接構築）

- **kintone 側**: REST の record POST/PUT は**サブテーブル配列を受ける**。payload 構造は `record[subtableCode] = { value: [ { value: { childCode: {value} } }, … ] }`。既存 `buildSubtablePutParams`（[execute.ts:5343](../../src/execute.ts#L5343)）が使う形と同じ。
- **kSQL 側の現状**: 親 INSERT/UPSERT は `record[field]={value}`（[execute.ts:4764](../../src/execute.ts#L4764)）を組み POST するが、**サブテーブル子フィールドを top-level 検証で拒否**する（`loadWritableTopLevelDmlFields`／`assertValidDmlRecords`）。サブテーブル DML（`APP$明細`）は**既存親の `_pid` 前提**で新規作成不可。
- **結論（codex P2-1 と一致）**: 「親 DML の一般的なサブテーブル書込み機能」が**技術的に必須ではない**。**IMPORT 自身が**①サブテーブル配列を含む `KintoneRecord` を組み立て②**サブテーブル対応の書込み検証**（子フィールドの実在・型・必須・選択肢を子スコープで検査）③POST、を行えば、親＋サブテーブルを 1 文で作成/更新できる。ブロッカーは kSQL の top-level 検証だけで、**IMPORT が構築した payload には専用の subtable-aware 検証を通す**ことで解ける。
- **更新（UPSERT）時の注意**（cli-kintone と同じ意味論）: 既存レコードのサブテーブルを PUT すると**CSV/JSON に無い行は削除**される（kintone の全置換）。行 ID を持たない行は新規、持つ行は更新。→ v2 で「サブテーブルは全置換」を明記（部分更新は行 ID 必須）。

## 4. 源契約の変更（v1 → v2 の本質的差）

- **v1（フラット）**: 源は `MaterializedTable {columns: string[], rows: ProcessRow[]}`（[execute.ts:244](../../src/execute.ts#L244)）＝行×列の平坦表。サブテーブルを表現できない。
- **v2（サブテーブル）**: 源は**レコード配列（各レコードが top-level 値＋サブテーブル行配列）**。`MaterializedTable`（平坦）では不足 → **`MaterializedRecord[] { top: Record<field, value>, subtables: Record<subtableCode, Row[]> }`** 相当の新しい源契約が要る。R4 の共通 `materializeDmlSource → MaterializedTable` を、**サブテーブル対応の入口**へ拡張（またはサブテーブル用の別入口）する。
- **CHECK/位置対応との関係**: v1 の CHECK・位置対応（`columns[i]→fields[i]`）は平坦前提。v2 は名前対応（JSON キー／CSV `*` 列）で、CHECK はトップレベル行に対して評価（サブテーブル行への CHECK は v3 以降）。

## 5. 構文案（v2）

```text
-- JSON（サブテーブルはネスト配列）
IMPORT INTO <app> ( <field1>, ..., <subtable> ( <child1>, <child2> ) )
FROM JSON <source>
[ ON DUPLICATE ( <key> ) ] [ CHECK … ] [ VALIDATE ONLY | ON ERROR SKIP INTO #err ];

-- CSV サブテーブル（cli-kintone の * 形式・任意）
IMPORT INTO <app> ( ... ) FROM CSV <source> SUBTABLE MARKER '*' ...;
```
- **`INTO` にサブテーブルを宣言**: `<subtable> ( <child…> )` でサブテーブル列を明示（またはフォーム定義から自動）。
- **JSON が第一候補**（ネストが自然）。**CSV `*` 形式は cli-kintone 互換のため任意で追加**（識別列・複数テーブル・開始行のみ親・空行無視といった cli-kintone 仕様差を取り込む＝R4 §10.4 で確認済みの複雑さ）。

## 6. 確定すべき論点（R2 候補）

- **源契約**: `MaterializedTable`（平坦）を v2 の record-with-subtables へどう拡張するか（別入口か・union か）。共通入口の再々編になるため R4 の 3 経路統合と整合を取る。
- **subtable-aware 書込み検証**: 子フィールドの実在/型/必須/選択肢/B29 を子スコープで検査（既存 `validateAndNormalizeDmlValue` を子フィールド情報で再利用）。top-level 拒否を IMPORT payload には適用しない切り分け。
- **UPSERT×サブテーブル**: 全置換の意味論・行 ID 有無・複合キー。
- **JSON の型/null/ネスト**: 文字列正規化・`null`＝空・サブテーブル以外の object を拒否。
- **CHECK**: v2 はトップレベル行のみ（サブテーブル行 CHECK は後続）。
- **面/loader**: JSON も同じ loader capability（bytes→`JSON.parse`）。エンコーディングは UTF-8 既定。
- **上限**: 10 MiB（R4）＋サブテーブル総行数上限。

## 7. 段階案・工数感

- **v2a: JSON フラット（サブテーブル無し）** — 源 union に `{kind:"JSON"}`・名前対応で `MaterializedTable` 生成。**小**（CSV パーサ不要・`JSON.parse`）。R4 の共通入口にほぼそのまま乗る。
- **v2b: サブテーブル（JSON ネスト＋任意で CSV `*`）** — 源契約を record-with-subtables へ拡張・subtable-aware 検証・POST payload 組立・UPSERT 全置換。**中**（源契約の再設計が本体）。
- 目安: v2a ＝ 3〜5 人日／v2b ＝ 8〜13 人日（源契約再設計・検証・全置換・受入）。いずれも SemVer minor（純加法）。

## 8. 提言

1. **JSON IMPORT は可能・推奨**。フラット JSON（v2a）は v1 の上に小さく載り、`JSON.parse` で CSV より実装が軽い面もある。
2. **サブテーブル IMPORT も可能**（親 DML の一般機能は不要・IMPORT が payload 構築＋subtable-aware 検証）。**JSON のネスト配列が第一候補**、CSV `*` 形式は cli-kintone 互換で任意。
3. **v2 の本体は「源契約を平坦 `MaterializedTable` から record-with-subtables へ拡張」**。R4 の 3 経路統合と整合する再設計が最大の論点。
4. 段階＝**v2a（JSON フラット）→ v2b（サブテーブル）**。実需（サブテーブル取込・JSON 連携）に応じて着手。
5. 次段＝本評価を codex レビューで裏取り → v2 仕様（R1）。実装は v1（フラット CSV）着手後が自然。
