# B45 対応計画 — サブテーブル仮想テーブル SELECT の WHERE でシステム列（`_pid`/`_rid`/`_idx`）が使えない

- 種別: バグ修正
- 優先度: 中
- 想定 SemVer: **patch**（受理範囲の拡大＋仮想列の既存誤意味論を型契約へ整合するバグ修正）
- ステータス: **R3**（codex 再レビュー反映済み・実装着手前の計画確定版）
- 関連: 言語リファレンス §19・[[batch-temp-table-workflow]]・B44 v2 行アドレッシング

## 1. 症状

`SELECT … FROM APP4221$テーブル WHERE _pid = 7` が実行前に throw する:

```
ArgumentError: WHERE predicate is unsupported (... reason=WHERE_FIELD_UNRESOLVED field=_pid ...)
```

`_rid` / `_idx` も同様に全滅。**言語リファレンス §19 の記載例そのものが動かない**（docs/ksql_language_reference.md:2272-2276 ほか）＝文書と実装の乖離。公開版 3.6.1 でも再現＝B42 の回帰ではない既存事象。

非対称（現状）:
- 同じ SELECT でも `_p.$id = 7`（親フィールド参照）は**動く**（親絞り込みの回避策あり）
- サブテーブル **DML**（`UPDATE/DELETE APPxxx$テーブル … WHERE _pid=/_rid=`）は**動く**
- SELECT の `_rid`/`_idx` 行絞り込みは**回避策なし**

## 2. 原因（裏取り済み）

WHERE 述語は実行前に `classifyWhereCapability`（src/core/optimization/whereCapability.ts:81）で押し下げ可能性を分類する。SELECT 経路（executeSelect → resolveSelectWhereCapability, src/execute.ts:2145）は分類が `UNSUPPORTED` なら**フェッチ前に throw**する（src/execute.ts:2220-2223）。

分類に渡す `WhereFieldSemanticsResolver` は `buildWhereFieldSemanticsResolver`（src/execute.ts:2011-2107）が構築し、**物理アプリのフォーム定義（getFieldsCached）からのみ**セマンティクスを引く。その共有ヘルパー `fromPhysical`（src/execute.ts:2060-2075）は:

```ts
const fromPhysical = (table, field) => {
  if (field === "$id") return withFieldSemanticSource(resolveFieldSemantics({ fieldType: "__ID__" }), table.appId, "$id");
  const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field));
  if (!info) return undefined;   // ← _pid/_rid/_idx はフォーム定義に無い → undefined
  ...
};
```

`_pid`/`_rid`/`_idx` はフォーム定義に存在しない列コードなので `info` が undefined → `fromPhysical` が **undefined** を返す → `classifyBinary`（whereCapability.ts:129-132）が `WHERE_FIELD_UNRESOLVED` / UNSUPPORTED を返す。**これが直接原因。**

### 2.1 なぜ `_p.$id` は動くのか

`fromPhysical` は `$id` を特別扱い（:2061）し `__ID__` セマンティクスを返す。`_p.<親項目>` は resolver 先頭の `_p` 分岐（:2079-2081）で `fromPhysical(stmt.from, <親項目>)` を呼び物理フォームから解決される。**`$id` と `_p.` だけ対応済みで、非修飾システム列が欠落している。**

### 2.2 なぜ SELECT だけ落ちるのか（構造的非対称）

- **DML はそもそも分類をスキップ**する。`assertDmlWhereCapability`（src/execute.ts:2175-2199）が冒頭で `if (stmt.subtableCode || …) return;`（:2182）→ classify を通らず、`executeUpdateSubtable`/`executeDeleteSubtable` が全親フェッチ→展開→**純粋ローカル evalWhere** でターゲット選別する（`_pid`/`_rid`/`_idx` は展開行 flat のキーとして値解決できる）。
- **SELECT は押し下げ可能性判定のため分類を必須で通す**が、サブテーブルは常に FULL_SCAN 固定（`resolveSelectMode`, src/converter/selectToKintone.ts:67-69）でフェッチ時に push クエリを破棄する（src/execute.ts:3663-3672）。**つまりサブテーブル SELECT の WHERE は本質的にローカル評価専用なのに、分類器にだけシステム列のセマンティクスを与えていない。**
- **フォールバックの非対称**: システム列メタを補完する `systemColumnMeta`（src/execute.ts:2912-2922）が既に存在し、他の3 resolver（`inferSelectColumnMeta` :3019/:3025/:3035、full-scan の `fieldSemanticsResolver` :4096/:4101/:4110）が使っている。**しかし WHERE 分類用の `buildWhereFieldSemanticsResolver` だけがこのフォールバックを持たない。** 「他は動くのに WHERE 分類だけ落ちる」構造。

