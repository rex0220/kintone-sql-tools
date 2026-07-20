# B42 — `VALIDATE` サブテーブル子フィールド監査仕様

- ステータス: 仕様 R4（2026-07-20 ユーザー指摘を反映・詳細9列／全該当行ロケータリスト／集約後 `tempTableMaxRows` を確定）
- 対象: B41 `VALIDATE APP…` のサブテーブルセル監査と生成時集約 `SUMMARY`
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B42
- 親仕様: [ksql_existing_record_validation_spec.md](ksql_existing_record_validation_spec.md) B41

## 1. 背景と目的

B41（v3.5.0）の `VALIDATE APP…` は、保存済みレコードを組み込み制約と任意の `CHECK` で検査する read-only 文である。一方、B41 v1 は対象をトップレベルフィールドに限定し、サブテーブルセル監査を「行番号付き」の v2 候補へ明示的に送った（[ksql_existing_record_validation_spec.md:15](ksql_existing_record_validation_spec.md#L15)、[同:89](ksql_existing_record_validation_spec.md#L89)）。言語リファレンスも、`(fields)` 省略時の対象を制約付きトップレベルフィールドと全トップレベル `NUMBER` としている（[ksql_language_reference.md:2087](../ksql_language_reference.md#L2087)）。したがって現状は文書と実装が一致した既知の対象外であり、silent regression ではない。

しかし実利用では、テーブル内の必須、数値上下限、文字数、選択肢、B29 整数部桁超過が結果へ一切現れず、既存データ監査として実害のある抜けになる。台帳 B42 はこの不足を実需ありの実装候補として記録している（[ksql_issue_tracker.md:37](../ksql_issue_tracker.md#L37)）。現行実装も、既定対象から `inSubtable` を除外し、明示指定した子フィールドを `ArgumentError` にしている（[execute.ts:745](../../src/execute.ts#L745)-[747](../../src/execute.ts#L747)、[execute.ts:754](../../src/execute.ts#L754)-[757](../../src/execute.ts#L757)）。

本仕様は、B41 の read-only、完全入力、組み込み検証の生値利用という契約を維持し、次を B42 v1 に一括して追加する。

- `(fields)` 省略時は、トップレベルに加えて、制約を持つサブテーブル子フィールドと全子 `NUMBER` を既定対象に含める。
- 詳細モードの固定スキーマは既存5列の末尾へ `$err_subtable`、`$err_subrow`、`$err_subrow_id`、`$err_count` を加えた9列とする。
- `$err_subrow` は全該当行の1-based表示序数、`$err_subrow_id` は同順の全 kintone 永続サブテーブル行 `id` を、カンマ区切りリストとして保持する。
- `(fields)` はテーブルコードで子全体を選べる。子の限定は `テーブル(子, …)` とし、裸の子コードは拒否する。
- 大量違反でも詳細行を生成せず集計できる `SUMMARY` を B42 v1 に同梱する。
- `CHECK` と `WHERE` のサブテーブル子参照は対象外のままとする。

## 2. 構文

```sql
VALIDATE <app> [ ( <target1>, <target2>, ... ) ]
[ SUMMARY ]
[ WHERE <トップレベル条件> ]
[ CHECK WHEN <トップレベル条件> THEN <メッセージ> ... ]
[ INTO #err ];

<target> ::= <トップレベルフィールド>
           | <テーブルコード>
           | <テーブルコード> ( <子フィールド1>, <子フィールド2>, ... )
```

`SUMMARY` の位置は `(fields)` の後、`WHERE` の前に確定する。`SUMMARY` は予約語に追加せず、`IDENT` の値を照合する soft keyword として実装し、AST flag と句順の parser test で固定する。

例:

```sql
-- トップレベルと全サブテーブルの監査対象を自動導出する詳細監査
VALIDATE APP100;

-- 明細テーブル内の監査可能な子をすべて監査
VALIDATE APP100 (明細);

-- トップレベルの顧客コードと、明細の数量・単価だけを監査
VALIDATE APP100 (顧客コード, 明細(数量, 単価)) INTO #err;
SELECT $id, $err_field, $err_code, $err_message, $err_value,
       $err_subtable, $err_subrow, $err_subrow_id, $err_count
FROM #err;

-- 詳細行を作らず、親×テーブル×フィールド×コードで件数化
VALIDATE APP100 SUMMARY INTO #summary;
```

現行 parser は括弧内を平坦な識別子配列として読み（[parser.ts:677](../../src/parser/parser.ts#L677)-[680](../../src/parser/parser.ts#L680)）、AST も `fields?: string[]` である（[ast.ts:75](../../src/types/ast.ts#L75)-[83](../../src/types/ast.ts#L83)）。`テーブル(子…)` と `SUMMARY` を採用する実装では、IMPORT の target と同様に親子スコープを保持する `ValidateTarget` union と `summary?: true` 相当へ変更する。

### 2.1 `(fields)` の解決規則

1. トップレベルの監査可能フィールドコードは、その1フィールドを選ぶ。
2. テーブルコード単独は、そのテーブルに直接属する「制約あり、または `NUMBER`」の子フィールドすべてへ展開する。監査可能な子が0件なら `ArgumentError` とする。
3. `テーブル(子…)` は、指定テーブルに直接属する監査可能な子だけを選ぶ。未知のテーブル、所属違い、重複、制約なしかつ非 `NUMBER` の子は、レコード取得前に `ArgumentError` とする。
4. 裸の子フィールドコードは引き続き拒否する。ただし現行の一律メッセージ（[execute.ts:754](../../src/execute.ts#L754)-[757](../../src/execute.ts#L757)）は、`VALIDATE child X requires an owning subtable target such as T(X)` 相当へ更新する。
5. 同じ実フィールドを、テーブル単独と `テーブル(子…)` の組合せ等で二重指定した場合も重複エラーとする。

裸の子コードを採らない理由は、子コードをアプリ全体で一意と仮定できないためである。フォーム定義はテーブルごとの `fields` に子を保持し（[formFieldInfo.ts:27](../../src/core/formFieldInfo.ts#L27)-[36](../../src/core/formFieldInfo.ts#L36)）、現行テストも別テーブルの同名子コードを明示的に扱う（[formFieldInfo.test.ts:54](../../src/core/__tests__/formFieldInfo.test.ts#L54)-[61](../../src/core/__tests__/formFieldInfo.test.ts#L61)）。よって B42 はスコープ付き解決を必須とし、グローバル一意性には依存しない。

### 2.2 `VALIDATE APP100$明細` を採らない理由

サブテーブル仮想テーブル `APP100$明細` は SELECT とサブテーブル DML の正式な言語形式であり、`_pid`、`_rid`、`_idx` を公開している（[ksql_language_reference.md:2247](../ksql_language_reference.md#L2247)-[2257](../ksql_language_reference.md#L2257)）。それでも B42 の監査対象指定には採らない。

1. 仮想テーブル形式では、トップレベル違反と複数テーブルの子違反を1文で混在監査できない。
2. 親 `VALIDATE APP100` と子 `VALIDATE APP100$明細` で9列の `#err` が分かれ、同じ監査結果として扱いにくい。
3. B41 の `WHERE` と `CHECK` は親レコード単位で評価する契約であり、子仮想行を主語にすると、一致子だけを監査するか親の全子を監査するかという別の意味論が必要になる。

したがって、親アプリを主語にして `Table(child, …)` で対象をスコープする。現行 parser の仮想テーブル明示拒否（[parser.ts:671](../../src/parser/parser.ts#L671)-[675](../../src/parser/parser.ts#L675)）は維持し、メッセージを `VALIDATE APP100$明細 is not supported; use VALIDATE APP100 (明細)` 相当の親アプリ形式への案内へ更新する。

## 3. 意味論

### 3.1 既定対象

`(fields)` 省略時の対象は次の和集合とする。

- 制約を持つトップレベルフィールドと全トップレベル `NUMBER`。
- 各サブテーブルに直接属する、制約を持つ子フィールドと全子 `NUMBER`。

「制約あり」は B41 と同じく `required`、`minValue`、`maxValue`、`minLength`、`maxLength`、選択肢定義のいずれかを持つことをいう。現行判定はこれらを `hasAuditableConstraint` に集約し、さらに `NUMBER` を常時対象にする（[execute.ts:731](../../src/execute.ts#L731)-[747](../../src/execute.ts#L747)）。B42 は親テーブルとの対応を維持した target descriptor へ組み替える。

子を既定対象へ含めるのは必須とする。明示指定時だけ対応すると、最も一般的な `VALIDATE APP100` に監査の抜けが残り、B42 の目的を満たさない。既存利用者では同じ SQL の違反行が増える可能性があるが、これは監査の抜けの修正であり、§8 の minor 判断へ反映する。

### 3.2 取得と行展開

records API の取得フィールドは次の和集合とする。

```text
$id
∪ トップレベル監査対象コード
∪ 子監査対象の親テーブルコード
∪ WHERE 参照（トップレベルのみ）
∪ CHECK 参照（トップレベルのみ）
```

子コード自体を `fields` へ入れてはならない。現行 B41 は target のコードをそのまま `requiredFields` へ入れるため（[execute.ts:816](../../src/execute.ts#L816)-[822](../../src/execute.ts#L822)）、B42 では target の表示コードと fetch コードを分離する。取得済みの親レコードでは、テーブル値が行配列、その各要素が `id` と子セルの `value` を持つ形で既存 adapter が処理している（[subtableAdapter.ts:18](../../src/converter/subtableAdapter.ts#L18)-[40](../../src/converter/subtableAdapter.ts#L40)）。

レコードごとに、トップレベル検証後、対象テーブルを**フォーム定義応答の列挙順**、各テーブル行を取得時の表示順、対象子をフォーム定義応答の列挙順で走査する。フォーム定義の flatten は `Object.values(properties)` を列挙する（[formFieldInfo.ts:48](../../src/core/formFieldInfo.ts#L48)-[56](../../src/core/formFieldInfo.ts#L56)）ため、同一入力に対して決定的だがフォームのレイアウト順は保証しない。明示指定時は target の記述順を優先し、テーブル内では行の表示順、子の記述順とする。最後に既存トップレベル `CHECK` を評価する。

### 3.3 詳細モードのセル検証

各子セルの生値 `tableRow.value[childCode].value` を、対応する子 `KintoneFieldInfo` とアプリの `numberPrecision` とともに `validateAndNormalizeDmlValue` へ渡す。フォーム flatten は子へ `required`、min/max、長さ、選択肢、`inSubtable`、`subtableCode` を付ける（[formFieldInfo.ts:58](../../src/core/formFieldInfo.ts#L58)-[76](../../src/core/formFieldInfo.ts#L76)）。検証 primitive 自体は `inSubtable` を分岐条件にせず、必須、数値、範囲、桁、長さ、選択肢を `KintoneFieldInfo` から評価する（[dmlValidation.ts:37](../../src/core/dmlValidation.ts#L37)-[106](../../src/core/dmlValidation.ts#L106)）。IMPORT もスコープ解決した子 info を同じ primitive へ渡している（[importRecordValidation.ts:110](../../src/import/importRecordValidation.ts#L110)-[115](../../src/import/importRecordValidation.ts#L115)、[同:140](../../src/import/importRecordValidation.ts#L140)-[144](../../src/import/importRecordValidation.ts#L144)）。

1セルの検証結果が NG なら1件の違反として扱う。現行 primitive は順に検査して最初の違反を返すため、同一セルから同時に複数の組み込み違反を列挙しない（[dmlValidation.ts:56](../../src/core/dmlValidation.ts#L56)-[105](../../src/core/dmlValidation.ts#L105)）。全行・全対象子セルを走査した後の詳細出力行は §3.4 の規則で集約する。

サブテーブルが0行ならセルが存在しないため、子の `required` 等は発火しない。既存 adapter もテーブル配列が空なら子行を1件も生成しない（[subtableAdapter.ts:18](../../src/converter/subtableAdapter.ts#L18)-[23](../../src/converter/subtableAdapter.ts#L23)）。これは B12-A（v2.13.0）の実機バグ修正時に kintone 実測で確定し auto-memory に記録された事項である。ただし workspace 文書内には行番号付き実機証跡がないため、B42 実機で**再確認・文書化**し、release gate とする。

### 3.4 同一メッセージ集約（2026-07-20 ユーザー要望）

詳細モードは、走査中に得た違反を次の5要素で集約し、同じキーにつき1行だけ出力する。

```text
($id, $err_subtable, $err_field, $err_code, $err_message)
```

`$err_count` はグループに属する違反件数を文字列化した数値とし、型メタは number とする。`$err_value` は走査順で最初に出現した違反の値を保持する。`$err_subrow` はグループに属する全該当行の1-based表示序数、`$err_subrow_id` は同順の全行IDを、それぞれカンマ区切りリストで保持する（例: `"1,2"` / `"7224309,7224313"`）。暗黙の切り捨ては行わず、100行なら100要素を出す。`$err_count=1` の行は従来どおり単一値となり、リスト表現と自然に一致する。トップレベル／`CHECK` 違反は両ロケータ列とも空のままとする。グループの出力順と各リストの要素順は先頭出現順とし、現行の走査順（トップレベル → テーブル → 表示行 → 子フィールド → CHECK）を変えない。

集約完了後の詳細出力生成時に限り、サブテーブル違反かつ `$err_count >= 2` の `$err_message` 末尾へ `（{count}行: {subrowリスト}）` を付加する（例: `文字列T2 は 3 文字以上で指定してください（2行: 1,2）`）。`subrowリスト` は `$err_subrow` と同一の1-based表示序数を先頭出現順・切り捨てなしで用いる。集約キーには装飾前の元 message を使い、装飾文字列をキーへ混入させない。`$err_count=1` の子違反、トップレベル違反、`CHECK` 違反は従来の message のままとする。`INTO #err` には装飾後の詳細行を実体化する。message 列を持たない SUMMARY は変更しない。

message をキーに含めるのは、`CHECK` が `$err_field=''`、`$err_code='ERR_CHECK'` のまま異なる message を複数返し得るためである。異なる message は別行を維持し、同一 message の CHECK は自然に集約する。CHECK はレコード単位で発火するため通常 `$err_count=1` となる。

### 3.5 詳細行数と `tempTableMaxRows`

詳細モードの走査件数は概念上 **親レコード数 × 各テーブル行数 × 対象子フィールド数** の積になり得るが、出力行数は §3.4 の集約キー数まで圧縮される。異なる message や error code が多い場合は、集約後も行数が大きくなり得る。

`VALIDATE … INTO #err` は集約済み結果行を一時テーブルへ実体化する。`tempTableMaxRows` は**集約後の詳細行数**に適用する。上限超過時は既存値を変更せず `ArgumentError` とし、truncate や部分成功にはしない。

### 3.6 `SUMMARY` モード

`SUMMARY` は詳細エラー行を作ってから GROUP BY するのではなく、セルを検査しながら次のキーへ直接加算する生成時集約である。

```text
($id, $err_subtable, $err_field, $err_code)
```

結果は親レコード×テーブル×フィールド×コードにつき1行となり、テーブル行数の因子を `$err_count` に畳み込む。トップレベル組み込み違反は `$err_subtable=''` で、同じ親・フィールド・コードは通常1件である。子違反は同じ親・テーブル・子・コードに該当した行数を数える。値、表示位置、永続行 ID は詳細モードで取得するため、`$err_message`、`$err_value`、`$err_subrow`、`$err_subrow_id` は SUMMARY に持たせない。

`CHECK` 違反は `$err_subtable=''`、`$err_field=''`、`$err_code='ERR_CHECK'` とし、同じ親で発火した CHECK group 数を `$err_count` に集約する。現行 CHECK 評価はグループ内先勝ち・グループ間独立で1 group につき最大1件を返し（[dmlCustomCheck.ts:60](../../src/core/dmlCustomCheck.ts#L60)-[75](../../src/core/dmlCustomCheck.ts#L75)）、B41 はそれぞれを空 field/value の `ERR_CHECK` 行にする（[execute.ts:881](../../src/execute.ts#L881)-[888](../../src/execute.ts#L888)）。SUMMARY は message を持たないため、同一親の異なる CHECK message も1行へ合算する。message 別の診断が必要なら詳細モードを使う。

SUMMARY も `tempTableMaxRows` の対象であり、集約後の行数が上限を超えれば §3.5 と同じく error になる。SUMMARY は message・値・行ロケータを持たず、レコード横断の規模把握に使う。詳細9列は message 別のレコード内訳と全該当行のロケータリストを提供する。

### 3.7 結果統計

詳細／SUMMARY の両モードで、公開 `SelectResult` の optional フィールドとして次の統計を返す。

```ts
validateStats?: { errorRecords: number; errorCount: number }
```

`errorRecords` は違反を1件以上持つ distinct `$id` 数、`errorCount` は `appendError` 呼び出し総数、すなわち詳細／SUMMARY の集約前違反総数とする。したがって両モードとも結果行の `$err_count` 合計と一致する。違反0件でも `validateStats: { errorRecords: 0, errorCount: 0 }` を付ける。通常の SELECT 互換性を維持するため型は optional とし、汎用 SELECT、`SELECT * FROM #err`、EXPLAIN には付与しない。

`VALIDATE … INTO #err` のバッチでは VALIDATE 文自身の `SelectResult` に統計を残し、一時表へは既存の固定列だけを実体化する。CLI の文サマリは `[1] VALIDATE success rowCount=… errorRecords=… errorCount=…`、単文サマリも `rowCount=… errorRecords=… errorCount=…` とする。JSON／MCP は `validateStats` を結果オブジェクトに含める。プラグインの結果ヘッダーは統計がある場合だけ `エラー {errorRecords} レコード / {errorCount} 件（表示 {rowCount} 行）` とし、ない結果は従来の `{rowCount} 件` を維持する。

### 3.8 `$err_value` と B29 数値精度

詳細モードの子セルでも B41 の `renderExistingValidationValue` を使う。空値・空配列は空文字、非空配列は code 配列 JSON、NUMBER は元字句を保持する（[existingRecordValidation.ts:1](../../src/core/existingRecordValidation.ts#L1)-[6](../../src/core/existingRecordValidation.ts#L6)）。子セルを flatten した文字列ではなく生値で検証・描画する。

対象にトップレベルまたは子の `NUMBER` が1つでもあれば、アプリ単位の `getNumberPrecisionCached` を1回利用する。取得した精度は各子 `NUMBER` にも渡し、`digits - decimalPlaces` を超える整数部を `ERR_NUMBER_INTEGER_DIGITS` とする（[dmlValidation.ts:71](../../src/core/dmlValidation.ts#L71)-[80](../../src/core/dmlValidation.ts#L80)）。現行 core と EXPLAIN は `targets.some(fieldType === "NUMBER")` で精度要否を決める（[execute.ts:829](../../src/execute.ts#L829)-[831](../../src/execute.ts#L831)、[execute.ts:6596](../../src/execute.ts#L6596)-[6607](../../src/execute.ts#L6607)）。B42 target descriptor の子もこの判定へ含める。

## 4. 出力スキーマ

### 4.1 詳細モード: 固定9列

既存5列の名前・順序・値を変えず、末尾へ4列を加える。

| 列 | 型メタ | トップレベル / CHECK 違反 | 子セル違反 |
|---|---|---|---|
| `$id` | number | 親レコード番号 | 親レコード番号 |
| `$err_field` | string | トップレベルフィールドコード / CHECK は空文字 | 子フィールドコード |
| `$err_code` | string | 既存エラーコード | 既存エラーコード |
| `$err_message` | string | 既存メッセージ | 既存メッセージ |
| `$err_value` | string | 現在の生値の描画 / CHECK は空文字 | 子セルの現在の生値の描画 |
| `$err_subtable` | string | 空文字 | 親テーブルコード |
| `$err_subrow` | string | 空文字 | 全該当行の1-based表示序数を先頭出現順に並べたカンマ区切りリスト |
| `$err_subrow_id` | string | 空文字 | 同順の全 kintone サブテーブル行永続 `id` のカンマ区切りリスト |
| `$err_count` | number | グループ件数（通常1） | 同一 message グループの違反件数 |

値はすべて従来どおり文字列で保持し、`$err_count` も `"1"`, `"100"` のような文字列化した数値とする。型メタは `$id` と `$err_count` が number、`$err_subrow` を含む他列が string である。集約時の `$err_value` はグループ先頭の値、`$err_subrow` / `$err_subrow_id` は全該当行を先頭出現順に並べたリストである。リスト要素数の暗黙上限は設けない。

`$err_subrow_id` の各要素は仮想テーブル `APP100$明細` の `_rid` と同値である。adapter は保存済み `row.id` を `_rid` に格納し、同じ走査で `_idx` に0-based indexを格納する（[subtableAdapter.ts:23](../../src/converter/subtableAdapter.ts#L23)-[29](../../src/converter/subtableAdapter.ts#L29)）。詳細監査では同じ `row.id` と `i + 1` を全該当行について同順にリストへ追加する。したがって仮想テーブルの `_idx` は **0-based**、監査の `$err_subrow` の各要素は **1-based** で基数が異なる。`#err` を `APP100$明細` へ突き合わせる場合は、`$err_subrow_id` を要素へ展開し、各要素を `_rid` と照合する。

子違反の修復キーは `$id` と `$err_subrow_id` の各要素であり、要素ごとに次の形へ変換できる。サブテーブル UPDATE は `_rid` 条件が安全上必須である（[ksql_language_reference.md:2271](../ksql_language_reference.md#L2271)-[2284](../ksql_language_reference.md#L2284)）。

```sql
UPDATE APP100$明細
SET 数量 = 1
WHERE _pid = <#err.$id> AND _rid = <#err.$err_subrow_id の各要素>;
```

`EXISTING_VALIDATION_COLUMNS`、`existingValidationColumnMeta`、batch analyzer の schema signature は同じ固定9列を持つ。詳細と SUMMARY の双方で `$err_count` は `KSQL_NUMBER` / number semantics とする。

### 4.2 SUMMARY: 固定5列

| 列 | 型メタ | 意味 |
|---|---|---|
| `$id` | number | 親レコード番号 |
| `$err_subtable` | string | 子違反の親テーブルコード。トップレベル / CHECK は空文字 |
| `$err_field` | string | 違反フィールドコード。CHECK は空文字 |
| `$err_code` | string | 既存エラーコード。CHECK は `ERR_CHECK` |
| `$err_count` | number | 集約キーに属する違反件数 |

`$id` と `$err_count` は `KSQL_NUMBER` / number semantics、残りは `KSQL_STRING` / string semantics とする。

詳細9列と SUMMARY 5列は別 schema signature である。同名 `#err` へ両者を追記すると、batch analyzer が payload field 配列を JSON signature 化し、不一致を analyze 時に fail-fast する既存規則をそのまま適用する（[batch.ts:321](../../src/core/batch.ts#L321)-[345](../../src/core/batch.ts#L345)）。実行時にも列名・順序・型メタ不一致を拒否する（[execute.ts:929](../../src/execute.ts#L929)-[944](../../src/execute.ts#L944)）。

## 5. 実装方針

本節は R3 の実装箇所と非回帰境界を示す。

### 5.1 parser・AST・target 解決

- `src/parser/parser.ts`: 現行 `parseIdentList`（[parser.ts:677](../../src/parser/parser.ts#L677)-[680](../../src/parser/parser.ts#L680)）を入れ子 target parser へ置き換え、field list 直後・WHERE 直前に soft keyword `SUMMARY` を1回だけ受理する。重複、句順違反を parser test で拒否する。
- `src/parser/parser.ts`: 仮想テーブル拒否（[parser.ts:671](../../src/parser/parser.ts#L671)-[675](../../src/parser/parser.ts#L675)）を維持し、親アプリ形式 `VALIDATE APP100 (明細)` へ誘導するメッセージへ更新する。
- `src/types/ast.ts`: `ValidateStatement.fields?: string[]`（[ast.ts:75](../../src/types/ast.ts#L75)-[83](../../src/types/ast.ts#L83)）を scoped target 配列へ変更し、`summary?: true` 相当を加える。
- `src/core/formFieldInfo.ts`: `buildScopedSubtableFieldIndex` が保持する `table -> children` と所有関係（[formFieldInfo.ts:21](../../src/core/formFieldInfo.ts#L21)-[38](../../src/core/formFieldInfo.ts#L38)）を target 解決に再利用する。
- `src/execute.ts`: `resolveExistingValidationTargets`（[execute.ts:740](../../src/execute.ts#L740)-[760](../../src/execute.ts#L760)）を、子なら `subtableCode` を必須で持つ descriptor にする。既定導出、所有関係、重複、裸の子拒否を records fetch 前に確定する。

### 5.2 取得・検証・集約

- `src/execute.ts`: `requiredFields` 構築（[execute.ts:816](../../src/execute.ts#L816)-[822](../../src/execute.ts#L822)）では、子 target を親テーブルコードへ写像し重複を除く。`WHERE` / `CHECK` の子参照は fetch 前に明示拒否する。
- `src/execute.ts`: records fetch と結果生成本体へ取得済みテーブル配列を展開する子セルループを持つ。詳細モードは5列キーの insertion-order counter へ直接加算して9列行へ変換し、SUMMARY は4列キーの counter へ直接加算して5列行へ変換する。
- `src/core/dmlValidation.ts`: `validateAndNormalizeDmlValue` を親子で共有し、新しい子専用制約判定を重複実装しない（[dmlValidation.ts:37](../../src/core/dmlValidation.ts#L37)-[106](../../src/core/dmlValidation.ts#L106)）。
- `src/core/existingRecordValidation.ts`: 詳細 `$err_value` の描画規則を再利用する（[existingRecordValidation.ts:1](../../src/core/existingRecordValidation.ts#L1)-[6](../../src/core/existingRecordValidation.ts#L6)）。

### 5.3 出力・batch・EXPLAIN・文書

- `src/execute.ts`: `EXISTING_VALIDATION_COLUMNS`、`existingValidationColumnMeta`、結果行生成を詳細9列へ同期し、SUMMARY 5列の別定数・列別型メタを維持する。
- `src/core/batch.ts`: VALIDATE の固定 schema signature を `summary` flag で詳細9列 / SUMMARY 5列に分ける。同名一時表への異種追記は既存どおり analyze 時に拒否する。
- `src/execute.ts`: EXPLAIN metadata の `targetFields` / `fetchFields`（[execute.ts:6601](../../src/execute.ts#L6601)-[6607](../../src/execute.ts#L6607)）を論理 target と親テーブル fetch に分け、plan builder（[execute.ts:6962](../../src/execute.ts#L6962)-[6980](../../src/execute.ts#L6980)）へ §7 の表示を追加する。
- `src/__tests__/existingRecordValidation.test.ts`: 固定9列、同一 message 集約、全該当行ロケータリスト、message 分離、集約後上限、batch signature、EXPLAIN を固定する。
- `docs/ksql_language_reference.md`: §17.4 の詳細9列、集約規則、SUMMARY 5列との役割分担、§19 の `_rid` 修復レシピとの接続を改定する。

## 6. 対象外

- `CHECK` からのテーブルコード、子フィールド、行番号、行 ID の参照。B37 はサブテーブル DML の `CHECK` を非対応としている（[ksql_custom_check_spec.md:149](ksql_custom_check_spec.md#L149)）。B42 は組み込み制約監査だけを子セルへ拡張し、子行スコープの式評価は設計しない。
- `WHERE` からのサブテーブル子参照。親をどの子行一致で選ぶかと、選ばれた親の全行を監査するか一致行だけを監査するかが別契約になるため、トップレベル WHERE に限定し、executor が records fetch 前に明示拒否する。
- `FILE`、`SUBTABLE` 自体、`CALC`、レコード番号、作成者/更新者、作成/更新日時、ステータス、作業者、カテゴリー、関連レコード等、B41 の組み込み制約監査に該当しない型。IMPORT も子 `FILE` 等を明示的な非対応型にしている（[importRecordValidation.ts:9](../../src/import/importRecordValidation.ts#L9)-[10](../../src/import/importRecordValidation.ts#L10)）。
- ユニーク制約、レコード横断制約、違反の自動修復。B42 は修復可能な永続ロケータとレシピを提供するが、監査結果から UPDATE 文を自動生成・実行しない。
- 1セルから複数の組み込み違反を同時列挙する検証器への変更。現行の先勝ち primitive を維持する。

## 7. EXPLAIN・面

`VALIDATE` は B42 後も read-only であり、CLI、MCP、プラグインの全面で提供する。現行テストは read-only、非 DML、完全入力、書込みなしを固定している（[existingRecordValidation.test.ts:77](../../src/__tests__/existingRecordValidation.test.ts#L77)-[83](../../src/__tests__/existingRecordValidation.test.ts#L83)）。B42 は確認ダイアログ、`--allow-dml`、mutation capability を追加しない。

`EXPLAIN VALIDATE` は現在の read-only、records fetch、完全入力、WHERE capability、audit fields、fetch fields、数値精度、書込みなし、違反件数なしの表示（[execute.ts:6962](../../src/execute.ts#L6962)-[6980](../../src/execute.ts#L6980)）を維持し、次を追加・変更する。

- `audit fields`: 子 target は `明細(数量, 単価)` のように親スコープ付きで表示する。
- `fetch fields`: 子コードではなく実際に取得する親テーブルコードを表示する。
- 詳細時 `subtable audit`: 対象テーブル、対象子数を表示する。
- 詳細時 `output schema`: 固定9列を表示する。
- 詳細時 `row locator`: message 単位で集約し、`$err_subrow` / `$err_subrow_id` が全該当行を先頭出現順で列挙することを表示する。
- SUMMARY 時: `mode=SUMMARY`、固定5列 output schema、`aggregation=record/subtable/field/code`、`row locator=none` を表示する。
- `number precision`: 子 `NUMBER` だけが対象の場合も `required` とする。
- EXPLAIN 中は従来どおりフォーム定義と必要時の number precision metadata だけを読み、records API と mutation API を呼ばず、行数・違反件数・実際のサブテーブル行数・集約後行数を表示しない。現行テストは records/mutation API 0 と違反件数なしを固定している（[existingRecordValidation.test.ts:228](../../src/__tests__/existingRecordValidation.test.ts#L228)-[237](../../src/__tests__/existingRecordValidation.test.ts#L237)）。

## 8. SemVer

推奨は **minor（v3.7.0 相当）** とする。

台帳 §2 の出荷前例では、B8 の `maxRecords` 意味論変更は v2.11.0 minor（[ksql_issue_tracker.md:67](../ksql_issue_tracker.md#L67)）、B13 の `MIN` / `MAX` 結果変更は v2.14.0 minor（[ksql_issue_tracker.md:64](../ksql_issue_tracker.md#L64)）、B9 の16桁超比較結果の修正は v3.3.0 minor（[ksql_issue_tracker.md:56](../ksql_issue_tracker.md#L56)）である。major の v3.0.0 は4面の比較意味論を全面刷新したリリースである（[ksql_issue_tracker.md:59](../ksql_issue_tracker.md#L59)）。

B42 により違反行が増えるのは B13 と同型の「監査の抜けの修正」である。詳細スキーマの追加4列は末尾加法で、既存5列の名前・順序・値・型は不変である。SUMMARY は新しい opt-in 構文である。以上から本プロジェクトの実績に従い minor とする。

SemVer を厳密に適用して固定結果 schema の加法変更も破壊的とみなし major にする案は、R1 の代替論として履歴に残す。ただし本プロジェクトの出荷前例とは整合しないため R2 では採らない。

## 9. 受入条件

### 9.1 parser・単体・統合テスト

- `(fields)` 省略で、トップレベル対象に加えて全テーブルの制約付き子と全子 `NUMBER` が選ばれ、制約なし非 `NUMBER`、`FILE` 等は選ばれない。
- 子の必須空、数値 min/max、文字列 min/maxLength、定義外選択肢、B29 整数部桁超過を検出する。詳細行は `$id`、子 `$err_field`、コード、メッセージ、先頭行の描画済み生値、親 `$err_subtable`、全該当行の1-based `$err_subrow` リスト、同順の永続 `$err_subrow_id` リストを持つ。
- 1親に複数テーブル、1テーブルに複数行、1行に複数不良セルがあるとき、全セルを走査し、同一 message グループを先頭出現順で1行へ集約する。
- 0行テーブルでは子 required を含めエラー0件。1行目が空セルなら required 1件。
- 同じ親にトップレベル違反、子セル違反、トップレベル `CHECK` 違反が混在し、トップレベル / CHECK は count=1、子の同一 message は件数化される。
- `VALIDATE APP (Table)` は Table の監査可能な子全体、`VALIDATE APP (Table(child1, child2))` は指定子だけを対象にする。未知テーブル、未知子、所属違い、重複、監査対象外、空 child list は fetch 前に失敗する。
- 裸の子コードは、そのコードがたまたま1つしかなくても拒否する。別テーブルの同名子を `T1(value), T2(value)` で正しく分離する。
- `VALIDATE APP100$明細` は専用 ParseError で拒否し、`VALIDATE APP100 (明細)` 形式を案内する。EXPLAIN でも同じ誘導になる。
- `SUMMARY` は `(fields)` 後・WHERE 前だけで soft keyword として受理し、既存の同名フィールド / app identifier を予約語化しない。重複、WHERE 後、CHECK 後、INTO 後は ParseError とする。
- requiredFields は子コードを含まず、親テーブルコードを1回だけ含む。トップレベル、WHERE、CHECK の必要列も失わない。
- 子 `NUMBER` だけを選んだ場合も number precision API は1回だけ呼ばれ、整数部桁チェックが有効になる。NUMBER が無ければ呼ばない。
- 詳細結果0件でも9列 schema と列メタを保持する。`$id`、`$err_count` は number、`$err_subrow` を含む他列は string。
- 詳細は `($id, $err_subtable, $err_field, $err_code, $err_message)` で集約し、`$err_value` は先頭行、`$err_subrow` / `$err_subrow_id` は全該当行を先頭出現順・切り捨てなしで列挙し、`$err_count` は文字列化した件数とする。異なる message は別行にする。
- SUMMARY 結果0件でも5列 schema と列メタを保持する。`$id` / `$err_count` は number、他は string。
- SUMMARY は詳細行を内部配列へ生成せず、トップレベル、複数子行、複数 error code を4列キーで正しく集約する。トップレベル count は通常1、子 count は該当行数になる。
- CHECK の SUMMARY は `$err_subtable=''`, `$err_field=''`, `$err_code='ERR_CHECK'` で、同一親の発火 group 数を `$err_count` にする。詳細モードの CHECK message は非回帰。
- 詳細／SUMMARY の `validateStats.errorCount` は集約前違反総数で各結果の `$err_count` 合計と一致し、`errorRecords` は distinct `$id` 数になる。0件でも0/0を返す。`INTO #err` の VALIDATE 文結果には付き、後段 SELECT には付かない。
- `VALIDATE … INTO #err; SELECT … FROM #err` で詳細9列を参照できる。SUMMARY 5列も別一時表で参照できる。詳細と SUMMARY を同名 `#err` へ混在追記すると analyze 時に schema mismatch で fail-fast し、実行しない。
- 詳細 / SUMMARY とも `tempTableMaxRows` は集約後行数へ適用し、超過時は既存行を変えず error になる。truncate / 部分成功にしない。
- `WHERE` / `CHECK` の子参照は、演算子にかかわらず records API 前に一貫した `ArgumentError`。トップレベル WHERE/CHECK は非回帰。
- read-only、`onLimit=error`、Cursor未使用、POST/PUT/DELETE 0回を維持する。
- EXPLAIN 詳細は親スコープ付き target、親テーブル fetch、9列 schema、message 集約、全該当行の row locator リスト、子 NUMBER 精度要否を示す。SUMMARY は5列 schema、集約キー、row locator none を示す。いずれも records/mutation API 0回、違反件数なしを維持する。

### 9.2 実機確認・運用レシピ

- 制約違反を持つ子セル（必須、数値上下限、文字数、選択肢）を保存済みレコードに用意し、期待する位置付き詳細行が CLI、MCP、プラグインで一致する。
- B29 用の子 `NUMBER` で、許容整数部桁数の境界値と1桁超過を確認する。
- 0行テーブルで子 required が発火しないことを**過去実測の再確認**として実施し、行番号付き evidence に文書化する。これは B12-A（v2.13.0）実機バグ修正時の kintone 実測確定事項として auto-memory に記録済みだが、workspace 文書内に行番号付き証跡がないため release gate を維持する。
- 2行・3行以上のテーブルで同一違反を発生させ、`$err_count` が行数、`$err_subrow` / `$err_subrow_id` が全該当行を先頭出現順で列挙する。大量行でも暗黙に切り捨てない。行を並べ替えた後は両リストが新しい出現順へ追随する。
- `#err` の子違反について、`$id` を `_pid`、展開した `$err_subrow_id` の各要素を `_rid` に使った `UPDATE APP100$明細 … WHERE _pid=… AND _rid=…` で対象行だけを修復し、再監査でその違反が消えることを確認する。実更新は復旧可能な fixture と事前 snapshot を使う。
- トップレベル違反と子違反の混在で、既存5列の値が変わらず、ロケータ3列がトップレベル行では空、`$err_count=1` である。
- `(fields)` 省略、テーブルコード、`テーブル(子…)`、裸の子拒否、仮想テーブル拒否と親形式への案内、別テーブル同名子を確認する。
- `INTO #err` 後の SELECT で9列を取得し、`WHERE $err_subtable = '明細'` が動く。`$err_subrow` は string リストとして扱い、`$err_subrow_id` は要素へ展開して `_rid` と突合する。
- 詳細9列を SUMMARY と同じ粒度へ再集約する場合は、行数ではなく `$err_count` を合計する。

```sql
VALIDATE APP100 INTO #err;
SELECT $id, $err_subtable, $err_field, $err_code, SUM($err_count) AS $err_count
FROM #err
GROUP BY $id, $err_subtable, $err_field, $err_code;
```

- 大量の同一違反 fixture で、詳細 `VALIDATE … INTO #detail` が1行へ集約され、`tempTableMaxRows=1` で完走することを確認する。異なる message / code により集約後行数が上限を超える場合は error とする。
- 実運用の2段構えを文書と smoke で固定する: **SUMMARY で規模と対象を把握 → `WHERE` / `(fields)` で絞った詳細 VALIDATE → `$id` / 展開した `$err_subrow_id` の各要素で修復**。
- EXPLAIN が records API を呼ばず、実行本体が書込み API を呼ばないことを各面で確認する。

## 10. 未決論点

R3 の機能範囲、詳細9列 / SUMMARY 5列 schema、詳細の同一 message 集約、SUMMARY の B42 v1 同梱、minor リリースは確定済みであり、未決はない。

1. **子 target 構文の最終形**: 推奨・本文契約は IMPORT と整合する `Table(child, …)`。代替 `Table.child` は、現行 VALIDATE が修飾参照を拒否し（[parser.ts:706](../../src/parser/parser.ts#L706)-[710](../../src/parser/parser.ts#L710)）、target と WHERE/CHECK で `.` の意味が分かれるため非推奨。
2. **WHERE / CHECK 子参照 guard の実装位置**: executor の参照解決直後・records fetch 前に拒否する形で確定済み。

SUMMARY を B42.1 へ分割し、B42 v1 を詳細モード＋少量 GROUP BY レシピだけで出す案は R1 レビュー時の代替案として存在した。しかし大量違反で監査が完走しない問題を残すため、ユーザー承認により不採用とし、R2 本文では B42 v1 同梱を契約とする。

## 11. R1 Claude レビュー（2026-07-20・全指摘コード裏取り済み）

引用 file:line は全数照合し正確。§6 の「WHERE 子参照に静的ガードなし」の発見も妥当（`infoByCode` は `flattenFormFieldProperties` 由来で子を含む＝[execute.ts:802](../../src/execute.ts#L802)-[827](../../src/execute.ts#L827) の存在チェックを子コードが素通りし、prefilter／requiredFields へ混入し得る）。以下を R2 で反映する。

### P1-1 行ロケータに永続行 ID を含めない判断は、リポジトリ自身のサブテーブル修復経路と矛盾

- kSQL は**サブテーブル仮想テーブル `APP100$明細` を SELECT/INSERT/UPDATE/DELETE/REORDER で正式対応済み**（言語リファレンス §19・[subtableAdapter.ts:12](../../src/converter/subtableAdapter.ts#L12)）。かつ **`UPDATE`/`DELETE` は安全のため `_rid`（永続行 ID）条件が必須**（言語 §19）。
- B41/#err の看板ユースは「違反を後続文で使う」。トップレベル違反は `$id` がそのまま修復キーになるが、子セル違反の唯一の書込み経路は `UPDATE APP100$明細 … WHERE _pid = … AND _rid = …` ＝ **1-based 序数だけでは #err から修復文を組めない**（序数→`_rid` の人手変換が必要で、行の並べ替えで無効化もされる）。
- IMPORT の `$err_subrow` が序数なのは**ソースがファイル行で ID を持たないから**。VALIDATE は保存済みレコードを読むため `row.id` が手元にある（[subtableAdapter.ts:27](../../src/converter/subtableAdapter.ts#L27)・[execute.ts:5877](../../src/execute.ts#L5877)）＝取得コスト増ゼロ。前提が異なるので前例の転用条件を満たさない。
- **勧告（R2 時点）**: `$err_subrow_id`（string・`_rid` と同値・トップレベル行は空）を追加し **8 列で一度に確定**する。未決論点2の「後続仕様で加法追加」は固定 schema 変更を2回踏む（7列→8列で batch signature・言語リファレンスを再改定）ため不採用。あわせて仮想テーブル `_idx`（0-based）と `$err_subrow`（1-based）の**基数不一致を §4 に明記**する。R4 では同一 message 集約後も全行を特定できるよう、`$err_subrow_id` を全 `_rid` のリストへ拡張し、突合時は要素展開する契約へ更新した。

### P1-2 代替構文 `VALIDATE APP100$明細` の検討が欠落

- parser は VALIDATE に対する仮想テーブル指定を**専用メッセージで既に拒否**している（[parser.ts:673](../../src/parser/parser.ts#L673)-[675](../../src/parser/parser.ts#L675)）＝設計上意識済みの構文であり、サブテーブルを対象化する kSQL の第一言語は `APP100$明細`（言語 §19）。§2 が `テーブル(子…)` を IMPORT 前例だけで正当化すると、「なぜ `VALIDATE APP100$明細` ではないのか」という質問に仕様が答えられない。
- **勧告**: `テーブル(子…)` 採用自体は妥当（**1文でトップレベル＋子の混在監査ができ、`#err` が1系統で済む**。仮想テーブル形式だと親と子で VALIDATE を2文書き、5列/7列の異 schema `#err` が並ぶ）。この採否理由を §2 に1節追加し、`APP100$明細` 形式は「明示拒否を維持」とエラーメッセージ（親アプリ形式への誘導文言）を受入条件に含める。

### P1-3 エラー行の爆発で監査が完走しない（ユーザー指摘・2026-07-20 方針承認済み）

- R1 §3.3 の「1 セル 1 違反 1 行」では、エラー行数の上限が **レコード数 × テーブル行数 × 対象子フィールド数** の積になる（例: 10,000 レコード × 明細 20 行 × 対象子 3 = 最大 60 万行）。VALIDATE の主用途は**制約を後付けしたアプリの過去データ監査**であり、全件・全行違反は例外でなく通常ケース（実例: APP4221 は全レコードが minLength 既存違反）。
- 実害は表示量より先に**容量制限**: `INTO #err` は一時テーブル実体化のため **`tempTableMaxRows`（既定 10,000・[execute.ts:911](../../src/execute.ts#L911)・truncate せず常に error）** に当たり、違反が多いアプリほど監査文自体が失敗する。B41 の「完全な監査集合のため `onLimit=error`」思想と「違反が多いと実体化できない」が正面衝突する。`INTO` なしでも数十万行の結果は MCP 応答・プラグイン表示（先頭 100 行）で実用にならない。R1 はこの爆発シナリオを扱っていない。
- **R2 反映事項（3点）**:
  1. §3 に爆発シナリオと `tempTableMaxRows` 到達時の挙動（error で完走しない）を明記する（詳細モードの限界の文書化・必須）。
  2. 集約レシピを受入条件へ追加: `#err` は一時テーブルなので少量なら既存 SQL で集計できる（`SELECT $id, $err_subtable, $err_field, $err_code, COUNT(*) FROM #err GROUP BY …`）。ただし詳細行が実体化できる規模でしか使えないことを明記する。
  3. **生成時集約 `SUMMARY` モードを仕様に含める**（推奨・スコープ抑制なら詳細モード＋レシピで v1 を出し B42.1 へ分割も可）: `VALIDATE APP100 SUMMARY [INTO #err]` は詳細行を作らず `$id, $err_subtable, $err_field, $err_code, $err_count` の集約行のみ生成する。行数が レコード数 × フィールド数 に圧縮され（テーブル行数の因子が消える）、打ち切りと違い**完全性を保ったまま**容量・表示を解決する。リポジトリ内前例=IMPORT のテーブル単位カウンタ（[importRecordValidation.ts:71](../../src/import/importRecordValidation.ts#L71)）。運用は2段構え: SUMMARY で規模把握 → `WHERE`/`(fields)` で絞った詳細 VALIDATE → 展開した `$err_subrow_id` の各要素で修復。

### P2-1 SemVer major 推奨は本プロジェクトの出荷前例と不整合

- §8/§10-1 が求める「文書根拠」は台帳 §2 に存在する: **B8**（`maxRecords` 意味論変更）= v2.11.0 **minor**・**B13**（`MIN`/`MAX` の結果が変わる）= v2.14.0 **minor**・**B9**（16桁超の比較結果が変わる）= v3.3.0 **minor**（台帳注記「16桁超の比較のみ結果が正しく変わる」）。major は v3.0.0（4面の比較意味論の全面刷新）のみ。
- 違反行の増加は「監査の抜けの修正」で B13 と同型・列追加は末尾加法で既存5列の名前/順序/値は不変。**勧告: minor（v3.7.0 相当）へ変更**。最終判断はユーザー。

### P2-2 0行テーブルの実機証跡は B12-A 実測として auto-memory に記録済み

- 「サブテーブル行なしなら子制約は発火しない」は **v2.13.0 B12-A の実機バグ3件修正時の kintone 実測確定事項**として auto-memory に記録がある（文書内の行番号付き証跡が無いという §3.3/§9.2 の指摘自体は正しい）。release gate 維持は妥当だが、位置づけを「初検証」でなく「**過去実測の再確認・文書化**」へ変更する。

### P3-1 §3.2「フォーム順」は過大表現

- 既定 target の列挙順は form fields API 応答の `Object.values` 列挙順（[formFieldInfo.ts:55](../../src/core/formFieldInfo.ts#L55)）であり、**フォームレイアウト順の保証はない**。「フォーム定義応答の列挙順（同一入力に対し決定的）」へ言い換える。

**R2 反映済み（2026-07-20）**
