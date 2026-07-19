# B39 IMPORT v2 評価 — JSON ソース＋サブテーブル

- 作成日: 2026-07-19
- ステータス: **評価 R1・codex レビュー済**（方向性=JSON可・サブテーブル可は妥当・要 R1 前確定6点は §9）（v1＝フラット CSV は [IMPORT 文 R4](ksql_import_statement_spec.md) で実装着手可）。本書は v2 の可否と方向。
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
- **実装容易性**: `JSON.parse` で構造を得る。RFC4180 の引用符・セル内改行・`*` グルーピングといった CSV 固有の難所が無い。**フラット JSON（サブテーブル無し）は v1 の上に小さく載る**（源 union に `{kind:"JSON"}` 追加＋名前対応で `MaterializedTable{columns,rows}` を作る）。
  - **ただし「外部ライブラリ不要」は数値契約次第（codex P1-1）**: ネイティブ `JSON.parse` は JSON number を JS `number` にして**元の数値字句を失う**（kSQL は最大30桁の厳密10進を字句保持で検証＝B9・`9007199254740992`≠`…993` の回帰あり）。→ v2a で JSON number を許すなら lossless number parser か「NUMBER 等は JSON string で供給」の契約が要る（丸め後は元値を判定不能なので parse 後検査だけでは不十分）。
- **型**: JSON の string/number をどう扱うか。kintone は最終的に文字列 value。**v2 でも「値は文字列に正規化し書込み先フィールド型に委ねる」方針を維持**（数値/日付の明示は不要か、CSV 同様 `CAST`/射影を許すかは §6 で確定）。JSON の `null`/真偽/ネスト object（サブテーブル以外）の扱いも要定義。

## 3. サブテーブル v2 の可否（可能・IMPORT が payload を直接構築）