### 2.3 展開行のプロパティ・型

- SELECT 展開: `expandSubtableRecords`（src/converter/subtableAdapter.ts:25-29）が各行に `_pid`（親 $id 文字列）・`_rid`（行 id 文字列, 無ければ `""`）・`_idx`（`String(i)`）を付与。
- 型想定（既存コード）: childTypeResolver は `_rid`→SINGLE_LINE_TEXT・`_idx`→NUMBER（src/core/applyPatchPlanner.ts:304-307）。REORDER の `resolveReorderSemantics`（src/execute.ts:7052-7058）は3列とも number。`systemColumnMeta` は `_rid`/`_pid`→`__ID__`（`_idx` は未収録）だが、`resolveFieldSemantics` は `__ID__` を **string ではなく `recordNumber`** にする（src/core/fieldSemantics.ts:32-45: `if (source.fieldType === "RECORD_NUMBER" || source.fieldType === "__ID__") { compareMode = "recordNumber"; }`）。→ **コード内でも表現が割れており、R2 の「既存 `__ID__` のまま統一」は不成立**（後述の決定点1）。
- ローカル評価は既に機能する: evalWhere は flat 行のキーを直接参照するため、分類段の throw さえ越えれば `_pid=7` 等の値解決は問題ない。

## 3. 修正方針

**押し下げは不可能**（サブテーブル行はローカル展開・FULL_SCAN 固定・push クエリ破棄）。`resolveSelectMode` は FROM/JOIN のどちらにサブテーブルがあっても FULL_SCAN（src/converter/selectToKintone.ts:67-70）、サブテーブル fetch は query を常に空にして親を取得する（src/execute.ts:3663-3672）。よって正しい方向は**システム列を「ローカル評価専用（非押し下げ）」として分類させる**こと。`syntheticSemantics("number"/"string")` はそれぞれ `KSQL_NUMBER`/`KSQL_STRING` を返す（src/core/fieldSemantics.ts:60-64）。両型は `LOCAL_SCALAR_TYPES` に含まれる一方（whereCapability.ts:63-70）、`NATIVE_OPERATORS` には存在しない（:36-61）ため、`classifyBinary` の local contract は通るが `native.has(...)` は偽（:133-160）→ **演算子や alias/JOIN の経路にかかわらず LOCAL_ONLY / WHERE_RESIDUAL** となる。EXPLAIN で最終保証する。

### 3.1 実装（3つの整合点）

**重要（R2 訂正）**: 修正は「単一 chokepoint」ではない。WHERE には**2つの並行 resolver** があり、両方＋ CTE/UNION 用メタの計 **3 箇所**にシステム列を供給する必要がある（codex レビューで確定・全てコード裏取り済み）。

#### (a) 意味論 resolver — `fromPhysical`（src/execute.ts:2060）

`$id` 分岐直後にサブテーブル・システム列分岐を追加。**ただし `_p.` 経路からの呼び出しを除外**（下記 P1-1）:

```ts
// boolean は省略不可にし、全呼び出し側で意図を明示する（_p 分岐だけ false）
const fromPhysical = (table, field, allowSubtableSystemColumns) => {
  if (field === "$id") return withFieldSemanticSource(resolveFieldSemantics({ fieldType: "__ID__" }), table.appId, "$id");
  if (allowSubtableSystemColumns && table.subtableCode) {
    if (field === "_rid") return syntheticSemantics("string");   // 行 id は不透明識別子（APPLY childTypeResolver=SINGLE_LINE_TEXT に一致）
    if (field === "_idx") return syntheticSemantics("number");   // 行索引は数値
    if (field === "_pid") return syntheticSemantics("number");   // 親 $id 由来・local-only（__ID__ は返さない＝押し下げ分類回避）
  }
  const info = infosByApp.get(table.appId)?.get(fieldCodeForTypeLookup(table, field));
  ...
};
```

