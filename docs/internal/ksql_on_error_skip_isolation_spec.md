# kSQL 仕様案：ON ERROR SKIP（事前検証エラー行の隔離・継続）

- 出典: 設計メモ `ksql-batch/kSQL仕様案_Tier0エラー行隔離.md`（2026-07-16 に repo へ移設）
- ステータス: **一部実装（B12-A `VALIDATE ONLY` は v2.13.0、文字数計数のkintone実機確認待ち）。仕様レビュー R4。** B12-B は未実装。看板ユースケース（`#err` から差分アプリへの書き戻し）は **UPDATE … FROM の業務キー結合（B11 v1.1）を前提**とする（[ksql_update_from_spec.md](ksql_update_from_spec.md)・本書 §7）。Tier 0＝API 送信前のローカル検証エラーのみ隔離（API 実行時エラーは従来どおり fail-fast）。台帳 [ksql_issue_tracker.md](../ksql_issue_tracker.md) §1 B12。
- B12-A 実装計画: [ksql_validate_only_implementation_plan.md](ksql_validate_only_implementation_plan.md)
- 2026-07-16 R1: `VALIDATE ONLY [INTO #err]` の構文・ツール境界・戻り値を確定。create/update/upsert の検証差、`#err` の保持列、複数エラー時の書き戻し例を明確化。
- 2026-07-16 R2: Oracle / Snowflake / PostgreSQL / SQL Server / Db2 の公式仕様と比較し、採用点・非採用点・kSQL 固有の安全性判断を §8 に追記。
- 2026-07-16 R3: Claude レビューをコードで再確認して反映。B12-B の前提を B11 v1.1（非 `$id` 業務キー結合）へ修正。B12-A の必須実装としてフィールド制約メタ拡張、collect 型検証器、`#err` 追記、文単位 read-only 判定を確定。例を実在構文 `APP<n>` へ修正。
- 2026-07-16 R4: B12-A の厳密なローカル検証が通常書き込み経路より厳しい場合を明記。B12-B の隔離厳格度を実装前の設計ゲートとし、false isolation の扱いを確定事項から分離。
- 2026-07-16 R5: B11.1 実機確認で判明した kintone PUT の全レコード再検証を §9 に追記。UPDATE の SET 対象外に既存の制約違反値がある場合は `VALIDATE ONLY` で検出できず、API実行時に fail-fast となる Tier 0 境界を明文化。
- 分担: Claude=仕様/観点、Codex=実装/テスト

## 1. 目的と定義

DML バッチの fail-fast 原則を維持したまま、「1 件の不良データで夜間バッチ全体が停止する」問題を解消する。

> **定義**: 本機能が隔離するのは、kSQL が **API 送信前にローカルで判定できる検証エラーに限る**（Tier 0）。kintone API 実行時のエラー（権限・競合・一意制約衝突・プラグイン/カスタマイズ JS による保存拒否・実行時の業務ルールエラー等）を行単位で隔離する機能ではない。API レベルの書き込み失敗は従来通り fail-fast とし、リクエスト数・実行セマンティクスへの影響をゼロに抑える。
>
> **非保証**: 本検証（VALIDATE ONLY 含む）の通過は、kSQL が取得済みのアプリ定義と入力データから判定可能なエラーの不存在を示すものであり、**kintone API による書き込み成功を保証しない**。

## 2. 構文

```sql
INSERT INTO <app> (...) <VALUES ... | SELECT ...>
  [VALIDATE ONLY [INTO #<err_table>]
   | ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;

UPSERT INTO <app> (...) <VALUES ... | SELECT ...>
  ON DUPLICATE (<key>)
  [VALIDATE ONLY [INTO #<err_table>]
   | ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;

UPDATE <app> SET ... WHERE ...
  [VALIDATE ONLY [INTO #<err_table>]
   | ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;
```

