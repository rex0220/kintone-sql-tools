# kSQL バッチ設計レシピ集

kSQL の現行機能（バッチ実行・一時テーブル・ASSERT・UPSERT・バッチ変数）だけで、**リラン可能で安全な差分更新バッチ**を組むためのレシピ集です。新機能ではなく、既存機能の組み合わせ方をまとめています。

- 対象: CLI（`-e` / `-f` / `--console`）と MCP（`ksql_mutate` 等）。プラグイン UI もバッチ対応（DML は文ごとの確認ダイアログ）。
- 参照: 言語リファレンス [§25 バッチ実行と一時テーブル](ksql_language_reference.md#25-バッチ実行と一時テーブル) / [§26 ASSERT](ksql_language_reference.md#26-assert) / [§17 UPSERT](ksql_language_reference.md#17-upsert)。
- 例のアプリ（`APP100`＝差分、`APP200`＝マスタ）・フィールドは説明用です。ご自身の物理アプリ ID・フィールドコードに置き換えてください。

### 前提フィールド（差分アプリ APP100 側）

| フィールド | 型 | 用途 |
|---|---|---|
| `処理ステータス` | ドロップダウン等 | `未処理` → `処理中` → `処理済` の状態管理 |
| `バッチID` | **文字列（1行）** | 実行識別子。`NOW()` のミリ秒 ISO を完全一致で保存（下記） |
| `確保日時` | 日時 | 「処理中」に確保した時刻。中断復旧の猶予判定に使う（R1 の 0）） |
| `処理日時` | 日時 | 完了時刻（分精度で可） |

> **`バッチID` は文字列フィールドにする（重要）**: `NOW()` は**ミリ秒付き ISO 文字列**（`2026-07-14T12:34:56.789Z`）ですが、kintone の**日時フィールドは分精度**で秒・ミリ秒が丸められます。`バッチID` を日時フィールドにすると `WHERE バッチID = @now` が一致せず（0 件）、確保・突合が成立しません。**`バッチID` は文字列（1行）フィールド**にして ISO 文字列をそのまま完全一致させます。`確保日時`・`処理日時` は日時フィールドで可（丸めは無害）。

> **DML の `WHERE` に `IN (SELECT …)` は書けません**。`UPDATE … WHERE $id IN (SELECT … FROM #tmp)` は実行時に `KintoneQueryError: IN (SELECT ...) は kintone クエリに変換できません` となります（**一時テーブルに限らず実アプリのサブクエリでも同じ**。`CREATE TEMP TABLE … AS SELECT` や `ASSERT` のサブクエリからは参照可）。**`ksql_validate` は `ok` を返す**ので静的検査では気づけません。そのため「処理した対象だけを後で更新する」には次の 2 通りを使います。
>
> 1. **バッチ ID で確保 → 直接条件で更新**（`WHERE バッチID = @now`）… R1。一時テーブルを一切参照しない
> 2. **`UPDATE … FROM #tmp`（v2.12.0 / 業務キー結合は v2.13.0）**… 一時テーブルの値を転記でき、`WHERE 対象.キー = t.キー AND 対象.バッチID = @now` のように**結合等値＋ターゲット絞り込み**を併記できる（R6）。ただし**複数マッチは実行前エラー**なので、ソース側は業務キー単位に 1 行化しておく
>
> `INSERT … SELECT` / `UPSERT … SELECT` は従来どおり一時テーブルを `FROM` ソースにできます（v1.7.0）。

> **選択系フィールドの WHERE 比較は `IN` を使う（`=` 不可）**: `処理ステータス` を**ドロップダウン・ラジオボタン・チェックボックス・複数選択**にした場合、WHERE の比較に `=` / `!=` は使えません（`フィールドタイプには演算子 = を使用できません（GAIA_IQ03）`）。**`WHERE 処理ステータス IN ('未処理')`** のように `IN` で書きます。**値の書き込みは `SET 処理ステータス = '処理済'` のように `=` のままで可**（本レシピの SQL はこの規則で書いています）。`処理ステータス` を**文字列（1行）**にすれば `=` も使えますが、選択系でも動くよう本レシピは **WHERE を `IN` で統一**します。

> **突合キー（`顧客コード`）はルックアップにしない**: UPSERT のキー `顧客コード` を**ルックアップ**フィールドにすると、マスタ（ルックアップ元）に存在しない値の書き込みで `値「…」が…（GAIA_LO04）` エラーになります。`顧客コード` は差分・マスタとも**文字列（1行）**にして、UPSERT のキー照合（`ON DUPLICATE (顧客コード)`）に使います。

> **前提バージョン**: 本レシピはバッチ変数を使うため **v2.1.0 以降**。さらに**差分 0 件の日**（空ソースからの `UPSERT … SELECT`）を no-op でそのまま完走させるには、明示列なら **v2.1.1 以降**、実体化済み一時テーブル/CTE の `SELECT *` なら **v2.11.0 以降**が必要です。主な機能の追加版 — バッチ実行・一時テーブル `v1.4.0`／ASSERT `v1.10.0`／プラグインの DML バッチ `v1.9.0`／`tempTableMaxRows` `v1.11.0`／バッチ変数・IN リストの変数 `v2.1.0`／0 行明示列 SELECT の no-op 化 `v2.1.1`／0 行実体化 `SELECT *` の列伝播 `v2.11.0`／**`UPDATE … FROM`（アプリ間・一時テーブル転記）`v2.12.0`**／**`VALIDATE ONLY`・`ON ERROR SKIP INTO #err`・`UPDATE … FROM` の業務キー結合 `v2.13.0`**（R2・R6）／**文字列・日時の `MIN`/`MAX` `v2.14.0`**／**`GROUP_CONCAT`・一時テーブル列の型伝播 `v2.15.0`**（R6）／**通常 `ORDER BY` の並び統一（kSQL が型ごとに定義した順）・kintone 固有順の `KORDER BY` `v3.0.0`**／**`KORDER BY` 大規模窓（Cursor API）`v3.1.0`**（R7）／**`UPDATE SET` の文字列関数・`LENGTH_CHAR`・`TRANSLATE`・符号付き数値リテラル・DML 書き込み先フィールド検査 `v3.2.0`**（R8〜R10）。

---

## 設計原則（リラン可能バッチ）

kSQL バッチは**トランザクションを持たず非アトミック**です。いつ失敗しても**先頭からのリランだけで正しく回復できる**設計にします。

1. **ステータス駆動**: 対象を「未処理 → 処理中 → 処理済」で管理する。
2. **中断復旧を先頭に**: 前回の中断で「処理中」に残った対象を、リラン冒頭で「未処理」に戻す（R1 の 0）。これが無いと claim-first は「処理中」を拾えず回復できない。
3. **確保 → 本処理 → 完了 の順（fail-fast）**: 対象を自分のバッチ ID で「処理中」に確保 → マスタ書き込み → 「処理済」。途中失敗は fail-fast で後段に進まず、次回リランで 0）が回収して再処理する。※ 部分成功を検出して差分だけ更新する仕組みではない。
4. **件数ゲート**: 確保対象の上限は確保の前に、実際に確保できた件数は確保の後に ASSERT する。**差分 0 件を正常とするか異常とするかは運用で選ぶ**（下記）。
5. **冪等**: `UPSERT`（キー一致で更新・なければ挿入）。ただし**キーがソース・マスタ双方で一意**が前提。
6. **時刻・バッチ ID の固定**: `SET @now = NOW()` を 1 回だけ評価し、確保・完了・突合で使い回す（1a では `SET @b = @a` 不可）。

---

## R1. 差分更新バッチ（復旧 → 確保 → 処理 → 完了）

親 DML の WHERE には `IN (SELECT …)` を書けないため、**対象をバッチ ID で確保してから直接条件で完了**させ、**中断で「処理中」に残った対象は冒頭で回収**します。

```sql
SET @now = NOW();          -- 1 回だけ評価し、確保・完了で使い回す

-- 0) 復旧: 前回の中断で「処理中」に残った対象を「未処理」に戻す（リラン回復の要）
--    確保日時に猶予を設け、当日実行中の他プロセスが確保した行を横取りしない
--    （WHERE の 処理ステータス は選択系フィールド想定で IN。SET は = のまま）
UPDATE APP100
SET 処理ステータス = '未処理'
WHERE 処理ステータス IN ('処理中') AND 確保日時 < TODAY();

-- 1) 件数ゲート（確保対象の上限。0 件を正常にするなら BETWEEN 0 …、異常検知したいなら BETWEEN 1 …）
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理')) BETWEEN 0 AND 10000;

-- 2) 確保: 未処理を自分のバッチ ID で「処理中」に（直接条件・確保日時も付与）
UPDATE APP100
SET 処理ステータス = '処理中', バッチID = @now, 確保日時 = @now
WHERE 処理ステータス IN ('未処理');

-- 3) 確保した分をスナップショット（バッチ ID＋処理中の直接条件）
CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名 FROM APP100 WHERE バッチID = @now AND 処理ステータス IN ('処理中');

-- 4) 確保後ゲート（実際に確保できた件数の上限）＋キー一意ゲート（冪等性の前提）
ASSERT (SELECT COUNT(*) FROM #tgt) <= 10000;
ASSERT (SELECT COUNT(*) FROM #tgt) = (SELECT COUNT(DISTINCT 顧客コード) FROM #tgt);

-- 5) 本処理: マスタへ UPSERT（UPSERT … SELECT は一時テーブル参照可）
UPSERT INTO APP200 (顧客コード, 顧客名)
SELECT 顧客コード, 顧客名 FROM #tgt
ON DUPLICATE (顧客コード);

-- 6) 完了: 確保した分を「処理済」に（直接条件）
UPDATE APP100
SET 処理ステータス = '処理済', 処理日時 = @now
WHERE バッチID = @now AND 処理ステータス IN ('処理中');
```

**なぜこの形か**
- **0) の復旧が「先頭からのリランだけで回復」を成立させる**: 5) や 6) で失敗すると対象は「処理中」で残る。復旧が無いと、次回リランは新しい `@now` で「未処理」だけを見るため取り残す。0) が猶予（`確保日時 < TODAY()`）付きで回収するので、翌実行で再処理される。
  - **猶予の意味**: `確保日時 < TODAY()` は「当日実行中の別プロセスが確保した行を横取りしない」ための最小の猶予です。当日中の再実行で回復したい場合は、猶予（リース期限）をジョブ制御側で持つか、手動で「処理中 → 未処理」に戻してください。
