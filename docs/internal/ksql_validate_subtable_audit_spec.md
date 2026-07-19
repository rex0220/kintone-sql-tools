# B42 — `VALIDATE` サブテーブル子フィールド監査仕様

- ステータス: 仕様 R1・Claude レビュー済（2026-07-20・P1×2 / P2×2 / P3×1＝§11。**R2 反映待ち**。引用 file:line は全数裏取り済みで正確・§6 の WHERE 潜在ギャップ指摘も実装確認で妥当）
- 対象: B41 `VALIDATE APP…` のサブテーブルセル監査
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B42
- 親仕様: [ksql_existing_record_validation_spec.md](ksql_existing_record_validation_spec.md) B41

## 1. 背景と目的

B41（v3.5.0）の `VALIDATE APP…` は、保存済みレコードを組み込み制約と任意の `CHECK` で検査する read-only 文である。一方、B41 v1 は対象をトップレベルフィールドに限定し、サブテーブルセル監査を「行番号付き」の v2 候補へ明示的に送った（[ksql_existing_record_validation_spec.md:15](ksql_existing_record_validation_spec.md#L15)、[同:89](ksql_existing_record_validation_spec.md#L89)）。言語リファレンスも、`(fields)` 省略時の対象を制約付きトップレベルフィールドと全トップレベル `NUMBER` としている（[ksql_language_reference.md:2087](../ksql_language_reference.md#L2087)）。したがって現状は文書と実装が一致した既知の対象外であり、silent regression ではない。

しかし実利用では、テーブル内の必須、数値上下限、文字数、選択肢、B29 整数部桁超過が結果へ一切現れず、既存データ監査として実害のある抜けになる。台帳 B42 はこの不足を実需ありの実装候補として記録している（[ksql_issue_tracker.md:37](../ksql_issue_tracker.md#L37)）。現行実装も、既定対象から `inSubtable` を除外し、明示指定した子フィールドを `ArgumentError` にしている（[execute.ts:745](../../src/execute.ts#L745)、[execute.ts:756](../../src/execute.ts#L756)）。

本仕様の目的は、B41 の read-only、完全入力、組み込み検証の生値利用という契約を維持したまま、各サブテーブル行の監査を追加することである。推奨案は次のとおり。

- `(fields)` 省略時は、トップレベルに加えて、制約を持つサブテーブル子フィールドと全子 `NUMBER` を既定対象に含める。
- エラー位置は IMPORT の前例に合わせ、既存5列の後ろへ `$err_subtable` と `$err_subrow` を追加する。
- `$err_subrow` は取得時の表示順を 1 から数えた序数とし、kintone の永続行 `id` は R1 では出力しない。
- `(fields)` はテーブルコードで子全体を選べる。子の限定は `テーブル(子, …)` とし、裸の子コードは拒否する。
- `CHECK` と `WHERE` のサブテーブル子参照は対象外のままとする。

## 2. 構文

```sql
VALIDATE <app> [ ( <target1>, <target2>, ... ) ]
[ WHERE <トップレベル条件> ]
[ CHECK WHEN <トップレベル条件> THEN <メッセージ> ... ]
[ INTO #err ];

<target> ::= <トップレベルフィールド>
           | <テーブルコード>
           | <テーブルコード> ( <子フィールド1>, <子フィールド2>, ... )
```

例:

```sql
-- トップレベルと全サブテーブルの監査対象を自動導出
VALIDATE APP100;

-- 明細テーブル内の監査可能な子をすべて監査
VALIDATE APP100 (明細);

-- トップレベルの顧客コードと、明細の数量・単価だけを監査
VALIDATE APP100 (顧客コード, 明細(数量, 単価)) INTO #err;
SELECT $id, $err_field, $err_code, $err_message, $err_value,
       $err_subtable, $err_subrow
FROM #err;
```

現行 parser は括弧内を平坦な識別子配列として読み（[parser.ts:677](../../src/parser/parser.ts#L677)-[680](../../src/parser/parser.ts#L680)）、AST も `fields?: string[]` である（[ast.ts:75](../../src/types/ast.ts#L75)-[83](../../src/types/ast.ts#L83)）。`テーブル(子…)` を採用する実装では、IMPORT の target と同様に親子スコープを保持する `ValidateTarget` union へ変更する。

### 2.1 `(fields)` の解決規則

1. トップレベルの監査可能フィールドコードは、その1フィールドを選ぶ。
2. テーブルコード単独は、そのテーブルに直接属する「制約あり、または `NUMBER`」の子フィールドすべてへ展開する。監査可能な子が0件なら `ArgumentError` とする。
3. `テーブル(子…)` は、指定テーブルに直接属する監査可能な子だけを選ぶ。未知のテーブル、所属違い、重複、制約なしかつ非 `NUMBER` の子は、レコード取得前に `ArgumentError` とする。
4. 裸の子フィールドコードは引き続き拒否する。ただし現行の一律メッセージ（[execute.ts:756](../../src/execute.ts#L756)）は、`VALIDATE child X requires an owning subtable target such as T(X)` 相当へ更新する。
5. 同じ実フィールドを、テーブル単独と `テーブル(子…)` の組合せ等で二重指定した場合も重複エラーとする。

裸の子コードを採らない理由は、子コードをアプリ全体で一意と仮定できないためである。フォーム定義はテーブルごとの `fields` に子を保持し（[formFieldInfo.ts:27](../../src/core/formFieldInfo.ts#L27)-[36](../../src/core/formFieldInfo.ts#L36)）、現行テストも別テーブルの同名子コードを明示的に扱う（[formFieldInfo.test.ts:54](../../src/core/__tests__/formFieldInfo.test.ts#L54)-[61](../../src/core/__tests__/formFieldInfo.test.ts#L61)）。よって「kintone 制約により子コードはアプリ内で必ず一意」という前提は、本リポジトリからは確認できず、むしろ現行契約と矛盾する。[公式フォーム取得 API](https://cybozu.dev/ja/kintone/docs/rest-api/apps/form/get-form-fields/) も子定義をテーブルの `fields` 配下に返す。R1 はスコープ付き解決を必須とし、グローバル一意性には依存しない。

## 3. 意味論

### 3.1 既定対象

`(fields)` 省略時の対象は次の和集合とする。

- 制約を持つトップレベルフィールドと全トップレベル `NUMBER`。
- 各サブテーブルに直接属する、制約を持つ子フィールドと全子 `NUMBER`。

「制約あり」は B41 と同じく `required`、`minValue`、`maxValue`、`minLength`、`maxLength`、選択肢定義のいずれかを持つことをいう。現行判定はこれらを `hasAuditableConstraint` に集約し、さらに `NUMBER` を常時対象にする（[execute.ts:731](../../src/execute.ts#L731)-[747](../../src/execute.ts#L747)）。B42 はこの判定から `!field.inSubtable` だけを外すのではなく、親テーブルとの対応を維持した target へ組み替える。

子を既定対象へ含めるのは推奨かつ必須とする。明示指定時だけ対応すると、最も一般的な `VALIDATE APP100` に監査の抜けが残り、B42 の目的を満たさない。既存利用者では、同じ SQL の違反行が増える可能性がある。これは意図した監査範囲の拡大だが、互換性上は結果集合の変更であり、§8 の SemVer 判断へ反映する。

### 3.2 取得と行展開

records API の取得フィールドは次の和集合とする。

```text
$id
∪ トップレベル監査対象コード
∪ 子監査対象の親テーブルコード
∪ WHERE 参照（トップレベルのみ）
∪ CHECK 参照（トップレベルのみ）
```

子コード自体を `fields` へ入れてはならない。[kintone の複数レコード取得 API](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/) は、テーブル内フィールドを `fields` に直接指定できず、親テーブルコードを指定するとその全子を返す。現行 B41 は target のコードをそのまま `requiredFields` へ入れるため（[execute.ts:816](../../src/execute.ts#L816)-[822](../../src/execute.ts#L822)）、B42 では target の表示コードと fetch コードを分離する必要がある。取得済みの親レコードでは、テーブル値が行配列、その各要素が `id` と子セルの `value` を持つ形で既存サブテーブル adapter が処理している（[subtableAdapter.ts:18](../../src/converter/subtableAdapter.ts#L18)-[40](../../src/converter/subtableAdapter.ts#L40)）。

レコードごとに、トップレベル検証後、対象テーブルをフォーム順、各テーブル行を取得時の表示順、対象子をフォーム順で走査する。明示指定時は target の記述順を優先し、テーブル内では行の表示順、子の記述順とする。最後に既存トップレベル `CHECK` を評価する。これにより同一入力に対する出力順を決定的にする。

### 3.3 セル検証

各子セルの生値 `tableRow.value[childCode].value` を、対応する子 `KintoneFieldInfo` とアプリの `numberPrecision` とともに `validateAndNormalizeDmlValue` へ渡す。フォーム flatten は子へ `required`、min/max、長さ、選択肢、`inSubtable`、`subtableCode` を付ける（[formFieldInfo.ts:58](../../src/core/formFieldInfo.ts#L58)-[76](../../src/core/formFieldInfo.ts#L76)）。検証 primitive 自体は `inSubtable` を分岐条件にせず、必須、数値、範囲、桁、長さ、選択肢を `KintoneFieldInfo` から評価する（[dmlValidation.ts:37](../../src/core/dmlValidation.ts#L37)-[106](../../src/core/dmlValidation.ts#L106)）。IMPORT も、スコープ解決した子 info を同じ primitive へ渡している（[importRecordValidation.ts:110](../../src/import/importRecordValidation.ts#L110)-[115](../../src/import/importRecordValidation.ts#L115)、[同:140](../../src/import/importRecordValidation.ts#L140)-[144](../../src/import/importRecordValidation.ts#L144)）。したがって子 info への再利用は成立する。

1セルの検証結果が NG なら1エラー行を出す。現行 primitive は順に検査して最初の違反を返すため、同一セルから同時に複数の組み込み違反を列挙しない。この優先規則はトップレベル B41 と同じである（[dmlValidation.ts:56](../../src/core/dmlValidation.ts#L56)-[105](../../src/core/dmlValidation.ts#L105)）。ただし全行・全対象子セルを走査するので、同じレコード、同じテーブル行に複数の不良セルがあればセルごとに別行となる。

サブテーブルが0行ならセルが存在しないため、子の `required` 等は発火しない。既存 adapter もテーブル配列が空なら子行を1件も生成しない（[subtableAdapter.ts:18](../../src/converter/subtableAdapter.ts#L18)-[23](../../src/converter/subtableAdapter.ts#L23)）。これは B12-A で確認された kintone 実挙動を継承する契約とする。ただし、その実機証跡は今回指定された B41 仕様および B12-A 文書内では行番号付きで再発見できなかったため、§9 の実機受入で再固定する。

### 3.4 `$err_value`

子セルでも B41 の `renderExistingValidationValue` をそのまま使う。空値・空配列は空文字、非空配列は code 配列 JSON、NUMBER は元字句を保持する（[existingRecordValidation.ts:1](../../src/core/existingRecordValidation.ts#L1)-[6](../../src/core/existingRecordValidation.ts#L6)）。子セルを flatten した文字列ではなく生値で検証・描画する。

### 3.5 B29 数値精度

対象にトップレベルまたは子の `NUMBER` が1つでもあれば、アプリ単位の `getNumberPrecisionCached` を1回利用する。キャッシュは appId と cache context 単位で `client.getNumberPrecision` を共有するため、親子で別取得は不要である（[execute.ts:3682](../../src/execute.ts#L3682)-[3691](../../src/execute.ts#L3691)）。取得した精度は各子 `NUMBER` にも渡し、`digits - decimalPlaces` を超える整数部を `ERR_NUMBER_INTEGER_DIGITS` とする（[dmlValidation.ts:71](../../src/core/dmlValidation.ts#L71)-[80](../../src/core/dmlValidation.ts#L80)）。

現行 core と EXPLAIN は `targets.some(fieldType === "NUMBER")` で精度要否を決める（[execute.ts:829](../../src/execute.ts#L829)-[831](../../src/execute.ts#L831)、[execute.ts:6596](../../src/execute.ts#L6596)-[6606](../../src/execute.ts#L6606)）。B42 target descriptor の子もこの判定へ含める。

## 4. エラー行スキーマ

固定スキーマを次の7列とし、既存5列の順序は変えない。

| 列 | 型メタ | トップレベル違反 | 子セル違反 |
|---|---|---|---|
| `$id` | number | 親レコード番号 | 親レコード番号 |
| `$err_field` | string | トップレベルフィールドコード | 子フィールドコード |
| `$err_code` | string | 既存エラーコード | 既存エラーコード |
| `$err_message` | string | 既存メッセージ | 既存メッセージ |
| `$err_value` | string | 現在の生値の描画 | 子セルの現在の生値の描画 |
| `$err_subtable` | string | 空文字 | 親テーブルコード |
| `$err_subrow` | number | 空文字 | 取得時の表示順を 1 から数えた序数 |

IMPORT は、子エラーの位置を `subtable` と `subrow` に保持し（[importRecordValidation.ts:12](../../src/import/importRecordValidation.ts#L12)-[18](../../src/import/importRecordValidation.ts#L18)）、`$err_subtable` / `$err_subrow` へ実体化する（[importErrors.ts:18](../../src/import/importErrors.ts#L18)-[25](../../src/import/importErrors.ts#L25)）。B42 はこの命名と「1-based 論理行」の意味を採用する。`$err_source_row` はファイル物理行専用なので追加しない。

`$err_subrow` は永続行 `id` ではなく、1-based 表示序数とする。B41 親仕様が「行番号付き」を要求し、IMPORT の `$err_subrow` も論理序数であり、監査結果を画面上の行へ対応付けやすいからである。既存 subtable 展開は0-based indexと永続 `row.id` の両方を保持する（[execute.ts:5873](../../src/execute.ts#L5873)-[5887](../../src/execute.ts#L5887)）ため、実装時は `rowIndex + 1` を出力できる。行の並べ替え後は同じセルの序数が変わり得る点を契約とする。永続 ID を使った自動修復は B41 の対象外（[ksql_existing_record_validation_spec.md:16](ksql_existing_record_validation_spec.md#L16)）であり、必要なら後続仕様で `$err_subrow_id` を加える。

トップレベル組み込み違反と `CHECK` 違反では、新2列を空文字にする。これにより既存5列の値と意味は維持され、明示列を選ぶ既存の後続 `SELECT $id, …, $err_value FROM #err` はそのまま動く。一方、`SELECT *`、CSVヘッダー、列数固定の利用者には2列追加が観測される。

現行は `EXISTING_VALIDATION_COLUMNS` が固定5列（[execute.ts:729](../../src/execute.ts#L729)）、`existingValidationColumnMeta` がその配列から型メタを作り（[execute.ts:778](../../src/execute.ts#L778)-[783](../../src/execute.ts#L783)）、batch analyzer が同じ5列を schema signature に直書きしている（[batch.ts:321](../../src/core/batch.ts#L321)-[329](../../src/core/batch.ts#L329)）。列追加時はこの3箇所を必ず同時に7列へ更新し、`$err_subrow` は number、`$err_subtable` は string とする。なお `existingValidationColumnMeta` の現在の「`$id` 以外は全て string」という分岐は `$err_subrow` に対応できないため、列別定義へ変更が必要である。

## 5. 実装方針

本節は将来の実装差分を特定するものであり、本 R1 起草ではコードを変更しない。

### 5.1 フォームと target 解決

- `src/core/formFieldInfo.ts`: `buildScopedSubtableFieldIndex` は `table -> children` と子の所有関係を既に保持する（[formFieldInfo.ts:21](../../src/core/formFieldInfo.ts#L21)-[38](../../src/core/formFieldInfo.ts#L38)）。B42 target 解決に再利用し、平坦 `byCode` だけに依存しない。
- `src/types/ast.ts`: `ValidateStatement.fields?: string[]`（[ast.ts:75](../../src/types/ast.ts#L75)-[83](../../src/types/ast.ts#L83)）を、トップレベル/テーブル全体/テーブル内子指定を保持する target 配列へ変更する。
- `src/parser/parser.ts`: 現行の `parseIdentList`（[parser.ts:677](../../src/parser/parser.ts#L677)-[680](../../src/parser/parser.ts#L680)）を、IMPORT と同型の入れ子 target parser へ置き換える。既存の平坦指定は同じ AST 意味へ変換し、既存 SQL を壊さない。
- `src/execute.ts`: `resolveExistingValidationTargets`（[execute.ts:740](../../src/execute.ts#L740)-[760](../../src/execute.ts#L760)）の戻り値を、子なら `subtableCode` を必須で持つ descriptor にする。既定導出、所有関係、重複、裸の子拒否をここで fail-fast に確定する。

### 5.2 取得と検証ループ

- `src/execute.ts`: `requiredFields` 構築（[execute.ts:816](../../src/execute.ts#L816)-[822](../../src/execute.ts#L822)）では、子 target を親テーブルコードへ写像し、重複を除く。`WHERE` / `CHECK` の子参照は fetch 前に明示拒否する。
- `src/execute.ts`: records fetch、raw/flat 行生成、組み込み検証、結果生成の本体（[execute.ts:856](../../src/execute.ts#L856)-[898](../../src/execute.ts#L898)）に、取得済みテーブル配列を展開する子セルループを追加する。トップレベルの `row.record[field.code].value` と同様に、子の生値を primitive と renderer へ渡す。
- `src/core/dmlValidation.ts`: `validateAndNormalizeDmlValue` 自体には `inSubtable` による除外がなく再利用可能（[dmlValidation.ts:37](../../src/core/dmlValidation.ts#L37)-[106](../../src/core/dmlValidation.ts#L106)）。新しい子専用制約判定を重複実装しない。
- `src/core/existingRecordValidation.ts`: `$err_value` 描画規則は現状のまま再利用する（[existingRecordValidation.ts:4](../../src/core/existingRecordValidation.ts#L4)-[6](../../src/core/existingRecordValidation.ts#L6)）。

### 5.3 出力、batch、EXPLAIN

- `src/execute.ts`: `EXISTING_VALIDATION_COLUMNS`（[execute.ts:729](../../src/execute.ts#L729)）、`existingValidationColumnMeta`（[execute.ts:778](../../src/execute.ts#L778)-[783](../../src/execute.ts#L783)）、結果行生成（[execute.ts:873](../../src/execute.ts#L873)-[897](../../src/execute.ts#L897)）を7列契約へ同期する。
- `src/core/batch.ts`: VALIDATE の固定 schema signature（[batch.ts:321](../../src/core/batch.ts#L321)-[329](../../src/core/batch.ts#L329)）を同じ7列へ更新する。旧5列 schema と新7列 schema の混在を許す条件分岐は設けない。
- `src/execute.ts`: EXPLAIN metadata の `targetFields` / `fetchFields`（[execute.ts:6601](../../src/execute.ts#L6601)-[6607](../../src/execute.ts#L6607)）を、論理 target と親テーブル fetch に分ける。plan builder（[execute.ts:6962](../../src/execute.ts#L6962)-[6980](../../src/execute.ts#L6980)）へ §7 の表示を追加する。
- テスト: `src/__tests__/existingRecordValidation.test.ts` の現行固定5列、子拒否、INTO、EXPLAIN テスト（[existingRecordValidation.test.ts:122](../../src/__tests__/existingRecordValidation.test.ts#L122)-[138](../../src/__tests__/existingRecordValidation.test.ts#L138)、[同:200](../../src/__tests__/existingRecordValidation.test.ts#L200)-[237](../../src/__tests__/existingRecordValidation.test.ts#L237)）を7列・新 target 規則へ更新し、§9 を追加する。

## 6. 対象外

- `CHECK` からのテーブルコード、子フィールド、行番号、行 ID の参照。B37 はサブテーブル DML の `CHECK` を非対応としている（[ksql_custom_check_spec.md:149](ksql_custom_check_spec.md#L149)）。B42 は組み込み制約監査だけを子セルへ拡張し、子行スコープの式評価は設計しない。
- `WHERE` からのサブテーブル子参照。親レコードをどの子行一致で選ぶかと、選ばれた親の全行を監査するか一致行だけを監査するかが別契約になるため、従来のトップレベル WHERE に限定する。現行 parser は修飾参照だけを明示拒否し（[parser.ts:697](../../src/parser/parser.ts#L697)-[715](../../src/parser/parser.ts#L715)）、executor の `infoByCode` には子も入る（[execute.ts:802](../../src/execute.ts#L802)-[816](../../src/execute.ts#L816)）。したがって「現行どおり拒否」を確実にするには、B42 実装時に `whereFields` の `inSubtable` を検査する明示ガードが必要である。現行コードだけからは全演算子での静的拒否を確認できず、この点は既存実装の潜在ギャップとして記録する。
- `FILE`、`SUBTABLE` 自体、`CALC`、レコード番号、作成者/更新者、作成/更新日時、ステータス、作業者、カテゴリー、関連レコード等、B41 の組み込み制約監査に該当しない型。IMPORT も子 `FILE` 等を明示的な非対応型にしている（[importRecordValidation.ts:9](../../src/import/importRecordValidation.ts#L9)-[10](../../src/import/importRecordValidation.ts#L10)）。
- ユニーク制約、レコード横断制約、違反の自動修復、永続サブテーブル行 ID を使う更新レシピ。B41 の対象外を維持する（[ksql_existing_record_validation_spec.md:16](ksql_existing_record_validation_spec.md#L16)）。
- 1セルから複数の組み込み違反を同時列挙する検証器への変更。現行の先勝ち primitive を維持する。

## 7. EXPLAIN・面

`VALIDATE` は B42 後も read-only であり、CLI、MCP、プラグインの全面で提供する。B41 は engine 側の純検証として全面同一と定め（[ksql_existing_record_validation_spec.md:68](ksql_existing_record_validation_spec.md#L68)-[71](ksql_existing_record_validation_spec.md#L71)）、現行テストも read-only、非 DML、完全入力、書込みなしを固定している（[existingRecordValidation.test.ts:77](../../src/__tests__/existingRecordValidation.test.ts#L77)-[83](../../src/__tests__/existingRecordValidation.test.ts#L83)）。B42 は確認ダイアログ、`--allow-dml`、mutation capability を追加しない。

`EXPLAIN VALIDATE` は現在の read-only、records fetch、完全入力、WHERE capability、audit fields、fetch fields、数値精度、書込みなし、違反件数なしの表示（[execute.ts:6962](../../src/execute.ts#L6962)-[6980](../../src/execute.ts#L6980)）を維持し、次を追加・変更する。

- `audit fields`: 子 target は `明細(数量, 単価)` のように親スコープ付きで表示する。
- `fetch fields`: 子コードではなく実際に取得する親テーブルコードを表示する。
- `subtable audit`: 対象テーブル、対象子数、`row locator=$err_subrow (1-based display order)` を表示する。
- `output schema`: 既存5列＋`$err_subtable,$err_subrow` を表示する。
- `number precision`: 子 `NUMBER` だけが対象の場合も `required` とする。
- EXPLAIN 中は従来どおりフォーム定義と必要時の number precision metadata だけを読み、records API と mutation API を呼ばず、行数・違反件数・実際のサブテーブル行数を表示しない。現行テストはこの契約を固定している（[existingRecordValidation.test.ts:228](../../src/__tests__/existingRecordValidation.test.ts#L228)-[237](../../src/__tests__/existingRecordValidation.test.ts#L237)）。

## 8. SemVer

推奨は **major** とする。

理由は次の2点が既存の公開観測結果を変えるためである。

1. `(fields)` 省略時に子を自動追加するため、従来0件またはN件だった同じ `VALIDATE APP…` が追加違反行を返し得る。
2. B41 が固定5列として公開した結果（[ksql_language_reference.md:2088](../ksql_language_reference.md#L2088)-[2089](../ksql_language_reference.md#L2089)）を固定7列へ変えるため、`SELECT *`、CSVヘッダー、列数を検査する利用者に影響する。

既存5列の列名、順序、値、型は維持し、トップレベル違反では新2列を空にするため、明示列参照の互換性は高い。しかし「結果行の増加」と「固定 schema の列追加」は単なる内部改善ではない。SemVer を厳密に適用するなら major が安全である。

minor を選ぶ代替案は、サブテーブル監査を新しい明示 opt-in に限定し、既定対象と5列 schemaを維持することである。しかし、位置列のない5列では子エラーを十分に表せず、既定 `VALIDATE APP…` の監査の抜けも残るため推奨しない。プロジェクトが「診断結果への加法変更」を minor と扱う明文化済み方針を別途採用する場合だけ minor を再検討する。この方針は現行ファイルから未確認である。

## 9. 受入条件

### 9.1 単体・統合テスト

- `(fields)` 省略で、トップレベル対象に加えて全テーブルの制約付き子と全子 `NUMBER` が選ばれ、制約なし非 `NUMBER`、`FILE` 等は選ばれない。
- 子の必須空、数値 min/max、文字列 min/maxLength、定義外選択肢、B29 整数部桁超過を検出する。各エラーは `$id`、子 `$err_field`、コード、メッセージ、描画済み生値、親 `$err_subtable`、1-based `$err_subrow` を持つ。
- 1親に複数テーブル、1テーブルに複数行、1行に複数不良セルがあるとき、全セルを走査して1セル1エラー行を生成し、順序が §3.2 の規則どおり安定する。
- 0行テーブルでは子 required を含めエラー0件。1行目が空セルなら required 1件。
- 同じ親にトップレベル違反、子セル違反、トップレベル `CHECK` 違反が混在する。トップレベルと `CHECK` の新2列は空、子だけ位置を持つ。
- `VALIDATE APP (Table)` は Table の監査可能な子全体、`VALIDATE APP (Table(child1, child2))` は指定子だけを対象にする。未知テーブル、未知子、所属違い、重複、監査対象外、空 child list は fetch 前に失敗する。
- 裸の子コードは、そのコードがたまたま1つしかなくても拒否する。別テーブルの同名子を `T1(value), T2(value)` で正しく分離する。
- requiredFields は子コードを含まず、親テーブルコードを1回だけ含む。トップレベル、WHERE、CHECK の必要列も失わない。
- 子 `NUMBER` だけを選んだ場合も number precision API は1回だけ呼ばれ、整数部桁チェックが有効になる。NUMBER が無ければ呼ばない。
- 結果0件でも7列 schema と列メタを保持する。`$id` と `$err_subrow` は number、それ以外は string。
- `VALIDATE … INTO #err; SELECT … FROM #err` で7列を参照できる。特に `$err_subtable` / `$err_subrow` で絞り込み・並び替えでき、既存5列だけの後続 SELECT も動く。異なる validation schema の同一 `#err` 追記は analyze 時に fail-fast する。
- `WHERE` / `CHECK` の子参照は、演算子にかかわらず records API 前に一貫した `ArgumentError`。トップレベル WHERE/CHECK は非回帰。
- read-only、`onLimit=error`、Cursor未使用、POST/PUT/DELETE 0回を維持する。
- EXPLAIN は親スコープ付き audit targets、親テーブル fetch、7列 schema、子 NUMBER 精度要否を示し、records/mutation API 0回、違反件数なしを維持する。

### 9.2 実機確認

- 制約違反を持つ子セル（必須、数値上下限、文字数、選択肢）を保存済みレコードに用意し、期待する位置付き行が CLI、MCP、プラグインで一致する。
- B29 用の子 `NUMBER` で、許容整数部桁数の境界値と1桁超過を確認する。
- 0行テーブルで子 required が発火しないことを再確認し、証跡を残す。今回の調査では過去の「実機確定」を示す行番号付き証跡を必読ファイルから特定できなかったため、この確認を release gate とする。
- 2行以上のテーブルで、表示順と `$err_subrow=1,2,…` が一致する。行を並べ替えて再取得した場合は新しい表示順へ追随する。
- トップレベル違反と子違反の混在で、既存5列の値が変わらず、新2列がトップレベル行では空である。
- `(fields)` 省略、テーブルコード、`テーブル(子…)`、裸の子拒否、別テーブル同名子を確認する。
- `INTO #err` 後の `SELECT` で既存5列と新2列を取得し、`WHERE $err_subtable = '明細'`、`ORDER BY $err_subrow` が動く。
- EXPLAIN が records API を呼ばず、実行本体が書込み API を呼ばないことを各面で確認する。

## 10. 未決論点

R1 の推奨案で実装を開始できるが、レビューで次を最終確認する。

1. **SemVer のリリース番号**: 本仕様は major を推奨する。診断結果の加法変更を minor とする既存プロジェクト方針があるなら、その文書根拠を提示して再判定する。
2. **永続行 ID**: R1 は `$err_subrow` の1-based 表示序数だけを出す。将来の自動修復・行並べ替えをまたぐ突合が実需なら、`$err_subrow_id` の加法追加を別仕様にする。`$err_subrow` の意味を途中で ID に変えない。
3. **子 target 構文**: 推奨は IMPORT と整合する `Table(child, …)`。代替は `Table.child` だが、現行 VALIDATE は修飾参照を拒否し（[parser.ts:706](../../src/parser/parser.ts#L706)-[710](../../src/parser/parser.ts#L710)）、target と WHERE/CHECK で `.` の意味が分かれるため非推奨。
4. **子コードのグローバル一意性**: 現行コードとテストは別テーブル同名子を許す前提である。公式 UI 上の最新制約を実機で確認できても、R1 は scoped index を維持し、裸の子コード解決には使わない。
5. **既存 WHERE 子参照の拒否**: 要求契約は拒否だが、現行 executor には全子参照を明示拒否する guard が見当たらない（§6）。B42 実装前に再現テストを追加し、現状が API エラー依存なら同時に静的 `ArgumentError` へ固定する。

## 11. R1 Claude レビュー（2026-07-20・全指摘コード裏取り済み）

引用 file:line は全数照合し正確。§6 の「WHERE 子参照に静的ガードなし」の発見も妥当（`infoByCode` は `flattenFormFieldProperties` 由来で子を含む＝[execute.ts:802](../../src/execute.ts#L802)-[827](../../src/execute.ts#L827) の存在チェックを子コードが素通りし、prefilter／requiredFields へ混入し得る）。以下を R2 で反映する。

### P1-1 行ロケータに永続行 ID を含めない判断は、リポジトリ自身のサブテーブル修復経路と矛盾

- kSQL は**サブテーブル仮想テーブル `APP100$明細` を SELECT/INSERT/UPDATE/DELETE/REORDER で正式対応済み**（言語リファレンス §19・[subtableAdapter.ts:12](../../src/converter/subtableAdapter.ts#L12)）。かつ **`UPDATE`/`DELETE` は安全のため `_rid`（永続行 ID）条件が必須**（言語 §19）。
- B41/#err の看板ユースは「違反を後続文で使う」。トップレベル違反は `$id` がそのまま修復キーになるが、子セル違反の唯一の書込み経路は `UPDATE APP100$明細 … WHERE _pid = … AND _rid = …` ＝ **1-based 序数だけでは #err から修復文を組めない**（序数→`_rid` の人手変換が必要で、行の並べ替えで無効化もされる）。
- IMPORT の `$err_subrow` が序数なのは**ソースがファイル行で ID を持たないから**。VALIDATE は保存済みレコードを読むため `row.id` が手元にある（[subtableAdapter.ts:27](../../src/converter/subtableAdapter.ts#L27)・[execute.ts:5877](../../src/execute.ts#L5877)）＝取得コスト増ゼロ。前提が異なるので前例の転用条件を満たさない。
- **勧告**: R2 で `$err_subrow_id`（string・`_rid` と同値・トップレベル行は空）を追加し **8 列で一度に確定**する。未決論点2の「後続仕様で加法追加」は固定 schema 変更を2回踏む（7列→8列で batch signature・言語リファレンスを再改定）ため不採用。あわせて仮想テーブル `_idx`（0-based）と `$err_subrow`（1-based）の**基数不一致を §4 に明記**する（`#err` を `APP100$明細` へ突き合わせる利用者は `$err_subrow_id = _rid` で結合すればよい、と誘導）。

### P1-2 代替構文 `VALIDATE APP100$明細` の検討が欠落

- parser は VALIDATE に対する仮想テーブル指定を**専用メッセージで既に拒否**している（[parser.ts:673](../../src/parser/parser.ts#L673)-[675](../../src/parser/parser.ts#L675)）＝設計上意識済みの構文であり、サブテーブルを対象化する kSQL の第一言語は `APP100$明細`（言語 §19）。§2 が `テーブル(子…)` を IMPORT 前例だけで正当化すると、「なぜ `VALIDATE APP100$明細` ではないのか」という質問に仕様が答えられない。
- **勧告**: `テーブル(子…)` 採用自体は妥当（**1文でトップレベル＋子の混在監査ができ、`#err` が1系統で済む**。仮想テーブル形式だと親と子で VALIDATE を2文書き、5列/7列の異 schema `#err` が並ぶ）。この採否理由を §2 に1節追加し、`APP100$明細` 形式は「明示拒否を維持」とエラーメッセージ（親アプリ形式への誘導文言）を受入条件に含める。

### P2-1 SemVer major 推奨は本プロジェクトの出荷前例と不整合

- §8/§10-1 が求める「文書根拠」は台帳 §2 に存在する: **B8**（`maxRecords` 意味論変更）= v2.11.0 **minor**・**B13**（`MIN`/`MAX` の結果が変わる）= v2.14.0 **minor**・**B9**（16桁超の比較結果が変わる）= v3.3.0 **minor**（台帳注記「16桁超の比較のみ結果が正しく変わる」）。major は v3.0.0（4面の比較意味論の全面刷新）のみ。
- 違反行の増加は「監査の抜けの修正」で B13 と同型・列追加は末尾加法で既存5列の名前/順序/値は不変。**勧告: minor（v3.7.0 相当）へ変更**。最終判断はユーザー。

### P2-2 0行テーブルの実機証跡は B12-A 実測として auto-memory に記録済み

- 「サブテーブル行なしなら子制約は発火しない」は **v2.13.0 B12-A の実機バグ3件修正時の kintone 実測確定事項**として auto-memory に記録がある（文書内の行番号付き証跡が無いという §3.3/§9.2 の指摘自体は正しい）。release gate 維持は妥当だが、位置づけを「初検証」でなく「**過去実測の再確認・文書化**」へ変更する。

### P3-1 §3.2「フォーム順」は過大表現

- 既定 target の列挙順は form fields API 応答の `Object.values` 列挙順（[formFieldInfo.ts:55](../../src/core/formFieldInfo.ts#L55)）であり、**フォームレイアウト順の保証はない**。「フォーム定義応答の列挙順（同一入力に対し決定的）」へ言い換える。