- `VALUES` 形式と `SELECT` 形式の INSERT / UPSERT の双方を対象とする
- `VALIDATE ONLY` … 全候補行を検証して結果を返すが、kintone への書き込みは 0 件。`INTO` 指定時は後続文から参照できる一時テーブルにも格納する
- `ON ERROR SKIP INTO #err` … 検証 NG 行を temp table `#err` に隔離し、合格行のみ書き込む
- `VALIDATE ONLY` と `ON ERROR SKIP` は排他的。同じ文への併記は ParseError
- `REJECT LIMIT n` の規則:
  - カウントは**隔離された行数**に適用する。1 行に複数の検証エラーがあっても 1 行として数える（`#err` にはエラーごとに 1 行記録されるが、LIMIT 判定は行数）
  - **n 行までは許容し、n+1 行目で超過**。`REJECT LIMIT 0` は 1 行でも隔離があれば停止（fail-fast に `#err` 付き診断を加えたものに相当）
  - 超過時も**全行の検証を完了**してから、**書き込みを一切行わず**停止する。部分書き込み後の停止は発生せず、結果は決定的
  - 超過による停止時も `#err` は結果セットとして返す（原因調査に使える）
  - `REJECT LIMIT` 省略時は `UNLIMITED`（隔離件数無制限で継続）。`ON ERROR SKIP` 句自体を書かなければ従来の fail-fast
- 句を付けない既存 SQL の挙動は一切変わらない（後方互換）

### 2.1 VALIDATE ONLY の公開境界（先行リリース）

- 単文の `VALIDATE ONLY` は read-only と分類し、`ksql_query` で実行できる。`allowDml` / `confirmText` は不要
- DML を含む `ksql_mutate` バッチ内にも記述できる。この場合はバッチ全体に既存の DML 承認を要求する
- 戻り値は `{ validatedRows, validRows, invalidRows, errorCount, errors }`。`errors` は §5 と同じ列を持つ結果セットで、`INTO` の有無にかかわらず返す
- `invalidRows` は不正なソース行のユニーク数、`errorCount` は検証エラー総数。1 行に複数エラーがあれば後者だけが増える
- `VALIDATE ONLY` は DML の影響件数ガード対象外。ただしソース取得上限・一時テーブル上限・タイムアウトは通常の read-only 実行と同じ
- `VALIDATE ONLY` の通過後に本実行へ自動昇格する機能は持たない。本実行は利用者が明示的に別途行う

### 2.2 read-only 分類の実装契約

- INSERT / UPSERT / UPDATE の AST に `validateOnly: boolean`（既定 `false`）を持たせる。`INTO` 指定時は `validationErrorTable: string | null` も保持する
- 型名だけを見る既存 `isReadOnlyType()` / `isDmlType()` では判定できないため、文単位の `writesKintone(stmt) = isDmlType(stmt.type) && !stmt.validateOnly` を追加する
- `StatementAnalysis.isDml` と `BatchAnalysis.containsDml` は「kintone へ書き込むか」という既存の公開意味を維持し、`writesKintone` から算出する。`VALIDATE ONLY` 文は `isReadOnly=true`, `isDml=false`
- `VALIDATE ONLY` だけのバッチは `isReadOnlyBatch=true` となり `ksql_query` で実行可能。通常 DML が1文でも混在すれば `containsDml=true` となり、従来どおり `ksql_mutate`・確認・DML用 limit 規則を使う
- MCP の `canRunWithQueryTool` / `requiresMutationTool`、CLI のDML承認、UIの確認ダイアログと `onLimitReached=error` 強制は、この文単位判定へ揃える

## 3. 実行セマンティクス

```
1. ソース確定（スナップショット）
2. 全行をローカル検証（API コストゼロ）
   └ NG 行 → #err へ。REJECT LIMIT 超過なら AssertError 相当で停止（何も書かない）
3. 合格行のみ従来通りバルク書き込み（100件チャンク）
   └ ここでの API エラーは従来通り fail-fast（Tier 0 では扱わない）
4. 結果メタデータに skippedRows / errTable を返す
```