- **確保（2）・完了（6）は直接条件**で一時テーブルを参照しない → 実行拒否を避ける。本処理（5）だけが `UPSERT … SELECT FROM #tgt`（許可）。
- **多重起動の緩和**: 2) で「処理中」に確保するため、別実行が同じ「未処理」を二重に拾いにくい。ただし kintone にレコードロックは無く、**確保 UPDATE 自体は競合し得る＝完全な排他ではない**。別実行が先に全件確保すると、このバッチの確保は 0 件になり、以降は「やることなし」で正常終了する（0 件を許容する場合）。**厳密な排他はジョブ制御側**（cron の多重起動防止・ロック）で保証。
  - `NOW()` は**厳密に一意な ID ではない**（同一ミリ秒起動で同値）。確実な一意性が要る場合は呼び出し側で採番した ID を `DECLARE @batchId = ...` ＋ CLI `--var`／MCP `variables` で注入する（R4 参照）。

**差分 0 件（＝空日）の扱い**
- 日次 cron では「今日は差分なし」は正常系です。1) を `BETWEEN 0 AND 10000` にすると 0 件で正常終了します。`BETWEEN 1 …` にすると 0 件で ASSERT 失敗＝アラートになるので、**差分ゼロを異常として検知したい場合のみ**そちらにします。
- 0 件のとき `#tgt` は 0 行で、`UPSERT … SELECT FROM #tgt` は **`inserted=0 / updated=0` の no-op** としてそのまま完走します（書き込み API も呼ばれません）。**v2.1.1 以降**の挙動です（v2.1.0 以前は空ソースの `UPSERT … SELECT` が「SELECT の列数（0）と一致しません」で停止したため、`BETWEEN 1` で 0 件を書き込み前に止める・呼び出し側で件数を先に確認してスキップ、といった回避策が必要でした。v2.1.1 でこれらは不要です）。実機でも差分 0 件リランが全文 0 件で完走することを確認済みです。
- **v2.11.0 以降**は、同じ空日に `SELECT * FROM #tgt` を `INSERT` / `UPSERT` ソースにしても、一時テーブル実体化時の列スキーマが保持されるため同じ no-op で完走します。列を明示する現行 R1 レシピの挙動は不変です。

