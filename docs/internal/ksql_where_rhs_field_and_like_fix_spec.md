# 対策 仕様・実装案: WHERE 右辺フィールド比較の破綻 / LIKE の SIMPLE・FULL_SCAN 不一致

- 作成日: 2026-07-14
- 更新履歴:
  - 2026-07-14 R1: 初版(ドラフト)。課題文書 `ksql_where_rhs_field_and_like_mode_divergence_issue.md`(codex 3 巡レビュー確定)を受けて起票
  - 2026-07-14 R2: codex レビュー反映。**S0 等値セマンティクスは案 1 で承認取得**。①DML の LIKE 経路(UPDATE/DELETE が `whereToKintone` 直呼びで誤更新/誤削除しうる)を棚卸しに追加し Phase 1 は fail-closed 化、②`whereToKintone` に中央ガードを追加(DML の fail-closed と SELECT の再流出防止を一体化)、③経路 C の「サイレント破壊」を「包含性未証明ゆえの可能性」へ表現訂正しテストを計画器テストと実 API 再現に区別、`hasWhereFunc` 直接呼び出しを 3 箇所に訂正、`matchLike` 非公開のテスト方針を明記
  - 2026-07-14 R3: codex 再レビュー反映。①**サブテーブル DML は fail-closed 対象外**に訂正(`executeUpdateSubtable`/`executeDeleteSubtable` は全件取得+`evalWhere` の JS 評価経路を持ち `whereToKintone` を通らない)。fail-closed は**通常(親)DML のみ**。サブテーブル DML のワイルドカード LIKE 継続動作の回帰テストを追加。②DML エラー化の **SemVer 整合**を明示: 厳密 SemVer なら v2.0.0、プロジェクト判断で安全修正として v1.14.0 に含めるなら `Breaking` 表記でなく「互換性に影響する安全上の制限」として例外理由を明記(S1 前にメンテナ選択)
  - 2026-07-14 R4: **バージョンを v1.14.0 に確定**(メンテナ決定。新しい非互換仕様の導入でなく誤更新/誤削除経路を止める安全修正のため。CHANGELOG は `Safety`/警告付き `Changed`)。移行方法から「サブテーブル DML の JS 評価経路」を除外し、親 DML の代替でなく「対象がサブテーブルなら従来どおり使用可」の制約説明へ分離。エラーメッセージに安全拒否理由+代替手段を明記。**kintone `like` = 単語検索の相違を言語リファレンス §6 に明記するドキュメントタスク(§3.6)を追加**
  - 2026-07-14 R5: S1〜S8 実装完了。全テスト・全成果物ビルド・v1.14.0 版整合を確認
