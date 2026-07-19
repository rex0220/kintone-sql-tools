# B39 IMPORT cli-kintone 互換取込仕様（R2）

- 作成日: 2026-07-19
- ステータス: **設計 R2・Claude R1レビュー反映済み・未実装**
- 分担: codex=設計／Claude=レビュー／実装担当=未定
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 関連: [IMPORT v1 仕様 R4](ksql_import_statement_spec.md)・[IMPORT v2 仕様 R1](ksql_import_v2_spec.md)・[cli-kintone 比較評価 R2](ksql_import_vs_cli_kintone_evaluation.md)
- 対象: cli-kintone `record export` の CSV を、変換用の中間ファイルなしで kSQL IMPORT へ戻す round-trip。添付ファイルは対象外。

変更履歴: R1→R2で、段3のテーブル取込例、FILE列の扱い、空テーブル全削除とUPDATE空セルの警告、段1の適用限界、JSON/CSV間の行ID意味論の未確定事項を追加した。

## 1. 目的と設計原則

本仕様は、cli-kintone export CSV の型表現、ヘッダ名、レコード番号、先頭 `*` とサブテーブル行 ID を段階的に解釈する互換取込を、v1/v2 の内部契約へ**加法的**に追加する。IMPORT は現時点では未実装であり、本書の `materializeDmlSource` 等は v1 R4 で確定した実装予定名である。現行コードの実在型は平坦な `MaterializedTable {rows, columns, columnMeta?}` だけである（[execute.ts:244-257](../../src/execute.ts#L244)）。

原則は次のとおり。

1. 既存の位置対応と SELECT 射影を壊さない。互換動作は `BY NAME` 等の明示句がある文だけに適用する。
2. 入力行・子行を黙って捨てない。未知列無視、レコード番号不一致、空テーブル行、破壊的全置換は EXPLAIN と処分結果へ現す。
3. サブテーブルの不良 child だけを落として親を部分書込みしない。隔離単位は親 record 全体とする（v2 R1 [§6.2](ksql_import_v2_spec.md#L148)）。
4. cli-kintone のサブテーブル update と同じく、指定テーブルは行 ID を照合し、入力に無い既存行を削除する。ただし `REPLACE SUBTABLES` の明示を必須にし、通常 IMPORT へ破壊を持ち込まない。
5. `BY`、`NAME`、`MATCH`、`RECORD`、`IGNORE`、`UNKNOWN`、`COLUMNS`、`REPLACE`、`SUBTABLES`、`ROW`、`ID` は IMPORT parser 内だけで識別子文字列を文脈判定する**ソフトキーワード**とし、`KEYWORDS` へ追加しない。現行 lexer は固定 map で予約語化する構造である（[tokens.ts:199](../../src/lexer/tokens.ts#L199)）。

## 2. 段階と互換性の定義

| 段 | deliverable | round-trip の到達点 | SemVer | 工数 |
|---|---|---|---:|---:|
| 0 | 数値契約の確認・文書/回帰 | フラット NUMBER の INSERT（CALC は無視） | patch（文書/回帰のみ） | 1〜2人日 |
| 1 | `BY NAME`、export列選別、LF複数値 | フラット CSV INSERT/業務キー UPSERT | minor | 6〜10人日 |
| 2 | レコード番号一致の純 UPDATE | export→編集→既存 record 更新 | minor | 5〜8人日 |
| 3 | `*`、行 ID、親子 payload、全置換 | サブテーブルを含む snapshot 更新/作成 | minor | 16〜25人日 |

段0は v1実装時の確認項目として同梱してよい。段1〜3はそれぞれ独立した minor release とし、後段を前段の受入条件にしない。累計は **28〜45人日**（レビュー修正、添付、実機負荷試験を除く）。

## 3. 共通構文と AST

### 3.1 構文

```text
-- v1 の位置対応（従来どおり）
IMPORT INTO APP100 (顧客コード, 金額)
FROM CSV src SELECT code, amount;

-- 段1: ヘッダ名対応
IMPORT INTO APP100 (顧客コード, 金額, 担当者)
FROM CSV exported BY NAME
[ IGNORE UNKNOWN COLUMNS ]
[ ON DUPLICATE (顧客コード) ]
[ CHECK ... ]
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ];

-- 段2: 挿入しないレコード番号一致 UPDATE
IMPORT UPDATE INTO APP100 (顧客コード, 金額)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
[ IGNORE UNKNOWN COLUMNS ]
[ CHECK ... ]
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ];

-- 段3: 指定テーブルだけを破壊的全置換
IMPORT UPDATE INTO APP100 (
  顧客コード,
  明細 (品名, 数量) ROW ID SOURCE `明細_行ID`,
  承認 (承認者) ROW ID SOURCE `承認_行ID`
)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細, 承認)
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ];
```

`SOURCE <header>` は CSV ヘッダの exact・case-sensitive・trimなしの名前であり、ロケール依存のシステム列名を推測しない。`IMPORT UPDATE` と `ON DUPLICATE` は排他である。`REPLACE SUBTABLES` は `IMPORT UPDATE` または将来の業務キー UPSERT と併用できるが、段3の初回 deliverable は事故面積を狭めるため上例のレコード番号 UPDATE と INSERT に限定する。

### 3.2 AST 差分

v1 R4 の予定 `DmlSource` の CSV variant へ次を加える。

```text
CsvImportMapping =
  | { mode: "POSITIONAL" }
  | { mode: "BY_NAME", ignoreUnknownColumns: boolean }

ImportWriteMode =
  | { kind: "INSERT" }
  | { kind: "UPSERT", keyFields: string[] }
  | { kind: "UPDATE_RECORD_NUMBER", sourceHeader: string }

ImportTarget =
  | { kind: "FIELD", fieldCode: string }
  | { kind: "SUBTABLE", subtableCode: string, children: string[], rowIdHeader: string }

ImportStatement += {
  mapping: CsvImportMapping,
  writeMode: ImportWriteMode,
  targets: ImportTarget[],
  replaceSubtables: string[]
}
```

現行 AST の UPSERT は書込み `fields` と `keyFields` を持ち（[ast.ts:636-648](../../src/types/ast.ts#L636)）、SELECT UPSERT も同形である（[ast.ts:655-666](../../src/types/ast.ts#L655)）。レコード番号 UPDATE をここへ混ぜず、判別可能な別 `writeMode` にする。

### 3.3 テーブル取込の記述例

#### 例1: 単一サブテーブルの全置換 UPDATE

CSV `orders`:

```csv
"*","レコード番号","顧客コード","明細_行ID","品名","数量"
"*","1","C001","10","りんご","5"
"","","","11","みかん","3"
"*","2","C002","20","ぶどう","8"
"*","3","C003","","",""
```

```sql
IMPORT UPDATE INTO APP100 (
  顧客コード,
  明細 (品名, 数量) ROW ID SOURCE `明細_行ID`
)
FROM CSV orders BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細);
```

レコード1は行ID 10、11を更新してその他の既存行を削除し、レコード2は行ID 20を更新してその他を削除する。レコード3は、親開始行に `*` がある一方、明細の行IDと全childセルが空なので有効child 0件となり、明細を全削除する。`MATCH RECORD NUMBER SOURCE` は照合キー専用でpayloadへ入らない。`REPLACE SUBTABLES` が無い文は全置換として成立せず、削除を実行できない。

#### 例2: 行IDの更新・追加・削除混在

レコード5の明細入力で、行ID `30` が対象レコードの既存明細にあればそのID付きで更新する。行IDが空の行はIDなしpayloadで追加し、kintoneに採番させる。行ID `99` が対象レコードの明細に無ければ、そのIDは送らず新規追加し、監査値 `rowIdNotFound/addRows` に計上する。既存明細にあるが入力に無い行IDは、全置換payloadから欠落するため削除する。これは §7.2 の対象親×対象table照合に従い、別親または別tableにだけ存在するIDも「対象tableに無い」と扱う。

#### 例3: 複数サブテーブル＋不良行隔離

```sql
IMPORT UPDATE INTO APP100 (
  顧客コード,
  明細 (品名, 数量) ROW ID SOURCE `明細_行ID`,
  承認 (承認者) ROW ID SOURCE `承認_行ID`
)
FROM CSV orders BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細, 承認)
ON ERROR SKIP INTO #err REJECT LIMIT 10;
```

列挙した明細と承認だけを全置換し、未列挙tableはpayloadから省略して維持する。不良childの隔離単位は親全体であり、`REJECT LIMIT 10` はchild error数でなくinvalid親数を数える。`#err` は `$err_subtable/$err_subrow/$err_source_row` により論理位置とCSV物理行を示す。

#### 例4: VALIDATE ONLYによる削除差分の事前確認

```sql
IMPORT UPDATE INTO APP100 (
  明細 (品名, 数量) ROW ID SOURCE `明細_行ID`
)
FROM CSV orders BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細)
VALIDATE ONLY;
```

書込みは0件だが、既存recordのread、対象親×tableの行ID照合、削除差分計算まで実行し、table別 `existingRows/inputRows/updateRows/addRows/deleteRows` と全errorを返す。

## 4. 段0 — 数値互換

### 4.1 決定

cli-kintone の NUMBER export は桁区切り・ロケール整形のない CSV string なので、その字面を JavaScript `number` に変換せず `string` のまま既存厳密10進検証へ渡す。現行 `validateAndNormalizeDmlValue` は NUMBER を exact decimal として検査し、整数部の許容桁もアプリ設定から検査する（[dmlValidation.ts:53-74](../../src/core/dmlValidation.ts#L53)）。よって通常の NUMBER round-trip に新しい値変換は不要である。

### 4.2 壊れる端

- **大きな精度**: CSV decoder/SELECT射影で一度でも IEEE-754 number 化すると壊れる。生 `BY NAME` は string を保持する。`CAST` 等の射影を使った場合はその式の精度契約に従い、「cli互換の字面保持」は保証しない。
- **CALC**: `CALC` は非書込みである（[execute.ts:3940-3942](../../src/execute.ts#L3940)）。export 列は §5 の既知非書込み列として無視できるが、`INTO` に指定したら analyze error とする。計算結果は取込後に再計算され、CSV値の復元ではない。
- **空セル**: NUMBER の `""` と未指定は位置対応では区別できない。INSERT では空値として既定値/必須/型検証へ渡す。UPDATE では `INTO` に列が存在する以上、空セルは明示クリアであり、維持したい列は `INTO` から外す。
- **UPDATE round-tripの破壊性**: cli-kintone exportは選択したexport列の空セルも出力する。export列をそのまま `BY NAME` の `INTO` に全指定すると、空セルは「未指定」ではなく明示クリアになり、既存値を維持しない。UPDATEでは変更対象だけを `INTO` に列挙することを必須の利用者警告とする。
- **指数、符号、小数桁、範囲**: export 自身の正規値は通る想定だが、編集後の指数表記やアプリ設定を超える桁は既存 NUMBER 検証結果に従い field error とする。

EXPLAIN は `sourceValueMode=string-preserving`、NUMBER/CALC/空セルの扱い、射影を使う場合は `roundTripNumericGuarantee=false` を表示する。

## 5. 段1 — BY NAME とフラット互換

段1はフラットCSV専用である。サブテーブルを持つアプリのcli-kintone exportは `*` markerと行ID列を含むため、段1へそのままround-tripできず、段3を必須とする。

### 5.1 名前対応と SELECT の優先順位

`BY NAME` は CSV header→宛先 field code の名前対応で、`INTO` は書込み allowlist かつ出力順を定める。各宛先 field `f` は同名 header `f` を1つだけ要求する。重複 header、対象 header 欠落、同じ header の二重消費は source schema error とする。

`BY NAME` と既存 `SELECT` 射影は**段1では排他**とする。名前対応後に SELECT を許すと、header名、射影alias、INTO名の三者で優先順位と CHECK scope が曖昧になるためである。変換が必要なら従来の位置対応 `FROM CSV ... SELECT ...` を使う。現行 INSERT SELECT は `columns[i] -> fields[i]` の位置対応である（[execute.ts:4745-4770](../../src/execute.ts#L4745)）。これを変更せず、`BY NAME` materializer が `INTO` 順の `MaterializedTable.columns/rows` を作って同じ下流へ渡す。

### 5.2 非書込み列・未知列（判断②）

安全側の既定は次の三分類とする。

1. `INTO` にある書込み可能なトップレベル field: 取り込む。
2. フォーム上で既知だが `CALC`、レコード番号、作成者/更新者、作成/更新日時、ステータス、作業者、カテゴリー、関連レコード、SUBTABLE、lookupコピー、`FILE`、または段1ではsubtable child: **export付随列として無視**し、EXPLAINに列名と理由を列挙する。現行非書込み集合とトップレベル検査は [execute.ts:3940-3963](../../src/execute.ts#L3940)、lookupコピーを含むフォーム判定は [formFieldInfo.ts:49-61](../../src/core/formFieldInfo.ts#L49) が根拠である。ただし `FILE` はどちらの `NON_WRITABLE_FIELD_TYPES` にも含まれず、現行判定上はwritableになり得る（[formFieldInfo.ts:50-62](../../src/core/formFieldInfo.ts#L50), [execute.ts:3940-3962](../../src/execute.ts#L3940)）。本仕様は添付ファイルを対象外とするためIMPORT analyzeで別途非対応に分類し、`INTO` 指定時はanalyze error、非指定時だけallowlist外の既知export列として監査付きで無視する。
3. フォームにも互換メタ列にも無い真の未知 header: 既定は `ERR_IMPORT_UNKNOWN_COLUMN` で文全体拒否。明示 `IGNORE UNKNOWN COLUMNS` のときだけ無視し、列名・非空セル数を EXPLAIN/結果へ出す。

これは cli-kintone `--fields` 相当を SQL の `INTO` で表しつつ、タイポを黙殺しない判断である。既知システム列も `INTO` に書けば「無視」へ降格せず非書込み analyze error とする。レコード番号だけは段2の `MATCH ... SOURCE` として入力専用利用できる。

### 5.3 複数値 LF

`BY NAME` の生CSVセルに限り、CHECK_BOX、MULTI_SELECT、USER_SELECT、ORGANIZATION_SELECT、GROUP_SELECT は RFC4180 decode 後のセル内 LF で分割する。CRLF は CSV parser がセル内容として保持した後、要素区切りとして `\r\n|\n` を正規化する。空セルは `[]`、非空セルの空要素（末尾LF、連続LF）は `ERR_IMPORT_MULTI_EMPTY_ITEM` とし黙って落とさない。ユーザー系は各要素を `{code}` にする。現行関数は JSON array の後にカンマ分割しか行わない（[execute.ts:3905-3929](../../src/execute.ts#L3905)）ため、グローバル挙動を変えず `convertImportCsvValue(raw, type, {cliKintone:true})` を新設し、非互換DMLのカンマ契約を維持する。

### 5.4 実行配線

- v1 R4 の `materializeDmlSource` CSV分岐で header schema を構築し、BY NAME mapping、列分類、LF変換用の生値/presenceを保持した `MaterializedTable` を作る。
- 通常 INSERT、UPSERT、CHECK/VALIDATE候補の3経路を共通 materializer へ接続する。現行分岐点は INSERT [execute.ts:4726-4743](../../src/execute.ts#L4726)、UPSERT [execute.ts:5578-5595](../../src/execute.ts#L5578)、候補生成 [execute.ts:4189-4233](../../src/execute.ts#L4189) である。
- 書込先の存在・トップレベル・writable検査は既存 `assertWritableTopLevelDmlFields` 相当を再利用する（[execute.ts:3944-3964](../../src/execute.ts#L3944)）。

### 5.5 エラー、EXPLAIN、処分句

CSV decode、重複header、対象header欠落、未知列既定拒否は **source/schema error** で、`VALIDATE ONLY`/`ON ERROR SKIP` でも文全体・書込み0件。型、必須、選択肢、LF空要素、CHECK は **row/field error** として既存処分へ渡す。`ON ERROR SKIP` は不良親行を `#err` へ隔離し、`REJECT LIMIT` を数える。`VALIDATE ONLY` は全行を検証し書込み0件。`#err` の `$err_row/$err_field/$err_code/$err_message` を維持し、元セルは既存source列として再利用可能にする。

EXPLAIN は `mapping=BY_NAME`、書込み列、既知無視列と理由、未知列方針、複数値 delimiter=`LF`、位置対応/射影非使用、推定親行数を表示する。

## 6. 段2 — レコード番号キー純 UPDATE

### 6.1 意味論

`IMPORT UPDATE ... MATCH RECORD NUMBER SOURCE h` は source header `h` を照合専用キーとして読み、該当する既存 record の指定 writable fieldsだけを PUTする。キー列自身は payloadへ入れない。現行 `ON DUPLICATE` はキーが書込み fields に含まれることを要求する（[execute.ts:4248-4255](../../src/execute.ts#L4248)）ため流用しない。一方、一般の `UPDATE ... FROM` は `$id` を RECORD_NUMBER join key として扱える（[execute.ts:4541-4568](../../src/execute.ts#L4541)）ので、照合/正規化の考え方は共有できるが、CSV sourceをtemp/JOINへ公開せず IMPORT内部で完結させる。

レコード番号は空でないASCII 10進整数（先頭 `+`、小数、指数、空白trimなしを拒否）とし、アプリコードprefix付き表示はR1対象外。source内の同一番号重複は `ERR_RECORD_NUMBER_DUP_SOURCE` で文全体・書込み0件。存在しない番号、他アプリ相当、空番号は row error とする。

### 6.2 新旧混在

この文は**純UPDATE**であり、番号空欄の新規行をINSERTしない。新旧混在CSVは、通常モードでは最初の新規行で書込み前に失敗、`VALIDATE ONLY`では全件報告、`ON ERROR SKIP`では新規/不一致行を `#err` に隔離して一致行だけ更新する。新規行も作りたい利用者は、番号ありを段2、番号なしを通常INSERTへ明示的に分ける。自動UPDATE-or-INSERTは、挿入時にレコード番号を指定できないことと処理順依存を隠すため採用しない。

### 6.3 配線・EXPLAIN

`materializeDmlSource` 後、書込み候補生成前に全キーを正規化・重複検査し、必要IDだけを決定的なchunkでreadする。候補は常に `mode=update,targetId=id` とし、create分岐を持たない。confirm件数は合格した更新親件数である。

EXPLAIN は `writeMode=UPDATE_RECORD_NUMBER`、source key header、source親行数、重複数、match/unmatched/invalid件数（実行前readを行うEXPLAINの場合）、`inserted=0` を表示する。未一致数が不明の静的EXPLAINでは `requiresLookup=true` とする。

## 7. 段3 — cli-kintone `*` サブテーブル取込

### 7.1 CSV grouping

- 先頭 `*` headerをmarker列として必須化する。marker非空行が親record開始、後続のmarker空行が同じ親の継続行である。先頭が空、marker値が不正、親開始が判定不能ならsource error。
- 親fieldは開始行だけから採用する。cli-kintone の実 `*` export は継続行にもtable外field（レコード番号を含む）の値を繰り返し出力し、それらを読込時には無視する。この実挙動との互換性のため、継続行の親セルが空または開始行と完全一致なら受理して無視する。非空かつ開始行と異なる場合だけ、壊れたgroupを検出するため `ERR_IMPORT_PARENT_VALUE_ON_CONTINUATION` とする。従来案の「非空なら無条件error」は実exportをround-tripできないため訂正する。
- 各宣言subtableはそのchild header群と `ROW ID SOURCE` headerを所有する。同じCSV行で複数tableのchild群が非空なら、それぞれのtableへ1 child rowずつ追加できる。
- あるtableのchild全列と行IDがすべて空の行は、そのtableについて**行なし**として無視する。ただし他tableの行は有効。非空childがあるのに行IDだけ空なら新規child、行IDだけ非空でもchild全列空なら既存空行の保持/更新候補として有効とする。
- 複数tableを同時に扱う。`REPLACE SUBTABLES (T...)` に列挙したtableだけが全置換対象で、CSVに存在しても未列挙tableはpayloadから省略して維持する。未列挙tableのchild列を `INTO` に宣言することはanalyze error。

### 7.2 行 ID と破壊的全置換

UPDATE対象の各tableについて既存行ID集合を取得し、入力を次のように処理する。

- 入力行IDが既存table内にある: そのID付きで更新し、未指定childは既存値維持ではなく、宣言childのCSV空/値を用いた**snapshot行**として検証する。
- 入力行IDが空: idなしpayloadとして追加し、kintoneに採番させる。
- 入力行IDが対象親・対象tableの既存集合にない: cli-kintone互換として入力IDをpayloadへ送らず、idなしの新規行として追加する。これは黙った降格にせず `rowIdNotFound/addRows` を親×tableでVALIDATE/EXPLAIN/confirmへ表示する。別親・別tableに同じIDが存在する場合も対象tableでは「無い」ため追加だが、監査情報に `rowIdOwnedElsewhere=true` を付ける。source内同一table行ID重複だけは結果が順序依存になるためglobal preflight errorとする。
- 既存行IDのうち入力に無いもの: payloadから除外し削除する。削除予定数は親×tableでpreflightし、confirmとEXPLAINに含める。

ユーザー確定の全置換を採用するため、`REPLACE SUBTABLES (明細,...)` は必須である。単なる `BY NAME` やtable target宣言だけでは削除を許可しない。空行しかないtableはCSV表現上「明示空配列」と区別できないため、**全置換宣言済みtableで親開始行を含むgroupに有効childが0件なら空table＝既存全行削除**とする。これは「うっかりchildセルをすべて空にした」入力でも全削除になる最も危険な事故面であり、暗黙の維持へ読み替えない。EXPLAINで `replacementRows=0/deletions=n` と目立つ警告を表示する。

### 7.3 二層sourceと親子書込み

CSV `*` materializerはv2 R1の別入口 `materializeImportRecords(...) -> MaterializedImportRecords` へ変換する。親位置とchild位置を保持する概念型はv2 R1 [§5.2](ksql_import_v2_spec.md#L113) を再利用し、次を加える。

```text
child += { sourceRowNumber, rowId?: string }
record += { markerRowNumber, replacementTables: Set<string> }
```

平坦 `MaterializedTable` や全DMLの `KintoneRecord` unionを再帰化しない。既存サブテーブルINSERTは既存行を残して追加し（[execute.ts:5126-5155](../../src/execute.ts#L5126)）、`_pid` 必須である（[execute.ts:5114-5118](../../src/execute.ts#L5114)）。既存UPDATEも `_rid` 条件必須（[execute.ts:5167-5205](../../src/execute.ts#L5167)）なので、いずれにも委譲しない。IMPORT専用payload builderが親トップレベル値と各tableの全row配列を1 PUT recordに組み立てる。現行helperにもtable全配列PUTの形はあるが `unknown as string` castを使う（[execute.ts:5343-5363](../../src/execute.ts#L5343)）ため、v2 R1どおり再帰payload型を新設する。

INSERTでは行IDをAPIへ送らず全childを新規採番させる。CSVに非空行IDがあれば「別環境への新規INSERTでID再現は不可」としてrow errorにし、黙って捨てない。UPDATEでは親トップレベルと列挙tableを同じPUT recordへ入れ、親＋全tableをAPI batch境界で分割しない。

### 7.4 検証、4層エラー、処分句

フォームflattenはchildの `inSubtable` しか保持せず親table所属を失う（[formFieldInfo.ts:21-54](../../src/core/formFieldInfo.ts#L21)）ため、raw formから `subtableCode -> child infos` indexを構築する。childの型/必須/選択肢/NUMBER精度はv2 R1の専用subtable-aware候補検証を使う。

エラー位置は `parentRow, subtableCode, childRow, childCode` の4層とし、`#err` に `$err_subtable/$err_subrow` を追加する（v2 R1 [§6.2](ksql_import_v2_spec.md#L148)）。CSV物理行は `$err_source_row` も追加し、親開始行とchild物理行を区別する。

- 通常モード: source/schema/preflight/row errorを全書込み前に検出し、1件でもあれば文全体0件。
- `VALIDATE ONLY`: 既存read、行ID照合、削除差分計算まで実行し、追加/更新/削除予定数と全errorを返す。書込み0件。
- `ON ERROR SKIP`: 不良childを含む親全体を `#err` に隔離し、その親ではトップレベル更新も削除も行わない。合格親だけ全置換する。
- `REJECT LIMIT`: error行数でなくinvalid親数を数える。同じ親の複数child errorは1 reject。

### 7.5 EXPLAIN とconfirm

静的EXPLAINは `sourceFormat=CLI_KINTONE_CSV`、marker header、親/継続物理行数、対象table、row-ID header、`replacement=destructive`、未知列方針を出す。既存readを伴う実行計画/VALIDATEではtable別に `existingRows/inputRows/updateRows/addRows/deleteRows`、親合計、invalid親数を出す。

confirmには通常DML件数に加え `parentsToWrite`、`subtableRowsToAdd/update/delete`、対象table名を渡す。削除が1件以上なら確認文の先頭・最も目立つ位置に **「サブテーブル全置換・N行削除」** を表示し、一般のUPDATE確認へ埋没させない。空tableによる既存全行削除も同じ専用警告の対象とする。confirm capabilityがこの内訳を表示できない面は段3を実行不可とし、MCP/CLI/pluginで黙った破壊を許さない。

## 8. エラー分類一覧

| 層 | 例 | 処分句で隔離 | 書込み |
|---|---|---:|---:|
| parse/analyze | 句の排他、table未宣言、非書込みをINTO指定 | 不可 | 0 |
| source/schema | CSV不正、header重複/欠落、marker不正、未知列既定拒否 | 不可 | 0 |
| global preflight | source内record番号/行ID重複、全置換句欠落、上限超過 | 不可 | 0 |
| parent/field | record番号未一致、NUMBER不正、CHECK | 可 | 親単位 |
| child/field | 行ID不一致、child型不正、継続行親値 | 可 | 親単位 |

global重複を隔離しないのは、入力順で結果を変えないv1 R4の `ERR_KEY_DUP_SOURCE` 方針と同じである。現行候補でもsource内UPSERT key重複を検出する（[execute.ts:4253-4273](../../src/execute.ts#L4253)）。

## 9. 受入条件

### 9.1 段0/1

1. 30桁級NUMBERを文字列のまま保持し、CALC/system列を監査付きで無視する。
2. header順がINTO順と異なってもBY NAMEで正しく書き、重複/欠落headerを全体拒否する。
3. 既知非書込み列、未知列既定拒否、明示未知列無視の3分類がEXPLAINと結果で区別できる。
4. 5種の複数値型がセル内LFで配列化され、空要素を黙って落とさない。
5. 位置対応とSELECT射影の既存意味が非回帰で、BY NAMEとの排他がparse/analyzeで明確である。

### 9.2 段2

1. record番号は照合だけに使われpayloadへ入らず、INSERT件数は常に0。
2. source重複は全体拒否、空/未一致は親row errorで処分句に従う。
3. 新旧混在を自動UPSERTせず、SKIP時だけ既存一致親を更新する。

### 9.3 段3

1. **親groupの対象tableについて行ID・全childセルが空なら、有効child 0件として既存全child行が削除される**ことを実機で確認し、VALIDATE/EXPLAIN/confirmの削除件数と一致する。
2. 複数table、同一物理行の複数table child、空table行、継続行を決定的にgroup化する。
3. `REPLACE SUBTABLES` なしでは既存child削除が1件も起きない。
4. 既存ID更新、空ID追加、未知ID追加、入力欠落ID削除を実機で確認し、VALIDATE/EXPLAINの差分件数と一致する。
5. child error時は親全体が隔離され、その親のトップレベル値・他table・削除も一切書かれない。
6. 4層位置とCSV物理行が `#err` から追跡できる。
7. confirm詳細を表示できない実行面がfail-closedになる。

## 10. v1/v2 R1との整合と差分

- v1 R4の平坦 `MaterializedTable`、3実行経路、位置対応、SELECT射影、B12/B37、10MiB/source、源内UPSERT重複拒否を維持する。本書段1はCSV materializerの別mapping modeである。
- v2 R1の `MaterializedImportRecords`、専用再帰payload、親単位隔離、4層位置、既存subtable DML非流用を継承する。
- **意図的差分1**: v2 R1 §7はJSON UPSERTで `_rid` を受けず全行を新規採番する。本書段3はcli-kintone互換のためCSV行IDを受け、既存IDを維持更新する。両source modeを混同せず、JSON契約は変更しない。
- **意図的差分2**: v2 R1 §8はCSV `*` を任意後続とした。本書はその後続deliverableを必須要件として具体化する。
- **意図的差分3**: v2 R1 §4.5は未知JSON keyを常に拒否する。本書の `IGNORE UNKNOWN COLUMNS` はexport CSVだけの明示opt-inで、JSONへ波及させない。
- 比較評価 R2はCSV record番号更新とLF複数値を未対応差分としている（[比較評価:24-29](ksql_import_vs_cli_kintone_evaluation.md#L24), [同:74-76](ksql_import_vs_cli_kintone_evaluation.md#L74)）。本書の段1/2/3が実装された時点で同資料の比較表・棲み分け記述を更新する必要がある。
- 実装時は公開IMPORTレシピに、UPDATEでexport列を `BY NAME` の `INTO` へ一括指定すると空セルが既存値を明示クリアする警告と、変更対象列だけを列挙する安全例を必ず載せる。

## 11. 未確定／要ユーザー判断

1. **アプリコード付きレコード番号**: 段2 R1では対象外。export実例を固定し、prefixを許す場合の照合先app一致規則を別途決める。
2. **INSERT時の非空行ID**: R1はrow error。別環境へのsnapshot移送で「IDを無視して追加」を明示opt-inにするか。
3. **全置換のconfirm閾値**: 1件でも専用confirmを必須とした。非対話CLI/MCPで事前承認トークンをどう表現するかは実装面仕様で決める。
4. **段3と業務キーUPSERT**: 初回はrecord番号UPDATE/INSERTに限定。業務キーUPSERTへ全置換を許す時期と、create/update混在時の行ID規則は後続判断。
5. **既知export列の名称表**: ロケール別system headerを推測せずフォームmetadataで分類する方針だが、cli-kintoneが出す `*`/行ID列の正確なheader衝突規則を公式fixtureで固定する必要がある。
6. **JSON/CSVのサブテーブルupsert収束**: v2 R1 §7のJSONは `_rid` を拒否し、全行をIDなしで新規採番する（[v2 R1:176-184](ksql_import_v2_spec.md#L176)）。本書段3のCSVは行IDを受理して既存行を更新する。同じIMPORTでもsource形式でupsertの意味論が分岐するUXリスクを許容し続けるか、将来JSONも行ID受理へ収束させるかを決める。

## 12. Claudeレビュー用重点（コード・実機裏取り）

1. `BY NAME`をINTO順の `MaterializedTable`へ落とすことで、v1 R4の3経路とCHECK型メタを汚さず再利用できるか。
2. LF変換をIMPORT専用境界に置き、現行カンマ/JSON配列契約（[execute.ts:3905-3929](../../src/execute.ts#L3905)）を回帰させないか。
3. record番号のbulk read、存在確認、source重複preflightを `UPDATE ... FROM` の `$id` 能力から安全に抽出でき、UPSERT候補へ誤接続しないか。
4. cli-kintone実機fixtureで、marker値、複数tableの物理行配置、親fieldの継続行値、空table行、行ID header名、未知行IDの「追加」payloadを再確認すること。
5. 行ID付き全配列PUTで、入力欠落IDが本当に削除され、既存ID/新規IDの混在がAPI仕様どおりになるか。revision競合時に親全体が失敗するか。
6. `ON ERROR SKIP`でinvalid親の削除差分を実行対象から完全に除外でき、`REJECT LIMIT`がchild error数でなく親数を数えるか。
7. `#err`への `$err_subtable/$err_subrow/$err_source_row` 追加がbatch schema、依存解析、各面の結果表示と後方互換か。
8. 既知非書込み列の監査付き無視と未知列既定拒否が、ユーザー要求のround-tripとfail-closedを両立するか。
9. 段別見積（1〜2、6〜10、5〜8、16〜25人日）と、各段をminor releaseとして独立させる判断が妥当か。
10. R2追加例が、`*`/継続行/行IDのCSV grouping、未知IDのIDなし追加、空table全削除、未列挙table維持、VALIDATE ONLYの差分計算と実機API挙動に一致するか。
11. FILEを `INTO` 指定時analyze error・非指定時監査付き無視とする追加分類、およびUPDATE空セルの明示クリア警告が全実行面と公開レシピに漏れなく反映できるか。
