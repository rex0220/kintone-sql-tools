# kSQL 仕様案：ON ERROR SKIP（事前検証エラー行の隔離・継続）

- 出典: 設計メモ `ksql-batch/kSQL仕様案_Tier0エラー行隔離.md`（2026-07-16 に repo へ移設）
- ステータス: **未実装・採用（B12・Phase 3）。codex レビュー前。** 依存機能 **UPDATE … FROM（B11・Phase 2・§7）を先行**。実装は **VALIDATE ONLY を先行リリース**（書き込み非変更・低リスクで需要検証）→ 需要立証後に `ON ERROR SKIP INTO #err`。Tier 0＝API 送信前のローカル検証エラーのみ隔離（API 実行時エラーは従来どおり fail-fast）。台帳 [ksql_issue_tracker.md](../ksql_issue_tracker.md) §1 B12。
- 分担: Claude=仕様/観点、Codex=実装/テスト

## 1. 目的と定義

DML バッチの fail-fast 原則を維持したまま、「1 件の不良データで夜間バッチ全体が停止する」問題を解消する。

> **定義**: 本機能が隔離するのは、kSQL が **API 送信前にローカルで判定できる検証エラーに限る**（Tier 0）。kintone API 実行時のエラー（権限・競合・一意制約衝突・プラグイン/カスタマイズ JS による保存拒否・実行時の業務ルールエラー等）を行単位で隔離する機能ではない。API レベルの書き込み失敗は従来通り fail-fast とし、リクエスト数・実行セマンティクスへの影響をゼロに抑える。
>
> **非保証**: 本検証（VALIDATE ONLY 含む）の通過は、kSQL が取得済みのアプリ定義と入力データから判定可能なエラーの不存在を示すものであり、**kintone API による書き込み成功を保証しない**。

## 2. 構文

```sql
INSERT INTO <app> (...) SELECT ...
  [ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;

UPSERT INTO <app> (...) SELECT ...
  ON DUPLICATE (<key>)
  [ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;

UPDATE <app> SET ... WHERE ...
  [ON ERROR SKIP INTO #<err_table> [REJECT LIMIT <n>]] ;
```

- `ON ERROR SKIP INTO #err` … 検証 NG 行を temp table `#err` に隔離し、合格行のみ書き込む
- `REJECT LIMIT n` の規則:
  - カウントは**隔離された行数**に適用する。1 行に複数の検証エラーがあっても 1 行として数える（`#err` にはエラーごとに 1 行記録されるが、LIMIT 判定は行数）
  - **n 行までは許容し、n+1 行目で超過**。`REJECT LIMIT 0` は 1 行でも隔離があれば停止（fail-fast に `#err` 付き診断を加えたものに相当）
  - 超過時も**全行の検証を完了**してから、**書き込みを一切行わず**停止する。部分書き込み後の停止は発生せず、結果は決定的
  - 超過による停止時も `#err` は結果セットとして返す（原因調査に使える）
  - `REJECT LIMIT` 省略時は `UNLIMITED`（隔離件数無制限で継続）。`ON ERROR SKIP` 句自体を書かなければ従来の fail-fast
- 句を付けない既存 SQL の挙動は一切変わらない（後方互換）

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
- **#err の共有規則**: 指定名の temp table がなければ自動作成、あれば追記（`$err_statement` で文を識別）。ただし共有できるのは**同一のソース列構成を持つ DML からのみ**で、列構成が異なる DML が同名 #err を指定した場合は validate 段階の静的エラーとする

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

Oracle `err$_` テーブル（ソース全列＋エラー情報列）に倣い、ソース列を保持しつつ `$` プレフィックスでエラー情報列を付加する。

| 列 | 内容 |
|---|---|
| （ソース全列） | 隔離された行の元の値 |
| `$err_statement` | バッチ内の文番号（1 起点。バッチ内複数 DML の切り分け用） |
| `$err_operation` | 操作種別（INSERT / UPDATE / UPSERT） |
| `$err_row` | ソース内の行位置（1 起点、入力順） |
| `$err_field` | エラーになったフィールドコード |
| `$err_code` | エラーコード（機械可読・安定値。下記） |
| `$err_message` | 人間可読メッセージ（日本語。文言は将来変更があり得るため、プログラムでの分類には `$err_code` を使う） |

エラーコード体系（案・安定値として凍結する）: `ERR_REQUIRED` / `ERR_TYPE_NUMBER` / `ERR_TYPE_DATE` / `ERR_RANGE_MAX` / `ERR_RANGE_MIN` / `ERR_LENGTH_MAX` / `ERR_LENGTH_MIN` / `ERR_CHOICE_INVALID` / `ERR_KEY_EMPTY` / `ERR_KEY_DUP_SOURCE`