**冪等性・リランの注意**
- **キー一意が前提**: `#tgt`・`APP200` 双方で `顧客コード` が一意のときだけ UPSERT が冪等。ソース内キー重複は初回に重複登録され（次回以降は更新に回るので無限には増えないが、できた重複は残り正しい回復も保証できない）、4) で止める。マスタ側重複時は更新が最大 `$id` の 1 件のみ。
- **事後突合は任意（検出力は下がった）**: claim-first では `#tgt` を「確保後の `バッチID=@now`」から作り 6) も同条件で更新するため、`処理済件数 = #tgt件数` はほぼ自明（かつ失敗すれば fail-fast で到達しない）。付けるなら次を 6) の後に。
  ```sql
  ASSERT (SELECT COUNT(*) FROM APP100 WHERE バッチID = @now AND 処理ステータス IN ('処理済'))
       = (SELECT COUNT(*) FROM #tgt);
  ```

---

## R2. 事前ゲート（件数チェック・inserts/updates 内訳）

書き込み前に「何件を新規作成し、何件を更新するか」を読み取り専用で確認します（書き込みなし）。

```sql
CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名 FROM APP100 WHERE 処理ステータス IN ('未処理');

-- 想定外件数なら停止（ゲートは先頭に）
ASSERT (SELECT COUNT(*) FROM #tgt) BETWEEN 1 AND 10000;

-- inserts（マスタ未存在）と updates（マスタ存在）を 1 結果セットで
--   COUNT(フィールド) は空文字・NULL（＝LEFT JOIN 未マッチ）をスキップして数える（§8）
SELECT
  COUNT(*)                       AS 対象件数,
  COUNT(m.顧客コード)             AS updates,
  COUNT(*) - COUNT(m.顧客コード)  AS inserts
FROM #tgt t LEFT JOIN APP200 m ON t.顧客コード = m.顧客コード;
```