- 検証は**書き込み開始前に全行完了**する。「一部書き込み後に REJECT LIMIT 超過で停止」は発生しない
- 1 ソース行に複数エラーがある場合、#err には**エラーごとに 1 行**記録する（REJECT LIMIT のカウントはソース行単位）
- DML バッチ内では #err を後続ステートメントから参照可能（差分アプリへの書き戻し等)
- **#err の共有規則**: 指定名の temp table がなければ自動作成、あれば追記（`$err_statement` で文を識別）。ただし共有できるのは**同一の入力ペイロード列構成を持つ DML からのみ**で、列構成が異なる DML が同名 #err を指定した場合は validate 段階の静的エラーとする

既存 temp store は `CREATE TEMP TABLE` の新規 `set` だけで追記 API を持たない。B12-A で内部専用 `appendValidationErrors(name, schema, rows)` を追加し、(1) 未作成なら作成、(2) 列名・列順が完全一致なら上限確認後に追記、(3) 不一致なら最初の追記前に静的エラー、とする。利用者向けの汎用 `INSERT INTO #temp` は解禁しない。追記後の総行数にも `tempTableMaxRows` を適用し、超過時は当該文の結果を追加しない。

### 3.1 操作別の検証対象

- INSERT: 明示値とローカルで判定可能な既定値を合わせた「新規作成ペイロード」を検証する。既定値を持たない必須列の欠落も行エラー
- UPDATE: kintone に送る変更列だけを検証する。未送信の必須列は検証しない
- UPSERT: 既存キー照合後、insert 行には INSERT 規則、update 行には UPDATE 規則を適用する。したがって `VALIDATE ONLY` でも通常 UPSERT と同じ照合用 read API は発生し得る
- 型変換と空値判定は実書き込みと同じ正規化関数を共有し、検証器と converter で判定を二重実装しない
- アプリ定義は文の開始時に 1 回取得したスナップショットを使う

### 3.2 B12-A の共通検証器（collect 型）

現行 `toKintoneValue()` は最初の不正値で `DmlConvertError` を throw するため、そのままでは全行・複数エラーを収集できない。B12-A では変換プリミティブを次の2層へ分ける。

```ts
type DmlValueValidation =
  | { ok: true; value: KintoneValue }
  | { ok: false; code: DmlValidationErrorCode; message: string };

validateAndNormalizeDmlValue(value, fieldInfo): DmlValueValidation; // throw しない
toKintoneValue(value, fieldInfo): KintoneValue;                     // 上記を呼び、NGなら従来どおり throw
```

- `VALIDATE ONLY` は全行・全対象列に `validateAndNormalizeDmlValue` を適用してエラーを収集する
- 句なし DML は既存の `toKintoneValue` 経路を維持し、最初のエラーで停止する後方互換を保つ
- required / length / range / choice も同じ `fieldInfo` と正規化済み値を入力にする。UPSERT のソース内キー重複など行間検証は別レイヤーで収集する
- エラー文言は変更可能だが `DmlValidationErrorCode` は §5 の安定コードへ対応させる
- `VALIDATE ONLY` は日付の実在性やフォーム制約まで厳密に確認するため、変換失敗値をrawのままAPIへ委ねる句なしDMLより厳しい場合がある。したがって検証エラーはローカル Tier 0 問題の検出であり、API拒否の保証ではない
- **B12-B 実装前ゲート**: `ON ERROR SKIP` の隔離条件を (A) 通常書き込み経路と同じ厳格度へ合わせて false isolation を避ける、または (B) B12-A と同じTier 0厳格検証を採用する、のどちらにするかを実装前に確定する。B12-A R2では決めない

### 3.3 フィールド制約メタデータ（B12-A 必須）

現行 `FormFieldProperty` → `flattenFormFieldProperties()` → `KintoneFieldInfo` は code / label / type / options しか保持しない。node と UI/plugin が共有するこの経路に以下を追加する。

| プロパティ | 用途 |
|---|---|
| `required?: boolean` | `ERR_REQUIRED` |
| `maxValue?` / `minValue?` | `ERR_RANGE_MAX` / `ERR_RANGE_MIN` |
| `maxLength?` / `minLength?` | `ERR_LENGTH_MAX` / `ERR_LENGTH_MIN` |
| `defaultValue?` | INSERT 時の「既定値を持たない必須列」判定 |
| 既存 `options` | `ERR_CHOICE_INVALID` |