## 6. 利用例（顧客マスタ差分更新バッチ STEP 3 への適用）

```sql
CREATE TEMP TABLE #tgt AS
SELECT d.$id AS 差分ID, d.顧客コード, d.顧客名, d.住所, d.電話番号
FROM APP_差分 d ...;

UPSERT INTO APP_顧客マスタ (顧客コード, 顧客名, 住所, 電話番号)
SELECT 顧客コード, 顧客名, 住所, 電話番号 FROM #tgt
ON DUPLICATE (顧客コード)
ON ERROR SKIP INTO #err REJECT LIMIT 100;

-- エラー行を差分アプリへ書き戻し（→ §7 の依存機能）
UPDATE APP_差分 SET 処理ステータス = 'エラー', エラー内容 = e.$err_message
FROM #err e WHERE APP_差分.$id = e.差分ID;

-- 正常行のみ処理済みへ
UPDATE APP_差分 SET 処理ステータス = '処理済', 処理日時 = NOW()
WHERE $id IN (SELECT 差分ID FROM #tgt)
  AND $id NOT IN (SELECT 差分ID FROM #err);
```

事前チェック STEP（不正データ隔離の UPDATE 群）がこの 1 句に吸収され、バッチが「本処理＋検証」の 2 STEP に簡素化される。

## 7. 依存・関連機能

- **UPDATE ... FROM（他テーブル参照の SET）**: 現行パーサーは SET の値にフィールド参照を許可しない（確認済み: 「SET の値にはリテラル・算術式を指定してください」）。#err のメッセージを差分アプリへ書き戻すユースケースに必須のため、本仕様とセットで実装が望ましい。代替として `$err_code` ごとに固定文言で UPDATE する回避策はあるが冗長。**結合の複数マッチ（更新対象 1 行に FROM 側が複数行マッチ）は DML 実行前エラーに固定**する——先勝ちは行順依存で決定性を失い、結合条件の誤りやデータ重複を静かに隠すため
- **結果メタデータ拡張**: `{ affectedRows, skippedRows, rejectLimit, errTable }` を mutate 結果に追加。MCP/CLI の呼び出し側がスキップ発生を機械判定できること
- **VALIDATE ONLY モード（DRY RUN との統合）**: 同じ検証エンジンを「書き込みゼロでエラー一覧のみ返す」モードで公開（Snowflake `VALIDATION_MODE = RETURN_ERRORS` 相当）。DRY RUN 機能案の一部として実装を共有できる

## 8. 参考事例（RDB での先行実装）

| 製品 | 機能 | 本仕様への採用点 |
|---|---|---|
| Oracle | `LOG ERRORS INTO err$_x REJECT LIMIT n`（DBMS_ERRLOG） | 構文の骨格。エラーテーブル＝ソース全列＋エラー情報列という設計。REJECT LIMIT の安全弁 |
| Snowflake | `COPY INTO ... ON_ERROR=CONTINUE` / `VALIDATION_MODE=RETURN_ERRORS` / `VALIDATE()` | 「検証のみモード」の分離。事後にエラー行を取得する API |
| Teradata | FastLoad/MultiLoad の ET/UV エラーテーブル | エラー種別ごとのテーブル分離という考え方（本仕様では $err_code 列で代替） |
| DB2 | `LOAD ... FOR EXCEPTION <table>` | 例外テーブルへの元行退避 |
| SQL Server | `BULK INSERT ... ERRORFILE / MAXERRORS`、`TRY_CAST` | エラー許容上限。型変換の「失敗を値で返す」検証部品 |
| PostgreSQL 17 | `COPY ... ON_ERROR ignore` | 後発でも需要が立証された事例。ログ詳細度オプション（LOG_VERBOSITY） |

RDB はエンジンがストレージを握るため行単位棄却が低コストだが、kSQL は kintone REST API の 100 件アトミック制約下にある。ゆえに先行事例の多くが採る「書き込み時に棄却」ではなく、**「書き込み前にローカル検証で棄却」**を採用する点が本仕様の設計判断（正常パスの API 発行数は現状と完全に同一）。

## 9. 制限事項（明文化してドキュメントに記載すべきもの)

1. Tier 0 で検証できないエラー（権限・ルックアップ・ユーザー実在性等）で書き込みが失敗した場合は従来通り fail-fast。「ON ERROR SKIP を付ければ絶対止まらない」わけではない
2. 一意制約の同時実行競合（検証後〜書き込み前に他者が同キーを作成）は検出不能。夜間バッチ前提では許容範囲
3. kintone 側のフィールド定義変更とキャッシュの不整合時は、検証合格でも書き込み失敗があり得る（フィールド定義の取得タイミングを文実行時とする）