> **1 結果セットにまとめる理由**: プラグイン UI は**最後に結果を返した文だけ**を表示するため、`SELECT COUNT(*)` を 2 本並べると両方を同時に見られません。LEFT JOIN で 1 行にまとめると全入口で同じ見え方になります。`COUNT(m.顧客コード)` が「マスタにマッチした件数（＝updates）」になるのは [§8 集計関数](ksql_language_reference.md#8-group-by--集計関数) の「`COUNT(フィールド)` は空文字・NULL をスキップ」仕様によります。

### 値の妥当性も先に見る（`VALIDATE ONLY`・v2.13.0）

件数ゲートは「何件か」しか見ません。**必須・型・範囲・文字列長・選択肢・UPSERT キー**が通るかは `VALIDATE ONLY` で書き込みゼロのまま全行検証できます（[§17.1](ksql_language_reference.md#171-validate-only書き込み前検証)）。

```sql
CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名 FROM APP100 WHERE 処理ステータス IN ('未処理');

-- 書き込まずに全行検証。#err に 1 行 = 1 エラー（1 行に複数エラーなら複数行）
UPSERT INTO APP200 (顧客コード, 顧客名)
SELECT 顧客コード, 顧客名 FROM #tgt
ON DUPLICATE (顧客コード)
VALIDATE ONLY INTO #err;

-- どのキーがなぜ落ちるかを 1 行にまとめて確認（GROUP_CONCAT は v2.15.0）
SELECT 顧客コード, GROUP_CONCAT($err_message SEPARATOR ' / ') AS エラー内容
FROM #err GROUP BY 顧客コード;
```

- `VALIDATE ONLY` は **read-only 扱い**で、`ksql_query` / CLI から DML 承認なしに実行できます（書き込み 0 件）。
- ただし**完全な入力を要求**するため、`truncate` 設定は常に `error` へ上書きされます。
- **通過は kintone の書き込み成功を保証しません**（権限・競合・カスタマイズ JS など、ローカルで判定できない要因があるため）。

> **確認手段の役割分担**: 構文・静的検査 → `ksql_validate`（kintone非アクセス）／実行計画（**フォーム定義と必要時のプロセス状態metadataだけを取得し、レコード取得・書込みなし**）→ `ksql_explain` / `--dry-run`／実データの件数 → 上の R2 を `ksql_query` / CLI で**実行**（read-only）／**値の妥当性** → `VALIDATE ONLY`。
>
> **`ksql_validate` は「実行できること」を保証しません**（構文・静的解析のみ）。たとえば `UPDATE … WHERE $id IN (SELECT … FROM #tmp)` は `ksql_validate` が `ok` を返しますが、実行時に `IN (SELECT ...) は kintone クエリに変換できません` で失敗します（下記の注記）。実行可否は read-only（`VALIDATE ONLY`・`SELECT`）で確かめてください。

---

## R3. 更新前スナップショット（`#before`）

上書きされる前のマスタの値を一時テーブルに退避し、結果に含めます（差分の記録・目視確認用）。

```sql
CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名 FROM APP100 WHERE 処理ステータス IN ('未処理');

-- 更新対象の「更新前の値」を退避（$ 始まりの列はエイリアスを付ける）
CREATE TEMP TABLE #before AS
SELECT $id AS レコードID, 顧客コード, 顧客名 FROM APP200
WHERE 顧客コード IN (SELECT 顧客コード FROM #tgt);

-- 本処理（UPSERT … SELECT は一時テーブル参照可）
UPSERT INTO APP200 (顧客コード, 顧客名)
SELECT 顧客コード, 顧客名 FROM #tgt
ON DUPLICATE (顧客コード);

-- 退避した更新前の値を確認（バッチは最後の結果セットを表示）
SELECT * FROM #before;
```

一時テーブルはバッチ内スコープ（呼び出し終了で破棄）なので、恒久保存が要る場合は別途アプリへ INSERT します。R1 に組み込む場合は、確保（R1 の 2）の後・UPSERT の前に `#before` を作ります。

---

## R4. バッチ変数の活用（v2.1.0）

- **時刻固定**: `SET @now = NOW();` … 以降のすべての文で同じ時刻（`NOW()` を文ごとに評価すると値がぶれる）。**1a では変数から変数への代入（`SET @b = @a`）はできない**ため、同じ値を複数用途に使うなら同じ `@now` を使い回します。
- **条件値の DRY 化**:
  ```sql
  SET @cutoff = TODAY();
  DELETE FROM APP100 WHERE 作成日時 < @cutoff AND 処理ステータス IN ('処理済');
  ```
  この DELETE は**同一実行の中では冪等**（`@cutoff` はその実行で固定）。ただし `TODAY()` はバッチごとに再評価されるため、**翌日のリランでは対象範囲が 1 日広がります**（同じ cutoff に対しては冪等だが、日をまたいで同じ対象集合を保証しない）。厳密に同じ対象を再現するなら固定の日付リテラルを使う。
- **チェックボックス/複数選択フィールド**: `=` を使えないフィールドは `IN (@変数)` で（v2.1.0）。
  ```sql
  SET @a = 'A'; SET @b = 'B';
  SELECT 顧客No FROM APP100 WHERE 顧客ランク IN (@a, @b);
  ```
- **バッチ由来ラベルと配列条件**: 1 つの配列を複数文で使い回し、処理ラベルを結果へ付ける。
  ```sql
  SET @batch = NOW();
  SET @ranks = ['A', 'B'];
  SELECT @batch AS バッチID, 顧客No FROM APP100 WHERE 顧客ランク IN @ranks;
  ```
  空配列の `IN @ranks` は 0 件、`NOT IN @ranks` は全件条件になる。更新系で最終 WHERE が全件条件へ簡約される場合は安全のため拒否される。
- **件数ゲートの DRY 化（スカラーサブクエリ代入・v2.3.0＝Phase 1b）**: `SET @cnt = (SELECT COUNT(*) ...)` で件数を**一度だけ**取得し、ゲート・記録・後続条件で使い回す。
  ```sql
  SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE 処理ステータス IN ('未処理'));
  ASSERT @cnt BETWEEN 0 AND 10000;                    -- 想定外件数なら停止
  UPDATE APP100 SET 対象件数メモ = @cnt WHERE 処理ステータス IN ('未処理');
  ```
  - サブクエリは **SET 時に 1 回だけ実行**（複数文で `@cnt` を参照しても再実行しない）。**先行して作成した一時テーブル**（`SET @cnt = (SELECT COUNT(*) FROM #tgt)`）や**先行変数**（`... WHERE 期限 < @cutoff`）も参照可。
  - **1 行 1 列**が必須。`GROUP BY` なしの集計は 0 件でも 1 行（`COUNT` は `0`）を返すため、件数取得は差分 0 件でも成立する（§8）。SET の評価失敗は `continueOnError` に関わらずバッチ停止（fail-fast）。
  - **R2 の事前ゲートを DRY 化**する例（`(SELECT COUNT(*) FROM #tgt)` を直接書く代わりに）:
    ```sql
    CREATE TEMP TABLE #tgt AS SELECT 顧客コード, 顧客名 FROM APP100 WHERE 処理ステータス IN ('未処理');
    SET @cnt = (SELECT COUNT(*) FROM #tgt);
    ASSERT @cnt BETWEEN 1 AND 10000;
    ```
- **定型バッチの外部パラメータ化（v2.4.0＝Phase 1c）**: SQL 側で既定値を宣言し、CLI/MCP だけ必要時に差し替える。
  ```sql
  DECLARE @since = '2026-01-01';
  SELECT 顧客No FROM APP100 WHERE 登録日 >= @since;
  ```
  CLI は `--var since=2026-07-01`、MCP は `variables: { "since": "2026-07-01" }`。プラグインは既定値で同じ SQL を実行する。`--var` は秘密情報には使用しない。

変数の詳細・制約は言語リファレンス [§25 バッチ変数](ksql_language_reference.md#25-バッチ実行と一時テーブル) を参照。

---

## R5. リテラル値リストを一時テーブル化して一括処理

外部（CSV・別システム）由来の **固定リスト**を **`FROM` なしの `SELECT … UNION ALL …`** で一時テーブルに実体化し、ゲート → 取り込み（`UPSERT … SELECT`）する。一時テーブルは、**`ASSERT` からは `IN` サブクエリ／`COUNT`** で、**`INSERT … SELECT` / `UPSERT … SELECT` からは `FROM` ソース**として再利用する。

```sql
-- 1) 外部リストを一時テーブルに実体化（書き込み可能キー「取引先コード」と値を持つ）
CREATE TEMP TABLE #incoming AS
  SELECT '1001' AS 取引先コード, '完了' AS 状態
  UNION ALL SELECT '1005', '完了'
  UNION ALL SELECT '1012', '完了';

-- 2) 事前ゲート: 取り込み件数を確認（ASSERT は COUNT で #t を参照）
ASSERT (SELECT COUNT(*) FROM #incoming) BETWEEN 1 AND 1000;

-- 3) 取り込み: 書き込み可能キーで登録/更新（UPSERT … SELECT は #t を FROM ソースに）
UPSERT INTO APP100 (取引先コード, 状態)
  SELECT 取引先コード, 状態 FROM #incoming
  ON DUPLICATE (取引先コード);
```

- **DRY**: 外部リストを `#incoming` の 1 箇所に集約し、`ASSERT`（`COUNT` / `IN` サブクエリ）と `UPSERT … SELECT`（`FROM` ソース）から再利用する。
- **`UPSERT` にはキーが必須**: `ON DUPLICATE (キーフィールド)` が必要で、キーは**アプリ側の書き込み可能フィールド**（例: `取引先コード` / `外部ID`）。**システムフィールド `$id` は UPSERT キーにできない**。
- **重要な制約 — `UPDATE` / `DELETE` の `WHERE` に `IN (SELECT …)` は書けない**（`… WHERE $id IN (SELECT id FROM #t)` は**実行時**に `IN (SELECT ...) は kintone クエリに変換できません`。注意の「サブクエリ参照の非対称」参照）。**対象アプリの既存行を `$id` で更新/削除**したい場合は、`UPDATE APP100 SET 状態='完了' WHERE $id IN ('1001','1005','1012')` のように **`UPDATE` / `DELETE` 側ではリストを直接 `IN (...)` に再掲**する（この経路では一時テーブルの DRY は効かない）。**一時テーブルの値で更新する**なら `UPDATE … FROM`（v2.12.0・R6）が使える。
- **セキュリティ（自動バインドではない）**: 上記の値は **SQL 文中にリテラルとして記述**しており、kSQL が外部リストを自動でバインドする機能ではない。外部値から SQL を生成する場合は、**ID を数字だけに検証**するか、**文字列リテラルの `'` を `''` にエスケープ**すること（誤ればインジェクションが起こり得る）。
- **kintone 内から導ける集合**なら `#incoming` を使わず直接 `IN (SELECT … FROM APPxxx WHERE …)` の方が簡単。R5 は **kintone 外由来の固定リスト**が対象。
- **前提バージョン**: `CREATE TEMP TABLE AS <FROM なし SELECT / UNION>` の実体化は **v2.10.0 以降**（それ以前は 0 行になる不具合があった）。

---

## R6. 不良データを隔離して残りを流す（`ON ERROR SKIP`・v2.13.0）

R1 は fail-fast で、**1 件の不良データがバッチ全体を止めます**。夜間の無人バッチでは「不良行だけ除けて残りは流し、翌朝に原因を見る」ほうが望ましいことがあります。`ON ERROR SKIP INTO #err` は、**書き込み前のローカル検証（必須・型・範囲・文字列長・選択肢・キー）に落ちた行だけ**を `#err` へ隔離し、合格行だけを書き込みます。

```sql
SET @now = NOW();

-- 1) 確保（R1 と同じ claim-first。直接条件で更新）
UPDATE APP100
SET 処理ステータス = '処理中', バッチID = @now, 確保日時 = @now
WHERE 処理ステータス IN ('未処理');

CREATE TEMP TABLE #tgt AS
SELECT 顧客コード, 顧客名, 住所 FROM APP100
WHERE バッチID = @now AND 処理ステータス IN ('処理中');

ASSERT (SELECT COUNT(*) FROM #tgt) BETWEEN 0 AND 10000;

-- 2) 本処理: NG 行は #err へ隔離し、合格行だけ書く。隔離が 100 行を超えたら何も書かず停止
UPSERT INTO APP200 (顧客コード, 顧客名, 住所)
SELECT 顧客コード, 顧客名, 住所 FROM #tgt
ON DUPLICATE (顧客コード)
ON ERROR SKIP INTO #err REJECT LIMIT 100;

-- 3) エラー行の書き戻し: 業務キー単位に全メッセージを連結して 1 行化
CREATE TEMP TABLE #err_summary AS
SELECT 顧客コード, GROUP_CONCAT($err_message SEPARATOR ' / ') AS エラー内容
FROM #err GROUP BY 顧客コード;

UPDATE APP100
SET 処理ステータス = 'エラー', エラー内容 = e.エラー内容, 処理日時 = @now
FROM #err_summary e
WHERE APP100.顧客コード = e.顧客コード AND APP100.バッチID = @now;

-- 4) 正常行の完了: #err に無い業務キーを temp で確定してから更新
CREATE TEMP TABLE #ok AS
SELECT 顧客コード FROM #tgt
WHERE 顧客コード NOT IN (SELECT 顧客コード FROM #err);

UPDATE APP100
SET 処理ステータス = '処理済', 処理日時 = @now
FROM #ok o
WHERE APP100.顧客コード = o.顧客コード AND APP100.バッチID = @now;
```

**なぜこの形か**

- **3) と 4) が `UPDATE … FROM`（v2.12.0 / 業務キー結合は v2.13.0）**: `#err` は UPSERT の**入力ペイロード列しか持たず**、差分アプリの `$id` を持ちません。そのため `$id` 結合では書き戻せず、**業務キー結合**が必要です。
- **`AND APP100.バッチID = @now` を必ず付ける**: `UPDATE … FROM` は結合等値とターゲット絞り込みを両方書けます。これが無いと、**今回のバッチが確保していない同一キーの行まで更新**され得ます。
- **4) は `#ok` を `SELECT` で先に確定させる**: `UPDATE … WHERE 顧客コード NOT IN (SELECT … FROM #err)` と書きたくなりますが、**DML の `WHERE` に `IN (SELECT …)` は書けません**（下記の注記）。`NOT IN (SELECT …)` は **`SELECT` 文（`CREATE TEMP TABLE … AS SELECT`）なら使えます**。
- **`GROUP_CONCAT` で全メッセージを残す（v2.15.0）**: 1 行に複数エラーがあると `#err` は複数行になります。`UPDATE … FROM` は**複数マッチを実行前エラー**にするため、業務キー単位へ 1 行化が必須です。`MIN($err_message)` だと代表 1 件しか残りませんが、`GROUP_CONCAT` なら全件を連結できます。
- **`REJECT LIMIT n`**: 隔離が n 行を超えたら**全行検証を終えたうえで書き込みゼロで停止**します（部分書き込みは起きません）。`#err` は結果として返るので原因調査に使えます。「不良が大量＝上流の異常」を検知するゲートです。