- **kintone 側**: REST の record POST/PUT は**サブテーブル配列を受ける**。payload 構造は `record[subtableCode] = { value: [ { value: { childCode: {value} } }, … ] }`。既存 `buildSubtablePutParams`（[execute.ts:5343](../../src/execute.ts#L5343)）が使う形と同じ。
- **kSQL 側の現状**: 親 INSERT/UPSERT は `record[field]={value}`（[execute.ts:4764](../../src/execute.ts#L4764)）を組み POST するが、**サブテーブル子フィールドを top-level 検証で拒否**する（`loadWritableTopLevelDmlFields`／`assertValidDmlRecords`）。サブテーブル DML（`APP$明細`）は**既存親の `_pid` 前提**で新規作成不可。
- **結論（codex P1-3 で訂正）**: 「親 DML の一般的なサブテーブル書込み機能」を先に作る必要は**ない**（IMPORT 専用経路で可）。ただし**「ブロッカーは top-level 検証だけ」は誤り**。kintone API 上のブロッカーは無いが、kSQL 側は**型・source materialization・payload 構築・候補モデル・検証・エラー隔離のすべてが平坦前提**で、IMPORT 専用でも**相応の新しい DML パイプライン**が要る。具体的な平坦前提＝①`KintoneFieldValue.value` は `string | string[] | Array<{code}>` でサブテーブル行配列を表現できない（[dmlToKintone.ts:53](../../src/converter/dmlToKintone.ts#L53)・既存サブテーブル DML も `value: rows as unknown as string` の型ハック [execute.ts:5358](../../src/execute.ts#L5358)）②`assertValidDmlRecords` は平坦 `targetFields` のみ走査（[execute.ts:3991](../../src/execute.ts#L3991)）③候補モデルは平坦 `KintoneRecord`＋エラー位置＝親行+field のみ（[dmlValidationCandidates.ts:11/46](../../src/core/dmlValidationCandidates.ts#L11)）④必須走査は `inSubtable` を除外（[dmlValidationCandidates.ts:54](../../src/core/dmlValidationCandidates.ts#L54)）。→ IMPORT が①サブテーブル配列を含む record を組み立て②**subtable-aware 検証**（`validateAndNormalizeDmlValue` は単一子値の型/必須/範囲/文字数/選択肢の**プリミティブとして再利用可**だが、subtable code 実在/子 code の所属/同名別テーブルのスコープ解決/行ごと必須・既定値/エラー位置=親行+subtable+子行+child は**別実装**）③POST。
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

---

## 9. codex レビュー結果（R1・2026-07-19）

Claude が P1-1/3 を実ファイルで裏取り。**判定＝方向性（JSON 可・サブテーブル可・v2a/v2b 分割・minor）は妥当だが、v2 仕様 R1 に進む前に P1 の訂正が必要**。私の評価は「JSON.parse で軽い」「ブロッカーは top-level だけ」で工数を過小評価していた。

### P1（訂正・要確定）
1. **JSON number の精度**（反映済み §2）: `JSON.parse` は数値字句を失う（B9 の厳密10進契約と衝突）。lossless parser か「NUMBER は JSON string 供給」の契約が要る。
2. **フラット JSON の値型**（要確定）: `normalizeRaw`（[dmlValidation.ts:121](../../src/core/dmlValidation.ts#L121)）は `null`→`""`・boolean→`"true"/"false"`・object→`"[object Object]"`・配列→型次第で String 化。未定義のまま流すと**非サブテーブル object が `"[object Object]"` として書かれる**。R1 前に確定＝root は配列のみ・要素は plain object・許可する top-level JSON 型・宣言外 object は拒否・配列は複数選択系 or サブテーブル専用・boolean/`null`/欠落キーの扱い。
3. **「ブロッカーは top-level 検証だけ」は誤り**（反映済み §3）: 型/materialization/payload/候補/検証/エラー隔離すべてが平坦前提＝IMPORT 専用でも新パイプラインが要る。
4. **subtable-aware 検証は別実装**（反映済み §3）: `validateAndNormalizeDmlValue` は単一子値のプリミティブとして再利用可だが、subtable code 実在・子所属・スコープ解決・行ごと必須/既定・書込不可子拒否・エラー位置（親行/subtable/子行/child）・`ON ERROR SKIP` の粒度（親全体 or 不良子行）・子の数値精度取得は別実装。
5. **UPSERT 全置換の契約不足**（要確定）: 全置換方向は kintone 仕様と一致（未更新行も `{id}` で含める [execute.ts:5225](../../src/execute.ts#L5225)・省略テーブルは維持）だが、**JSON で既存行 ID をどう供給するかが未定義**。R1 で「(a) v2b は常に全置換＝行 ID 受けず全削除+新規採番／(b) 予約キー `_rid` で行 ID 対応（ID あり=更新・なし=追加・入力に無い既存行=削除）」のどちらかを明記。不正・別親の行 ID の扱いも。
6. **源契約は「3経路の拡張」でなく二層化**（要確定）: `MaterializedRecord[]` を導入しても R4 の平坦3経路（位置対応・payload Map・列数）は再利用不可。→ **二層＝`MaterializedTable`（CSV/フラット JSON/SELECT 共通）＋`MaterializedImportRecords`（サブテーブル IMPORT 専用）**。共通化はロード・上限・source cache・UPSERT キー preflight まで、record-with-subtables から先は専用の payload/validation 経路。3経路を巨大 union にすると平坦 DML への回帰リスク。

### P2（改善）
- **JSON 名前対応規則**（P2-1）: `INTO` に無い JSON キー=拒否/無視・`INTO` にあるが JSON に無い=欠落/空・レコードごとキー集合が異なる場合・**JSON object の重複キー（`JSON.parse` は後勝ちで検出不能）**・`INTO` 省略/フォーム自動の可否。安全側=未知キー拒否・欠落は「未指定」で既定値/必須検証へ。
- **CHECK のサブテーブル値参照を構文段階で拒否**（P2-2・CHECK は平坦一意出力列名スコープ [execute.ts:4220/4281](../../src/execute.ts#L4220)）。

### 工数の見直し
v2b は §7 の 8〜13 人日より**上振れ**（P1-3/4/6 の平坦前提の解体＝型拡張・二層 source・subtable-aware 検証・エラー隔離・全置換 UPSERT）。**現実的には v2b＝12〜20 人日**（v2a＝3〜5 は維持）。SemVer minor は妥当。

### 総合判定（codex）
JSON・サブテーブルとも**実現可能で方向性は妥当**。ただし R1 前に「JSON 数値/値型契約・二層 source・subtable-aware 検証の別実装・UPSERT 行 ID 契約」を確定する必要がある。次段＝本評価の訂正を反映した **v2 仕様 R1**（v2a を先行して小さく出し、v2b は上記確定後）。