呼び出し割り当ては次のとおり。

- `_p`（src/execute.ts:2079-2081）は `fromPhysical(stmt.from, field.field, false)`。親物理列だけを解決し、システム列補完を禁止する。
- 別名修飾（:2082-2088）は対象 table が物理なら `true`。補完側でも `table.subtableCode` を必須にするため、通常物理アプリの同名実列は従来どおりフォーム定義から解決される。
- no-JOIN 非修飾（:2090-2095）は `true`。
- JOIN 非修飾（:2097-2105）は各物理 table を `true` で候補化するが、**システム列では候補が一意な場合だけ返す**。サブテーブルが2つ、またはサブテーブル仮想列と通常物理アプリの同名実列が衝突する場合は `undefined` として `WHERE_FIELD_UNRESOLVED` を維持し、alias 修飾を要求する。現行の `matches.length > 1 ? syntheticSemantics("string")`（:2103-2105）へシステム列を流すと、結合行は `{ ...lRow, ...rRow }` で右側の非修飾値が勝つ（src/engine/process.ts:140-142）うえ `_idx` まで string 比較になるため禁止する。一般列の既存フォールバック契約は変更しない。

#### (b) 型 resolver — `row: FieldTypeResolver`（src/execute.ts:3140、typed IN 用）

`syntheticSemantics` は typed IN 経路（evalWhere.ts:130 `typedInContains(leftStr, values, fieldType)`）を通らない。IN は**別の `FieldTypeResolver`（:3140）** が返す `fieldType` 文字列を使うため、こちらにも並行してシステム列を供給する（`_p` 同様ガード）:

小さな共有関数 `subtableSystemFieldType(table, field)`（table.subtableCode があるときだけ `_rid`→`"SINGLE_LINE_TEXT"`、`_idx`/`_pid`→`"NUMBER"`）を追加し、次の**全分岐**へ明示的に入れる。

- `_p`（src/execute.ts:3141-3144）: **呼ばず**、現行 `fieldTypesByApp.get(stmt.from.appId)?.get(field.field)` のみ。
- 別名修飾（:3145-3148）: table/CTE 検証後、`subtableSystemFieldType(table, field.field) ?? fieldTypesByApp...`。
- no-JOIN 非修飾（:3150-3153）: CTE 除外後、同じ順で補完。
- JOIN 非修飾（:3155-3162）: 現行どおり CTE 混在は `undefined`。各 physical table について synthetic type またはフォーム型を候補化し、**候補が1件のときだけ**返す。複数候補は `undefined` として意味論 resolver と同じ alias 要求にする。

これが無いと `_pid IN (…)` / `_idx IN (…)` が型無し比較になり、大きな数値リテラルで `String(v.value)` が raw lexeme を失うおそれ（P2-1）。

#### (c) CTE/UNION メタ — `systemColumnMeta`（src/execute.ts:2912）の3列型を統一【必須】

CTE/一時表/UNION 後段の WHERE は `fromPhysical` を通らず、実体化された `columnMeta`（`systemColumnMeta` 由来）を使う（:2084/:2092、無いと `syntheticSemantics("string")` へフォールバック）。現状 `systemColumnMeta` は `$id`/`_rid`/`_pid` を一括して `__ID__` + `sortKind: "number"` にする（src/execute.ts:2912-2918）が、`__ID__` の compareMode は `recordNumber` であり、(a) の `_rid`=string / `_pid`=number と両方不一致。また `_idx` を欠くため `WITH x AS (SELECT _idx FROM APP$t) SELECT * FROM x WHERE _idx > 2` は string 比較になり `"10" > "2"` を誤判定する。

