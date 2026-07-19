# B39 IMPORT v2 仕様 — JSON ソース＋サブテーブル

- 作成日: 2026-07-19
- ステータス: **v2 仕様 R1・Claude レビュー済（承認・§13）**（分担=codex 作成/Claude レビュー）
- 分担: codex=仕様作成／Claude=レビュー
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 前提: [IMPORT v2 評価 R1](ksql_import_json_subtable_evaluation.md)・[IMPORT v1 仕様 R4](ksql_import_statement_spec.md)

## 1. 目的

B39 IMPORT v1 のフラット CSV に、(1) 名前対応の JSON source、(2) 親レコードとサブテーブル行を一体で取り込む IMPORT を純加法で追加する。v1 の `MaterializedTable`、SELECT/CSV の位置対応、通常 INSERT/UPSERT、B12/B37 の平坦候補経路は変更しない。v1 R4 は `MaterializedTable` を3経路の共通内部契約にし、既存の位置対応を維持すると確定済みである（[v1仕様:225-230](ksql_import_statement_spec.md#L225)）。現行 `MaterializedTable` も `rows`、`columns`、任意 `columnMeta` の平坦表である（[execute.ts:244-257](../../src/execute.ts#L244)）。

本機能は既存 SQL の意味を変えない新構文・新 source kind なので **SemVer minor** とする。サブテーブル行を対象にした `CHECK`、添付ファイル、レコード番号キー、CSV↔アプリ JOIN は対象外とする。v1 R4 も後三者を v2 側へ分離し、フラット経路を保守的に固定している（[v1仕様:221-229](ksql_import_statement_spec.md#L221)）。

## 2. スコープと段階

### 2.1 v2a — フラット JSON

- `FROM JSON <source>`、root/値型/数値/名前対応の厳格な JSON 契約を追加する。
- `INTO` はトップレベル field の明示列挙を必須とし、サブテーブル宣言を禁止する。
- JSON record を名前対応で平坦な `MaterializedTable` に変換し、v1 R4 の通常 INSERT/UPSERT・VALIDATE/CHECK 経路へ渡す。
- CSV 射影の `SELECT`、`ENCODING`、`NO HEADER`、`COLUMNS` は JSON では指定できない。

現行平坦 INSERT SELECT は列数を検査して `columns[i] -> fields[i]` で payload を作る（[execute.ts:4745-4773](../../src/execute.ts#L4745)）。v2a は JSON key を `INTO` 順へ射影した `columns/rows` を作る境界までを JSON 固有とし、その後だけを再利用する。

### 2.2 v2b — サブテーブル IMPORT

- JSON のネスト配列を第一の source 形式とする。
- `INTO app (field..., subtable(child...))` を追加する。
- `MaterializedImportRecords`、IMPORT 専用 payload 型、subtable-aware 検証、親単位のエラー隔離、UPSERT のサブテーブル全置換を追加する。
- cli-kintone 互換 CSV `*` 形式は **任意の後続 deliverable** とする。v2b の完了条件は JSON ネストであり、CSV `*` は同じ `MaterializedImportRecords` へ変換できる場合だけ追加する。

既存の汎用サブテーブル DML は、INSERT では既存親へ現在行を残して追加し（[execute.ts:5126-5155](../../src/execute.ts#L5126)）、UPDATE では `_rid` 条件を必須にする（[execute.ts:5167-5205](../../src/execute.ts#L5167)）。これは親を含む一括 IMPORT の契約ではないため、v2b はこの構文・実行関数へ委譲しない。

## 3. 構文と AST

```text
IMPORT INTO <app> (
  <field1>, ...
  [, <subtable1> ( <child1>, ... ) ...]
)
FROM JSON <source>
[ ON DUPLICATE ( <key1>, ... ) ]
[ CHECK WHEN <condition> THEN <message> ... ]
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ];
```

- `<source>` は v1 と同じ名前付き source（識別子またはバッククォート識別子）であり、path や JSON literal は SQL に埋め込まない。v1 の resolver/handle は同期存在確認と遅延 `load()` を分離する（[v1仕様:244-249](ksql_import_statement_spec.md#L244)）。
- `INTO` は v2a/v2b とも省略不可。トップレベル field code、subtable code、各 child code を明示する。フォームからの自動展開は行わない。
- 同じトップレベル field/subtable、同一 subtable 内の同じ child の重複宣言は parse/analyze error とする。同じ child code が別 subtable に存在しても、親 subtable の宣言スコープで解決する。
- `ON DUPLICATE` key はトップレベル field のみで、すべて `INTO` に含める。IMPORT UPSERT の源内複合キー重複は、処分句に関係なく照合 read 前に文全体を拒否するという v1 契約を継承する（[v1仕様:238-242](ksql_import_statement_spec.md#L238)）。
- AST は `DmlSource` に `{kind:"JSON"; sourceName:string}` を加え、`ImportTarget` をトップレベル field と `{subtableCode, children}` の判別 union にする。v2b record を `MaterializedTable` union に混ぜない。

### 3.1 CHECK の構文制約

`CHECK` の参照可能名は、v2a では宣言済みトップレベル出力 field、v2b でもトップレベル field だけとする。subtable code、child code、配列添字、`_rid` の参照は analyze 段階で拒否する。現行 CHECK は出力名の一意性を要求し、利用可能な平坦名集合に対して参照を検査する（[execute.ts:4220-4233](../../src/execute.ts#L4220), [execute.ts:4281-4293](../../src/execute.ts#L4281)）。サブテーブル行への CHECK は v3 以降で別スコープを設計する。

## 4. JSON source 契約

### 4.1 loader、encoding、上限

JSON は v1 の `ImportSourceHandle = {load(): Promise<{bytes, encoding?}>}` と同期 resolver、文単位 cache、**10 MiB = 10,485,760 bytes/source/文**、row 上限を共有する。実行順は source handle の同期確認 → 書込先フォーム検証 → `load()` → byte 上限 → decode/JSON 構文検査 → materialize → UPSERT preflight → DML 検証/CHECK/confirm → 書込みとする。これは source より先に書込先を検査する現行順序（[execute.ts:4735-4743](../../src/execute.ts#L4735)）と v1 R4 の確定順序（[v1仕様:244-249](ksql_import_statement_spec.md#L244)）に沿う。

JSON encoding は UTF-8 のみとする。loader の `encoding` が `sjis`、または JSON 構文の前後に非空白データがある場合は parse error とする。空 bytes、空白のみ、root `[]` は「空 source」エラーとし、書込み0件とする。

### 4.2 構造

- root は JSON array のみ。
- root の各要素は JSON object prototype 相当の record object のみ。配列、scalar、`null` を record として許可しない。
- object key は exact match・case-sensitive・trim なしで field/subtable code と対応する。
- JSON object の**重複 key は階層を問わず parse error**とする。後勝ちは認めない。
- デコーダは JSON token を走査して重複 key と数値字句を検査してから値を構築する。重複 key と元数値字句を失うため、裸の `JSON.parse` だけを適合実装とはしない。

### 4.3 数値契約

次を確定する。

1. 書込先が `NUMBER`（子 field を含む）または将来の精度検証対象型の場合、JSON 値は **string で供給しなければならない**。空値は `""`、数値は元字句を保つ文字列とする。
2. JSON number を許すのは、書込先が精度対象外で、かつ字句が符号付き10進整数、数学値が `Number.MIN_SAFE_INTEGER` 以上 `Number.MAX_SAFE_INTEGER` 以下の場合だけである。小数、指数表記、`-0`、安全整数域外は field validation error とする。
3. 安全整数判定は parse 後の `number` ではなく**元字句**に対して行う。適合後に10進文字列へ正規化して単一値検証へ渡す。

既存 `validateAndNormalizeDmlValue` は `normalizeRaw` 後に `String(value)` を `parseExactDecimal` へ渡す（[dmlValidation.ts:31-57](../../src/core/dmlValidation.ts#L31)）。したがって精度対象を string に限定すれば既存の厳密10進検証を保てる。B9 回帰は `9007199254740992` と `9007199254740993` を別値として扱うことを要求する（[execute.test.ts:113-122](../../src/__tests__/execute.test.ts#L113)）。丸め後の `number` から元字句を復元できないため、parse 後の `Number.isSafeInteger` だけでは仕様を満たさない。

### 4.4 値型

トップレベル field と child field の値は次のとおりとする。

| JSON 値 | 許可 | 意味 |
|---|---:|---|
| string | 可 | その文字列。NUMBER 等の精度対象はこの形式必須 |
| number | 条件付き | §4.3 の安全整数のみ。10進 string にして検証 |
| boolean | 不可 | 暗黙の `"true"`/`"false"` 化をしない |
| null | 条件付き | **明示的な空値**。scalar は `""`、collection は `[]` |
| array | 条件付き | 複数選択系 field、または宣言済み subtable のみ |
| object | 条件付き | 宣言済み subtable の配列要素だけ。scalar field では拒否 |

複数選択系は JSON string array のみを受け、`null` 要素、重複要素、number/boolean/object/array 要素を拒否する。ユーザー・組織・グループ選択も code の string array とする。空配列は明示的な全解除である。既存 kintone value 型は scalar string、string array、`{code}` array のみを表す（[dmlToKintone.ts:53-58](../../src/converter/dmlToKintone.ts#L53)）。また既存 `normalizeRaw` は `null` を空、boolean/object を `String(raw)` へ落とし得る（[dmlValidation.ts:121-134](../../src/core/dmlValidation.ts#L121)）ため、IMPORT 境界で上表を検査し、不許可値を既存 normalizer に到達させない。

### 4.5 名前対応、未知 key、欠落

- 各 record の key 集合は異なってよい。
- `INTO` に宣言していない key は、トップレベル・child とも **拒否**する。無視モードは設けない。予約 key `_rid` も未知 key として拒否する。
- `INTO` に宣言した key が JSON record に無い場合は**未指定**であり、空値とは区別する。create ではフォーム既定値を適用し、その後に必須検証する。update ではそのトップレベル field を payload から省略して既存値を維持する。
- JSON `null` は未指定ではなく明示的な空値なので、update でも消去を試み、必須/型検証を受ける。
- create で `INTO` にないフォーム field も、既存 create 候補と同様、既定値と必須を検査する。現行候補検証は payload にない create field に既定値/空値/必須検証を行う一方、subtable child は走査から除外する（[dmlValidationCandidates.ts:54-71](../../src/core/dmlValidationCandidates.ts#L54)）。v2b は child について同じ意味を専用走査で実装する。

## 5. 二層 source 契約

### 5.1 平坦層

`MaterializedTable` は SELECT、v1 CSV、v2a フラット JSON の共通契約として維持する。v2a JSON materializer は `INTO` 宣言順の `columns` と各 key の「値あり／未指定」を区別できる row representation を作る。実装時に `ProcessRow` の `?? ""` が未指定を空へ潰すなら、JSON 境界で presence metadata を併設しなければならない。現行位置対応は欠落値を `""` にするため（[execute.ts:4764-4770](../../src/execute.ts#L4764)）、名前対応の欠落契約をそのまま通してはならない。

### 5.2 サブテーブル層

v2b は別入口 `materializeImportRecords(...) -> MaterializedImportRecords` を持つ。概念型は次とする（名称は実装時に同義名へ変更可）。

```text
MaterializedImportRecords = {
  records: Array<{
    rowNumber: number,
    top: Map<fieldCode, ImportValue>,
    subtables: Map<subtableCode, Array<{
      childRowNumber: number,
      values: Map<childCode, ImportValue>
    }>>
  }>
}
```

`KintoneFieldValue` 自体を再帰 union に広げて全 DML に波及させず、IMPORT 専用の materialized/payload 型を追加する。既存型はサブテーブル配列を表現できず（[dmlToKintone.ts:53-58](../../src/converter/dmlToKintone.ts#L53)）、現行サブテーブル PUT は `rows as unknown as string` の型ハックを使う（[execute.ts:5343-5361](../../src/execute.ts#L5343)）。v2b payload builder は REST payload の再帰構造を正しく型付けし、このキャストを再利用しない。

共有範囲は source handle 解決、遅延 load、byte/row 上限、文単位 cache、decode、トップレベル UPSERT key preflight、confirm までとする。record-with-subtables 以降の payload、候補、検証、エラー整形は専用経路とし、v1 の3経路を巨大 union にしない。現行候補は `payload: Map<string, unknown>` と平坦 `KintoneRecord`、位置は親 `rowNumber` と field だけである（[dmlValidationCandidates.ts:11-23](../../src/core/dmlValidationCandidates.ts#L11)）。

## 6. サブテーブル payload と検証

### 6.1 フォーム解決

analyze/preflight で次を全て検査する。

- subtable code がフォーム上の `SUBTABLE` として存在する。
- child code がその subtable に直接所属する。同名 child が別 subtable にあっても流用しない。
- child は書込可能であり、計算・lookup コピー・システム等の書込不可 field を拒否する。
- トップレベル field と child を混同しない。
- NUMBER child が一つでもあればアプリの number precision を取得し、親 NUMBER と同じ `NumberPrecision` を使う。

現行フォーム flatten は child に `inSubtable=true` を付けるが、親 subtable code との所属関係を保持しない（[formFieldInfo.ts:21-56](../../src/core/formFieldInfo.ts#L21)）。よって v2b は raw form properties から `subtableCode -> child infos` のスコープ付き index を別に構築する。既存トップレベル DML は `inSubtable` を一律拒否する（[execute.ts:3944-3964](../../src/execute.ts#L3944)）ため、この helper を v2b child 検証へ流用しない。

### 6.2 行検証と既定値

- 各 child 値の型、範囲、桁、長さ、選択肢、必須は `validateAndNormalizeDmlValue` を単一値 primitive として再利用する。
- create/update を問わず、source に現れた各 subtable row について宣言済み child を走査する。欠落 child はフォーム既定値を適用し、その後に必須検証する。`null` は明示空として検証する。
- 宣言外 child、書込不可 child、型不正は親 record を invalid にする。
- 空 subtable array は有効で、create では空テーブル、update では明示的な全行削除を表す。subtable key 自体の欠落は create ではフォーム既定/必須規則、update ではテーブル維持を表す。
- `ON ERROR SKIP` の隔離単位は**親 record 全体**とする。不良 child row だけを落として親を部分書込みしない。通常モードは最初のエラーで文全体を書込み0件、`VALIDATE ONLY` は全エラーを報告して書込まない。

既存 `assertValidDmlRecords` は target field を平坦に走査し、位置を `(row, field)` でしか示せない（[execute.ts:3991-4007](../../src/execute.ts#L3991)）。v2b はこれを呼ばず、エラー位置を次の4階層で保持する。

```text
parentRow, subtableCode, childRow, childCode
```

エラー表は既存 `$err_row`/`$err_field` を保ちつつ、v2b で `$err_subtable` と `$err_subrow` を加える。トップレベル error では両列を空、child error では `$err_field=childCode` とする。これにより既存の親行単位 invalid 集合（[dmlValidationCandidates.ts:91-105](../../src/core/dmlValidationCandidates.ts#L91)）を拡張しつつ、隔離単位は変えない。

### 6.3 payload

合格した親 record ごとに次を直接構築する。

```text
record[subtableCode] = {
  value: sourceRows.map(row => ({ value: normalizedChildRecord }))
}
```

create は POST、UPSERT update は親 record ID を指定した PUT とする。バッチ内の一親 record とその全 subtable rows は不可分であり、API batch 境界でも分割しない。既存サブテーブル helper も親 record の table value 全体を1つの PUT record に組み立てる（[execute.ts:5343-5365](../../src/execute.ts#L5343)）。

## 7. UPSERT とサブテーブル行 ID

方式 **(a) `_rid` を受けない全置換**を採る。

- UPSERT update で JSON に subtable key がある場合、その subtable は入力配列で全置換する。payload の全行に id を付けず、kintone に全行を新規採番させる。入力に無い既存行は削除される。
- subtable key が欠落した場合、そのテーブル field を PUT payload から省略し、既存テーブルを維持する。
- `[]` は明示的な全行削除である。
- `_rid` は予約入力として認識せず、宣言外 key として source 検査で拒否する。したがって不正 ID・別親 ID を受理する経路は存在しない。
- 行 ID を保つ部分更新は v3 以降の別機能とする。

この判断は、既存 UPDATE が変更しない行も `{id}` として payload に含める全体配列を作ること（[execute.ts:5221-5235](../../src/execute.ts#L5221)）、DELETE が残す行を table payload に含めること（[execute.ts:5280-5288](../../src/execute.ts#L5280)）と整合する。一方、IMPORT で `_rid` を公開すると親所属確認のため既存全行取得と照合が必須になり、既存 `_rid` DML と同等の別契約になる。v2b は再現可能な snapshot import を優先する。

## 8. CSV `*` 形式（v2b 任意）

追加する場合は cli-kintone 互換を最低条件とし、独自の簡略形式は作らない。

- table 識別列と複数 subtable を扱う。
- 親 field は各親 record の開始行だけを採用する。
- subtable marker 行を同じ親へ group 化する。
- 空 table 行を無視し、明示的な空テーブルとの表現差を定義する。
- JSON と同じ `MaterializedImportRecords`、名前/所属検査、親単位隔離、全置換契約へ変換する。

v1 評価でも `*` 形式は識別列、複数 table、開始行だけの親 field、空行無視を含み、単純な配列組立ではないと確認されている（[v1仕様:128-141](ksql_import_statement_spec.md#L128)）。このため JSON v2b の受入を CSV `*` 実装でブロックしない。

## 9. 受入条件

### 9.1 v2a

1. root 非array、非object要素、空 root、末尾 garbage、UTF-8 不正を拒否し、書込み0件。
2. 全階層の重複 key を拒否し、後勝ちにしない。
3. NUMBER target は string の `"9007199254740992"` と `"9007199254740993"` を別値のまま検証・payload 化する。
4. NUMBER target の JSON number、安全域外 number、全 target の小数/指数 JSON number を拒否する。非精度 target の `9007199254740991` は許可し、`9007199254740992` は拒否する。
5. boolean、scalar field の object、型不一致 array を拒否し、`null` と欠落 key の差を create/update で確認する。
6. 未知 key、宣言重複、JSON key 重複を拒否する。record ごとの key 集合差は許可する。
7. v1 CSV と SELECT の位置対応、CHECK、VALIDATE、UPSERT に非回帰。

### 9.2 v2b

1. 複数 subtable、同名 child の別 table、未知 child、別 table child、書込不可 child を検査する。
2. child の必須/既定値/選択肢/長さ/NUMBER 桁精度を行単位で検査する。
3. error は親行+subtable+子行+child を示し、`ON ERROR SKIP` は不良親全体を隔離する。
4. create の nested payload、UPSERT update の指定 table 全置換、欠落 table 維持、`[]` 全削除を API mock で確認する。
5. `_rid` を拒否し、全置換行に id を送らないことを確認する。
6. CHECK の child/subtable 参照を API call 前の analyze error にする。
7. source 内 UPSERT key 重複、byte/row/subtable総行上限、confirm、VALIDATE ONLY を親 record 単位で確認する。
8. v1 の `KintoneRecord` 型と平坦候補経路を拡張せず、既存 DML/サブテーブル DML の回帰 suite を通す。

## 10. 実装段階と工数

### 10.1 v2a: **4〜7 人日**

評価時の3〜5人日から見直す。内訳は AST/parser/analyze 0.5〜1、字句対応 JSON decoder（重複 key・数値字句）1.5〜2.5、名前/presence/type materialize 1〜1.5、3面 loader/schema/help 0.5〜1、回帰/文書 0.5〜1。単純 `JSON.parse` では済まず、既存 normalizer が object/boolean を文字列化し得るため IMPORT 境界検査が必要である（[dmlValidation.ts:121-134](../../src/core/dmlValidation.ts#L121)）。

### 10.2 v2b: **12〜20 人日**

評価 R1 の再見積りを維持する。内訳目安は scoped form model/型 2〜3、二層 materializer/payload 2〜3、subtable-aware 検証/既定/精度 3〜5、UPSERT 全置換/省略/空配列 2〜3、B12エラー隔離/CHECK制約 1.5〜2.5、3面・受入・非回帰・文書 1.5〜3.5。一部並行化込みで12〜20人日とする。平坦候補が親 row+field しか持たず（[dmlValidationCandidates.ts:11-23](../../src/core/dmlValidationCandidates.ts#L11)）、フォーム flatten が親 table scope を失う（[formFieldInfo.ts:21-56](../../src/core/formFieldInfo.ts#L21)）ため、専用モデルは省略できない。

CSV `*` 形式を含める場合は互換 parser/grouping/fixture に **追加3〜6人日**を別計上する。よって「v2b 12〜20人日」は JSON ネストの必須範囲であり、CSV `*` 込みは15〜26人日を目安とする。

## 11. 未解決点

R1 で実装を止める未確定事項はない。次は Claude review でコードとの不整合を潰す。ただし以下は実装前に名前・上限値を固定する必要がある。

- v2b の総 child row 上限を、既存 row 上限と同一カウンタにするか、独立 `importSubtableMaxRows` にするか。どちらでも byte 上限とは独立し、全 child row の合計へ適用する。
- `$err_subtable` / `$err_subrow` を B12 の固定メタ列へ常設追加するか、IMPORT v2b の error table だけに追加するか。意味と位置情報は本仕様どおり必須。
- lossless/重複検出 JSON decoder を内製 tokenizer にするか、browser/Node 両 build で使える依存へするか。選定条件は元数値字句・全階層重複 key・10 MiB 上限・CSP/build 互換であり、裸の `JSON.parse` は不可。
- CSV `*` deliverable を v2b 同時 release に含めるか。JSON v2b の契約・受入条件はこの選択に依存しない。

## 12. Claude レビュー用の要確認ポイント

1. 精度対象は JSON string 必須、JSON number は元字句が安全整数の場合だけ、という二段契約が B9 と `validateAndNormalizeDmlValue` の厳密10進経路を壊さないか。
2. 重複 key と数値字句を保持する decoder 必須化により、`JSON.parse` 後では回復不能な P1/P2 が閉じているか。
3. `null=明示空`、欠落=create の既定/必須・update の維持、未知 key 拒否、`INTO` 必須が通常 DML の create/update 契約と矛盾しないか。
4. `MaterializedTable` と `MaterializedImportRecords` の二層化で、v1 の3平坦経路や `KintoneRecord` union を汚さずに source cache/preflight だけ共有できるか。
5. scoped form index、子の書込可否/必須/既定/NUMBER精度、4階層 error location、親単位 SKIP が subtable-aware 検証を十分に閉じているか。
6. `_rid` 非対応・指定 table は id 無し全置換・欠落は維持・`[]` は全削除、という UPSERT 契約が kintone PUT と既存 subtable DML の挙動に合うか。
7. CHECK の child 参照を analyze 段階で拒否し、CSV `*` を任意 deliverable に分離した工数 **v2a 4〜7／v2b JSON 12〜20／CSV追加3〜6人日**が妥当か。

---

## 13. Claude レビュー結果（R1・2026-07-19・承認）

codex 執筆の本仕様を Claude がコードで裏取り。**判定＝承認・設計は健全**。評価 §9 の P1×6 はいずれも現行コードの契約に沿って正しく解決されている。

### 裏取りで正確だった点
- §4.3 数値契約: `validateAndNormalizeDmlValue`→`String(value)`→`parseExactDecimal`（[dmlValidation.ts:53](../../src/core/dmlValidation.ts#L53)）・B9 回帰（`9007199254740992`≠`…993`・[execute.test.ts:113](../../src/__tests__/execute.test.ts#L113)）。精度対象を string 供給に限定＋JSON number は元字句で安全整数判定、は B9 の字句保持契約を壊さない。
- §4.4 値型: `KintoneFieldValue.value`＝scalar/`string[]`/`{code}[]`（[dmlToKintone.ts:53](../../src/converter/dmlToKintone.ts#L53)）・`normalizeRaw` の null/boolean/object 落とし（dmlValidation.ts:121）。IMPORT 境界で不許可値を弾き `"[object Object]"` 混入を防ぐ、は正しい。
- §5 二層: 平坦位置対応の `?? ""` 欠落潰し（[execute.ts:4764](../../src/execute.ts#L4764)）→ 名前対応の欠落は presence metadata が要る、は妥当。`MaterializedTable`＋`MaterializedImportRecords` の二層で3経路 union 化を避ける判断も正。
- §6.1 subtable-aware: `formFieldInfo` は child を `inSubtable` でフラット化するが**親 subtable code を保持しない**（[formFieldInfo.ts:34](../../src/core/formFieldInfo.ts#L34)）→ scoped index 別構築が必要、は正しい。既存トップレベル DML が `inSubtable` を一律拒否（execute.ts:3944）なので流用不可も正。
- §7 UPSERT: UPDATE は未変更行も `{id}` で全行送る（[execute.ts:5221](../../src/execute.ts#L5221)）→ 全置換 `_rid` 非対応は kintone PUT と整合。

### codex 3 open item への Claude 見解
- **`$err_subtable`/`$err_subrow`**: IMPORT v2b の error table だけに追加を推奨（B12 の固定6列は他 DML に波及するため常設は避ける）。
- **JSON decoder**: 依存追加より**内製 tokenizer** を推奨（CSP・browser/Node 両 build・10 MiB を満たす依存が限られる＋供給契約を kSQL 内で閉じられる）。
- **CSV `*`**: JSON v2b と分離し**後続 deliverable**（§8 のとおり契約は JSON と共通なので分離しても破綻しない）。

### 観察（設計判断・ブロッカーではない）
- **カスタム decoder が v2a の主コスト**: §4.2 重複 key parse error＋§4.3 JSON number の安全整数「元字句」判定のため、**裸の `JSON.parse` では不十分**（字句喪失・重複 key 後勝ちを検出不能）。これが v2a を「3〜5→4〜7 人日」に押し上げている。**もし①全値を JSON string 必須（number 全面禁止）②重複 key は `JSON.parse` 後勝ち許容（warning）に緩めれば、native `JSON.parse` で v2a は軽いまま**。厳密さ（B9 精度・重複 key 検出）と実装軽量のトレードオフとして、R2 で採否を確定するとよい（本仕様は厳密側＝decoder 必須で確定）。

### 総合
**承認・R1 として実装判断可**。次段は実需に応じて v2a 実装（v1 実装後）。上記トレードオフ（decoder 厳密 vs 軽量）だけ、着手前にユーザー確認の価値あり。
