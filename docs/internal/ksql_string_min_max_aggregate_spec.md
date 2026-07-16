# 課題+仕様案: `MIN` / `MAX` の文字列対応（テキスト列で NaN になる問題）

- 作成日: 2026-07-16
- 発見経緯: B12-B `ON ERROR SKIP` の実機確認（APP4221・2026-07-16）。看板レシピ（[ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md) §6）の `SELECT 顧客コード, MIN($err_message) … GROUP BY 顧客コード` が **`NaN` を返し**、業務キー単位のエラーメッセージ集約（B11.1 書き戻しの前段）が機能しないことが判明。
- ステータス: **課題+仕様案 R2（codex レビュー反映済み・実装着手可）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 課題

`MIN` / `MAX` は**数値集約専用**で、テキスト列に対しては値を `Number()` で数値化するため、非数値文字列は `NaN` になる。

```sql
-- 実測（APP4221・#err の $err_message 集約）
SELECT k, MIN(msg) AS m, MAX(msg) AS mx FROM #t GROUP BY k;
-- → m="NaN", mx="NaN"（msg が 'ERR_TYPE_NUMBER' 等のテキスト）
```

SQL 標準では `MIN`/`MAX` は文字列にも適用でき（辞書順）、多くの RDB でテキスト列の最小/最大を返す。kSQL はこれを数値限定にしているため、以下が壊れる:

- **B12 書き戻しレシピ**（§6）: 1 ソース行に複数エラーがあると `#err` は複数行になり、業務キー単位に 1 行へ畳む必要がある。`MIN($err_message)` はその定石だが `NaN` 化する。現状の回避策は「`SELECT DISTINCT 業務キー, '検証エラー' AS flag`（定数フラグ）」で 1 行化するのみ＝**具体的なエラーメッセージを書き戻せない**。
- **日時列の最古/最新**: 言語リファレンスの一時テーブル例 `MAX(受注日) AS 最新受注日`（DATE 列）も同じく `NaN` 化する（`Number("2026-07-16")=NaN`）。すなわちこのバグは B12 固有ではなく、**日時・テキストの `MIN`/`MAX` 全般**に及ぶ（文書化済みレシピが1件壊れている）。
- テキスト列の代表値抽出全般（コード・名称の辞書順 min/max 等）。

## 2. 現状（コード裏取り済み）