API の文字列表現を無理に number 化せず、比較時に既存の厳密数値比較方針へ正規化する。`flattenFormFieldProperties()` の再帰処理、node client、UI client、フィールドキャッシュ、fixture の双方で欠落しないことをテストする。

### 3.4 静的エラーと行エラー

列数不一致、存在しない/書込不可フィールド、式評価エラー、`#err` のスキーマ不一致など、行を除外しても文を安全に実行できない問題は隔離しない。`VALIDATE ONLY` / `ON ERROR SKIP` のどちらでも従来どおり文全体を停止する。

## 4. 検証項目（kintone フィールド定義から判定可能なもの）

| 分類 | 検証内容 | 対象フィールド |
|---|---|---|
| 必須 | required フィールドの空値 | 全型 |
| 型変換 | 数値変換不可、日付/時刻/日時の形式不正 | NUMBER, DATE, TIME, DATETIME |
| 範囲 | maxValue / minValue、maxLength / minLength | NUMBER, 文字列一行/複数行 |
| 選択肢 | 定義外の値 | DROP_DOWN, RADIO, CHECK_BOX, MULTI_SELECT |
| キー | UPSERT キー（重複禁止フィールド）の空値 | updateKey 対象 |
| ソース内重複 | UPSERT ソース内に同一キーが複数存在した場合、**そのキーを持つ全行を `ERR_KEY_DUP_SOURCE` として隔離**する（一部の行を入力順で偶然採用しない。どの行が正か決める根拠は入力順にはなく、重複解消は利用者の責務とする） | updateKey 対象 |
| 書込不可 | 計算・ルックアップコピー先など更新不可フィールドへの代入 | ※これは行エラーではなく validate 段階の静的エラーとする |

**対象外（ローカル検証不能）**: ユーザー/組織/グループ選択の実在性、ルックアップ整合、レコード権限、プロセス管理状態、既存レコードとの INSERT 時一意制約衝突（※事前 SELECT 1 回で検証する準ローカル検証を将来オプション `WITH UNIQUE CHECK` として検討）。

## 5. エラーテーブル（#err）スキーマ

Oracle `err$_` テーブルを参考に、DML へ投影された入力ペイロード列を保持しつつ `$` プレフィックスでエラー情報列を付加する。

| 列 | 内容 |
|---|---|
| （入力ペイロード列） | INSERT / UPSERT は DML の対象列名へ対応付けた値。UPDATE は `$id` と SET 対象列の検証時点の値 |
| `$err_statement` | バッチ内の文番号（1 起点。バッチ内複数 DML の切り分け用） |
| `$err_operation` | 操作種別（INSERT / UPDATE / UPSERT） |
| `$err_row` | ソース内の行位置（1 起点、入力順） |
| `$err_field` | エラーになったフィールドコード |
| `$err_code` | エラーコード（機械可読・安定値。下記） |
| `$err_message` | 人間可読メッセージ（日本語。文言は将来変更があり得るため、プログラムでの分類には `$err_code` を使う） |

`SELECT` の背後にある元テーブル全列は保持しない。JOIN・式・集約では「元行」が一意に定義できず、DML の入力投影に含まれない相関 ID を暗黙に持ち回ると実行器依存になるためである。後続処理との相関には、DML 対象にも含まれる業務キー（UPSERT キー等）を使う。

エラーコード体系（案・安定値として凍結する）: `ERR_REQUIRED` / `ERR_TYPE_NUMBER` / `ERR_TYPE_DATE` / `ERR_RANGE_MAX` / `ERR_RANGE_MIN` / `ERR_LENGTH_MAX` / `ERR_LENGTH_MIN` / `ERR_CHOICE_INVALID` / `ERR_KEY_EMPTY` / `ERR_KEY_DUP_SOURCE`

## 6. 利用例（顧客マスタ差分更新バッチ STEP 3 への適用）