→ `systemColumnMeta` を **`$id` は既存 `__ID__` のまま、`_rid` は `syntheticColumnMeta("string")`、`_pid`/`_idx` は `syntheticColumnMeta("number")`** に分割する。これにより (a)(b)(c) の契約を一致させる。既存サブテーブル SELECT テスト（src/__tests__/execute.test.ts:2971-2998）を回帰確認し、CTE/一時表/UNION の3列を個別に固定する。

### 3.2 決定点（R3 確定）

- **決定点1（型）**: 3列 number ではなく **`_rid`=string・`_idx`=number・`_pid`=number(local-only)**（compareScalarValues に semantics が渡るため型が比較結果を変える＝`"007"="7"` が number で真・string で偽。P1-2）。`__ID__` は `recordNumber` かつ native operator を持つため、仮想3列には使わず `$id` 専用のままにする。意味論 resolver=`KSQL_STRING/KSQL_NUMBER`、typed-IN resolver=`SINGLE_LINE_TEXT/NUMBER`、materialized meta=`synthetic string/number` の3経路で compareMode を統一する。
- **決定点2（`_p._pid`）**: **benign ではない・ガード必須**（R1 の判断を撤回）。`resolveFieldRef`（src/engine/evalFunc.ts:599-606）が修飾キー不在時に `.` 以降へフォールバックするため、`_p._pid` は局所評価で `_pid` に**誤マッチ**する（現状は throw で拒否＝無条件追加は「拒否→サイレント誤マッチ」への回帰）。→ (a)(b) とも `_p` 経路ではシステム列補完を無効化し、`_p._pid`/`_p._rid`/`_p._idx` は `WHERE_FIELD_UNRESOLVED` のまま維持しテストで固定。
- **演算子範囲**: `=` 限定にしない。number/string の local contract を通す全比較を許可＝`=` `!=` `<>` `<` `<=` `>` `>=` `BETWEEN`(parser が `>= AND <=` に展開・parser.ts:2034) `IN` `NOT IN` `IS NULL` `IS NOT NULL` `LIKE` `NOT LIKE`。**`KLIKE`/`NOT KLIKE` は局所評価不能（evalWhere.ts:108 で throw）なので対象外**。

### 3.3 B45 のスコープ境界（R3 明確化）

- **今回対応**: SELECT WHERE（直参照・alias・一意な JOIN・CTE/一時表/UNION 後段）と、同じ system meta を使う ORDER BY の型整合。`ORDER BY _idx` は number、`ORDER BY _rid` は string として固定する（ORDER 比較は semantics を使う。src/engine/process.ts:535-556/:595-596）。GROUP BY のキー同値性は生文字列を連結して Map 化する既存実装（src/engine/process.ts:223-228/:284-288）で3列とも既に参照可能なため、仕様変更せず受理の回帰テストだけ置く。
- **NULL/未保存行**: adapter は row.id 欠落を `_rid: ""` にする（src/converter/subtableAdapter.ts:25-29）。NULL_CHECK は `""` を NULL と扱う（src/engine/evalWhere.ts:283-292）ため、`_rid IS NULL` は未採番行に true、`IS NOT NULL` は false、保存済み行では逆、という既存規約を B45 でも採用してテストする。`_pid`/`_idx` は展開行では常に値を持つ。
- **JOIN の曖昧参照**: 上記 §3.1(a)(b) のとおり対象外（拒否継続）で、alias 修飾を必須にする。通常物理アプリの `_pid` 等の実フィールドを仮想列扱いしない。
- **今回変更しない**: REORDER/DML。REORDER は専用 `resolveReorderSemantics` が3列を number にする（src/execute.ts:7052-7058）ため `_rid` の SELECT 契約とは不一致だが、B45 の SELECT resolver を共有せず本修正の回帰面ではない。別課題として扱い、B45 で意味論変更しない。集計関数 `MIN/MAX(_rid/_idx/_pid)` も別の `AggregateSortKindResolver`（src/execute.ts:2823-2862）を通るため対象外。`KLIKE/NOT KLIKE` も前記どおり対象外。

## 4. テスト（修正前 fail / 修正後 pass を示す）

