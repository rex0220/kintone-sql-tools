# B5: 通常親 UPDATE / DELETE の WHERE で KLIKE を解禁する仕様

- Issue: B5
- Revision: R1
- Date: 2026-07-21
- Target release: v3.10.0（B7・B47 と同梱）
- Target branch: `feat/b7-b47-plugin-abort-parent-like`
- Status: 仕様起草。コード実装前

## 1. 目的

APPLY を持たない通常のトップレベル（親レコード）`UPDATE` / `DELETE` の `WHERE` で、`KLIKE` / `NOT KLIKE` を使用可能にする。

B5 は新しい対象選択エンジンを追加しない。通常親 DML が既に使用する「WHERE 全体を kintone query へ exact pushdown し、その GET が返した集合をそのまま更新／削除対象とする」経路に、native `like` / `not like` へ完全変換できる KLIKE だけを通す小さな carve-out である。

```sql
UPDATE APP730
SET 確認用フラグ = 'B5'
WHERE 都道府県K KLIKE '東京都';

DELETE FROM APP730
WHERE 都道府県K NOT KLIKE '東京都' AND レコード番号 IN (900001, 900002);
```

## 2. 現行実装の根拠

### 2.1 KLIKE は native query へ完全変換でき、LIKE はできない

`whereToKintone()` は AST 全体を再帰変換し、`LOGICAL` の `AND` / `OR` も kintone query へ出力する（[src/converter/whereToKintone.ts:45-54](../../src/converter/whereToKintone.ts#L45)、[src/converter/whereToKintone.ts:119-129](../../src/converter/whereToKintone.ts#L119)）。演算子変換は `KLIKE` → `like`、`NOT_KLIKE` → `not like` である（[src/converter/whereToKintone.ts:84-99](../../src/converter/whereToKintone.ts#L84)）。前置 `NOT` は `pushDownNot()` でリーフまで押し下げ、KLIKE と NOT KLIKE を相互反転できる（[src/converter/whereToKintone.ts:132-145](../../src/converter/whereToKintone.ts#L132)、[src/engine/pushDownNot.ts:40-55](../../src/engine/pushDownNot.ts#L40)）。

一方、SQL `LIKE` / `NOT LIKE` は `isLike()` で検出すると `KintoneQueryError` を投げる。kSQL の LIKE は常に JS 残余評価が必要であり、native query への完全変換として扱わない（[src/converter/whereToKintone.ts:61-70](../../src/converter/whereToKintone.ts#L61)）。型能力判定も、native `like` が使える型の KLIKE は `EXACT_PUSHDOWN`、SQL LIKE は residual と分類する（[src/core/optimization/whereCapability.ts:122-162](../../src/core/optimization/whereCapability.ts#L122)）。

### 2.2 通常親 UPDATE / DELETE は exact pushdown の返却集合を対象にする

通常 UPDATE は `updateToGetQuery()` で安全性ガード後に WHERE 全体を `whereToKintone()` へ渡し、`$id` を取得する（[src/converter/dmlToKintone.ts:146-159](../../src/converter/dmlToKintone.ts#L146)）。行依存 SET の UPDATE も同じガードと全体変換を使う（[src/converter/dmlToKintone.ts:211-235](../../src/converter/dmlToKintone.ts#L211)）。通常 DELETE も同型である（[src/converter/dmlToKintone.ts:489-500](../../src/converter/dmlToKintone.ts#L489)）。

実行時、通常 UPDATE は変換済み query で対象 ID／必要フィールドを取得した後に confirm と PUT へ進み（[src/execute.ts:6235-6262](../../src/execute.ts#L6235)、[src/execute.ts:6265-6283](../../src/execute.ts#L6265)）、DELETE も対象 ID 取得後に confirm と DELETE へ進む（[src/execute.ts:6911-6947](../../src/execute.ts#L6911)）。さらに通常親 DML は実行前の型能力判定で WHERE 全体に `EXACT_PUSHDOWN` を要求する（[src/execute.ts:2199-2222](../../src/execute.ts#L2199)）。JS で WHERE を再評価する段階はないため、GET の返却集合がそのまま mutation 対象集合である。

UPDATE ... FROM も、親側 target filter がある場合は `updateToGetQuery()` で exact query 化し、照合キーの `in` と `and` 結合して対象を取得する（[src/execute.ts:5398-5419](../../src/execute.ts#L5398)）。したがって B5 は APPLY なし・サブテーブルでない親 UPDATE である限り UPDATE ... FROM の親 target filter も含む。ただし source SELECT 内の KLIKE は従来どおり SELECT の規則に従う。

### 2.3 現在の拒否点は二重である

第一の拒否点は `assertDmlWhereIsSafe()` であり、現在は KLIKE と LIKE を別々に拒否する（[src/converter/dmlToKintone.ts:34-47](../../src/converter/dmlToKintone.ts#L34)）。第二の拒否点は共通の `validateKlikeStatement()` であり、UPDATE は B47 の APPLY 複数親経路だけを carve-out し、DELETE を含むその他 DML を拒否する（[src/core/klikeValidation.ts:44-94](../../src/core/klikeValidation.ts#L44)）。

B5 の実装はこの二点だけを経路条件付きで緩和する。parser、AST、`whereToKintone()`、対象取得、mutation、search-abort wrapper に新分岐を追加しない。

### 2.4 サブテーブル DML は別経路であり KLIKE を評価できない

サブテーブル UPDATE は親を全取得して展開後に `evalWhere()` で対象子行を選ぶ（[src/execute.ts:7159-7168](../../src/execute.ts#L7159)）。サブテーブル DELETE も同じである（[src/execute.ts:7234-7243](../../src/execute.ts#L7234)）。REORDER も親全取得後に `evalWhere()` で対象親を選ぶ（[src/execute.ts:7443-7457](../../src/execute.ts#L7443)）。

`evalWhere()` は KLIKE ノードが `appliedKlikes` 集合に含まれる場合だけ true とし、それ以外は評価不能として throw する（[src/engine/evalWhere.ts:101-117](../../src/engine/evalWhere.ts#L101)）。通常のサブテーブル DML は B47 のような applied-set を構築しない。したがってサブテーブル UPDATE / DELETE / REORDER の KLIKE は恒久非対応とし、`evalWhere()` 到達前の静的検証で明確に拒否する。

## 3. スコープ

### 3.1 許可する文

次の条件をすべて満たす文の親 `WHERE` で `KLIKE` / `NOT KLIKE` を許可する。

1. 文種が `UPDATE` または `DELETE` である。
2. `UPDATE` に APPLY block がない。
3. 対象が `APP<n>$<table>` ではなくトップレベル `APP<n>` である。
4. WHERE 全体が型能力判定で `EXACT_PUSHDOWN` となり、`whereToKintone()` で完全変換できる。
5. KLIKE 自体の既存制約（右辺は文字列リテラル／解決可能な文字列バッチ変数、`%` 禁止）を満たす。既存検証は [src/core/klikeValidation.ts:102-117](../../src/core/klikeValidation.ts#L102) を再利用する。

この条件には単純 SET、行依存 SET、CHECK / ON ERROR SKIP、および `UPDATE ... VALIDATE ONLY` を含む。`UPDATE ... VALIDATE ONLY` は文種として UPDATE のまま read-only 実行され、現行言語でも親 UPDATE に対応している（[src/types/ast.ts:769-784](../../src/types/ast.ts#L769)、[docs/ksql_language_reference.md:1989-2006](../ksql_language_reference.md#L1989)）。

### 3.2 許可しない文・式

- 通常親 UPDATE / DELETE の `LIKE` / `NOT LIKE`。JS 残余評価が必要で、通常経路には residual 機構がないため従来どおり拒否する。
- `APP<n>$<table>` の UPDATE / DELETE、および REORDER の KLIKE / NOT KLIKE。JS 評価経路なので恒久拒否する。
- INSERT / INSERT SELECT / UPSERT / UPSERT SELECT の KLIKE。B5 は照合・source SELECT・APPLY 分岐の受理範囲を広げない。source SELECT 自体の KLIKE は SELECT 規則でのみ判定する。
- 独立した監査文 `VALIDATE APP<n> ... WHERE/CHECK ...` の KLIKE。これは `UPDATE ... VALIDATE ONLY` とは別文種であり、既存拒否（[src/core/klikeValidation.ts:90-93](../../src/core/klikeValidation.ts#L90)）を維持する。
- WHERE に SQL LIKE、関数、算術、CASE、EXISTS、未解決フィールド、またはその他の変換不能ノードが混在し、WHERE 全体を exact pushdown できない文。
- B47 が扱う APPLY 複数親 UPDATE。B5 の通常親 carve-out へ吸収せず、B47 専用計画を維持する。

## 4. OR / NOT 配下の KLIKE

### 4.1 判断

**B5 では OR / NOT 配下の KLIKE / NOT KLIKE を許可する。** ただし WHERE 全体を `whereToKintone()` が完全変換でき、型能力判定が `EXACT_PUSHDOWN` であることを必須とする。

例:

```sql
UPDATE APP730 SET 確認用フラグ = 'B5'
WHERE 都道府県K KLIKE '東京都' OR 都道府県 = '神奈川県';

DELETE FROM APP730
WHERE NOT (都道府県K KLIKE '東京都') AND レコード番号 IN (900001, 900002);
```

OR は `whereToKintone()` が両辺を再帰変換して `or` を出力する（[src/converter/whereToKintone.ts:119-129](../../src/converter/whereToKintone.ts#L119)）。NOT はド・モルガン変換と比較演算子反転でリーフへ押し下げられ、KLIKE / NOT KLIKE も反転対象である（[src/engine/pushDownNot.ts:9-37](../../src/engine/pushDownNot.ts#L9)、[src/engine/pushDownNot.ts:40-55](../../src/engine/pushDownNot.ts#L40)）。両辺／反転後リーフが exact なら、生成された native query の集合そのものが対象集合であり、JS 残余は不要である。

### 4.2 B47 との非対称

B47 の APPLY 複数親 UPDATE は、native query を候補集合の prefilter とし、元 WHERE を `evalWhere()` で residual 評価する。OR / NOT 配下では KLIKE だけを安全な上位集合として抽出できないため `unappliedKlikes` を拒否する。現行 B47 carve-out と専用エラーは [src/core/klikeValidation.ts:66-75](../../src/core/klikeValidation.ts#L66) および [src/execute.ts:6497-6517](../../src/execute.ts#L6497) にある。

B5 は prefilter + residual ではなく WHERE 全体の exact pushdown である。このため OR / NOT を含めて全体を native query として表現できる場合には unapplied KLIKE が存在せず、安全に許可できる。この非対称は文種による例外ではなく、**対象集合を確定する計画が exact か superset + residual か**の違いによる。

## 5. 完全性と fail-closed

KLIKE は native `like` の返却集合を対象集合として確定する。10 万件検索打ち切りで集合が欠落した状態を成功扱いすると、一部だけの誤更新／誤削除になる。そのため B5 の受入条件は「検索打ち切りを全 surface で検出し、最初の mutation より前にエラー終了すること」である。

既存 `execute()` は SELECT 系以外を `failClosed=true` で `wrapClientWithSearchAbort()` に渡す（[src/execute.ts:666-689](../../src/execute.ts#L666)）。wrapper は `getRecords()` の `searchAborted` を見た時点で `SearchAbortedError` を投げる（[src/execute.ts:802-817](../../src/execute.ts#L802)）。エラー型は「完全な対象集合を確定できない」ことを明記している（[src/execute.ts:207-218](../../src/execute.ts#L207)）。バッチも非 SELECT 文を同じ fail-closed wrapper で文単位に包む（[src/execute.ts:1377-1390](../../src/execute.ts#L1377)）。

B7 により plugin `getRecords()` も raw Fetch の `X-Cybozu-Warning` を判定して `searchAborted: true` を返せる（[src/ui/kintoneClient.ts:165-180](../../src/ui/kintoneClient.ts#L165)）。したがって B5 は新しい warning/result 型、surface gate、search-abort 分岐を追加しない。既存 wrapper をそのまま流用し、打ち切り時は confirm / PUT / DELETE を 0 回とする。

`maxRecords` 超過も対象集合の truncate を許さず、既存 DML の error 契約を維持する。search abort と `maxRecords` 上限は別の完全性ゲートであり、どちらも mutation 前に閉じる。

## 6. 実装 carve-out

### 6.1 `assertDmlWhereIsSafe`

対象: [src/converter/dmlToKintone.ts:34-47](../../src/converter/dmlToKintone.ts#L34)

- KLIKE blanket rejection を削除し、通常親 UPDATE / DELETE から到達した KLIKE を許可する。
- LIKE rejection と説明は維持する。
- `updateToGetQuery()`、`updateToGetQueryForArith()`、`deleteToGetQuery()` が引き続き WHERE 全体を `whereToKintone()` へ渡すことを固定する（[src/converter/dmlToKintone.ts:146-159](../../src/converter/dmlToKintone.ts#L146)、[src/converter/dmlToKintone.ts:211-235](../../src/converter/dmlToKintone.ts#L211)、[src/converter/dmlToKintone.ts:489-500](../../src/converter/dmlToKintone.ts#L489)）。
- サブテーブル経路は converter より前の `validateKlikeStatement()` で拒否し、`evalWhere()` へ到達させない。経路の順序に依存するだけでなく converter 単体テストでも「親専用」であることを明示する。

### 6.2 `validateKlikeStatement`

対象: [src/core/klikeValidation.ts:44-94](../../src/core/klikeValidation.ts#L44)

- `UPDATE`: B47 の既存 APPLY 複数親 carve-out を最初に維持する。その次に、`applyBlocks` なし・`subtableCode` なしの通常親 UPDATE なら `validateKlikeWhereExpressions(stmt.where)` と nested SELECT 検証を行って許可する。
- `DELETE`: `subtableCode` なしの通常親 DELETE だけ同じ KLIKE 式検証を行って許可する。
- サブテーブル UPDATE / DELETE、INSERT、UPSERT、REORDER、独立 VALIDATE は現行拒否を維持し、文種／対象種が分かる明確なエラーにする。
- B47 の `isSinglePositiveRecordIdWhere()` 条件、unapplied KLIKE 判定、node identity、prefilter + residual 計画には触れない。

### 6.3 変更しない箇所

- parser / AST / KLIKE の `%`・右辺型規則
- `whereToKintone()` と `pushDownNot()`
- UPDATE / DELETE の対象取得と mutation 順序
- `assertDmlWhereCapability()` の `EXACT_PUSHDOWN` 要求
- `wrapClientWithSearchAbort()` と各 client adapter
- B47 の `ApplyParentSelectionPlan`、`appliedKlikes`、`unappliedKlikes`

## 7. EXPLAIN

通常 UPDATE / DELETE の既存 EXPLAIN plan builder を拡張し、次を表示する。

1. `kintone query:` に KLIKE を `like`、NOT KLIKE を `not like` として表示する。
2. 対象選択が `exact native pushdown; JS residual none` であることを表示する。
3. `search abort: DML fail-closed (SearchAbortedError; mutation 0)` を表示する。
4. EXPLAIN 自体は records / mutation API を呼ばない既存契約を維持する。

通常 UPDATE は既に `safeWhereToKintone(stmt.where)` を `kintone query:` へ出す（[src/execute.ts:8694-8724](../../src/execute.ts#L8694)）。DELETE も同じ表示を持つ（[src/execute.ts:8817-8826](../../src/execute.ts#L8817)）。`safeWhereToKintone()` は変換成功時に実 query を返す（[src/execute.ts:8921-8928](../../src/execute.ts#L8921)）。新しい EXPLAIN 文種や実アクセスは追加せず、この既存 DML 表示の範囲に selection mode と fail-closed 前提を加える。

## 8. 旧棚上げ理由の解消

旧 KLIKE spec §3.5 と台帳 B5 は次の三点を未決としていた（[docs/internal/ksql_klike_native_search_spec.md:80-89](ksql_klike_native_search_spec.md#L80)、[docs/ksql_issue_tracker.md:40](../ksql_issue_tracker.md#L40)）。R1 の整理は次のとおりである。

1. **DML result への warnings 追加**: 不要。対象集合の不完全性は warning で継続せず、既存 `SearchAbortedError` で fail-closed にする。DML result 型は変更しない。
2. **plugin の B7 未解決**: 解消。B7 の plugin raw Fetch 経路は実装され、APP730 の実機で検索打ち切りヘッダー検出を確認済みである（[docs/internal/evidence/b7_plugin_search_abort_smoke.md:1-25](evidence/b7_plugin_search_abort_smoke.md#L1)）。
3. **サブテーブル DML**: 解消ではなく制約として維持する。JS `evalWhere()` で KLIKE を独立評価できないため恒久拒否する。

## 9. テスト計画

### 9.1 converter / validation

- 親 UPDATE / 行依存 UPDATE / DELETE の KLIKE → query に `like`。
- 親 UPDATE / DELETE の NOT KLIKE、および `NOT (field KLIKE ...)` → query に `not like`。
- `KLIKE OR exact条件`、`NOT (KLIKE OR exact条件)` を全体変換できる。
- KLIKE + SQL LIKE 混在、関数／算術／CASE／EXISTS、型能力上 native `like` 非対応のフィールドは実行前拒否。
- KLIKE の `%`、不正右辺型、未解決変数は既存エラー。
- サブテーブル UPDATE / DELETE / REORDER は `evalWhere()` 前に明確な KLIKE 非対応エラー。
- INSERT / UPSERT / 独立 VALIDATE の拒否を維持。
- B47 APPLY 複数親の AND-leaf KLIKE は従来どおり許可し、OR / NOT 配下の unapplied KLIKE は従来どおり拒否する。

### 9.2 execute / fail-closed

- 親 UPDATE KLIKE: GET query が native `like`、返却 ID だけ PUT。
- 親 DELETE NOT KLIKE: GET query が native `not like`、返却 ID だけ DELETE。
- `searchAborted:true`: `SearchAbortedError`、confirm / PUT / DELETE 0 回。
- `maxRecords` 超過: error、confirm / mutation 0 回。
- KLIKE なしの通常 UPDATE / DELETE の query、件数、confirm、mutation の非回帰。
- 単文、バッチ、CLI、MCP、plugin で許可／拒否と fail-closed が一致する。
- EXPLAIN に native query、exact/no residual、search-abort fail-closed が出る。

## 10. 実機受入（APP730）

APP730 はサブテーブルなしの 618,525 件アプリであり、B7 実機でも使用済みである（[docs/internal/evidence/b7_plugin_search_abort_smoke.md:5-20](evidence/b7_plugin_search_abort_smoke.md#L5)）。B47-P4 では 10 万件超のサブテーブルアプリがなく KLIKE DML の打ち切りを直接確認できなかった（[docs/internal/evidence/b47_apply_parent_like_klike_smoke.md:34-41](evidence/b47_apply_parent_like_klike_smoke.md#L34)）。B5 は APP730 の通常親 DML でこの未確認点を補完する。

### 10.1 read-only 事前確認

通常親 UPDATE には `VALIDATE ONLY` があるが、DELETE にはない（[docs/ksql_language_reference.md:1989-2006](../ksql_language_reference.md#L1989)）。次の順で確認する。

1. `EXPLAIN UPDATE ... WHERE <KLIKE> VALIDATE ONLY` で native `like`、exact/no residual、DML fail-closed を確認する。
2. 十分に小さい KLIKE 条件では `UPDATE ... VALIDATE ONLY` を実行し、対象解決と post-image 検証を read-only で確認する。POST / PUT / DELETE API は呼ばれない契約である（[docs/ksql_language_reference.md:1991-2008](../ksql_language_reference.md#L1991)）。
3. DELETE は `EXPLAIN DELETE` と、同一 WHERE の read-only `SELECT $id ...` / `COUNT(*)` で対象を確認する。ただし SELECT は mutation 直前の完全性保証の代替ではなく、DELETE 本実行は可逆 fixture のみに限定する。

### 10.2 可逆な小 mutation

- APP730 に検証専用の書込可能フィールド／専用レコードを用意し、狭い KLIKE か `KLIKE AND $id IN (...)` で 1〜数件だけ UPDATE する。
- mutation 前の値と `$id` を保存し、実行後に対象／非対象を照合して直ちに復元する。
- DELETE は復元可能な専用コピー fixture だけを使い、元レコードの全 payload を保存して再作成する。共有実データを削除しない。
- KLIKE なしの通常 UPDATE / DELETE も同じ小 fixture で非回帰確認する。

### 10.3 10 万件打ち切り fail-closed

- APP730 で 10 万件超に一致することが B7 で確認済みの広い KLIKE 条件を通常親 UPDATE と DELETE に使用する。
- UPDATE は安全な SET 値を指定するが、期待結果は `SearchAbortedError` であり、confirm 0 回、PUT 0 回、対象フィールド変更 0 件とする。
- DELETE も期待結果は `SearchAbortedError`、confirm 0 回、DELETE API 0 回、総件数および sentinel レコード不変とする。
- plugin raw Fetch、Node/CLI/MCP の各 surface で同じ結果を確認する。少なくとも plugin は B7 の実機検出を B5 の実 DML まで end-to-end で接続する release gate とする。

### 10.4 拒否・非回帰

- SQL LIKE を持つ通常親 UPDATE / DELETE は実行前拒否。
- サブテーブル UPDATE / DELETE / REORDER の KLIKE は API 前に明確なエラー。
- INSERT / UPSERT / 独立 VALIDATE の KLIKE は拒否。
- B47 APPLY 複数親の許可例と OR / NOT unapplied 拒否例を再実行し、B5 carve-out が B47 を壊していないことを確認する。

## 11. SemVer・リリース

B5 は従来安全上拒否していた通常親 UPDATE / DELETE の受理範囲を広げる利用者可視の機能追加であるため **minor** とする。B7（plugin 打ち切り検出）と B47（APPLY 親 WHERE LIKE/KLIKE）の基盤上に載せ、三件を **v3.10.0** に同梱する。現行 package version も `3.10.0` である（[package.json:1-4](../../package.json#L1)）。

リリース時は言語リファレンス、旧 KLIKE spec §3.5、issue tracker B5、CHANGELOG、MCP tool description / schema、plugin manifest と配布 artifact の受理範囲・version を同期する。本 R1 の起草段階ではこれらを変更しない。

## 12. 受入条件

1. APPLY なし・トップレベル UPDATE / DELETE の KLIKE / NOT KLIKE が native `like` / `not like` の exact query として実行される。
2. OR / NOT 配下 KLIKE も、WHERE 全体が exact なら許可される。
3. SQL LIKE、変換不能 WHERE、サブテーブル DML、INSERT / UPSERT / REORDER / 独立 VALIDATE の拒否を維持する。
4. search abort と `maxRecords` 超過は mutation 前に fail-closed となる。
5. EXPLAIN が native query、residual なし、search-abort fail-closed を示す。
6. B47 の APPLY carve-out、unapplied KLIKE 拒否、node identity を変更しない。
7. APP730 で通常親 KLIKE UPDATE / DELETE の 10 万件打ち切りを実測し、`SearchAbortedError`・書き込み 0 件を確認する。
8. KLIKE なしの通常 UPDATE / DELETE と全 surface の非回帰テストが通る。

## 13. Claude レビュー重点

1. `validateKlikeStatement()` の条件が B5 通常親だけを開き、B47 APPLY・サブテーブル・独立 VALIDATE を誤って巻き込まないか。
2. OR / NOT 許可の根拠が、型能力判定と `whereToKintone()` の全体 exact 変換で十分か。特に collection 型の native operator allowlist を見落としていないか。
3. `UPDATE ... VALIDATE ONLY` を B5 の read-only 確認手段として許可しつつ、独立 `VALIDATE APP` の拒否を維持する区別が妥当か。
4. UPDATE ... FROM、CHECK / ON ERROR SKIP、行依存 SET の全経路が同じ converter と fail-closed wrapper を通り、抜け道がないか。
5. APP730 の広い KLIKE で UPDATE / DELETE の mutation API 0 回を観測でき、B47-P4 の未実測点を十分に補完できるか。