- ステータス: **実装完了(v1.14.0)**
- 対象バージョン: 現行 v1.13.2 → **v1.14.0 確定**(挙動変更を含むため minor バンプ + CHANGELOG に Safety/移行案内)
- 課題文書: [ksql_where_rhs_field_and_like_mode_divergence_issue.md](ksql_where_rhs_field_and_like_mode_divergence_issue.md)
- 関連ドキュメント: [docs/ksql_language_reference.md §6](../ksql_language_reference.md#L595)(LIKE / 比較)、[docs/perf-where-pushdown-join.md](../perf-where-pushdown-join.md)(JOIN WHERE 押し下げ)

---

## 1. 背景・目的

課題文書で確定した 2 バグを修正する。

- **①** WHERE 右辺にフィールド/文字列関数を置くと、右辺だけが `Number()` 強制されて文字列比較が壊れる(数値化不能な一般文字列・非正準な数値文字列で `=`→不一致 / `!=`→一致)。
- **②** 同じ LIKE が SIMPLE(kintone 送出)と FULL_SCAN(JS 評価)で異なる結果になる。`%`/`_` を含むパターンで顕在化し、JOIN・DISTINCT・関数等でモードが切り替わると同一 SQL の結果が変わる。

**設計原則(課題文書 §共通の根本テーマ)**:
1. (①)AST の値表現と評価器の型ドメインを SQL 意味論に合わせる。右辺も左辺と同じ文字列ドメインで解決する。
2. (②)実行モードが結果集合を変えない。kintone へ push する述語は「JS 評価と一致することが保証できる範囲」に限定する。

本対策は両方とも**最小で安全な修正(Phase 1)を確定**させ、性能最適化(Phase 2)は安全性が証明できるまで将来課題として分離する。

---

## 2. 対策①: 右辺フィールド/文字列関数の文字列比較

### 2.1 方針(案 B: 評価器の局所修正を採用)

課題文書 §修正方針の案 A(専用 RHS 型の新設)・案 B(`resolveValue` 局所修正)のうち、**案 B を Phase 1 として採用**する。

- 変更は `resolveValue`(`src/engine/evalWhere.ts`)の `ARITH_VALUE` 分岐 1 箇所に閉じる。
- 右辺 AST の型・パーサ・`whereToKintone`・`hasWhereFunc` は変更しない。右辺の裸フィールドは従来どおり `ARITH_VALUE` のまま構文解析され、`hasWhereFunc` により **FULL_SCAN へ正しくルーティングされ続ける**(kintone はフィールド同士比較を表現できないため、この routing は正しい)。`whereToKintone` の `ARITH_VALUE`→例外([whereToKintone.ts:179-180](../../src/converter/whereToKintone.ts#L179-L180))も維持。
- 案 A(左辺 `FieldValue` と対称な専用 RHS 型の導入)は構造的に綺麗だが、`SqlValue` union・パーサ・`convertValue`・`hasWhereFunc`・`resolveValue` に波及するため、**将来のリファクタ**として §7 に残す。

### 2.2 実装

`resolveValue`([src/engine/evalWhere.ts:174-187](../../src/engine/evalWhere.ts#L174-L187))の `ARITH_VALUE` 分岐を、式が**単一フィールド参照 / 単一文字列関数のときは数値化せず文字列解決**するよう分岐する。

```ts
// resolveValue 内
case "ARITH_VALUE":
  // 右辺が単一フィールド参照 / 単一文字列関数のときは、左辺(resolveField)と
  // 同じく文字列ドメインで解決する。Number() 強制で "NaN" 化する不具合(課題①)を回避。
  if (value.expr.type === "FIELD_REF")   return resolveFieldRef(row, value.expr.field);
  if (value.expr.type === "STRING_FUNC") return evalStringFunc(value.expr, row);
  // 真の算術式(演算子を含む: 金額 * 1.1 など)は従来どおり数値評価。
  return String(evalArithExpr(value.expr, row));
```

- `ArithNode` の型は `NUMBER` / `FIELD_REF` / `STRING_FUNC` / 二項(op を持つ)([evalFunc.ts:19-32](../../src/engine/evalFunc.ts#L19-L32))。単一フィールド → `FIELD_REF`、単一関数 → `STRING_FUNC`、演算子付き → 二項。純粋な数値リテラルはパーサが `NUMBER`(`ARITH_VALUE` にならない)へ畳む([parser.ts:1550-1552](../../src/parser/parser.ts#L1550-L1552))ため `ARITH_VALUE` には来ない。
- `evalStringFunc` は `LENGTH` 等の数値系関数も**文字列**(`"5"`)で返す([evalFunc.ts:57-145](../../src/engine/evalFunc.ts#L57-L145))ため、`=`/`!=` の文字列比較で正しく機能する。`>` 等は下記のとおり `evalOp` 側で数値化されるので問題ない。

### 2.3 等値比較セマンティクスの決定(**S0 = 案 1 で承認済み**)

> **確定(2026-07-14 codex 承認)**: 下記 **案 1(`=`/`!=` は文字列比較のまま)** を採用する。①を最小範囲で直し、既存の比較実装を維持でき、型情報なしで `"007"` と `"7"` を誤って同一視しないため。以降の実装・テストは案 1 前提。案 2 と将来の型対応比較は参考として残す。


課題文書が明示した「`"01" = "1"` を等値とみなすか」の決定。現行 `evalOp`([evalWhere.ts:114-127](../../src/engine/evalWhere.ts#L114-L127))は `>` / `<` / `>=` / `<=` のみ「両辺が数値化可能なら数値比較」で、`=` / `!=` は**常に文字列一致**。

| 案 | `=`/`!=` の比較 | `文字列=文字列`(非数値) | `金額=金額`(正準数値) | `"1.5"` vs `"1.50"`(別フィールド) | `"007"` vs `"7"`(コード) | evalOp 変更 |
|----|----------------|--------------------------|------------------------|-----------------------------------|--------------------------|-------------|
| **案 1(推奨)** 文字列比較のまま | 文字列一致 | ✅ 一致 | ✅ 一致 | 不一致(文字列として別物) | 不一致(別コードとして保持) | **なし**(2.2 のみ) |
| 案 2 数値対応 `=` | 両辺数値化可能なら数値、不能なら文字列 | ✅ 一致 | ✅ 一致 | 一致(数値 1.5) | **一致してしまう**(数値 7) | `=`/`!=` を numeric-aware に変更 |

**推奨は案 1(文字列比較のまま)。** 理由:
- ①の修正は「右辺を文字列で解決する」(2.2)だけで完結し、`evalOp` を触らないため**回帰面が最小**。
- 左辺(`resolveField`)と IS NULL(`= ""`)は既に文字列前提。案 1 はこれと一貫。
- 郵便番号・商品コード等の「数値に見える文字列」を別物として保持できる(案 2 は `"007"` と `"7"` を同一化する副作用)。
- 現行の RHS 数値正規化は「右辺だけ `Number()`・左辺は生」という**非対称でフォーマット依存の未定義挙動**(課題文書 §原因)。案 1 はこれを対称・予測可能にするだけで、明確な既存仕様を壊すわけではない。

案 2 は「`>` が数値対応なのに `=` が文字列」という非対称の解消というメリットがあるが、コード同一視の副作用と evalOp 変更の回帰を伴うため不採用(上記のとおり案 1 で承認済み)。**フィールド型(number/text)を評価器へ渡す型対応比較**が理想だが、`ProcessRow` が型情報を持たない現構造では大改修になるため §7 の将来課題とする。

### 2.4 影響・後方互換

- **挙動が変わるのは「右辺が非数値 / 非正準数値の文字列フィールド・文字列関数」の比較のみ**。従来 `"NaN"` 化して壊れていたものが正しくなる(純粋なバグ修正)。
- 正準な数値フィールド同士(`金額 = 金額` 等)は案 1 で従来どおり一致 — 回帰なし。
- 右辺が真の算術式(`税込 = 金額 * 1.1`)は `String(evalArithExpr(...))` 経路のまま変更なし。
- ルーティング(FULL_SCAN 化)は不変。SIMPLE で kintone に渡ることはない。

### 2.5 テスト観点(修正前 fail → 修正後 pass を示す)

- `文字列 = 文字列`(自己一致, 非数値値)→ 一致 / `!=` → 不一致 ★修正前 fail
- 右辺非正準数値: 左 `"01"` vs 右 `"01"`(自己)→ 一致 ★修正前 fail(右辺が `"1"` 化)
- `金額 = 金額`(正準数値)→ 一致(**回帰防止**)
- JOIN 文字列突き合わせ `cb.担当者 != cm.担当者_コンサル` — 完全一致行が正しく除外される ★修正前 fail
- 右辺文字列関数 `略称 = REPLACE(正式名, '株式会社', '')` の一致/不一致 ★修正前 fail
- 右辺算術式 `税込 = 金額 * 1.1` が数値比較のまま(**回帰防止**)
- 右辺 `LENGTH(x)` 等の数値系関数比較が `>` / `=` で妥当(**回帰防止**)

---

## 3. 対策②: LIKE の SIMPLE / FULL_SCAN 一貫化

### 3.1 方針(A-a: ワイルドカード付き LIKE は kintone へ push しない)

課題文書の推奨どおり **A-a を Phase 1 として採用**する。不変条件は「**`%`/`_` を含む LIKE / NOT LIKE は、いかなる経路でも kintone クエリに変換しない**」。SELECT は必ず全件(または他条件で絞った集合)を取得して JS の `matchLike`([evalWhere.ts:242-269](../../src/engine/evalWhere.ts#L242-L269))が言語仕様(§6)どおり評価する。DML は経路により扱いが異なる(§3.2 経路 D):
- **通常(親レコード)UPDATE/DELETE**: WHERE を `whereToKintone` で kintone クエリに変換して対象 `$id` を GET する。**JS 評価経路を持たない**ため **fail-closed(明示エラー)** で誤操作を防ぐ。
- **サブテーブル UPDATE/DELETE**: 別経路(`executeUpdateSubtable`/`executeDeleteSubtable`)で親を全件取得し `evalWhere` で JS 評価する([execute.ts:2297-2305](../../src/execute.ts#L2297-L2305), [:2363-2371](../../src/execute.ts#L2363-L2371))。`whereToKintone` を通らないため、ワイルドカード LIKE を**正しく JS 評価でき、fail-closed の対象外**(SELECT の FULL_SCAN と同じ扱い)。

A-b(kintone `like` で粗くプレフィルタ → JS 厳密判定)は、kintone の**単語検索が JS 候補集合を包含する保証がなく**(取りこぼし=偽陰性は後段で復元不能)、証明できるまで採らない(課題文書 §未証明の安全性)。

**不変条件の担保は二段構え**にする。(i) 各計画器がワイルドカード LIKE を FULL_SCAN / 非押し下げへ正しくルーティングする。(ii) それでも変換器に到達したら `whereToKintone` が**中央ガードで例外**を投げる(§3.3(1))。(ii) により、将来追加される呼び出し経路からの再流出も防げ、DML は (ii) だけで自動的に fail-closed になる。

### 3.2 変換経路の棚卸し(**SELECT 3 経路 + DML**)

ワイルドカード LIKE が kintone に漏れる経路は SELECT の 3 つ(A/B/C)に加え、**DML(UPDATE/DELETE)の対象 ID 決定(D)** がある。全経路に同一の除外/拒否条件を適用する。

| # | 経路 | 現状 | 対処 |
|---|------|------|------|
| A | 単一テーブル SELECT SIMPLE: `resolveSelectMode`→`selectToKintoneParams` | ワイルドカード LIKE でも SIMPLE のまま kintone へ生パターン送出 | `hasWhereFunc` 相当のゲートにワイルドカード LIKE を加え **FULL_SCAN 化** |
| B | 単一テーブル SELECT FULL_SCAN: `selectToFetchAllParams`([selectToKintone.ts:161](../../src/converter/selectToKintone.ts#L161)) | `!hasWhereFunc` なら WHERE 全体を kintone へ push | 同じゲートを通すことで **WHERE を push しない**(全件取得 → JS フィルタ) |
| C | JOIN 押し下げ: `extractTableCondition`→`isPushDownableRight`([wherePredicatePushdown.ts:51-61](../../src/core/optimization/wherePredicatePushdown.ts#L51-L61)) | LIKE の右辺 `STRING` を push 可能と判定し `whereToKintone` で kintone へ | `isPushDownableRight`(または LIKE 判定箇所)で**ワイルドカード LIKE を push 不可**にする |
| **D** | **通常(親)DML の対象 ID 決定: `updateToGetQuery`/`updateToGetQueryForArith`/`deleteToGetQuery`([dmlToKintone.ts:130](../../src/converter/dmlToKintone.ts#L130), [:186](../../src/converter/dmlToKintone.ts#L186), [:353](../../src/converter/dmlToKintone.ts#L353))** | WHERE を **`whereToKintone` へ直接**渡し、その結果で `$id` を GET → 更新/削除。ワイルドカード LIKE も生パターンで送出(既存テスト [dmlToKintone.test.ts:146](../../src/converter/__tests__/dmlToKintone.test.ts#L146) が `件名 like "%報告%"` を確認) | **Phase 1 は fail-closed**: 通常 DML の WHERE にワイルドカード LIKE があれば `DmlConvertError` で明示的に拒否(中央ガード §3.3(1) でも担保)。JS 評価による対象 ID 確定は Phase 2 |
| — | **サブテーブル UPDATE/DELETE: `executeUpdateSubtable`/`executeDeleteSubtable`([execute.ts:2297-2305](../../src/execute.ts#L2297-L2305), [:2363-2371](../../src/execute.ts#L2363-L2371))** | 親を全件取得(query `""`)→ 展開 → `evalWhere` で JS 評価して対象確定。`whereToKintone` を**通らない** | **対処不要(許可)**。ワイルドカード LIKE を正しく JS 評価する。回帰テストで「継続動作・中央ガード非影響」を固定 |

> **経路 D(通常 DML)は最も重大**: SELECT の A/B は「結果がモード依存で変わる」不一致、C は「JOIN 結果が欠落しうる」だが、通常 DML は**誤ったレコードを更新・削除**する。取得結果をそのまま破壊的操作の対象にするため復元も効かない。例:
> ```sql
> UPDATE APP100 SET 状態 = '対象' WHERE 件名 LIKE '報告%'   -- kintone 意味論で対象決定 → 誤更新の恐れ
> DELETE FROM APP100 WHERE 件名 LIKE '一時%'                 -- 同上 → 誤削除の恐れ
> ```
> 通常 DML は既に WHERE の関数(`FUNC_FIELD`)等を `whereToKintone` の例外で拒否している(JS 評価経路を持たない)。ワイルドカード LIKE も同様に拒否するのが既存設計と一貫し、サイレントな誤操作より安全。**サブテーブル DML はこの限りでない**(上表の「—」行。JS 評価経路があるため許可)。

### 3.3 実装

#### (1) 共有ヘルパ + `whereToKintone` 中央ガード

`matchLike` 内の判定([evalWhere.ts:245](../../src/engine/evalWhere.ts#L245))と同一ロジックを 1 箇所に集約し、ドリフトを防ぐ。

```ts
// 例: src/core/sql.ts など共通モジュール、または converter 内の非公開ヘルパ
export function likePatternHasWildcard(pattern: string): boolean {
  return pattern.includes("%") || pattern.includes("_");
}

// BINARY が「ワイルドカード付き LIKE / NOT LIKE」か
export function isWildcardLike(where: WhereExpr): boolean {
  return where.type === "BINARY"
    && (where.op === "LIKE" || where.op === "NOT_LIKE")
    && where.right.type === "STRING"
    && likePatternHasWildcard(where.right.value);
}
```

- LIKE の右辺は文字列リテラル(`STRING`)が通常([parser.ts:1374-1376, 1393-1395](../../src/parser/parser.ts#L1374-L1376))。右辺がフィールド等(`ARITH_VALUE`)の LIKE は既に `hasWhereFunc` で FULL_SCAN 化されるため二重に安全。
- `matchLike` の内部判定も `likePatternHasWildcard` を使うよう置換し、判定の単一情報源にする。
- `likePatternHasWildcard` / `isWildcardLike` は**エクスポートしてテスト可能**にする(下記 `matchLike` が非公開のため、ワイルドカード判定はこのヘルパ単体でも回帰を張れるようにする)。

**中央ガード**: `whereToKintone` の `convertBinary`([whereToKintone.ts:57-62](../../src/converter/whereToKintone.ts#L57-L62))で、ワイルドカード LIKE の変換要求が来たら例外を投げる。これが不変条件「いかなる経路でも kintone へ変換しない」の最終防壁になり、DML(経路 D)の fail-closed もここで自動的に成立する。

```ts
function convertBinary(expr: BinaryExpr): string {
  if (isWildcardLike(expr)) {
    throw new KintoneQueryError(
      "ワイルドカード（% / _）付きの LIKE は kintone クエリに変換できません（JS 評価が必要です）"
    );
  }
  // ...既存の変換
}
```

- SELECT 経路(A/B/C)は「そもそも `whereToKintone` にワイルドカード LIKE を渡さない」ルーティングが本線。中央ガードは、計画器の見落としや将来の新経路で**サイレントに漏れる代わりに大きく落ちる**ための保険(fail-loud)。
- 通常 DML(経路 D)は `whereToKintone` 直呼びのため、このガードで拒否される。ただしメッセージを DML 文脈にするため、§3.3(4) のとおり DML 側でも事前チェックして `DmlConvertError` を投げる(ガードは二重の保険)。
- **サブテーブル DML は `whereToKintone` を通らない**(全件取得 + `evalWhere`)ため中央ガードの影響を受けず、ワイルドカード LIKE を継続して JS 評価する。回帰テスト(§3.7)で保証。

#### (2) 経路 A / B: FULL_SCAN ゲートへ組み込み

`hasWhereFunc`(役割は「kintone に push できない WHERE を含むか」)へワイルドカード LIKE を再帰的に加える。名称が実態から乖離するため、**`whereRequiresJsEval`(または `hasNonPushableWhere`)へリネーム**し、既存の関数検出 + ワイルドカード LIKE を OR する。

```ts
export function whereRequiresJsEval(where: WhereExpr | null): boolean {
  if (where === null) return false;
  switch (where.type) {
    case "BINARY":
      return isFunc(where.left)
        || where.right.type === "ARITH_VALUE"
        || where.right.type === "CASE_VALUE"
        || where.right.type === "SUBQUERY_IN_LIST"
        || where.right.type === "SCALAR_SUBQUERY"
        || isWildcardLike(where);            // ← 追加
    case "NULL_CHECK": return isFunc(where.field);
    case "LOGICAL":    return whereRequiresJsEval(where.left) || whereRequiresJsEval(where.right);
    case "NOT":
    case "GROUP":      return whereRequiresJsEval(where.expr);
    case "EXISTS":     return true;
  }
}
```

`hasWhereFunc` の**直接呼び出しは 3 箇所**: `resolveSelectMode`([selectToKintone.ts:71](../../src/converter/selectToKintone.ts#L71))、`selectToFetchAllParams`([:161](../../src/converter/selectToKintone.ts#L161))、`collectFullScanReasons`([execute.ts:3159](../../src/execute.ts#L3159) の EXPLAIN 理由列挙)。これらをリネーム後の関数へ差し替える。EXPLAIN の理由文言は「WHERE 句に JS 評価が必要な式(関数・右辺式・ワイルドカード LIKE)」へ更新。

> `execute.ts:1212`(`canInlineSingleCte`)は `resolveSelectMode` を呼ぶだけで `hasWhereFunc` の直接呼び出しではない。ただし `resolveSelectMode` が FULL_SCAN を返すようになる分、**CTE のインライン判定([:1212](../../src/execute.ts#L1212))に挙動波及**する(ワイルドカード LIKE を含む CTE が SIMPLE 扱いされなくなる)。回帰テストで確認する。

#### (3) 経路 C: JOIN 押し下げから除外

`extractTableCondition` の `BINARY` 分岐([wherePredicatePushdown.ts:15-18](../../src/core/optimization/wherePredicatePushdown.ts#L15-L18))で、ワイルドカード LIKE を push 対象から外す。`referencesOnlyTable`([:66-67](../../src/core/optimization/wherePredicatePushdown.ts#L66-L67))も同様に false を返させる。

```ts
case "BINARY":
  if (isWildcardLike(where)) return null;               // ← 追加: 偽陰性防止
  if (!isSingleTableField(where.left, tableAlias)) return null;
  if (!isPushDownableRight(where.right)) return null;
  return where;
```

`AND` 分解([:24-30](../../src/core/optimization/wherePredicatePushdown.ts#L24-L30))は既に「片方だけ push・残りは JS」を行うため、`WHERE 他条件 AND 文字列 LIKE 'X%'` では他条件のみ kintone へ、LIKE は JS へ、という**安全な分割が自動的に成立**する(経路 C は Phase 2 の一部を既に備えている)。

> **経路 C 除外の根拠(表現の精度)**: 現状で「JOIN 結果が必ずサイレントに壊れる」ことが実 API で確認されているわけではない。確認済みなのは **kintone 検索が JS 候補集合を包含する保証がない**ことであり、そのため**偽陰性で JOIN 結果を静かに壊す可能性がある**。安全性を証明できない以上、Phase 1 では push 対象から除外する、という位置づけ。§3.7 の修正前 fail テストも「現行では危険な述語(ワイルドカード LIKE)が push 抽出される」という**計画器テスト**であり、「実際に JOIN 結果が欠落する」実 API 再現テストとは区別する(後者は実 API 検証タスク §3.5 側)。

#### (4) 経路 D: 通常(親)DML の fail-closed

**この対処は通常 DML の 3 変換関数のみに入れる。サブテーブル DML(`executeUpdateSubtable`/`executeDeleteSubtable`)はこれらを呼ばず全件取得 + `evalWhere` 経路のため、事前チェックを通らず引き続きワイルドカード LIKE を JS 評価する(意図どおり・許可)。**

`updateToGetQuery` / `updateToGetQueryForArith` / `deleteToGetQuery`([dmlToKintone.ts:130](../../src/converter/dmlToKintone.ts#L130), [:186](../../src/converter/dmlToKintone.ts#L186), [:353](../../src/converter/dmlToKintone.ts#L353))で、`whereToKintone(stmt.where)` を呼ぶ前に WHERE 全体を走査し、ワイルドカード LIKE を含むなら `DmlConvertError`(DML 変換の既存エラー型)で拒否する。

```ts
// 各 DML→GET 変換の冒頭
if (whereHasWildcardLike(stmt.where)) {
  throw new DmlConvertError(
    "UPDATE / DELETE の WHERE にワイルドカード（% / _）付き LIKE は使用できません。" +
    "kintone の like は SQL のワイルドカードと異なる単語検索のため、" +
    "対象レコードを誤って選択し誤更新・誤削除する恐れがあり、安全のため拒否しました。" +
    "先に SELECT で対象のレコード番号を確認し、IN または完全一致条件で UPDATE / DELETE してください。"
  );
}
```

- `whereHasWildcardLike` は WHERE ツリーを再帰走査して `isWildcardLike` を検出する述語(`whereRequiresJsEval` から LIKE 判定のみ切り出す形でも可)。
- 中央ガード §3.3(1) だけでも `whereToKintone` が例外を投げて破壊操作は防げるが、DML 側で事前チェックすることで **DML 文脈の分かりやすいメッセージ**を返す。ガードは二重の保険。
- **既存テスト [dmlToKintone.test.ts:146](../../src/converter/__tests__/dmlToKintone.test.ts#L146)** は「ワイルドカード LIKE が `件名 like "%報告%"` に変換される」ことを期待しているため、**エラーを期待する形に更新**する(旧挙動が誤操作源だったことをコメントで残す)。非ワイルドカードの DML LIKE テストがあれば従来どおり通す。
- Phase 2: DML でも候補を JS 評価して対象 `$id` を確定する経路を用意すれば、fail-closed を許容に緩められる(スコープ外)。

### 3.4 既知のコストと Phase 2(将来最適化)

- **コスト**: 前方一致 `LIKE '受注%'` のような最頻ケースを含め、単一テーブルのワイルドカード LIKE は**全件取得**になる(経路 A/B)。他に絞り込み条件がなければ取得量が増える。これは A-a の正しさと引き換えの既知コスト。
- **Phase 2(安全な部分押し下げ)**: 単一テーブルでも `selectToFetchAllParams` に AND 分割を導入し、`extractTableCondition` 同様に**証明可能に厳密な述語(`=` / `!=` / `IN` / 範囲 / `IS NULL`)だけを kintone へ push**、ワイルドカード LIKE は JS 評価に残す。LIKE の近似は一切 push しないため偽陰性は出ない。JOIN 経路 C の分割ロジックを単一テーブルへ横展開する形。
- **A-b(kintone プレフィルタ)** は、kintone 単語検索の**包含性が実 API で証明できた場合のみ**の別課題(課題文書 §未確認/追加調査事項)。現時点では採らない。

### 3.5 非ワイルドカード LIKE の扱い(要追加調査)

`LIKE '会社'`(ワイルドカードなし=部分一致)は現状どの経路でも kintone へ push される。FULL_SCAN 側は `String.includes`、kintone は**単語検索**で厳密同義とは限らない(課題文書 §未確認事項)。Phase 1 では**現状維持**とし、以下を別タスクで実 API 検証する。検証で乖離が判明した場合は非ワイルドカード LIKE も push 除外へ倒す(保守側)。

- トークン分割境界・部分語一致・使用不可記号・全半角/かな正規化・10 万件打ち切り

### 3.6 kintone `like` = 単語検索の相違をドキュメントに明記(ユーザー向け)

本対策で「ワイルドカード LIKE は JS 評価/通常 DML では拒否」となる根拠は、**kintone REST API の `like` が SQL のワイルドカード一致でも単純な部分文字列一致でもなく、単語(トークン)単位の検索**だからである([kintone REST API 仕様](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/))。この差異を利用者が把握できるよう、言語リファレンス [§6](../ksql_language_reference.md#L595) を更新する(S7)。明記する内容:

- **LIKE の評価主体**: ワイルドカード(`%`/`_`)を含む LIKE は本ツールが**JS 側(`matchLike`)で §6 のワイルドカード意味論どおり**評価する(kintone へは送らない)。SELECT はモードに依らず一貫、通常 DML はワイルドカード LIKE を**エラー**にする(サブテーブル DML は JS 評価で使用可)。
- **kintone `like` との相違**: kintone API の `like` は**単語検索**であり、SQL の前方/後方/部分一致や JS の部分文字列一致とは一致しないことがある(トークン分割・部分語・記号・全半角/かな正規化・10 万件打ち切り)。ワイルドカードなし LIKE は現状 kintone へ委譲するため、この相違の影響を受けうる(§3.5、実 API 検証は別タスク)。
- **推奨**: 厳密な部分一致が必要な場合はワイルドカードを明示(`'%会社%'`)して JS 評価に載せる、を案内。

### 3.7 テスト観点(A-a 前提に分割)

- **ルーティング**: ワイルドカード付き LIKE(`'すと%'` / `'%と%'` / `'A__'`)が
  - 単一テーブルで `resolveSelectMode` → FULL_SCAN(経路 A)★修正前 fail
  - `selectToFetchAllParams` の生成クエリに LIKE が**含まれない**(経路 B)★修正前 fail
  - `extractTableCondition` がワイルドカード LIKE に `null` を返す(経路 C)★修正前 fail
- **AND 分割**: `WHERE ステータス = '完了' AND 文字列 LIKE 'すと%'` で、kintone へは `ステータス = "完了"` のみ push・LIKE は JS(経路 C、及び Phase 2 導入時の経路 B)
- **評価**: `matchLike` が §6 どおり(前方 `'田%'` / 後方 `'%田'` / 中間 `'%田%'` / 単一 `'A__'`)。`matchLike` は**非公開関数**のため、`evalWhere` / `applyFilter` 経由でテストする(またはワイルドカード判定は公開ヘルパ `likePatternHasWildcard` 単体で張る)。
- **中央ガード**: `whereToKintone` にワイルドカード LIKE を直接渡すと `KintoneQueryError` を投げる(計画器を迂回した流出の保険)★修正前 fail(現状は変換して返す)
- **通常 DML fail-closed(経路 D)**: `UPDATE ... WHERE 件名 LIKE '報告%'` / `DELETE ... WHERE 件名 LIKE '一時%'`(**親レコード**)が `DmlConvertError` で拒否される ★既存テスト([dmlToKintone.test.ts:146](../../src/converter/__tests__/dmlToKintone.test.ts#L146))を「変換成功」→「エラー」に更新。非ワイルドカードの DML LIKE(あれば)は従来どおり通す(回帰防止)
- **サブテーブル DML はワイルドカード LIKE 許可(回帰防止)**: サブテーブル `UPDATE/DELETE ... WHERE <subtable>.項目 LIKE '%X%' AND ... _rid ...` が `evalWhere` で正しく対象を選び、**エラーにならず**継続動作する(中央ガード非影響の確認)。`executeUpdateSubtable`/`executeDeleteSubtable` 経路のテスト
- **経路 C は計画器テスト**: `extractTableCondition` がワイルドカード LIKE に `null` を返すことを検証する(「危険な述語が push 抽出されない」の確認)。実 API での JOIN 結果欠落再現は別タスク(§3.5)であり本テストの対象外
- **非ワイルドカード回帰**: `LIKE '会社'` が従来どおり部分一致(Phase 1 では push 維持)
- **モード非依存**: 同一 SQL にモード切替トリガ(JOIN/DISTINCT/関数)を足しても LIKE 結果集合が不変
- **NOT LIKE**: 上記各観点の否定形

---

## 4. バージョン / リリース方針

- **バージョン: v1.14.0(確定・2026-07-14 メンテナ決定)**。通常 DML のワイルドカード LIKE エラー化は厳密 SemVer では major(v2.0.0)相当だが、**新しい非互換仕様の導入ではなく、SQL 仕様と異なる条件で誤更新・誤削除し得る経路を停止する安全修正**であり、変更範囲も限定的で既存の minor 運用と整合するため v1.14.0 に含める(v2.0.0 は影響に対して過大)。過去に既定挙動を変える修正を minor に載せた前例(v1.12.0 の非グループ集計 0 件時 1 行返却)とも整合。
- **CHANGELOG**:
  - 分類は **`Safety`(または目立つ警告付きの `Changed`)**。`Breaking` 表記は使わない。
  - 「**通常(親)DML のワイルドカード（% / _）付き LIKE はエラーになる**」と明記。
  - 移行方法: **SELECT で対象 `$id`（レコード番号）を確認し、`IN` または完全一致条件で UPDATE/DELETE する**。
  - **制約説明(移行方法とは分けて記載)**: 対象がサブテーブルの UPDATE/DELETE は JS 評価経路のため**従来どおりワイルドカード LIKE を使用可能**。これは通常の親レコード DML の代替にはならない(別機能)ので、一般的な回避策としては案内しない。
  - ①の誤結果修正は **Fixed**、②SELECT のルーティング変更(**前方一致含むワイルドカード LIKE が FULL_SCAN=全件取得になる性能影響**)は **Changed** に併記。
- **エラーメッセージ**(§3.3(4))には、(a) 安全上の理由で拒否したこと、(b) 代替手段(SELECT で対象確認 → `IN`/完全一致で DML)を含める。
- プラグイン(`prod/js/desktop.js`)は EXPLAIN/実行エンジンをバンドルするため、修正後は**全成果物の再ビルド**が必要(論理アプリ対応リリースの教訓と同様)。EXPLAIN 理由文言の変更も波及する。
- リリース手順は既存慣例(bump → 全成果物再ビルド → verify → バージョン整合確認 → release/ 差し替え → npm publish はユーザー操作)。

## 5. 実装ステップと依存

| ステップ | 内容 | 依存 |
|---|---|---|
| S0 | §2.3 等値セマンティクス確定 | **完了(案 1 承認)** |
| S1 | 対策① `resolveValue` 修正 + evalWhere 単体テスト(§2.5) | S0 |
| S2 | 対策② 共有ヘルパ `likePatternHasWildcard` / `isWildcardLike` エクスポート + `matchLike` 内判定の置換 + `whereToKintone` 中央ガード(§3.3(1)) | なし |
| S3 | 対策② 経路 A/B: `hasWhereFunc`→`whereRequiresJsEval` リネーム + ワイルドカード LIKE 追加、**直接呼び出し 3 箇所**差し替え、EXPLAIN 文言更新 | S2 |
| S4 | 対策② 経路 C: `extractTableCondition` / `referencesOnlyTable` の除外 | S2 |
| S5 | 対策② 経路 D: **通常 DML** 3 変換関数の fail-closed + 既存 DML LIKE テスト更新(§3.3(4))。**サブテーブル DML は変更せず**継続動作の回帰テストを追加 | S2 |
| S6 | 変換・実行・EXPLAIN・DML(通常/サブテーブル)の回帰テスト(§3.7)+ 既存テスト更新 | S1・S3・S4・S5 |
| S7 | ドキュメント更新: 言語リファレンス §6 に **LIKE の実行モード / kintone `like`=単語検索の相違(§3.6)/ 通常 DML のワイルドカード LIKE 制約** を明記、CHANGELOG(Safety/移行案内) | S1〜S6 確定後 |
| S8 | 検証・全成果物ビルド・リリース準備 | S1〜S7 |

実装順 S0(済) → (S1) / (S2→{S3, S4, S5}) 並行可 → S6 → S7 → S8。各ステップ「テスト通過 → コミット」。推奨ブランチ `fix/where-rhs-field-and-like-mode`(単一 PR)。

## 6. リスク・未決事項

- **(未決・別タスク)** §3.5 非ワイルドカード LIKE と kintone 単語検索の同義性は実 API 検証が必要。乖離があれば非ワイルドカード LIKE も push 除外へ(保守側)。
  - **(決定済み)** §4 のとおり、安全修正として v1.14.0 に含める。
- **(挙動変更・要告知)** 経路 D の fail-closed により、**通常(親)DML** の `UPDATE/DELETE ... WHERE ... LIKE '…%'` がエラーになる(従来は実行できたが kintone 意味論で誤操作の恐れがあった)。CHANGELOG に明記し回避策(完全一致・IN・範囲での対象指定、または SELECT で対象確認)を案内。**サブテーブル DML は対象外**(JS 評価経路があるため継続動作)。
- **(性能)** §3.4 のとおり前方一致 LIKE の全件取得コスト。Phase 2(単一テーブル AND 分割)で緩和可能だが本 PR スコープ外。
- **(波及)** `hasWhereFunc` リネームは EXPLAIN 出力・CTE インライン判定([execute.ts:1212](../../src/execute.ts#L1212))にも波及。文言差分はプラグインバンドルにも波及するため再ビルド必須。

## 7. スコープ外(将来課題)

- 対策① 案 A(左辺 `FieldValue` と対称な専用 RHS 型の新設)への構造的リファクタ。
- フィールド型(number/text)を評価器へ渡す**型対応比較**(`ProcessRow` への型情報付与)。§2.3 の等値/大小比較を型で厳密化できる。
- 対策② A-b(kintone 単語検索によるプレフィルタ)および単一テーブル Phase 2 部分押し下げ。
- §3.5 の kintone 検索意味論(トークン・記号・正規化・件数上限)の網羅的整合。
