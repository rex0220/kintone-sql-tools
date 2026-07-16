# 仕様案: 一時テーブル / CTE 列の型メタ伝播（B14・B13 フェーズ2）

- 作成日: 2026-07-16
- 位置づけ: [B13 文字列・日時 MIN/MAX](ksql_string_min_max_aggregate_spec.md) §7/§9 で**フェーズ2として分離**した積み残し。**B16 `GROUP_CONCAT` の前提**（[機能比較評価](ksql_sql_feature_comparison_evaluation.md) §4）。
- ステータス: **仕様案 R2（codex レビュー反映済み・実装着手可）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 課題

一時テーブル / CTE の列は**型メタを持たない**ため、実アプリ列では効く型ベースの評価が temp 経由だと効かない。

```sql
-- 実アプリ列: v2.14.0 で辞書順 MIN/MAX が効く
SELECT MIN(会社名) FROM APP4148;                       -- → 'サイボウズ物産株式会社'

-- temp 経由: 型不明 → 従来の数値経路 → NaN（実機実測・2026-07-16）
CREATE TEMP TABLE #t AS SELECT 会社名 FROM APP4148;
SELECT MIN(会社名) FROM #t;                            -- → 'NaN'
```

これにより 2 つの機能が成立しない:

1. **B13 フェーズ2**: temp/CTE 列のテキスト・日時 `MIN`/`MAX`（上記）。
2. **B16 `GROUP_CONCAT` の看板ユースケース**: B12 の `#err` は**一時テーブル**なので、`GROUP_CONCAT` を実装しても `GROUP_CONCAT($err_message) FROM #err GROUP BY 顧客コード` は型不明のまま。**B14 なしでは B16 を入れても成果が出ない**（現在の回避策 `SELECT DISTINCT 業務キー, '検証エラー' AS flag` のまま＝具体的なエラーメッセージを書き戻せない）。

同じ欠落は **v2.5.0 の型メタ付き `IN`/`NOT IN` 評価**にもある（言語リファレンス §11 に「一時テーブル/CTE 経由は文字列比較（別課題）」と既に明記）。本仕様はその基盤も用意するが、`IN` への配線は §8 のとおり**別課題**とする。

## 2. 現状（コード裏取り済み）

### 2.1 実体化の構造と生成箇所