**テスト配置（R2 訂正）**: `selectToKintone.test.ts` は mode/converter のテストで private な `buildWhereFieldSemanticsResolver` や実行時 `evalWhere` を通らない。→ **`src/__tests__/execute.test.ts` と `src/__tests__/explain.test.ts` に配置**（既存のサブテーブル実行テストは execute.test.ts:2971 にある）。

- `execute.test.ts`（実行経路・値解決）:
  - `_pid = <n>` / `_rid = '<id>'` / `_idx = <n>` が throw せず期待行を返す（修正前 fail）。
  - 演算子: `!=` / `>` / `BETWEEN` / `IN` / `NOT IN`（型付き比較の確認）。
  - alias 修飾 `t._pid` / JOIN 併用サブテーブルの修飾システム列。
  - JOIN 非修飾は、system 列の提供元が1表だけなら各型で成功。サブテーブル2表、または通常物理アプリの同名実列との衝突は `WHERE_FIELD_UNRESOLVED` で拒否し、右側行へのサイレント誤マッチを防ぐ。
  - **型意味論**: 大きな `_rid`（`'9007199254740993'` 等）が string として正しく比較・`_idx > 2` が number 比較（string なら `"10">"2"` 誤判定になる負例）。
  - typed IN は no-JOIN・alias 修飾・一意な JOIN の各分岐で `_rid`=text / `_pid`,`_idx`=number を確認。
  - `_rid IS NULL` / `IS NOT NULL` を保存済み id と row.id 欠落（`""`）の双方で確認。
  - 回帰: `_p.$id` / `_p.<親項目>` / 通常子列の WHERE が従来どおり。
  - **`_p._pid` / `_p._rid` / `_p._idx` が `WHERE_FIELD_UNRESOLVED` のまま拒否**（`_pid` 等に誤マッチしない）。
- `explain.test.ts`（押し下げされないことの確定的検証）:
  - `mode: FULL_SCAN` / `reason: WHERE_RESIDUAL`（相当）。
  - kintone query が `(全件取得)`＝**query/pushdown candidate に `_pid`/`_rid`/`_idx` が出ない**。
- CTE/一時表/UNION: `_rid` は `"007" != "7"` の string、`_pid`/`_idx` は number 意味論を維持。特に `WITH x AS (SELECT _idx FROM APP$t) SELECT * FROM x WHERE _idx > 2` で `"10" > "2"` 型の誤判定を防ぐ（(c) の検証）。既存 execute.test.ts:2971-2998 も回帰実行する。
- ORDER BY/GROUP BY: `_idx` の 0,2,10 が数値順、`_rid` が文字列順。`GROUP BY _idx` は既存の生値同値性を維持する。
- 実機 smoke（B42 の証跡様式に追記）: APP4221$テーブル で `WHERE _pid=` / `_rid=` / `_idx=` の SELECT が期待行を返す（回避策 `_p.$id` との一致確認）。

## 5. リリース

- SemVer=**patch** 妥当（既存の受理済み構文が実行前に落ちる不具合と、`systemColumnMeta` の仮想列型不整合の修復）。`_rid` の ORDER/CTE 比較は `recordNumber` から opaque string へ訂正され得るため「意味論変更なし」とは表現しないが、公開契約へ合わせる bug fix と位置づける。
- B44/B45 は同一 `src/execute.ts` を触るが**非重複の関数・実行経路**（B44=APPLY/DML 実行・検証、B45=SELECT resolver）。「完全に別コード」ではないので検証は独立に。
- 判断（codex 推奨）: v3.8.0 が**未凍結**なら独立テストを添えて **同梱可**。**release gate 完了・凍結済み**なら **v3.8.1**。現状 v3.8.0 は「実装中」（ksql_apply_block_spec.md:3・package.json は 3.8.0）＝未凍結。同梱可否はユーザー判断。

## 6. 分担

- 実装=codex／レビュー=Claude（コード裏取り必須）。テストは codex が「修正前 fail・修正後 pass」を示す（[[review-test-gap-division]]）。
- 併せて**言語リファレンス §19 の乖離を解消**（実装が追いつくので文書修正は不要になるが、§19 の例が実動作と一致することをレビューで確認）。