```sql
CREATE TEMP TABLE #tgt AS
SELECT d.$id AS 差分ID, d.顧客コード, d.顧客名, d.住所, d.電話番号
FROM APP4220 d WHERE d.処理ステータス = '未処理';

UPSERT INTO APP4219 (顧客コード, 顧客名, 住所, 電話番号)
SELECT 顧客コード, 顧客名, 住所, 電話番号 FROM #tgt
ON DUPLICATE (顧客コード)
ON ERROR SKIP INTO #err REJECT LIMIT 100;

-- 1 入力行に複数エラーがあり得るため、B11 の複数マッチ禁止に触れないよう
-- 業務キー単位へ 1 行化してから差分アプリへ書き戻す（→ §7 の依存機能）
CREATE TEMP TABLE #err_summary AS
SELECT 顧客コード, MIN($err_message) AS エラー内容
FROM #err GROUP BY 顧客コード;

-- B11 v1.1（業務キー結合）が必要。B11 v1 の target.$id = source.key では実行不可
UPDATE APP4220 SET 処理ステータス = 'エラー', エラー内容 = e.エラー内容
FROM #err_summary e WHERE APP4220.顧客コード = e.顧客コード;

-- 正常行のみ処理済みへ
UPDATE APP4220 SET 処理ステータス = '処理済', 処理日時 = NOW()
WHERE $id IN (SELECT 差分ID FROM #tgt)
  AND 顧客コード NOT IN (SELECT 顧客コード FROM #err);
```

APP4220＝差分アプリ、APP4219＝顧客マスタ。この例のエラー書き戻しは、`#err` が UPSERT 入力ペイロードだけを保持して差分アプリの `$id` / `差分ID` を持たないため、構造的に業務キー結合を必要とする。B11 v1 の `$id` 単一等値では代替できない。

事前チェック STEP（不正データ隔離の UPDATE 群）がこの 1 句に吸収され、バッチが「本処理＋検証」の 2 STEP に簡素化される。

## 7. 依存・関連機能

- **B11 v1（実装済み）**: `UPDATE ... FROM` の SET 転記は利用可能だが、結合は `target.$id = source.key` に限定される
- **B11 v1.1（B12-B のリリースゲート）**: `target.<業務キー> = source.<業務キー>` の単一等値を追加する。§6 の書き戻しは差分アプリの `$id` を `#err` に保持しないため、v1.1 なしでは実行不能。複数マッチは引き続き最初の PUT 前にエラーとする
- **結果メタデータ拡張**: `{ affectedRows, skippedRows, rejectLimit, errTable }` を mutation result と MCP/CLI の文サマリーへ後方互換な追加フィールドとして加える。operation別 result型、`toMutationSummary`、CLI表示、MCP/CLIスナップショットを更新する
- **VALIDATE ONLY モード（DRY RUN との統合）**: 同じ検証エンジンを「書き込みゼロでエラー一覧のみ返す」モードで公開（Snowflake `VALIDATION_MODE = RETURN_ERRORS` 相当）。DRY RUN 機能案の一部として実装を共有できる

### 7.1 リリース分割

1. **B11 v1（実装済み）** — `$id` 単一等値の `UPDATE ... FROM`
2. **B12-A: VALIDATE ONLY** — AST、制約メタデータ、collect 型 Tier 0 検証器、`#err` 作成/追記、文単位read-only分類、エラー結果セット、CLI/MCP表示。B11には依存しない
3. **B11 v1.1: 業務キー結合** — `target.<field> = source.<field>` の単一等値、型正規化、複数マッチfail-closedを追加
4. **B12-B: ON ERROR SKIP** — B12-A の検証結果で正常行だけを既存 DML 経路へ渡し、`REJECT LIMIT` とmutation結果メタデータを追加。エンジン単体はB11非依存だが、§6を製品受入条件にするためB11 v1.1後にリリースする

B12-A の利用実績は B12-B の着手判断材料にはするが、B12-A の構文・エラーコードは先行公開時点で互換契約として固定する。

### 7.2 最低受入条件