`MaterializedTable`（[execute.ts:195](../../src/execute.ts#L195)）は**行と列名のみ**を保持する（列の型情報がない）:

```ts
/** CTE / 一時テーブルの実体化結果。空結果でも出力列を保持する。 */
interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
}
```

生成箇所は**3つ**あり、性質が2種類に分かれる:

| # | 箇所 | 種別 | 列の出どころ |
|---|---|---|---|
| 1 | `CREATE TEMP TABLE … AS SELECT`（[execute.ts:797](../../src/execute.ts#L797)） | **SELECT 由来** | `runFullScan` の `result.columns` |
| 2 | CTE（`WITH`）（[execute.ts:1910](../../src/execute.ts#L1910)） | **SELECT 由来** | 同上 |
| 3 | `#err`（`appendValidationErrors`・[execute.ts:507/523](../../src/execute.ts#L507)） | **合成** | バリデータが構築（下記） |

### 2.2 `#err` は SELECT 由来ではない（設計上の要点）

`#err` の列は SELECT の出力ではなく**バリデータが合成**する（[dmlValidationCandidates.ts:21](../../src/core/dmlValidationCandidates.ts#L21)）:

```
"$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message"
```
＋ 入力ペイロード列（UPSERT/INSERT の対象列）。

したがって **§4.3 の SELECT 型推論では `#err` の型は決まらない**。合成側で**明示宣言**する必要がある（§4.2）。**B16 が必要とするのはまさにこの経路**。

### 2.3 消費側が temp/CTE で降参している箇所

`loadAggregateSortKindResolver`（B13・[execute.ts:1531 付近](../../src/execute.ts#L1531)）は、参照先が CTE/temp なら**型メタを取りに行かず `undefined` を返す**:

```ts
// appId 収集: CTE/temp を含む JOIN の非修飾参照は一意性を型メタで確定できない
if ([stmt.from, ...stmt.joins.map((j) => j.table)].some((t) => t.cteName !== null)) continue;
...
// resolver 本体
if (!table || table.cteName !== null) return undefined;      // 修飾参照
if (stmt.from.cteName !== null) return undefined;            // 非修飾・JOIN なし
```

`cteName !== null` は **CTE と一時テーブルの両方**を指す（`physicalSelectTables` が同じ判定で物理アプリを絞り込む）。ここが B14 の接続点。

## 3. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `MaterializedTable` への列型メタ付与（3 生成箇所すべて）＋ **集約ソート種別リゾルバ（B13）への配線** |
| **対象（B16 の前提）** | `#err` の `$err_*` 列の型を明示宣言し、`GROUP_CONCAT($err_message)`／`MIN($err_message)` が temp でも効くようにする |
| **非対象（別課題）** | 型メタ付き `IN`/`NOT IN` 評価（v2.5.0）への配線＝**挙動変更**のため独立検証が要る（§8） |
| **非対象** | `ORDER BY` の `sortKinds`（既存 `FieldSortKindMap` の意味論は変更しない） |

## 4. 設計

### 4.1 列メタの型と `MaterializedTable` 拡張

```ts
/** 実体化列の型メタ。確定できないものは持たない（= 従来経路）。 */
export interface MaterializedColumnMeta {
  /** 集約・ソートの種別。B13 の AggregateSortKindResolver と同じ意味論 */
  readonly sortKind?: "number" | "string";
  /** kintone の物理フィールドに対応する列のみ（SELECT の素通し列・`#err` の DML 対象列）。将来の typed IN 配線（§8）で使う */
  readonly fieldType?: string;
}

interface MaterializedTable {
  readonly rows: ProcessRow[];
  readonly columns: string[];
  /** 列名 → 型メタ。確定した列だけ載せる（欠落 = 型不明 = 従来経路） */
  readonly columnMeta?: ReadonlyMap<string, MaterializedColumnMeta>;
}
```

- **`columnMeta` は optional**。持たない実体化は従来どおり型不明＝**後方互換**。
- **確定できるものだけ載せる**。不明な列はエントリを作らない（B13 と同じ fail-safe）。
- `fieldType` は**物理フィールドの素通し列のみ**に付ける（計算列には型がない）。本仕様では格納するだけで消費しない（§8 の前提）。

### 4.2 供給源A: 合成テーブル `#err`（明示宣言）

`#err` の列は `columns = [...payloadFields, ...VALIDATION_META_COLUMNS]`（[execute.ts:2668](../../src/execute.ts#L2668)）で構成される。両者を**別々の供給元**から宣言する。

#### メタ列（`VALIDATION_META_COLUMNS`）

| 列 | sortKind | 根拠 |
|---|---|---|
| `$err_statement` | `number` | `String(statementNumber)`（[dmlValidationCandidates.ts:67](../../src/core/dmlValidationCandidates.ts#L67)） |
| `$err_row` | `number` | `String(candidate.rowNumber)` |
| `$err_operation` / `$err_field` / `$err_code` / `$err_message` | `string` | テキスト |

#### ペイロード列（`payloadFields`）— **R2 で訂正**

> **R1 の「元 SELECT の推論結果を引き継ぐ」は誤り。** `#err` は `INSERT`/`UPSERT … VALUES` や `UPDATE` でも生成され、**元 SELECT が存在しない**。`INSERT`/`UPSERT … SELECT` の場合も SELECT 列は**位置対応で DML 対象フィールドへ割り当てられる**ため、SELECT の出力列名と `#err` の列名は一致しない。

**供給元は書き込み先アプリのフィールド定義**とする。`prepareDmlValidation`（[execute.ts:2648-2664](../../src/execute.ts#L2648)）が**既に取得済み**:

```ts
const payloadFields = stmt.type === "UPDATE" ? ["$id", ...stmt.assignments.map((a) => a.field)] : [...stmt.fields];
const fieldInfos = await getFieldsCached(stmt.appId, client, cacheContext);
const infoByCode = new Map(fieldInfos.map((field) => [field.code, field]));
```

- 各ペイロード列の型は `infoByCode.get(列名)` の `KintoneFieldInfo` から §4.3 と同じ分類（B13 の `sortKind` ＋ `fieldType`）で宣言する。
- **`$id`（UPDATE 経路の先頭列）は `RECORD_NUMBER` 相当**＝`sortKind: "number"`・`fieldType: "RECORD_NUMBER"`。`infoByCode` には無いため個別に扱う。
- これで **VALUES / SELECT / UPDATE の全経路**を一様に覆える。**追加 API は不要**（2653 で取得済みのものを使う）。

#### 追記時の一致検査

- 既存 `#err` への append 時は、現行のスキーマ一致検査（[execute.ts:515](../../src/execute.ts#L515)）と同様に `columnMeta` の一致も要求する。
- **一致は Map の参照一致ではなく構造一致**（キー集合と各エントリの `sortKind` / `fieldType` が等しいこと）で判定する。矛盾したら現行と同じく `ArgumentError`。

これにより `GROUP_CONCAT($err_message)`（B16）と `MIN($err_message)`（B13）が `#err` で機能する。

### 4.3 供給源B: SELECT 由来の推論

`CREATE TEMP TABLE … AS SELECT` / CTE の実体化時に、SELECT の**出力列ごと**に型を推論する。**確定できるものだけ**:

| 列種別（`SelectColumn`） | 推論 |
|---|---|
| `FieldColumn`（素通し） | **ソースの型を継承**。物理アプリ → `getFieldsCached` の `KintoneFieldInfo`（`fieldType` ＋ B13 の分類で `sortKind`）。temp/CTE → **その列の `columnMeta` を継承**（＝チェーン・§4.4） |
| `WildcardColumn` / `ParentWildcardColumn` | 展開後の各列に上記を適用（**フォーム定義の取得が要る**・§4.5） |
| `AggregateColumn` | `COUNT`/`SUM`/`AVG` → `number`／`MIN`/`MAX` → **引数の解決結果**（B13 のリゾルバ）／（将来 `GROUP_CONCAT` → `string`） |
| `AggArithColumn` / `ArithColumn` | `number`（評価が `Number()` 化するため確定） |
| `LiteralColumn` | `string`（文字列リテラル） |
| `StringFuncColumn` | **本仕様では推論しない（型不明）**。関数ごとの戻り型表（`LENGTH`→number・`CAST`→引数依存・`COALESCE`→引数依存…）は面が広く、誤ると静かに壊れるため**別課題**（§8） |
| `CaseColumn` | **推論しない**（分岐ごとに型が異なり得る） |
| `ScalarSubqueryColumn` | **推論しない** |

> **原則**: 迷ったら載せない。載せないことは「従来どおり数値経路」を意味し、**現状（NaN）から悪化しない**。逆に誤った型を載せると**静かに誤った集約結果**を生む（NaN より悪い）。

**`WITH` 内の `SHOW APPS` / `DESCRIBE`**（言語リファレンス §13）は SELECT 由来ではなく列が合成されるため、本仕様では**型不明として保存**する（`#err` のような明示宣言は行わない）。

### 4.5 フォーム定義 API の増加（R2 で訂正）

> **R1 の「API 呼び出しは増えない」は誤り。** 現行の `validateSelectFieldCodes`（[execute.ts:1321-1322](../../src/execute.ts#L1321)）は**明示のユーザーフィールドが 1 つも無ければフォーム定義を取得しない**（`userFields.length === 0` で `continue`）。つまり `SELECT *` のアプリでは現在フォーム定義を取っていない。

- ワイルドカード展開列の型推論には**フォーム定義が必要**なので、`SELECT *` を実体化するアプリでは**新たに取得が発生する**。
- 正しい表現は「**アプリごと最大 1 回。`getFieldsCached` を共有するため既取得なら追加なし**」。同一 `cacheContext` 内の再実行でも増えない。
- ワイルドカード推論を落として「増加ゼロ」を守る選択肢もあるが、`CREATE TEMP TABLE #t AS SELECT * FROM APP…` は常用パターンで**型が付かない穴が大きい**ため、**取得を許容する方を採る**。
- **0 行の bare `SELECT *`（実アプリ）は対象外**。B2 の既存制限（列自体を復元できない）に従い、列が無いので型メタも無い。

### 4.4 チェーン・UNION・JOIN

- **チェーン**（`#t2 AS SELECT x FROM #t1`）: `#t1` の `columnMeta` を引き継ぐ。実体化は文の順に行われるため、参照時点で上流の meta は確定済み。
- **JOIN**: 出力列は**その列のソース表**で解決する（修飾 `a.x` はその表、非修飾は一意なときのみ＝B13 の既存規則と同じ。衝突は載せない）。
- **UNION / UNION ALL**: 出力列名は左辺（現行 `leftCols`・[execute.ts:1862](../../src/execute.ts#L1862)）。型は**左右の推論が一致した列のみ**載せる。**不一致・片側不明は載せない**（例: `SELECT 会社名 FROM APP4148 UNION ALL SELECT 金額 FROM APP4221` は string と number の衝突 → 型不明）。

## 5. 消費側の配線

`loadAggregateSortKindResolver`（B13）の temp/CTE 降参箇所（§2.3）を、**`columnMeta` 参照へ差し替える**:

- リゾルバに `tempTables` / `cteCache`（`ReadonlyMap<string, MaterializedTable>`）を渡す（呼び出し元 `executeFullScanSelect` / `executeFullScanWithCte` は既に保持）。
- **修飾参照は `FROM #t AS t` の `t.x` 形**（R2 で訂正）: 参照先の `columnMeta.get(列名)?.sortKind` を返す。無ければ `undefined`（従来）。
  > **`#t.x` は書けない。** `parseTableRef`（[parser.ts:1263-1266](../../src/parser/parser.ts#L1263)）は temp/CTE の alias を「`AS` 指定 → 暗黙 alias → **無ければ null**」とする。物理アプリ（[:1281](../../src/parser/parser.ts#L1281)）だけが `?? name` でテーブル名を既定 alias にするため `APP100.x` は解決するが、`FROM #t` は `alias = null` で `#t.x` は照合できない（リゾルバは `table.alias === ref.tableAlias` で照合）。**この非対称の解消は名前解決の変更であり B14 の対象外**（§8）。
- 非修飾（JOIN なし）: `stmt.from` が temp/CTE ならその `columnMeta` を引く。
- **JOIN の非修飾参照**: 物理側と temp 側を**同じ土俵で一意性判定**する。現行は「CTE/temp が1つでもあれば即 `undefined`」だが、B14 後は temp の列名も候補に含めて数え、**候補が1つのときだけ**その meta を返す（0 個・2 個以上＝衝突は `undefined`）。
  - これは現行より**受理範囲が広がる**方向のみ（`undefined` だったものが確定する）。
- **消費側での API 増加はない**（temp の meta は実体化時に確定済み。物理アプリ側は B13 の既存キャッシュ経路のまま）。実体化側の増加は §4.5 のとおり。

## 6. 受入条件

- [ ] `CREATE TEMP TABLE #t AS SELECT 会社名 FROM APP4148; SELECT MIN(会社名) FROM #t;` が**辞書順の文字列**を返す（現在 `NaN`）。
- [ ] 同じく日時列（`CREATED_TIME` 等）の temp 経由 `MIN`/`MAX` が最古/最新を返す。
- [ ] **数値列の temp 経由 `MIN`/`MAX` は数値比較を維持**（回帰ゼロ。`顧客No` max=214 が `"99"` にならない）。
- [ ] `MIN($err_message) FROM #err` が文字列を返す（`$err_row` / `$err_statement` は数値のまま）。
- [ ] **`#err` のペイロード列が DML 対象アプリのフィールド定義から型付く**（`INSERT`/`UPSERT … VALUES`・`… SELECT`・`UPDATE` の**全経路**）。`UPDATE` 経路の `$id` は数値（`RECORD_NUMBER` 相当）。**元 SELECT の列名には依存しない**。
- [ ] **チェーン**: `#t1 → #t2` の 2 段でも型が伝播する。
- [ ] **CTE**（`WITH c AS (SELECT 会社名 FROM APP4148) SELECT MIN(会社名) FROM c`）でも効く。
- [ ] **UNION の型衝突**（string と number）は型不明＝従来経路。左右一致なら伝播。
- [ ] **JOIN**: `FROM #t AS t` の修飾参照 `t.x` が解決し、物理×temp の同名衝突は型不明。物理側のみ一意なら解決。
- [ ] 推論しない列種別（`StringFuncColumn` / `CaseColumn` / `ScalarSubqueryColumn`）は型不明＝従来経路（**現状維持**）。
- [ ] `WITH` 内の `SHOW APPS` / `DESCRIBE` 由来の列は型不明。
- [ ] `columnMeta` を持たない実体化（既存経路）は完全に従来動作。
- [ ] `#err` への追記で `columnMeta` が矛盾したら `ArgumentError`。一致判定は**構造一致**（キー集合と `sortKind`/`fieldType`）で、Map の参照一致ではない。
- [ ] **フォーム定義 API はアプリごと最大 1 回**（`getFieldsCached` 共有・既取得なら追加なし・同一 `cacheContext` の再実行で増えない）を計測テストで固定。`SELECT *` の実体化では**新規取得が 1 回発生してよい**（§4.5）。
- [ ] `ORDER BY` の `sortKinds`・typed `IN` 評価に**回帰なし**（本仕様では配線しない）。

## 7. リスク・SemVer

- **SemVer: minor**。挙動変更は「temp 経由のテキスト・日時 `MIN`/`MAX` が `NaN` → 正しい値」の方向のみ。数値は不変。
- **最大のリスク＝誤った型の伝播**。誤ると NaN でなく**静かに誤った集約結果**になる（例: テキストを number と誤判定 → 全て NaN、数値を string と誤判定 → `"10" < "9"`）。→ §4.3 の「迷ったら載せない」を厳守し、推論する列種別を**素通し・集約・算術・リテラルに限定**する。
- **リスク（メモリ）**: `columnMeta` は列数ぶんの小さな Map（行数に比例しない）。一時テーブル上限（1万行）に対して無視できる。
- **リスク（スキーマ検査）**: `#err` の追記で `columnMeta` 一致を要求すると、同一 `#err` へ**異なる文**から追記する既存パターン（B12-A/B12-B の複文）で不一致が起きないか要確認 → 受入条件に含める。判定は**構造一致**（§4.2）。
- **リスク（API 増）**: `SELECT *` を実体化するアプリでフォーム定義取得が新規に 1 回発生する（§4.5）。アプリごと 1 回・キャッシュ共有のため上限は明確だが、「増加ゼロ」ではない点を計測テストで固定する。

## 8. スコープ外・後続

- **型メタ付き `IN`/`NOT IN`（v2.5.0）への配線**: 本仕様で `fieldType` は保存するが**消費しない**。配線すると temp 経由の `IN` が文字列比較 → 配列/オブジェクト要素比較へ**挙動変更**するため、独立した課題として仕様・実機検証を行う（言語リファレンス §11 の「一時テーブル/CTE 経由は文字列比較（別課題）」の解消）。
- **`StringFuncColumn` の戻り型推論**: 関数ごとの戻り型表（`LENGTH`/`DATEDIFF`/`YEAR`→number・`CAST`→引数依存・`COALESCE`/`ISNULL`/`NULLIF`→引数依存）。面が広く誤りが静かに効くため別課題。
- **`CaseColumn` の型推論**（全分岐が同型のときのみ確定、など）。
- **`#t.x`（alias なしの temp 修飾参照）**: `parseTableRef` が temp/CTE には既定 alias を与えない（物理アプリだけ `?? name`）ため現状 `#t.x` は解決できない（§5）。**名前解決の変更**であり本仕様とは別課題。当面は `FROM #t AS t` の `t.x` を使う。
- **B16 `GROUP_CONCAT`**: 本仕様の完了後に実装し、**同一リリース（v2.15.0）で束ねる**（片方だけでは `#err` 集約が成立せず成果が出ないため）。