**隔離される範囲（重要）**

- 隔離できるのは **kSQL が API 送信前にローカルで判定できるエラーだけ**（Tier 0）です。**kintone API の実行時エラー**（権限・競合・カスタマイズ JS による保存拒否など）は**従来どおり fail-fast**で、行単位に隔離されません。
- 逆に、ローカル検証は**書き込み経路より厳しいことがあります**。検証を通っても書き込み成功は保証されません。
- **前提バージョン**: `ON ERROR SKIP` / `VALIDATE ONLY` / 業務キー結合は **v2.13.0 以降**、`GROUP_CONCAT` と `#err` 列の型伝播は **v2.15.0 以降**。

---

## R7. kintone の REST API と同じ並びで大量取得する（`KORDER BY`・v3.0.0 / v3.1.0）

CSV 連携や突合で「**kintone REST API の並び（型別順序）**」が要ることがあります。v3.0.0 以降、通常の `ORDER BY` は「どの実行面（CLI / MCP / プラグイン）でも・何度実行しても同じ結果になる」ように **kSQL が型ごとに定義した並び**（数値は数値順・文字列は Unicode コードポイント順。[言語リファレンス §10](ksql_language_reference.md#10-order-by)）で並べます。このため、**kintone がフィールド型ごとに持つ独自の並び** — ドロップダウン・ラジオボタンの選択肢定義順、ステータスのプロセス定義順など — とは一致しないことがあります。kintone 側の並びが必要な場合は **`KORDER BY`** を使います。一覧画面と同じ並びに**近づける**には、画面と同じキー・方向を指定し、同値群の順序は暗黙保証されないため**最後のキーへ `$id ASC` を明示**します（kSQL は暗黙追加しません）。

```sql
-- kintone 固有順のまま先頭 10,001 件（v3.1.0 から単発 GET に収まらない窓も可）
SELECT $id, 郵便番号, 住所1
FROM APP730
KORDER BY 郵便番号 ASC, $id ASC
LIMIT 10001
```

- **`LIMIT` は必須**。**単発 API になるのは `LIMIT ≤ 500` かつ `OFFSET ≤ 10000` かつ `LIMIT ≤ maxRecords` の 3 条件を満たす場合**で、このとき OFFSET はサーバーが読み飛ばすため `maxRecords` の引き上げは不要です（例: `LIMIT 500 OFFSET 10000` は `maxRecords=500` のままで成功）
- 3 条件から外れる窓は **Cursor API**（v3.1.0）で 500 件ずつ連結します（結果順は raw API と完全一致することを実測済み）。**Cursor のときだけ**走査件数 `OFFSET + LIMIT` ≤ 実行時 `maxRecords` が条件になります（OFFSET 分を kSQL が受信して読み捨てるため）。CLI/MCP の既定は 500 なので、上の例は `--max-records 10001`（MCP は `maxRecords: 10001`）へ引き上げます。超過は実行前の planning error（黙ってフォールバックしません）
- カーソルの対象集合は作成時点で固定ですが**値は取得時点**です。更新が走る時間帯の実行は避けてください。カーソル枠（1 ドメイン 10 個の共有・同時上限 `cursorMaxActive`）・再試行禁止・cleanup 警告の詳細は [v3.1.0 移行ガイド](ksql_v3_1_migration_guide.md)を参照
- 条件: トップレベル SELECT・単一アプリ・WHERE 完全押し下げ・型 allowlist 等（詳細は[言語リファレンス §10](ksql_language_reference.md#10-order-by)）

---

## R8. Shift_JIS で出力できない漢字を変換する（v3.2.0）

cli-kintone の CSV を Shift_JIS で出力すると、CP932 に無い漢字を含むレコードで出力エラーになることがあります。`TRANSLATE` を使い、該当する 40 字を Shift_JIS で扱える字体へ 1 対 1 で変換します。変換表は [計算式プラグインでの実例](https://qiita.com/rex0220/items/9db98b2cf027b686e0b5) と同じものです。

| | 変換表 |
|---|---|
| 変換元 | `啞焰鷗摑麴噓俠頰軀俱繫姸鹼嚙攢𠮟繡蔣醬蟬搔瘦驒簞塡顚禱瀆吞囊剝潑醱屛幷麵萊屢沪蠟` |
| 変換先 | `唖焔鴎掴麹嘘侠頬躯倶繋妍鹸噛攅叱繍蒋醤蝉掻痩騨箪填顛祷涜呑嚢剥溌醗屏并麺莱屡濾蝋` |

```sql
SELECT
  TRANSLATE(会社名,
    '啞焰鷗摑麴噓俠頰軀俱繫姸鹼嚙攢𠮟繡蔣醬蟬搔瘦驒簞塡顚禱瀆吞囊剝潑醱屛幷麵萊屢沪蠟',
    '唖焔鴎掴麹嘘侠頬躯倶繋妍鹸噛攅叱繍蒋醤蝉掻痩騨箪填顛祷涜呑嚢剥溌醗屏并麺莱屡濾蝋'
  ) AS 会社名,
  住所
FROM APP100;
```

`𠮟` は UTF-16 では 2 コードユニットですが、`TRANSLATE` はコードポイント単位で変換表をそろえるため、後続の対応もずれません。変換元と変換先の文字数が異なる場合は、欠落文字を黙って削除せず `ArgumentError` で停止します。変換後の SELECT 結果を cli-kintone の CSV 出力対象に使用してください。

**kintone 側の値そのものを変換して書き戻す（`UPDATE`・v3.2.0〜）**

CSV 出力のたびに変換するのではなく、レコードの値自体を Shift_JIS で扱える字体へそろえたい場合は `UPDATE` で書き戻します。

形 A: 対象全行をそのまま変換する（1 文）

```sql
UPDATE APP100
SET 会社名 = TRANSLATE(会社名,
  '啞焰鷗摑麴噓俠頰軀俱繫姸鹼嚙攢𠮟繡蔣醬蟬搔瘦驒簞塡顚禱瀆吞囊剝潑醱屛幷麵萊屢沪蠟',
  '唖焔鴎掴麹嘘侠頬躯倶繋妍鹸噛攅叱繍蒋醤蝉掻痩騨箪填顛祷涜呑嚢剥溌醗屏并麺莱屡濾蝋')
WHERE 処理ステータス IN ('未処理');
```

- 親 DML の `WHERE` には関数を書けないため、形 A は WHERE 条件の**全行**へ PUT します。変換対象の字を含まない行も更新扱いになり、更新日時が変わり通知・Webhook・カスタマイズ JS が発火し得ます（R10 形 A と同じ注意）。副作用を抑えたい・リランしたい場合は形 B へ。

形 B: 変換が必要な行だけへ絞る（一時テーブル経由）

```sql
-- 変換すると値が変わる行（＝変換対象字を含む行）だけを実体化
CREATE TEMP TABLE #sjis AS
  SELECT $id AS 対象id,
         TRANSLATE(会社名, '啞…蠟', '唖…蝋') AS 変換後
  FROM APP100
  WHERE 会社名 <> TRANSLATE(会社名, '啞…蠟', '唖…蝋');
UPDATE APP100 SET 会社名 = n.変換後 FROM #sjis AS n WHERE APP100.$id = n.対象id;
```

- `'啞…蠟'` / `'唖…蝋'` は上の全 40 字（変換元 / 変換先）の**省略表記**です。実際には省略せず全字を書きます。
- SELECT 側の `WHERE` には関数を書けるので、`会社名 <> TRANSLATE(…)`（＝変換すると値が変わる行）だけを選べます。対象 0 件でも `UPDATE … FROM` は no-op で完走します（リラン安全）。
- 書き込み前の事前確認は末尾に `VALIDATE ONLY` を付けると、書き込み 0 で検証だけできます（例: `UPDATE APP100 SET 会社名 = TRANSLATE(…) WHERE … VALIDATE ONLY`）。

---

## R9. データ品質チェック — サロゲートペア・文字数予算（v3.2.0）

`LENGTH`（UTF-16 コードユニット＝kintone の「文字数」）と `LENGTH_CHAR`（コードポイント）の**差はサロゲートペアの個数**です。絵文字や `𠮟`・`𠮷`（常用漢字・人名で普通に現れる）を含む行を、外部連携の前に洗い出せます。

```sql
-- サロゲートペアを含む行を検出（差 = ペア数）
SELECT $id, 会社名,
       LENGTH(会社名) AS 文字数,
       LENGTH(会社名) - LENGTH_CHAR(会社名) AS ペア数
FROM APP100
WHERE LENGTH(会社名) - LENGTH_CHAR(会社名) > 0
```

- SELECT の `WHERE` は関数・算術式を書けます（FULL_SCAN で JS 評価）。**親 DML の `WHERE` には書けない**点が対照的です（R10）
- `éé` のような「UTF-8 だと 2 バイト／1 ユニット」の文字は差 0 になり誤検知しません（バイト数比較では原理的に判定できなかったケース）
- kintone の `maxLength` は UTF-16 で数えるため、**上限チェックは従来どおり `LENGTH`** を使います。「人が数える文字数」に近いのは `LENGTH_CHAR` です（IVS・結合文字・ZWJ 絵文字は対象外）

---

## R10. 表記の正規化を書き戻す（`UPDATE SET` の文字列関数・v3.2.0）

v3.2.0 から文字列関数を `UPDATE SET` に直接書けます（従来は `CASE WHEN 1=1 THEN … ELSE … END` で包むか一時テーブル経由が必要でした）。

**形 A: 対象全行をそのまま正規化する（1 文）**

```sql
-- 電話番号のハイフン・空白を除去して書き戻す
UPDATE APP100
SET 電話番号 = REPLACE(REPLACE(電話番号, '-', ''), ' ', '')
WHERE 処理ステータス IN ('未処理');
```

```sql
-- 顧客コードを 8 桁ゼロ埋めへ（先頭ゼロは文字列のまま保持される）
UPDATE APP100 SET 顧客コード = LPAD(顧客コード, 8, '0') WHERE 処理ステータス IN ('未処理');
```

- **親 DML の `WHERE` に関数は書けない**ため、形 A は「変換が不要な行」も含めて WHERE 条件の全行へ PUT します。**値は冪等でも副作用は冪等ではありません** — 同値でも更新扱いになり、更新日時が変わり、通知・Webhook・カスタマイズ JS が発火し得ます。リランや副作用を抑えたい場合は形 B が安全です。`VALIDATE ONLY` は**検証エラーの有無**を書き込みゼロで事前確認するもので（エラー行だけが返る）、正常行の変換後の値一覧をプレビューする機能ではありません
- `UPDATE … FROM` とサブテーブル UPDATE の `SET` には関数を直接書けません（明示エラー）

**形 B: 変換が必要な行だけへ絞る（一時テーブル経由・従来の定石）**

```sql
CREATE TEMP TABLE #norm AS
  SELECT $id AS 対象id,
         REPLACE(REPLACE(電話番号, '-', ''), ' ', '') AS 正規化
  FROM APP100
  WHERE 処理ステータス IN ('未処理')
    AND LENGTH(電話番号) > LENGTH(REPLACE(REPLACE(電話番号, '-', ''), ' ', ''));
UPDATE APP100 SET 電話番号 = n.正規化 FROM #norm AS n WHERE APP100.$id = n.対象id;
```

SELECT 側の `WHERE` なら関数で「変換すると変わる行」だけを選べます。対象 0 件でも `UPDATE … FROM` は no-op で完走します（リラン安全）。

---

## R11. ファイルからアプリへ取込む（`IMPORT`・v3.6.0）

CSV / JSON ファイルを、**変換・検証・不良行隔離付きで**アプリへ取込む自己完結ステートメント。ソースは**面が名前付きで供給**し、SQL にパスを埋めません（`IMPORT` は source 供給時のみ有効＝off-by-default）。

| 面 | ソース供給 |
|---|---|
| CLI | `--import-csv <name>=<path>` / `--import-json <name>=<path>` |
| MCP | `importSources: [{ name, text \| base64, encoding? }]`（inline・パス不可） |
| プラグイン | ヘッダーの「ファイルを選択」（ソース名は拡張子を除いたファイル名。例 `sales.csv` → `sales`） |

**フラット CSV を射影して UPSERT**（`CAST` で数値化・業務キーで重複判定）:
```sql
IMPORT INTO APP100 (顧客コード, 金額)
FROM CSV sales
SELECT code, CAST(amount AS NUMBER) AS 金額
ON DUPLICATE (顧客コード);
```

**不良行を隔離して残りを流す**（`ON ERROR SKIP`・R6 と同じ思想）:
```sql
IMPORT INTO APP100 (顧客コード, 金額) FROM CSV sales BY NAME
ON ERROR SKIP INTO #err;
SELECT * FROM #err;
```

**JSON**（厳密10進・精度対象の NUMBER は string 供給・全階層 duplicate key 拒否）:
```sql
IMPORT INTO APP100 (顧客コード, 金額) FROM JSON payload;
```

- `VALIDATE ONLY` で**書込み前に全行検証**（`ksql_validate` は構文のみ・実行可否は VALIDATE ONLY で確認する）。
- `CHECK WHEN … THEN …`（B37）で行レベル業務ルールを付与できる。
- **行上限は `maxRecords`（既定 500）**。500 件超は `--max-records`（CLI）等で拡張する（超過は fail-closed でサイレント切り捨てはしない）。

## R12. cli-kintone と round-trip する（`BY NAME`・レコード番号 UPDATE・サブテーブル・v3.6.0）

kintone 公式 CLI `cli-kintone` で export した CSV を、そのまま kSQL へ戻せます。

**フラット export を取込む**（ヘッダ＝フィールドコード名で対応・非書込み列は監査付き無視・複数値はセル内 LF）:
```sql
IMPORT INTO APP100 (顧客コード, 金額, 担当者)
FROM CSV exported BY NAME IGNORE UNKNOWN COLUMNS;
```

**レコード番号をキーに既存レコードを更新**（純 UPDATE・INSERT 0・番号は照合専用）:
```sql
IMPORT UPDATE INTO APP100 (金額)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`;
```

**サブテーブル**（意味論が source で異なる）:
- **JSON**（ネスト配列・**新規 INSERT / 業務キー UPSERT**・行 ID なし全置換）:
```sql
IMPORT INTO APP100 (顧客コード, 明細(品名, 数量)) FROM JSON payload;
```
- **CSV `*` 形式**（cli-kintone export・**既存レコードの UPDATE 全置換**・行 ID 維持更新/欠落削除）:
```sql
IMPORT UPDATE INTO APP100 (明細(品名, 数量) ROW ID SOURCE `明細_行ID`)
FROM CSV exported BY NAME
MATCH RECORD NUMBER SOURCE `レコード番号`
REPLACE SUBTABLES (明細);
```

**cli-kintone との使い分け**:

| 用途 | 推奨 |
|---|---|
| 添付ファイル込みの取込・単純な一括ロード | **cli-kintone** |
| 取込時の変換（`CAST`/関数）・業務チェック・不良行隔離・SQL パイプライン統合・MCP/ブラウザから | **kSQL IMPORT** |

- **添付ファイル（FILE）は kSQL IMPORT 非対応**（cli-kintone を使う）。
- **CSV のサブテーブルは UPDATE 専用**（`REPLACE SUBTABLES` で全置換）。**新規 INSERT は JSON**。
- **破壊的全置換は `REPLACE SUBTABLES` 必須**＋削除件数を confirm で明示。**MCP はサブテーブル mutation を fail-closed**（削除内訳を対話表示・承認できないため）→ サブテーブル書込みは CLI / プラグイン、MCP は `VALIDATE ONLY` / `EXPLAIN`（`ksql_query`）まで。
- 標準スペース・**ゲストスペース**の両方で動作する。

## 適用限界（スケール指針）

判断基準は総レコード数ではなく **「日次の実変更件数が API 制限と実行時間に収まるか」** です。

| 実行あたり処理件数 | 判断 |
|---|---|
| 〜数千件（差分型の日次バッチ） | **本設計の主戦場**。1 日の API 上限のごく一部で収まる |
| 〜数万件 | 成立。各種上限・タイムアウトの調整、または日付範囲での分割実行が必要 |
| 数十万件〜 | **機能では解けない領域**。上流での差分抽出（CDC 化）や連携方式の見直しを先に検討 |

- **API 上限はコース差あり**: 1 日あたりのリクエスト上限は**スタンダード 10,000 / ワイド 100,000（/アプリ）**（[kintone REST API 共通仕様](https://cybozu.dev/ja/kintone/docs/rest-api/overview/kintone-rest-api-overview/)）。同時アクセス数（ドメインあたり）の制約もあります。
- **調整対象**（入口ごと）: `maxRecords`（既定 500）／`tempTableMaxRows`（既定 10,000）／MCP の `dmlMaxRows`・`dmlTotalMaxRows`／実行タイムアウト。
- マスタが 10 万件でも**日次差分が数百件なら問題ありません**。

---

## 注意

- **トランザクションはありません**。非アトミックで、途中失敗時に前半のみ反映され得ます（だからこそ R1 の「復旧・確保・冪等」設計にします）。
- 一時テーブルは**同時 16 個・1 個あたり既定 10,000 行**（`tempTableMaxRows` で変更可）。バッチは**最大 20 文**。
- DML バッチは常に **fail-fast**（`ASSERT` 失敗・エラーで停止）。`continueOnError` は read-only バッチのみ。
- **サブクエリ参照の非対称**: `UPDATE` / `DELETE` の `WHERE` に `IN (SELECT …)` は書けず、**実行時**に `KintoneQueryError: IN (SELECT ...) は kintone クエリに変換できません` となる（一時テーブル・実アプリのどちらのサブクエリでも同じ）。**`ksql_validate` は `ok` を返す**ため静的検査では検出できない。一方 `INSERT … SELECT` / `UPSERT … SELECT`、および `CREATE TEMP TABLE … AS SELECT` や `ASSERT` のサブクエリからは参照できる（R3 が成立する根拠）。一時テーブルの値で更新したい場合は **`UPDATE … FROM`（v2.12.0 / 業務キー結合は v2.13.0・R6）** を使う。
- **検索打ち切り（10 万件）の扱い（v2.10.0 以降）**: kintone は `like` / `not like` の一致候補が **10 万件に達すると検索を打ち切る**。現行の挙動を整理すると:
  - **現在**: CLI/MCP の `SELECT` はこの打ち切りを検出すると**警告付き**で返る（結果が欠落し得る）。プラグイン経路は検出しない。
  - **現在**: DML の対象取得（読取）が打ち切り信号を受けたら、**書き込み前に `SearchAbortedError` で停止**（fail-closed）＝サイレントな一部更新/削除の防止。一時テーブル実体化も同様にエラー。
  - **現在**: `UPDATE` / `DELETE` の WHERE に `LIKE` / `NOT LIKE` は使えず、`KLIKE` は**全 DML で使用不可**（いずれも**別の静的制約で実行前に拒否**される）。したがって「`LIKE` / `KLIKE` を直接含む DML」は今は書けない。
  - **将来**: 上記 fail-closed は、`KLIKE` 親レコード DML を解禁する際の安全基盤になる。
  - 実務では、大規模アプリを対象にする DML は **`$id` 範囲・`IN`・完全一致などで 10 万件未満に絞って**から処理する。