- 全エラー 0 件の `VALIDATE ONLY` で write API が 0 回、通常実行と同じ候補行数が `validRows` になる
- 1 行複数エラーで `invalidRows = 1`、`errorCount > 1`、`errors` はエラー数分になる
- `REJECT LIMIT n` は不正行数が n 以下なら正常行だけを書き込み、n+1 以上なら write API 0 回で全エラーを返す
- UPSERT は insert/update の判定後に別々の必須検証規則を適用する
- API 書き込みエラーは隔離されず、従来どおり fail-fast
- 句なし DML の AST・実行結果・API 回数に回帰がない
- `VALIDATE ONLY` 単文/専用バッチは `containsDml=false` で `ksql_query` が受理し、通常DML混在時だけ `ksql_mutate` を要求する
- 同名 `#err` は同一schemaなら追記し、異なるschemaまたは `tempTableMaxRows` 超過なら既存行を壊さず静的エラーになる
- node / UI のフォームフィールド取得で required・range・length・default metadata が保持される
- §6 の業務キー書き戻しが B11 v1.1 で動作し、複数マッチ時は PUT 0 回になる

## 8. 他 RDB・DWH の同等機能との比較評価

### 8.1 機能比較

| 製品 | 対象 | 継続できるエラー | エラー取得 | 上限超過・原子性 | B12 との関係 |
|---|---|---|---|---|---|
| Oracle Database | 通常の INSERT / UPDATE / MERGE / DELETE | NOT NULL・一意・参照・CHECK、型変換、トリガー等の実行時 DML エラーの一部 | 永続エラーテーブル。エラー番号・文言・操作・行データ・任意タグを保持 | `REJECT LIMIT` 超過で本体 DML をロールバックする一方、記録済みエラーログは残る。既定上限は 0 | **最も近い先行例**。句の骨格、操作種別、機械可読コード、エラーテーブルを採用。ただし kSQL は実行時 API エラーを扱えない |
| Snowflake | ステージファイルからの `COPY INTO` | ファイル解析・変換等。`ON_ERROR=CONTINUE` は不正行を飛ばしてロード継続 | COPY 結果、`VALIDATION_MODE=RETURN_ERRORS`、ロード後の `VALIDATE()` | 行単位継続のほかファイル単位・件数/割合でファイルを棄却。通常 COPY の既定は文中止 | **VALIDATE ONLY の直接的な先行例**。検証と本実行を分ける UX を採用。ただし Snowflake の検証モードにも変換付き COPY 非対応という境界がある |
| PostgreSQL 18 | text / CSV の `COPY FROM` | 入力値から列型への変換エラーのみ | 最終件数と `NOTICE`。verbose で行・列を通知するが、標準のエラーテーブルはない | `ON_ERROR=ignore` + 正整数 `REJECT_LIMIT`。省略時は無制限。超過時は COPY が失敗 | `ON ERROR` と行数上限の分かりやすさを支持。ただし診断の再利用性と対象エラー範囲は B12 の方が広い |
| SQL Server | `BULK INSERT` | 主に入力の構文・形式エラー。`MAXERRORS` が適用されない制約/型もある | `ERRORFILE` に元入力、別制御ファイルに診断 | `MAXERRORS` 既定 10。`BATCHSIZE` 使用時はバッチごとのコミットとなり部分反映への配慮が必要 | ファイル退避と安全弁は参考になるが、通常 DML ではなく、B12 の「上限超過なら write API 0 回」とは安全性が異なる |
| Db2 | `LOAD` utility | 一意索引・範囲制約・セキュリティーポリシー違反等 | `FOR EXCEPTION` の例外テーブル。ロード前の不正データ・構文エラーは別の dump file | `WARNINGCOUNT` は警告数による停止。例外表は利用者が事前作成し、既存行へ追記 | 元行を後処理可能な表へ残す点を採用。エラー種別ごとの出力先分離は採らず `$err_code` に統合 |
| **kSQL B12** | INSERT / UPDATE / UPSERT の候補行 | アプリ定義と入力から API 送信前に判定できる Tier 0 エラーのみ | 結果セット＋任意の一時表 `#err`。コード・文言・操作・行位置・入力ペイロードを保持 | 全行を先に検証。不正行数が上限超過なら **write API 0 回**。範囲内なら正常行だけを既存チャンクで送信 | REST API 越しでDBトランザクションを持てない制約に合わせた、事前検証型の設計 |