`evalAggregate`（[process.ts:274](../../src/engine/process.ts#L274)）は**返り値型が `number`**で、収集した文字列値を一律 `Number()` する:

```ts
function evalAggregate(func, distinct, arg, rows): number {
  ...
  const nums = eff.map(Number);          // ← テキストは NaN（process.ts:308）
  switch (func) {
    case "MAX": return nums.length === 0 ? 0 : maxOf(nums);  // 数値比較のみ
    case "MIN": return nums.length === 0 ? 0 : minOf(nums);
  }
}
```

### 2.1 集約結果の消費経路は3系統（R2 で訂正）

R1 の「呼び出し元3箇所はすべて `String()` 化済み」は**誤り**。返り値型を `number|string` へ広げる際、以下の3系統すべてを見る必要がある:

1. **直接集約列** — `applyGroupBy` → project（[process.ts:241/829](../../src/engine/process.ts#L241)）。`String(...)` 化して出力するため文字列返却でも透過。
2. **集約算術式** — `evalAggArithExpr`（[process.ts:331](../../src/engine/process.ts#L331)）。`AGG_REF` を `return evalAggregate(...)` で**そのまま数値として要求**。テキスト集約が文字列を返すと型不整合。
3. **文字列関数内の集約** — `resolveAggInStringFuncArg`（[process.ts:825](../../src/engine/process.ts#L825)）。`AGG_REF`/`AGG_ARITH` を `{ type:"NUMBER", value: evalAggregate(...) }` と**強制的に NUMBER AST ノードへ格納**。`UPPER(MIN(name))` 等で文字列が来ると NUMBER ノードの `value` が文字列になり不整合。

### 2.2 型メタは「そのままでは」流用不可（R2 で訂正）

- `FieldTypeResolver`（[evalWhere.ts:61](../../src/engine/evalWhere.ts#L61)）の返却は `string | undefined`（フィールド型文字列のみ）。
- `getFieldTypeMap`（[execute.ts:2288](../../src/execute.ts#L2288)）は `code → fieldType` のみを構築し **`KintoneFieldInfo.sortKind` を捨てる**。
- 現状の型ロード `loadTypedInFieldTypes`（[execute.ts:1471](../../src/execute.ts#L1471)）は **WHERE/HAVING/CASE の IN 対象フィールドだけ**を `collectSelectTypedInFieldRefs`（[:1450](../../src/execute.ts#L1450)）で集め、対象がなければ空 Map を返す。`applyGroupBy`（[process.ts:915](../../src/engine/process.ts#L915)）に resolver は渡していない。
- したがって `SELECT MIN(name) FROM APP100` は、resolver 引数を足すだけでは**型不明のまま**＝従来の NaN。

### 2.3 再利用できる既存基盤

- `detectSortKind`（[formFieldInfo.ts:92](../../src/core/formFieldInfo.ts#L92)）が **CALC の number/string を format から確定済み**（`NUMBER`/`NUMBER_DIGIT`→number・他→string）。`KintoneFieldInfo.sortKind` に保持。
- `FieldSortKindMap = Map<string, "number"|"string">`（[process.ts:461](../../src/engine/process.ts#L461)）と `buildSortKindsForSelect`/`buildSortKindMapByApp`（[execute.ts:2402/2332](../../src/execute.ts#L2402)）が ORDER BY 用に存在（`getFieldsCached` でキャッシュ共有）。ただし **ORDER BY 対象フィールドしか集めず**、`detectSortKind` はテキスト/日時に `undefined` を返す（＝ここでは「テキスト」と「不明」を区別できない）。集約用にはそのままでは不足＝**専用の収集器と分類器が必要**。

## 3. 意味論の選択肢

| 案 | 比較規則 | 評価 |
|---|---|---|
| A: **型メタで分岐**（推奨） | 数値型=数値比較（従来）／テキスト・日時=辞書順文字列比較／型不明=従来数値 | 正確。回帰ゼロ。専用リゾルバ配線が要る（§5） |
| B: 値ベースヒューリスティック | 全値が有限数なら数値・そうでなければ辞書順 | ❌ 郵便番号 `"0100"`・`"10"vs"9"` で不安定 |
| C: 常に辞書順へ統一 | すべて文字列辞書順 | ❌ 既存の数値 MIN/MAX が回帰（`"10"<"9"`） |

**推奨は案A**（codex 承認）。判定根拠を「値の見た目」でなく「フィールド型」に置くのは選択系 IN（v2.5.0〜）と同じ設計方針。

## 4. 仕様（案A）

### 4.1 集約用ソート種別リゾルバ（WHERE 用 `FieldTypeResolver` とは分離）

`FieldTypeResolver`（fieldType 文字列のみ）では CALC の number/string を表現できないため、集約専用の型を導入する:

```ts
type AggregateSortKindResolver = (field: FieldRef) => "number" | "string" | undefined;
```

`KintoneFieldInfo`（`fieldType` + 既存 `sortKind`）から次で判定する:

- `sortKind === "number"` → **数値**（NUMBER / RECORD_NUMBER / CALC(number format) を既にカバー）
- `sortKind === "string"` → **文字列**（CALC(string format) をカバー）
- `sortKind === undefined` のとき `fieldType` で補完:
  - **文字列**: `SINGLE_LINE_TEXT` / `MULTI_LINE_TEXT` / `RICH_TEXT` / `LINK` / `DROP_DOWN` / `RADIO_BUTTON` / `STATUS`
  - **文字列（日時）**: `DATE` / `TIME` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME`
  - それ以外（`CHECK_BOX` / `MULTI_SELECT` / `USER_SELECT` / 組織 / グループ / `STATUS_ASSIGNEE` / `CREATOR` / `MODIFIER` / `FILE` / 不明）→ **`undefined`**

`undefined` は**従来の数値経路**（後方互換）へフォールバックする。既存 `detectSortKind` を壊さないため、集約用は別関数 `detectAggregateSortKind`（もしくは上記合成ロジック）とし、ORDER BY 用 `FieldSortKindMap` の意味論は変更しない。

### 4.2 比較規則（`MIN`/`MAX` のみ。`SUM`/`AVG`/`COUNT` は不変）

`arg` が**直接フィールド参照**で、リゾルバが種別を確定できたとき:

- **数値**（`"number"`）: 従来どおり `Number()` 化して数値 min/max。返り値は数値。
- **文字列**（`"string"`・テキストおよび日時）: **辞書順文字列比較**（JS の `<`／UTF-16 code unit 順）。返り値はその文字列。
- **`undefined`（型不明 / 非フィールド参照＝算術式・文字列関数・スカラーサブクエリ / CTE・temp 経由）**: **従来どおり数値**（後方互換）。

> **日時の辞書順について（R2 で厳密化）**: 「任意の ISO 文字列は辞書順＝時系列順」ではない（タイムゾーンオフセットが異なると逆転し得る）。本仕様が辞書順＝時系列順を保証するのは **kintone から取得した正規化済み DATETIME 文字列**（UTC・`...Z` 固定）に限る。DATE/TIME も kintone 正規化形式（`YYYY-MM-DD`・`HH:mm`）前提。

### 4.3 空値・DISTINCT・NULL

- 空値スキップは現行維持（`FIELD_REF` の空文字は収集前に除外＝[process.ts:292](../../src/engine/process.ts#L292)）。全行が空なら現行同様「該当なし」。数値の空グループは従来 `0`、文字列の空グループは **`""`（空文字）** を返す。
- `DISTINCT` は文字列レベル重複除去（現行 [:304](../../src/engine/process.ts#L304)）で、テキストでも自然に効く。

### 4.4 対象外（本仕様では非対応）

- **複数値/オブジェクト型**（`CHECK_BOX` / `MULTI_SELECT` / `USER_SELECT` / 組織 / グループ / 作業者 / `CREATOR` / `MODIFIER` / 添付ファイル）: JSON 文字列/表示名の辞書順 min/max は意味を持たないため対象外＝**従来どおり数値（実質 NaN）**。将来必要なら別課題。
- `SUM` / `AVG`（数値専用のまま）・`COUNT`（不変）。
- **厳密10進**の数値 min/max（案B・保留。本仕様は IEEE-754 の従来挙動を維持）。

## 5. 実装差分

### 5.1 型メタの収集とロード（P1-1 対応・専用経路）

`loadTypedInFieldTypes` をそのまま流用**しない**。集約専用の収集器＋ローダーを新設する:

- **収集器**: SELECT の集約式（直接 `AGG_REF`・集約算術 `AGG_ARITH`・文字列関数内集約 `resolveAggInStringFuncArg` 経路）を再帰し、`func ∈ {MIN, MAX}` かつ `arg` が**直接 `FIELD_REF`** のものだけ `FieldRef` を収集する。
- **ロード対象アプリ**: 修飾参照は該当 APP、JOIN の非修飾参照は一意性判定のため**全物理 APP** のメタを取得（`collectSelectTypedInFieldRefs`/`loadTypedInFieldTypes` の `physicalSelectTables` と同型）。**CTE/temp 参照は取得対象外＝型不明**。
- **キャッシュ共有**: `getFieldsCached`（既存フィールド定義キャッシュ）を共有。MIN/MAX 候補を持つアプリだけ取得し、候補ゼロなら空リゾルバ（従来数値）。
- **リゾルバ生成**: 取得した `KintoneFieldInfo` から §4.1 の `AggregateSortKindResolver` を構築。JOIN 非修飾で同名衝突は `undefined`（型不明経路）。

> **リスク（初回のみ API 増）**: これまで単純集約 SELECT ではフォーム定義 API を呼んでいなかったため、MIN/MAX 候補があるアプリでは**初回のみ**フォーム定義取得が増える（同一 context 再実行はキャッシュヒットで増えない）。計測テストで固定する（§6）。

### 5.2 評価3経路への配線（M1-1 対応）

| 経路 | 変更 |
|---|---|
| `evalAggregate`（274） | 返り値型を **`number \| string`** へ拡張。`arg` が `FIELD_REF` かつリゾルバが `"string"` を返せば**辞書順で文字列 min/max**（収集済み文字列値をそのまま比較・数値化しない）。`"number"`/`undefined`/非フィールドは従来の数値経路。引数に `resolveAggSortKind?: AggregateSortKindResolver` を追加 |
| `applyGroupBy` / project（915/829/241） | `resolveAggSortKind` を渡す。直接列は `String(...)` 化で下流透過 |
| `evalAggArithExpr`（331） | `AGG_REF` を **`Number(evalAggregate(...))`** でラップ＝**テキスト集約を算術に混ぜたら仕様どおり `NaN`**（`MIN(text)+1 → NaN`）。リゾルバを再帰全体へ渡す |
| `resolveAggInStringFuncArg`（825） | number 結果 → `{ type:"NUMBER", value }`／string 結果 → `{ type:"STRING", value }`。リゾルバを `resolveAggInStringFuncExpr` の再帰全体へ渡す。これで `UPPER(MIN(text))` / `LENGTH(MAX(text))` が正しく文字列を受ける |

## 6. 受入条件

- [ ] テキスト列 `MIN`/`MAX` が辞書順の最小/最大**文字列**を返す（`MIN('B','A','C')='A'`・`MAX='C'`）。
- [ ] **数値フィールドの `MIN`/`MAX` は従来どおり数値比較**（`"9"` と `"10"` で min=9/max=10）＝回帰ゼロ。
- [ ] 日時（正規化済み DATETIME/DATE）の `MIN`=最古・`MAX`=最新。
- [ ] `CALC`：number format は数値・string format は辞書順（sortKind 経由）。
- [ ] `RICH_TEXT` / `CREATED_TIME` / `UPDATED_TIME` は文字列扱い。`CREATOR`/`MODIFIER` は対象外（従来数値）。
- [ ] **型メタ未取得ではテキスト MIN/MAX にならないことを防ぐ実行統合テスト**（resolver 引数追加だけでは NaN のまま＝収集器・ローダーが要ることの回帰）。
- [ ] フォーム定義 API は**キャッシュミス時1回**、同一 context 再実行では増えない（計測）。
- [ ] JOIN：`MIN(a.name)`（修飾）と、フィールド名が一意な JOIN での `MIN(name)` は文字列。**同名フィールドが競合する JOIN は型不明経路**（従来数値）。
- [ ] 算術・文字列関数混在：`UPPER(MIN(text))`・`LENGTH(MAX(text))` が正しく動作。`MIN(text)+1 → NaN`。
- [ ] temp/CTE 経由は従来どおり NaN（型不明）。
- [ ] 空グループ: 数値=`0`／文字列=`""`。`DISTINCT` 併用でテキスト重複除去が効く。
- [ ] `HAVING` / `ORDER BY` / 後段 SELECT / UNION 左辺列でテキスト集約の alias が文字列として参照できる。
- [ ] `SUM`/`AVG`/`COUNT` に回帰なし。

## 7. B12 書き戻しレシピとの関係

本仕様が入っても、**B12 の `#err` は一時テーブル**で型メタを持たないため、`MIN($err_message) FROM #err` は §4.2 の契約上「型不明＝従来数値＝NaN」のままになる。したがって:

- **短期（本仕様と独立・v2.13.0 で対応済み）**: B12 レシピ（§6・roadmap）を**定数フラグ 1 行化**（`SELECT DISTINCT 業務キー, '検証エラー' AS flag FROM #err`）へ修正し、`MIN($err_message)` を使わない。言語リファレンスに「`MIN`/`MAX` はテキスト非対応（本仕様まで）」を注記済み。
- **本仕様の適用範囲**: まずは**型メタを持つ実アプリ列**のテキスト min/max を対象にする。一時テーブル/CTE 列へ広げるには、実体化時に列型メタを保持する拡張（`MaterializedTable` に型情報を足す）が別途必要＝**フェーズ2**として分離。
- よって B12 の看板レシピを「メッセージ集約」で成立させるには、本仕様（実アプリ列）＋temp 列型メタ（フェーズ2）の両方が要る。当面は定数フラグ回避で十分。

## 8. リスク・SemVer

- **SemVer**: 挙動変更（テキスト・日時列が従来 `NaN` → 文字列）。ただし**現状 `NaN` は実質使い物にならない**ため依存コードは想定されず、実害は小さい。数値フィールドは厳密に従来維持（回帰ゼロ）。→ minor。
- **リスク（返り値型拡張の波及）**: `evalAggregate` の `number → number|string` 化は集約を消費する3系統（直接列・算術・文字列関数）に波及。tsc で洗い出し、算術・数値関数混在時は `Number()` へ強制（NaN 許容）と明記済み（§5.2）。
- **リスク（初回 API 増）**: §5.1 のとおり MIN/MAX 候補があるアプリで初回フォーム定義取得が増える。キャッシュ計測テストで固定。
- **リスク（数値テキストの意図せぬ辞書順化）**: 郵便番号・電話番号など「数値に見えるテキスト」は**テキスト型なので辞書順になる**。これは kintone の型に忠実で正しい（数値フィールドではないため数値順を期待すべきでない）。

## 9. スコープ外・将来

- 一時テーブル/CTE 列のテキスト min/max（`MaterializedTable` への列型メタ付与＝フェーズ2）。
- 複数値/USER/組織/グループ/添付/CREATOR/MODIFIER の集約。
- 厳密10進の数値 min/max（案B・保留）。
- 文字列集約 `GROUP_CONCAT` 相当（別課題）。
