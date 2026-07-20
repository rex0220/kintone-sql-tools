# B44 — `APPLY` ブロックによるテーブル内外項目の同時更新仕様

- ステータス: **v3.8.0 実装中（2026-07-20〜）**。v1／v1.1／v1.2 は Phase 1～9 実装済（commit 017ebba・実機確認済）。**v2（複数親・INSERT/UPSERT・`_idx`・`EXPECT ROWS`・多値 ADD/REMOVE）も同一 v3.8.0 へ同梱**（2026-07-20 ユーザー決定）。実装計画=[ksql_apply_block_impl_plan.md](ksql_apply_block_impl_plan.md)（Phase 10a〜17d の23分割・§18/§19 で XL/L を分割・Claude 承認済）。MCP 実 mutation は v2 でも全 APPLY で fail-closed
- 対象: B44「テーブル内外項目の同時更新」
- 台帳: [ksql_issue_tracker.md B44](../ksql_issue_tracker.md#L39)
- 前提: [B42 サブテーブル監査仕様](ksql_validate_subtable_audit_spec.md)・B43 DML post-image 事前検証
- 構文決定: [C1/C3 比較 §7](ksql_b44_c1_c3_comparison.md#L178)・[一般形 `APPLY <フィールドコード>` §8](ksql_b44_c1_c3_comparison.md#L234)

## 1. 背景と目的

B42、B43、B44 は次の三段で一つの修復フローを構成する（[ksql_issue_tracker.md:33](../ksql_issue_tracker.md#L33)-[39](../ksql_issue_tracker.md#L39)）。

1. B42: 保存済みレコードのトップレベル・サブテーブル子フィールド違反を監査し、`$id`、`$err_subtable`、`$err_subrow_id` を返す。
2. B43: DML の PUT 後状態を事前検証し、既存違反による API 実行時失敗を事前に検出する。
3. B44: 親フィールドとサブテーブルセルを一つの親レコード PUT に合成し、相互に書き込みを妨げる既存違反を同時修復する。

実機では APP4221 `$id=7` に対する次の文が、`VALIDATE ONLY` では `validatedRows=1`、`validRows=1`、`errorCount=0` と判定された一方、実更新ではサブテーブル `テーブル.文字列T2` の既存 `minLength` 違反により `CB_VA01` となった（[ksql_issue_tracker.md:38](../ksql_issue_tracker.md#L38)）。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 7
VALIDATE ONLY;
```

現行の DML 事前検証は、候補 payload に存在する列だけを検証し、UPDATE 前からレコード内にある値は検証しない（[dmlValidationCandidates.ts:46](../../src/core/dmlValidationCandidates.ts#L46)-[52](../../src/core/dmlValidationCandidates.ts#L52)）。また、作成候補の未指定フィールド検証でもサブテーブル子フィールドを除外している（[dmlValidationCandidates.ts:61](../../src/core/dmlValidationCandidates.ts#L61)-[64](../../src/core/dmlValidationCandidates.ts#L64)）。

現行の親 DML はサブテーブル子フィールドを更新対象として拒否し、`APP<n>$テーブル` 形式へ誘導する（[execute.ts:4032](../../src/execute.ts#L4032)-[4052](../../src/execute.ts#L4052)）。一方、サブテーブル仮想テーブル DML は親フィールドを同じ PUT record に含められない。この分断により、親と子の両領域に既存違反がある場合、親 UPDATE とサブテーブル UPDATE が互いの違反に阻まれ、通常 DML だけでは修復できない。

B39 `IMPORT` は親フィールドとサブテーブルを同一レコード payload にできる既存経路だが、ファイル取込、行集合構築、全置換を含む用途であり、条件付きセル修復の常用構文ではない。特に MCP ではサブテーブル mutation を fail-closed とし、`VALIDATE ONLY` / `EXPLAIN` のみ許可している（[mcp/index.ts:60](../../src/mcp/index.ts#L60)-[63](../../src/mcp/index.ts#L63)、[execute.ts:4845](../../src/execute.ts#L4845)）。

**B43 との関係（R2 で明確化）**: 本仕様の post-image 検証は **`APPLY` を含む文に限り**提供する。`APPLY` を含まないプレーン DML（従来の `UPDATE … VALIDATE ONLY` 等）の検証範囲は本仕様では変更せず、台帳 B43（プレーン DML 事前検証が既存サブテーブル違反を検出しない false pass）は**独立課題として残る**。B44 実装で B43 が自動解決されるわけではない（ただし post-image 検証エンジンは B43 解決時にプレーン DML へ流用できる設計とする）。

本仕様は、親 UPDATE を主語にしてレコード内の集合値フィールドへの変更計画を宣言する、一般形の後置ブロックを導入する。

```text
APPLY <フィールドコード> ( <動詞による変更計画> )
```

`SUBTABLE` noun は書かない。v1 の対象型はサブテーブルだけだが、構文自体は将来の複数値フィールドにも拡張できる形に固定する。

## 2. 構文

### 2.1 全体文法

```ebnf
<apply-update> ::=
    UPDATE <app>
    SET <parent-assignment> ( "," <parent-assignment> )*
    WHERE <parent-predicate>
    <apply-block>+
    [ VALIDATE ONLY [ INTO <temp-table> ] ]

<apply-block> ::=
    APPLY <field-code> "("
        <apply-operation>
        ( ";" <apply-operation> )*
        [ ";" ]
    ")"

<apply-operation> ::=
      <patch-operation>
    | <append-operation>
    | <remove-operation>

<patch-operation> ::=
    PATCH SET <child-assignment> ( "," <child-assignment> )*
    <row-selector>
    [ <expect-rows> ]

<append-operation> ::=
    APPEND "(" <child-field> ( "," <child-field> )* ")"
    VALUES <value-row> ( "," <value-row> )*

<remove-operation> ::=
    REMOVE <row-selector>
    [ <expect-rows> ]

<row-selector> ::=
      WHERE <child-predicate>
    | ALL ROWS

<expect-rows> ::=
      EXPECT ROWS <nonnegative-integer>
    | EXPECT ROWS BETWEEN <nonnegative-integer> AND <nonnegative-integer>
    | EXPECT ROWS AT LEAST <nonnegative-integer>
    | EXPECT ROWS AT MOST <nonnegative-integer>
```

`APPEND`、`REMOVE`、`EXPECT ROWS` は後続段階の文法をR1で確定するものであり、v1 executor は §9 の範囲外構文を明示的な `UnsupportedError` で拒否する。

### 2.2 句順

親 `WHERE` はすべての `APPLY` ブロックより前に置く。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  PATCH SET 文字列T2 = 'NNN' WHERE _rid = '67890'
)
VALIDATE ONLY;
```

次の後置順を固定する。

```text
UPDATE … SET … WHERE 親条件
APPLY …
APPLY …
VALIDATE ONLY
```

`APPLY` の後に親 `WHERE` を置く形、`VALIDATE ONLY` の後に `APPLY` を置く形は ParseError とする。

### 2.3 `SUBTABLE` noun の禁止

採用構文は次である。

```sql
APPLY テーブル (
  PATCH SET 文字列T2 = 'NNN' WHERE _rid = '67890'
)
```

次の形は採用しない。

```sql
APPLY SUBTABLE テーブル (
  PATCH SET 文字列T2 = 'NNN' WHERE _rid = '67890'
)
```

`APPLY` の対象がサブテーブルであるかはフォームメタデータ取得後に検証する。v1 で対象がサブテーブル以外、不存在、書き込み不可フィールドの場合は、最初の records API より前に `ArgumentError` とする。これは現行 DML がフィールド存在性・`inSubtable`・書き込み可否を executor 側で検証する方針（[execute.ts:4037](../../src/execute.ts#L4037)-[4051](../../src/execute.ts#L4051)）と合わせる。

### 2.4 soft keyword 方針

新たに導入する `APPLY`、`PATCH`、`APPEND`、`REMOVE`、`ROWS`、`EXPECT`、`AT`、`LEAST`、`MOST`、および将来の `ADD` は予約語へ追加せず、所定位置だけで認識する soft keyword とする。

現行 parser も `CHECK` や `VALIDATE ONLY` を `IDENT` の大文字化比較で認識し（[parser.ts:2658](../../src/parser/parser.ts#L2658)-[2673](../../src/parser/parser.ts#L2673)、[parser.ts:2676](../../src/parser/parser.ts#L2676)-[2705](../../src/parser/parser.ts#L2705)）、共通判定は `IDENT` と大文字化した値を比較している（[parser.ts:2735](../../src/parser/parser.ts#L2735)-[2736](../../src/parser/parser.ts#L2736）。

したがって既存の同名フィールド、alias、アプリ論理名は予約語化しない。親 `WHERE` の解析完了後に `APPLY`、識別子、`(` が連続した場合だけブロック開始と判定する。

### 2.5 ブロック内のセミコロン

ブロック内の `;` は操作区切りであり、トップレベルの文区切りではない。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  PATCH SET 文字列T2 = 'abc' WHERE _rid = '101';
  PATCH SET 数値T1 = 1 WHERE _rid = '102';
)
VALIDATE ONLY;
```

規則は次のとおり。

- 括弧深度1の `APPLY (...)` 内にある `;` はブロックパーサが消費する。
- 最後の操作後の `;` は省略可能。
- `)` より後の `;` は通常どおり文終端になる。
- 文字列リテラル、行コメント、ブロックコメント内の `;` は区切りとして扱わない。
- 空ブロック、連続する空操作、`APPLY テーブル (; PATCH …)` は ParseError。
- バッチ文分割、コンソール継続入力、末尾セミコロン省略と併用できなければならない。

## 3. 操作構文

### 3.1 `PATCH`

`PATCH` は、選択した既存行の指定セルだけを変更する。対象外行、対象行の未指定セル、既存行 ID、行数、行順を保持する。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  PATCH SET 文字列T2 = 'abc'
  WHERE LENGTH(文字列T2) < 3
)
VALIDATE ONLY;
```

複数セルを同時に変更できる。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  PATCH SET 文字列T2 = 'abc', 数値T1 = 1
  WHERE _rid = '67890'
);
```

システム列 `_pid`、`_rid`、`_idx` は代入先にできない。現行サブテーブル UPDATE も `_` で始まるシステム列への代入を拒否している（[execute.ts:5772](../../src/execute.ts#L5772)-[5777](../../src/execute.ts#L5777)）。

### 3.2 `APPEND`

`APPEND` は新規行をサブテーブル末尾へ追加する。既存行は変更・削除しない。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  APPEND (文字列T2, 数値T1)
  VALUES ('abc', 1), ('def', 2)
);
```

`_pid`、`_rid`、`_idx` は指定できない。新規行の `_rid` は PUT 成功後に kintone が採番する。v1.1 で提供する。

### 3.3 `REMOVE`

`REMOVE` は選択した既存行を最終サブテーブル payload から除外する。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY テーブル (
  REMOVE WHERE 数値T1 = 0 EXPECT ROWS AT MOST 5
);
```

全行削除は `WHERE` 省略ではなく明示する。

```sql
APPLY テーブル (
  REMOVE ALL ROWS
)
```

`REMOVE` は既存行 ID の欠落を伴う破壊的操作であるため、v1.2 まで提供しない。

### 3.4 `ALL ROWS`

全行を対象とする操作では、必ず `ALL ROWS` と書く。

```sql
APPLY テーブル (
  PATCH SET 文字列T2 = '補正済み' ALL ROWS
)
```

`PATCH SET …` または `REMOVE` の後で `WHERE` と `ALL ROWS` の両方を省略することはできない。これは条件脱落による意図しない全行変更を防止するためである。

v1 では `ALL ROWS` を「明示された常時真の安全な述語」として扱い、§7 の件数ガードと revision ガードを必須とする。

## 4. スナップショット意味論と変更計画

### 4.1 評価スナップショット

1文に含まれるすべての親代入、`PATCH` / `REMOVE` セレクタ、代入式は、対象親を取得した時点の同一スナップショットに対して評価する。

- 親 `SET` の右辺は親の更新前値を参照する。
- `PATCH` の右辺と子 `WHERE` は各子行の更新前値を参照する。
- 先に記述した `PATCH` の結果を、後続の `PATCH` / `REMOVE` セレクタや右辺から参照しない。
- `APPEND` 行は同じ文の `PATCH` / `REMOVE` から不可視とする。
- 記述順による「後勝ち」は採用しない。

ブロックは逐次命令ではなく、一つの post-image を生成する宣言的な変更計画である（[ksql_b44_c1_c3_comparison.md:185](ksql_b44_c1_c3_comparison.md#L185)-[188](ksql_b44_c1_c3_comparison.md#L188)）。

### 4.2 重複操作

次を最初の PUT より前に `ArgumentError` とする。

- 同一セルを複数の `PATCH` が更新する。
- `PATCH` 対象行と `REMOVE` 対象行が重複する。
- 同一既存行を複数の `REMOVE` が選択する。
- 同じ `APPLY` ブロック内で、同一 `_rid` が重複・不明・別親所属として解決される。
- 1文に同一フィールドコードの `APPLY` ブロックが複数ある。
- 同じ子フィールドを1つの `PATCH SET` 内で重複指定する。

同一行の異なるセルを異なる `PATCH` が更新することは許可する。ただし同一セル重複検出のため、全操作を解決してから post-image を構築する。

### 4.3 PUT 合成

対象親ごとに、次を一つの `record` オブジェクトへ合成する。

- 親 `SET` の変更。
- 各 `APPLY` が生成したサブテーブル変更。
- 対象親の取得時 revision。

現行トップレベル UPDATE の変換は主に `$id` を取得し、100件単位の PUT payload を生成する（[dmlToKintone.ts:149](../../src/converter/dmlToKintone.ts#L149)-[170](../../src/converter/dmlToKintone.ts#L170)）。B44 はこの経路を逐次呼び出さず、親全体のスナップショット取得、変更計画、post-image 検証を行う専用合成プランナーを使用する。

原子性の表現は次に固定する。

- 1対象親につき、PUT payload 内の `records[]` 要素は1個だけとする。
- API 呼び出しは最大100親ずつのチャンクとする。
- 同一親へ親変更と子変更を分割した複数 PUT を送らない。
- 文全体はトランザクションではない。
- 複数チャンクの後続チャンクが失敗した場合、先行して成功したチャンクはロールバックされない。
- revision conflict 時はそのチャンクを失敗させ、自動再取得・再評価・再試行をしない。

現行 converter も UPDATE の一括 PUT を100件単位へ分割している（[dmlToKintone.ts:160](../../src/converter/dmlToKintone.ts#L160)-[173](../../src/converter/dmlToKintone.ts#L173)）。

## 5. 行セレクタと revision ガード

### 5.1 セレクタ4種

| セレクタ | 例 | 基準 | v1 |
|---|---|---|---|
| `_rid` | `WHERE _rid = '67890'` | kintone 永続行 ID | 対応 |
| `_idx` | `WHERE _idx = 0` | 取得スナップショット内の0-based位置 | v3.8.0 Phase 11 |
| 安全な述語 | `WHERE LENGTH(文字列T2) < 3` | 子行の取得時値 | 対応 |
| 全行 | `ALL ROWS` | 取得スナップショットの全既存行 | 対応 |

`_rid` は B42 の `$err_subrow_id` と同値である。B42 の表示序数 `$err_subrow` は1-basedだが、仮想列 `_idx` は0-basedであり、両者を混同してはならない（[ksql_validate_subtable_audit_spec.md:149](ksql_validate_subtable_audit_spec.md#L149)-[160](ksql_validate_subtable_audit_spec.md#L160)）。

現行 adapter は保存済み `row.id` を `_rid`、配列の index を文字列化して `_idx` に格納している（[subtableAdapter.ts:23](../../src/converter/subtableAdapter.ts#L23)-[29](../../src/converter/subtableAdapter.ts#L29)）。`_idx` は既存の参照専用システム列であり、B44 が新設する1-based列ではない。

### 5.2 v1 の安全な述語

v1 の子述語は次をすべて満たすものに限定する。

- 対象サブテーブルの子フィールド、`_rid`、リテラル、バッチ変数だけを参照する。
- 親参照 `_p.*`、他テーブル、サブクエリ、集約、ウィンドウ関数を含まない。
- 現在時刻や外部状態に依存しない決定的な式である。
- 取得済み全行へローカル評価できる。
- kintone query への押し下げ結果だけを対象集合の正としない。
- `KLIKE`、子行ごとの外部 API 呼び出し、ユーザー定義副作用を含まない。

`_rid = <値>` は安全な述語の特殊形だが、0行マッチ規則だけは通常述語より厳しくする。

### 5.3 0行マッチ

- `_rid` 単一指定が0行: `ArgumentError`。
- `_idx` 単一指定が0行: `ArgumentError`。
- 一般述語が0行: no-op。
- `ALL ROWS` で0行テーブル: no-op。
- `EXPECT ROWS` がある場合: 実マッチ件数が期待条件を満たさなければ `ArgumentError`。
- `_rid` / `_idx` の対象消失エラーを `EXPECT ROWS 0` で無効化することはできない。

`EXPECT ROWS` は各親・各操作について独立に評価する。全親の合計件数では判定しない。

### 5.4 revision ガード

保存済み親に対する mutating `APPLY` は、セレクタ種別にかかわらず revision ガードを必須とする。

```text
GET: $id + $revision + 親SET参照列 + 対象サブテーブル全体
→ セレクタ解決
→ post-image構築・検証
→ 同じrevisionを付けてPUT
```

現行サブテーブル UPDATE も親の revision を読み取り、PUT record に設定している（[execute.ts:5899](../../src/execute.ts#L5899)-[5917](../../src/execute.ts#L5917)、[execute.ts:5927](../../src/execute.ts#L5927)-[5942](../../src/execute.ts#L5942)）。B44 ではこれを任意設定にせず、親 `SET` を含む合成 PUT 全体の必須条件とする。

特に次は revision 必須条件から除外できない。

- `_idx`、一般述語、`ALL ROWS` を使用する。
- `APPEND` または `REMOVE` を行う。
- 複数 `APPLY` を合成する。
- 複数親へ適用する。
- 既存親を更新する UPSERT update 分岐。

新規親を作成する INSERT / UPSERT insert 分岐には取得時 revision が存在しないため適用しない。

### 5.5 `EXPECT ROWS` の位置づけ — セレクタではなくガード（R2 追記・ユーザー質疑より）

`EXPECT ROWS` は**対象集合を変更しない**。`WHERE`（絞り込み）と `EXPECT ROWS`（事前表明）は役割が直交する。

- `WHERE … AND _idx <= 4` のような位置条件は対象集合を絞る＝マッチ超過時に**先頭だけを黙って更新し、残りを黙って未修復のまま残す**。本仕様が排除する「静かな誤更新・静かな取りこぼし」を再導入するため、件数制限の代替にならない。
- `EXPECT ROWS AT MOST n` は対象集合を変えず、実マッチ件数が表明と食い違えば**文全体を失敗させ書き込みゼロ**にする（fail-closed）。
- `_idx` は「テーブル内の位置」であり「マッチ件数」ではない＝「マッチのうち最大 n 件」は `_idx` では表現不能。また `EXPECT ROWS AT LEAST 1` 方向（一般述語の 0 行 no-op を「修復対象消失エラー」へ引き上げる）はセレクタでは原理的に書けない。
- 系譜としてはバッチ `ASSERT`（想定が崩れたら停止）・`dmlMaxRows`（件数ガード）と同じ宣言的ガードを、操作単位・両方向（上限/下限）にしたもの。

`ALL ROWS`（§3.4）の意味の確認: 親 WHERE で選ばれた**各レコード内**の対象サブテーブルの**取得スナップショット時点の全既存行**を指す。他レコード・他テーブルには及ばず、同文 `APPEND` の追加行は含まない（§4.1）。WHERE 省略と同義だが、書き忘れ事故防止のため省略を許さず明示させる（`REORDER ALL` と同じ発想）。

## 6. post-image 検証と診断出力

### 6.1 検証範囲

通常実行と `VALIDATE ONLY` は、PUT 後の最終レコードである post-image を検証する。

検証対象は変更したセルだけではなく、次の全体である。

- 更新対象親の非更新トップレベルフィールド。
- 親 `SET` 後のトップレベルフィールド。
- 対象外サブテーブルを含む全サブテーブルの全存続行。
- `PATCH` 後の子セル。
- 将来の `APPEND` 行の必須、既定値、型、選択肢、長さ、数値範囲、B29整数部桁数。
- 複数 `APPLY` 合成後の最終レコード。

FILE は監査可能制約を持たないため post-image 検証の対象外とし、payload にも含めない（サブテーブルのパッチ形 payload は未送信セルを保持する）。

検証対象メタデータの導出とセル検証はB42と共有する。B42 は子フィールドの生値と `KintoneFieldInfo` を `validateAndNormalizeDmlValue` へ渡し、必須、数値範囲・桁、文字列長、選択肢を検証する（[ksql_validate_subtable_audit_spec.md:109](ksql_validate_subtable_audit_spec.md#L109)-[115](ksql_validate_subtable_audit_spec.md#L115)。検証 primitive の実装箇所は [dmlValidation.ts:37](../../src/core/dmlValidation.ts#L37)-[106](../../src/core/dmlValidation.ts#L106) である。

候補生成、親単位の invalid 判定、post-image 構築、行ロケータ付与はB44/B43用に新設する。セル単位 primitive だけを再利用し、「payload列だけの検証」に戻してはならない。

全親の post-image 検証、重複検出、件数ガードを最初の PUT より前に完了する。通常実行で1件でも検証エラーがあれば書き込みは0件とする。v1 は `ON ERROR SKIP` を提供しない。

### 6.2 `VALIDATE ONLY`

`VALIDATE ONLY` は実際の対象親スナップショットを取得し、セレクタ解決、重複検出、post-image 構築、制約検証、件数集計まで実施するが、mutation API を呼ばない。

現行の `DmlValidationResult` は `type`、`operation`、`validatedRows`、`validRows`、`invalidRows`、`errorCount`、`columns`、`errors` を持つ（[execute.ts:343](../../src/execute.ts#L343)-[351](../../src/execute.ts#L351)）。B44 はこれを次の形で加法拡張する。

```json
{
  "type": "VALIDATION",
  "operation": "UPDATE",
  "validatedRows": 1,
  "validRows": 1,
  "invalidRows": 0,
  "errorCount": 0,
  "apply": [
    {
      "field": "テーブル",
      "operations": [
        {
          "kind": "PATCH",
          "matchedRows": 2,
          "changedRows": 2
        }
      ],
      "changedSubtableRows": 2,
      "deletedRows": 0
    }
  ],
  "guards": {
    "revisionRequired": true,
    "parentRows": 1,
    "dmlMaxRows": 100,
    "subtableRows": 2,
    "dmlMaxSubtableRows": 100,
    "wouldExceed": false
  },
  "columns": [],
  "errors": []
}
```

件数定義は次のとおり。

- `validatedRows`: post-image を構築・検証した親件数。
- `validRows`: post-image に検証エラーがない親件数。
- `invalidRows`: 1件以上の検証エラーがある親件数。
- `errorCount`: セル単位エラー行数。
- `matchedRows`: 操作のセレクタに一致した既存子行数。
- `changedRows`: 実際に変更計画へ入った子行数。
- `changedSubtableRows`: 同一親・同一テーブル内で変更される子行の重複排除件数。
- `deletedRows`: 最終 payload から除外する既存行数。v1 の `PATCH` では必ず0。

`VALIDATE ONLY` は安全ガード超過でも mutation を行わないため、実件数と `wouldExceed=true` を返せる。ただし selector error、重複操作、未知 `_rid`、型解決失敗、取得上限超過は診断結果へ格下げせず文全体を fail-closed で失敗させる。

### 6.3 エラー列と行ロケータ

B44 `VALIDATE ONLY` の `columns` は、診断対象フィールド列（現行どおり `$id` を先頭に含む）の後ろに次のメタ列を固定順で持つ。

```text
$err_statement
$err_operation
$err_row
$err_field
$err_code
$err_message
$err_value
$err_subtable
$err_subrow
$err_subrow_id
```

**`$id` はメタ列として重複追加しない**（R2）。現行 UPDATE `VALIDATE ONLY` の出力は payload 列として `$id` を既に含む（実測: `["$id","文字列MIN","$err_statement",…]`）ため、`$id` をメタ列側にも置くと同名列が二重に現れる。`$id` は payload 列（先頭）を正とし、メタ列は上記10列で固定する。

現行B12の先頭6メタ列は名前と順序を維持する。現行定義は [dmlValidationCandidates.ts:26](../../src/core/dmlValidationCandidates.ts#L26)-[28](../../src/core/dmlValidationCandidates.ts#L28) にある。

| 列 | 意味 |
|---|---|
| `$err_statement` | バッチ内の1-based文番号 |
| `$err_operation` | `UPDATE` |
| `$err_row` | 対象親候補の1-based序数 |
| `$err_field` | 違反したトップレベルまたは子フィールドコード |
| `$err_code` | B42/B43と共通の検証エラーコード |
| `$err_message` | 検証メッセージ |
| `$id` | 対象親レコード番号 |
| `$err_value` | post-image上の違反値をB42と同じ規則で描画した文字列 |
| `$err_subtable` | 子違反では親サブテーブルコード、トップレベル違反では空文字 |
| `$err_subrow` | 子違反では取得スナップショット内の1-based表示序数、それ以外は空文字 |
| `$err_subrow_id` | 保存済み子行では `_rid` と同値、新規行・トップレベル違反では空文字 |

B42詳細モードのロケータ意味論と列型は [ksql_validate_subtable_audit_spec.md:143](ksql_validate_subtable_audit_spec.md#L143)-[160](ksql_validate_subtable_audit_spec.md#L160) に合わせる。`VALIDATE ONLY INTO #err` は同じ列と型メタを一時テーブルへ実体化する。

### 6.4 `EXPLAIN`

`EXPLAIN` はフォーム定義等の計画用メタデータを取得してよいが、records API と mutation API を呼ばない。このため実際の親件数、マッチ子行数、revision、違反件数は表示しない。現行B42のEXPLAINもrecords/mutation APIを呼ばず、実件数を出さない契約である（[ksql_validate_subtable_audit_spec.md:221](ksql_validate_subtable_audit_spec.md#L221)-[233](ksql_validate_subtable_audit_spec.md#L233)）。

出力は少なくとも次を含む。

```text
statement:              UPDATE APPLY
target app:             APP4221
parent selector:        $id = 8
parent cardinality:     single
apply target:           テーブル (SUBTABLE)
operations:             PATCH
selector:               _rid | SAFE_PREDICATE | ALL_ROWS
snapshot evaluation:    yes
inserted rows visible:  no
revision guard:         required
payload preservation:   row ids=yes, row order=yes, unpatched cells=yes
post-image validation:  required (B43 equivalent)
parent rows:            unknown (records API not called)
matched subtable rows:  unknown (records API not called)
deleted rows:           0 (static for PATCH)
dmlMaxRows:             <resolved value>
dmlMaxSubtableRows:     <resolved value>
MCP mutation:           disabled in v1
records API:            0
mutation API:           0
```

`EXPLAIN` が示す `deleted rows: 0` は `PATCH` の静的性質であり、実マッチ件数ではない。実件数、期待件数判定、ガード超過状況は `VALIDATE ONLY` で確認する。

## 7. 安全性

### 7.1 二重件数ガード

B44 mutation は次の二重ガードを必須とする。

1. `dmlMaxRows`: 対象親レコード数の上限。
2. `dmlMaxSubtableRows`: 変更対象となる子行合計の上限。

`dmlMaxSubtableRows` は、全親・全 `APPLY` を通じた次の合計とする。

```text
PATCH対象の既存行
∪ REMOVE対象の既存行
∪ APPENDする新規行
```

同じ既存行の異なるセルを複数 `PATCH` する場合は1行と数える。既定値は500とし（1年分の日次データ366行を1文で扱える保守値。kintone 制約由来ではない）、正の安全な整数だけを許可する。親側 `dmlMaxRows` は既存 DML と同じ100（v1 は単一親のため実質常に1）。

両件数は、全対象親のスナップショット取得、セレクタ解決、重複排除後、最初の PUT より前に確定する。どちらか一方でも上限を超えれば書き込みは0件とする。

現行サブテーブル UPDATE は確認件数に対象子行数を渡している（[execute.ts:5747](../../src/execute.ts#L5747)-[5759](../../src/execute.ts#L5759)）。B44 はこれを親件数だけへ弱めず、親と子を独立に制限する。

### 7.2 MCP fail-closed

v1 のMCP提供範囲は次に固定する。

- 静的構文検査: 許可。
- `EXPLAIN`: 許可。
- `VALIDATE ONLY`: 許可。
- 実 mutation: 拒否。

`allowDml=true`、`confirmText`、十分な `dmlMaxRows` / `dmlMaxSubtableRows` が指定されても、v1 の `ksql_mutate` は `UnsupportedError` とする。MCPの既存IMPORT方針も、サブテーブル mutation を閉じて `VALIDATE ONLY` / `EXPLAIN` だけを許可している（[mcp/index.ts:60](../../src/mcp/index.ts#L60)-[63](../../src/mcp/index.ts#L63)）。

将来のMCP緩和は、ASTと実行計画から次をすべて証明できる `PATCH` だけを別 capability として検討する。

- `deletedRows=0`。
- 取得時の全既存行 ID が最終 payload に一度ずつ存在する。
- 未知、重複、別親所属の `_rid` がない。
- 既存行順が不変。
- `APPEND`、`REMOVE`、`REORDER` がない。
- revision が必須かつ送信される。
- post-image 検証が完了している。
- 親・子の二重ガード内である。
- `VALIDATE ONLY` で実件数と対象内訳を取得できる。
- MCP capability 判定がSQL文字列検索ではなくASTレベルで行われる。

## 8. 面ごとの提供範囲

| 面 | v1 `EXPLAIN` | v1 `VALIDATE ONLY` | v1 mutation |
|---|---:|---:|---:|
| CLI | 対応 | 対応 | 対応 |
| MCP | 対応 | 対応 | 非対応・fail-closed |
| プラグイン | 対応 | 対応 | 対応 |

### 8.1 CLI

CLI mutation は既存のDML許可・確認に加え、次を必須とする。

- `--allow-dml`。
- 対話確認、または明示的な `--yes`。
- `--dml-max-rows`。
- 新設 `--dml-max-subtable-rows`。
- 確認表示に親件数、テーブル別 `PATCH` / `APPEND` / `REMOVE` 件数、削除件数、revision必須を表示する。

### 8.2 MCP

- `ksql_validate`: 構文・静的契約だけを検証し、APIを呼ばない。
- `ksql_explain`: §6.4の静的計画を返す。
- `ksql_query`: `VALIDATE ONLY` をread-onlyとして実行できる。
- `ksql_mutate`: v1のAPPLY mutationを拒否する。

現行MCPも `ksql_query` で `UPDATE … VALIDATE ONLY` をread-onlyとして扱い、mutating DMLを拒否している（[mcp/index.ts:94](../../src/mcp/index.ts#L94)-[98](../../src/mcp/index.ts#L98)）。`writesKintone` もDMLの `validateOnly=true` を書き込みなしとして分類する（[dmlGuard.ts:53](../../src/core/dmlGuard.ts#L53)-[59](../../src/core/dmlGuard.ts#L59)）。

### 8.3 プラグイン

プラグイン mutation は実行前ダイアログで次を表示する。

- 親件数。
- 変更子行合計。
- テーブル別・動詞別件数。
- `REMOVE` 解禁後は削除件数と削除対象親数。
- 操作が元に戻せないこと。
- revision conflict時に自動再試行しないこと。

既存プラグインは通常DML確認ダイアログを持ち（[desktop.ts:2825](../../src/ui/desktop.ts#L2825)-[2838](../../src/ui/desktop.ts#L2838)）、IMPORTではテーブル別の更新・追加・削除件数を表示している（[desktop.ts:2841](../../src/ui/desktop.ts#L2841)-[2873](../../src/ui/desktop.ts#L2873)。B44は後者と同等以上の内訳表示を使用する。

## 9. v3.8.0 内の実装フェーズ

> **2026-07-20 ユーザー決定**: 以下の v1／v1.1／v1.2 は別release版を表す「段階リリース」ではなく、**v3.8.0を1回だけreleaseするための内部実装フェーズ**へ読み替える。v1をPhase 1～6、v1.1をPhase 7、v1.2をPhase 8で実装し、Phase 9で統合・実機・release準備を行う。各フェーズのreview gateは維持するが、途中版のversion bump・公開は行わない。§9.2のMCP別capabilityはあくまで検討事項、§9.3のREMOVE mutationはCLIと確認UIを持つpluginだけ、MCP mutationはfail-closedという安全条項を変更しない。

### 9.1 v1（Phase 1～6）— 修復用 `PATCH`

提供範囲を次に固定する。

- 親 `UPDATE` のみ。
- 1文につき1サブテーブル。
- 1つの `APPLY` ブロック。
- ブロック内は `PATCH` のみ。
- 親条件は単一親を表す `$id = <正の整数>`。
- 子セレクタは `_rid` または安全な述語。明示的な `ALL ROWS` は常時真の安全な述語として扱う。
- `_idx` は非対応。
- revisionガード必須。
- post-image検証必須。
- `VALIDATE ONLY` / `EXPLAIN` 同時提供。
- MCP mutationは閉じたまま。
- `UPDATE … FROM`、`CHECK`、`ON ERROR SKIP` との併用は非対応。

### 9.2 v1.1（Phase 7）— 複数テーブルと `APPEND`

- 1文内の複数 `APPLY`。
- 異なる複数サブテーブル。
- `APPEND`。
- 新規行の必須・既定値・数値精度を含むpost-image検証。
- 子行追加を含めた `dmlMaxSubtableRows`。
- 削除ゼロを計画で証明できる `PATCH` についてのみMCP別capabilityを検討。

### 9.3 v1.2（Phase 8）— `REMOVE`

- `REMOVE WHERE …`。
- `REMOVE ALL ROWS`。
- 削除行 ID・件数・対象親の事前表示。
- CLI、確認UIを持つプラグインから提供。
- MCP mutationは引き続きfail-closed。

### 9.4 v2 — 文種・セレクタ・集合型拡張（**2026-07-20 ユーザー決定により v3.8.0 に同梱**）

> **2026-07-20 ユーザー決定**: 下記 v2 も別release版でなく **v3.8.0 内の実装フェーズ**として同梱する。実装計画 [ksql_apply_block_impl_plan.md](ksql_apply_block_impl_plan.md) の Phase 10〜17（10a〜17d の23分割）で段階実装し、Phase 17 で統合・実機・release 準備を行う。各 review gate は維持するが途中版の version bump・公開は行わない。**MCP 実 mutation は v2 でも全 APPLY で fail-closed のまま**（実装計画 §16 裁定4）。

- INSERTの初期行（Phase 13）。
- UPSERTのinsert/update分岐（Phase 14）。
- UPSERTで `ON INSERT` を省略した場合、新規親のサブテーブルはkintone既定値とし、`ON UPDATE` を省略した場合は既存サブテーブルを保持する。両方を省略した場合は現行UPSERTと同一とする。
- 複数親（Phase 10・最大100親/chunk・非トランザクション・§4.3）。
- `_idx` セレクタ（Phase 11）。
- `EXPECT ROWS`（Phase 12）。
- 複数値フィールドへの `ADD` / `REMOVE`（Phase 15）。

複数値フィールドでも一般形は変えない。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 8
APPLY 複数選択 (
  ADD '重要';
  REMOVE '新規'
);
```

動詞と対象フィールド型の整合をフォームメタデータ取得後に検証する。`APPLY SUBTABLE`、`APPLY MULTISELECT` のように集合型ごとのnounを追加しない。

## 10. SemVer

推奨は **minor** とする。

理由は次のとおり。

- 新しい後置構文とASTを加える純加法機能である。
- `APPLY`等をsoft keywordとし、既存識別子を予約語化しない。
- `APPLY`を含まない既存UPDATEの構文・意味論・出力は変更しない。
- v1のMCP mutationは既定で閉じるため、既存capabilityを暗黙に拡大しない。
- 新設定 `dmlMaxSubtableRows` はAPPLY mutationにだけ適用する。
- B44 v1／v1.1／v1.2は **v3.8.0** に一括同梱する（2026-07-20ユーザー決定）。B43との実装順にかかわらず、B44の途中フェーズを別版としてreleaseしない。

本リポジトリでは新機能と監査の正しさ改善をminorで提供しており、B42もminor判断である（[ksql_validate_subtable_audit_spec.md:235](ksql_validate_subtable_audit_spec.md#L235)-[243](ksql_validate_subtable_audit_spec.md#L243)）。

## 11. 受入条件・テスト観点

### 11.1 parser・AST

- `UPDATE … WHERE … APPLY テーブル (...) VALIDATE ONLY` を解析できる。
- `APPLY <field> (` の位置だけで `APPLY` をsoft keywordとして認識する。
- `SUBTABLE` nounを要求せず、`APPLY SUBTABLE テーブル` は拒否する。
- 新soft keywordと同名の既存フィールド、alias、アプリ識別子が非回帰。
- 親 `WHERE` 後に複数ブロック、全ブロック後に `VALIDATE ONLY` という句順を固定する。
- ブロック内セミコロン、バッチ文セミコロン、文字列・コメント内セミコロンを区別する。
- ブロック末尾セミコロンの有無を受理する。
- 空ブロック、空操作、同一フィールドのブロック重複を拒否する。
- v1外の `APPEND`、`REMOVE`、複数ブロック、`_idx`、`EXPECT ROWS` は構文として識別したうえで明示的なバージョン対象外エラーにする。

### 11.2 単体・統合

- APP4221の親 `文字列MIN` と `テーブル.文字列T2` を1つのPUT recordへ合成する。
- `_rid`、安全な述語、`ALL ROWS` のマッチ集合が取得スナップショットに対して評価される。
- `_idx` が0-basedであり、v1では拒否される。
- `_rid` 0件はエラー、一般述語0件と0行テーブルの `ALL ROWS` はno-op。
- 同一セル多重PATCH、PATCH/REMOVE重複、未知・重複・別親 `_rid` をPUT前に拒否する。
- `APPEND` 行が同文のPATCH/REMOVEから不可視。
- 対象外行、未指定セル、行ID、行順をPATCH後も保持する。
- 対象親GETに `$id`、`$revision`、親SET参照列、対象サブテーブル全体、post-image検証に必要なフィールドが含まれる。
- PUT recordに取得時revisionが含まれる。
- 1親につきPUT record要素が1件であり、親変更と子変更を別PUTへ分割しない。
- 将来の複数親テストでは100親ごとのチャンクになる。
- 後続チャンク失敗時に先行チャンクが成功済みである非トランザクション性を結果・文書で隠さない。
- 全post-image検証、重複検出、`dmlMaxRows`、`dmlMaxSubtableRows` 判定が最初のPUTより前に完了する。
- 親1件・子501行では `dmlMaxRows=1` を満たしても、既定 `dmlMaxSubtableRows=500` で書き込み0件となる。
- 同一子行の複数セル変更は子件数1として数える。
- post-image検証が親の非更新フィールド、対象外テーブル、未変更子行の既存違反も検出する。
- 子エラーに `$id`、`$err_subtable='テーブル'`、1-based `$err_subrow`、`$err_subrow_id=_rid` が入る。
- トップレベルエラーではサブテーブルロケータ3列が空になる。
- `VALIDATE ONLY` は実マッチ件数、変更子行数、削除件数、ガード判定を返し、mutation APIを0回にする。
- `EXPLAIN` はmetadata以外のrecords/mutation APIを0回とし、実件数を表示しない。
- revision conflictを自動再試行せず、書き込み成功として報告しない。
- MCPは`EXPLAIN` / `VALIDATE ONLY`を許可し、mutationを`allowDml`等の指定にかかわらず拒否する。
- CLIとプラグインは親件数・子件数を確認表示する。

### 11.3 実機確認

実機は APP4221 を使用する。ただし `$id=7` はB42/B43の既存証拠フィクスチャとして温存し、B44試験では別レコードを作成する（[ksql_b44_syntax_ideas.md:572](ksql_b44_syntax_ideas.md#L572)-[575](ksql_b44_syntax_ideas.md#L575)）。

実機手順は次を含む。

1. APP4221に復旧可能な専用レコードを作り、`$id`、revision、`テーブル`の全行IDと全値をsnapshotとして保存する。
2. フォーム制約変更等により、トップレベル `文字列MIN` と子 `テーブル.文字列T2` に既存違反が混在する状態を作る。
3. 親だけを修正する従来UPDATEが `CB_VA01` で失敗することを確認する。
4. 子だけを修正する従来サブテーブルUPDATEも、残る親違反により失敗することを確認する。
5. B42 `VALIDATE` が同じ親・子違反を返し、子違反の `$err_subrow_id` が実行前snapshotの行IDと一致することを確認する。
6. B44 `VALIDATE ONLY` が、親・子を同時修復したpost-imageを `validRows=1`、`invalidRows=0` と判定し、PATCH件数と二重ガードを表示する。
7. 同じB44文を実行し、親 `文字列MIN` と対象行 `文字列T2` が同時に更新されることを確認する。
8. 対象外サブテーブル行、未指定セル `数値T1`、行ID、行順が不変であることを確認する。
9. 再度B42 `VALIDATE` を実行し、対象違反が消えていることを確認する。
10. GET後PUT前に別更新を挟み、revision conflictでB44が拒否されることを確認する。
11. CLIとプラグインで結果・件数・確認表示が一致し、MCP mutationがfail-closedになることを確認する。
12. 試験終了後に制約と専用レコードを復元または削除し、`$id=7`を含む既存証拠フィクスチャが変更されていないことを記録する。

## 12. 対象外

R1およびv1では次を対象外とする。

このうち「複数サブテーブル／複数 `APPLY`／`APPEND`」はv1.1（Phase 7）で、「`REMOVE`」はv1.2（Phase 8）で解禁する。v3.8.0最終scopeでも対象外のままなのは、親DELETE、`UPDATE ... FROM`等の相関更新、MCP実mutation、および下記の恒久非対応項目である。**親INSERT／UPSERT、複数親、`_idx`、`EXPECT ROWS`実行、複数値fieldの`ADD`／`REMOVE` は 2026-07-20 ユーザー決定により §9.4 の v2 として v3.8.0（Phase 10〜17）へ同梱する**（従来「対象外」だったが解禁）。

- `APPLY SUBTABLE` noun構文。
- 親INSERT、UPSERT、DELETE。
- 複数親への適用。
- 複数サブテーブル、同一サブテーブルの複数ブロック。
- `APPEND`、`REMOVE`、行置換、`REPLACE`、`REORDER`。
- `_idx` による更新。
- `EXPECT ROWS` の実行。
- `UPDATE … FROM`、CTE、一時テーブルを使った親子相関更新。
- `ON ERROR SKIP`、`REJECT LIMIT`。
- `APPLY` 内の `CHECK`、子行スコープのカスタム制約。
- B42監査結果から修復SQLを自動生成・自動実行する機能。
- revision conflict時の自動再取得・再評価・再試行。
- 文全体のトランザクション、チャンク間ロールバック、補償更新。
- サブテーブル間、親子間、レコード間の参照整合性検証。
- FILEフィールド。
- （複数値フィールドの `ADD` / `REMOVE` は §9.4 の v2 として v3.8.0 Phase 15 で提供＝対象外から解除）
- MCPからの実mutation。
- 現行 `APP<n>$テーブル` DMLの構文・安全規則変更。現行UPDATE/DELETEは引き続き `_rid` 条件を必須とする（[execute.ts:5722](../../src/execute.ts#L5722)-[5731](../../src/execute.ts#L5731)、[execute.ts:5802](../../src/execute.ts#L5802)-[5811](../../src/execute.ts#L5811)）。
- 現行サブテーブルDMLへの `VALIDATE ONLY` / `ON ERROR SKIP` の追加。現行parserはこれらを明示拒否している（[parser.ts:2447](../../src/parser/parser.ts#L2447)-[2453](../../src/parser/parser.ts#L2453)、[parser.ts:2644](../../src/parser/parser.ts#L2644)-[2650](../../src/parser/parser.ts#L2650)）。
- プレーン DML（`APPLY` なし）の post-image 検証（=台帳 B43 本体。§1 の R2 注記参照）。

## 13. レビュー履歴

### R1 → R2（2026-07-20・Claude レビュー）

**裏取り**: 主要引用をサンプリング検証し**全て一致**。特に「現行サブテーブル UPDATE は親 revision を読み取り PUT に設定」（[execute.ts:5899](../../src/execute.ts#L5899) `getRevision`・[execute.ts:5904-5925](../../src/execute.ts#L5904-L5925) `buildSubtablePutParams` が `revision` を records 要素へ設定）は事実＝§5.4 の revision ガードは既存実装の必須化であり新規発明ではない。ほか、システム列代入拒否（[execute.ts:5774](../../src/execute.ts#L5774) `a.field.startsWith("_")`）・MCP のサブテーブル mutation fail-closed（mcp/index.ts ヘルプ・ksql_query 登録）・`VALIDATION_META_COLUMNS`（dmlValidationCandidates.ts:26-28）を確認。引用行番号に ±数行のズレが数か所あるが同一箇所を指しており効力に影響なし（P3・修正不要）。

**R2 反映（P2×2）**:

1. **P2-a `$id` 列の重複**（§6.3）: R1 はメタ列リストに `$id` を含めていたが、現行 UPDATE `VALIDATE ONLY` の出力は payload 列として `$id` を既に含む（実測裏付け）→ 同名列の二重出現になるため、`$id` は payload 列を正としメタ列から除外・メタ10列で固定。
2. **P2-b B43 との関係**（§1・§12): 三段連携の記述だけでは「B44 実装で B43 も解決される」と誤読し得る → post-image 検証は `APPLY` 文限定・プレーン DML の B43 は独立課題として残る旨を明記し、§12 対象外にも追加。

**判定**: 上記反映のうえで**仕様として実装着手可の水準**（着手はユーザー承認待ち）。codex 起草の意味論（スナップショット・二重ガード・段階リリース・MCP fail-closed）は無変更。

### R2 フェーズ統合決定（2026-07-20・ユーザー決定）

v1／v1.1／v1.2を別releaseにせず、v3.8.0内のPhase 1～8として段階実装し、Phase 9の統合・実機gate後に1回だけreleaseする。上記Claudeレビューのスナップショット・二重guard・MCP fail-closed等の安全判断は維持し、§9の表現だけを「段階リリース」から「実装フェーズ」へ読み替えた。