公式資料: [Oracle DML Error Logging](https://docs.oracle.com/en/database/oracle/oracle-database/19/admin/managing-tables.html) / [Snowflake COPY INTO](https://docs.snowflake.com/en/sql-reference/sql/copy-into-table) / [PostgreSQL 18 COPY](https://www.postgresql.org/docs/18/sql-copy.html) / [SQL Server BULK INSERT](https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql) / [Db2 load exception tables](https://www.ibm.com/docs/en/db2/12.1?topic=integrity-load-exception-tables)

### 8.2 評価

1. **機能モデルは Oracle が最も近い。** 通常 DML に句を付け、正常行を継続しながらエラー行を表へ残す点は一致する。B12 の `$err_operation`、`$err_code`、`$err_message`、入力列という構成にも妥当性がある。
2. **先行順は Snowflake 型が妥当。** Snowflake が検証のみとロード継続を別機能として提供しているのと同様、B12-A `VALIDATE ONLY` で検証器と診断 UX を先に安定させ、B12-B で書き込み行の選別へ進む分割はリスクが低い。
3. **上限超過時の write API 0 回は kSQL に必須。** RDB は同一エンジン内でロールバックできるが、kSQL は複数の kintone API 呼び出しを横断するトランザクションを持たない。検出しながら書き込む方式では、後半で上限を超えた時点で前半を戻せない。
4. **診断能力は Oracle / Db2 に近く、永続性は劣る。** `#err` はバッチ内で扱いやすい一方、一時表なので監査証跡にはならない。長期保存が必要な場合は B11 `UPDATE ... FROM` または INSERT でログ用アプリへ明示的に転記する。
5. **検出範囲は RDB より狭い。** Oracle は制約・トリガー等のサーバー実行時エラーも隔離できるが、B12 はローカル Tier 0 に限定される。したがって利用者向け名称・説明では単なる「DMLエラー継続」ではなく、必ず **事前検証エラー行の隔離** と表現する。
6. **不正“行数”で数える判断は維持する。** 1 行に複数エラーがある場合でも運用上の修正対象は1行である。結果には `invalidRows` と `errorCount` の双方を返し、安全弁は前者へ適用する。この区別は Snowflake の parsed/loaded 行差分とも整合する。

### 8.3 総合判定

**採用継続（妥当）**。B12 は既存製品の単純模倣ではなく、Oracle のエラー表、Snowflake の検証専用モード、PostgreSQL / SQL Server の許容上限を、kintone REST API の非トランザクション制約に合わせて再構成した仕様である。

競合機能に対する強みは「上限超過を全行検証後に確定し、書き込みを始めない決定性」と「通常 DML / SELECT ソースへ適用できること」。弱みは「API 実行時エラーを隔離できないこと」と「`#err` が永続監査ログではないこと」。この2点を制限事項として維持すれば、機能名・構文・段階リリース方針はいずれも妥当と評価する。

## 9. 制限事項（明文化してドキュメントに記載すべきもの)

1. Tier 0 で検証できないエラー（権限・ルックアップ・ユーザー実在性等）で書き込みが失敗した場合は従来通り fail-fast。「ON ERROR SKIP を付ければ絶対止まらない」わけではない
2. 一意制約の同時実行競合（検証後〜書き込み前に他者が同キーを作成）は検出不能。夜間バッチ前提では許容範囲
3. kintone 側のフィールド定義変更とキャッシュの不整合時は、検証合格でも書き込み失敗があり得る（フィールド定義の取得タイミングを文実行時とする）
4. kintone は UPDATE（PUT）時にレコード全体を再検証する。制約を後から追加したアプリなどで、既存レコードの SET 対象外フィールド（サブテーブル子を含む）に必須・minLength等の制約違反値が残っている場合、UPDATE は `CB_VA01` 等で失敗し得る。B12-A の UPDATE 検証は送信する SET 列だけを対象とするため、この既存値違反は `VALIDATE ONLY` では検出せず、API実行時エラーとして従来どおり fail-fast になる
