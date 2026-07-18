# B3 v1 — 配列バッチ変数と `IN @list` 展開 仕様

- 作成日: 2026-07-19
- ステータス: **仕様 R1・codex レビュー済（要 R2・実装着手は R2 確定後）**。判定＝基本方針（文ごと実行前展開・通常 `InList` 再利用・literal IN の評価/押し下げ継承）は妥当。ただし R2 で 6 点の確定が要る＝①**空配列の親aware boolean簡約**（既存に定数述語経路なし）②**親DMLの `NOT IN []` 安全契約**（全件更新/削除の迂回）③**EXPLAIN での配列SET評価**④**validate-all-first の静的 array/scalar 型検査**（v1 は全件静的に決まる）⑤**WHERE以外の条件位置**（HAVING/CASE/CHECK WHEN/サブクエリ）の対象範囲⑥**IN上限は「分割なし・API依存」と明記**。工数 3.5〜6.5人日（B41 の0.7〜0.8倍・B41より軽い結論は維持）。詳細は §11。台帳 B3（優先低・棚上げ）の実装着手判断用。
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B3
- 前提: [バッチ変数 Phase 1a](ksql_batch_variables_phase1a_spec.md)（§6 に本構文の推奨案）・[Phase 1b](ksql_batch_variables_phase1b_spec.md)
- 関連: [B15 IN 負数リテラル](ksql_in_list_negative_number_issue.md)・[選択系 IN 押し下げ](ksql_selection_in_pushdown_spec.md)

## 1. 目的・スコープ

1 つのバッチ変数に**複数値（配列）**を持たせ、`WHERE k IN @list` で要素へ展開する。現状は「各要素が独立スカラー変数」の `IN (@a, @b)`（R4・v2.1.0）しか無く、**1 変数＝複数値**を表現できない（`SET @l = (...)` は ParseError＝実機確認済み）。

- **対象（v1）**：①**配列リテラル代入** `SET @l = ['A', 'B', 'C']`（既存 `ArrayLiteral` を再利用）②**展開参照** `WHERE k IN @l` / `NOT IN @l`（カッコ無し）。
- **対象外（後続）**：**サブクエリからの配列代入** `SET @l = (SELECT code FROM #t)`（Phase 1b 連携・本命だが別スコープ・§9）／裸の数値配列 `[1, 2]`（現状 `ArrayLiteral` は STRING 限定・§3.4）／`IN (@l)`（カッコ付き）での展開（曖昧なので採らない・§2.3）／再代入・SELECT 句・LIMIT 等での配列参照。

### 1.1 価値の正直な位置づけ（優先低の理由）
v1 は**リテラル配列**のみ＝`SET @l=['A','B']; … IN @l` は `… IN ('A','B')` を直接書くのとほぼ等価で、利点は「1 変数を複数文で使い回す DRY」に留まる。**動的リスト（上流結果）の持ち回りという本来の主用途は Phase 1b（サブクエリ→配列）が要る**うえ、それも**一時テーブル＋`IN (SELECT …)` / `UPDATE … FROM` で既に代替可能**（Oracle/SQL Server の unnest と同型）。よって B3 は「不能→可能」ではなく**記述簡潔化**の機能であり、優先低が妥当。本仕様は着手時に構文と実装差分を確定しておくためのもの。

## 2. 構文

### 2.1 定義（配列リテラル代入・既存構文の再利用）
```sql
SET @l = ['A', 'B', 'C'];        -- 角括弧＝既存 ArrayLiteral（STRING 要素）
SET @empty = [];                 -- 空配列（§3.3）
```
- `[...]` は既に kSQL の配列リテラル（`ArrayLiteral`・[ast.ts:479](../../src/types/ast.ts)）で、複数値フィールド（CHECK_BOX / MULTI_SELECT / USER_SELECT）の書込み値に使用中（`SET タグ = ['重要','VIP']` 等）。**新しいリテラル文法を足さない**。
- 要素は現状 **STRING 限定**。数値は `['1', '2']`（文字列表記）で書く。裸 `[1, 2]` は §3.4。

### 2.2 参照（カッコ無し `IN @l` で展開）
```sql
SELECT $id FROM APP100 WHERE 顧客コード IN @l;
UPDATE APP100 SET フラグ = '1' WHERE 顧客コード IN @l;   -- 親 DML の WHERE でも可（§6）
DELETE FROM APP100 WHERE $id NOT IN @l;
```
- **カッコの有無で意味を切り分ける**：`IN (…)`＝**要素の並び**（`IN (@a,@b)`＝スカラー変数の列・R4 のまま）／`IN @l`＝**@l 自体がリスト**（配列変数の展開）。
- パーサは `IN` の次トークンが `(` なら従来（要素列 or サブクエリ）、`@var` なら配列変数展開へ分岐（§4）。既存構文を壊さない。

### 2.3 採らない形（設計判断）
- **`IN (@l)`（カッコ付き）での展開は採らない**：`IN (@a,@b)` の要素列と同居すると「`(@l)`＝1 要素スカラーか配列展開か」が曖昧（1a §125 の留保点）。カッコ無し `IN @l` で無曖昧化する。従来どおり **`IN (@l)` はスカラー 1 要素**として解釈（＝配列変数を `IN (@l)` に置くと §3.5 のスカラー誤用エラー）。
- **`SET @l = (1,2)` は採らない**：`(...)` はスカラー括弧式／IN 要素列と衝突（実機 ParseError）。
- **他RDB対照**：主流は PostgreSQL `= ANY(@arr)`（配列型＋専用演算子）か unnest（`TABLE()`/`STRING_SPLIT`＋`IN(SELECT)`）。裸 `IN @var` は前例が無い kSQL 独自形だが、既存 `[...]` 再利用＋曖昧さ回避で本案を推奨。

## 3. 意味論

### 3.1 展開
`WHERE k IN @l`（`@l = ['A','B','C']`）は、**置換フェーズで** `WHERE k IN ('A','B','C')` と等価な `InList` へ展開する。展開後は**リテラルを直接書いた場合と同一 AST**になり、以降（SIMPLE 押し下げ・FULL_SCAN 評価・EXPLAIN）は既存経路をそのまま通る（§5・§6）。`NOT IN @l` も対称に展開。

### 3.2 型
- 配列要素は `VarValue` のスカラーと同じく型を持つ（v1 は STRING）。展開後の `InList.values` は既存の混在（STRING/NUMBER）と同じく evalWhere / 押し下げが扱う。kintone フィールドとの比較は既存 IN と同一意味論（B15 の負数・型付き比較を含む）。

### 3.2.1 JS（FULL_SCAN）と API（SIMPLE）の一致（B3 展開の前提・実機確認済み）
B3 は `IN @l` を**リテラル IN と同一 AST**へ展開するので、その IN が SIMPLE 押し下げでも FULL_SCAN でも同じ結果になることが前提。実機で確認した結論：
- **マッチ意味論は一致**。kSQL の JS 評価は kintone の `in` を写しており、**複数値フィールド（CHECK_BOX/MULTI_SELECT 等）も「含む」意味論で展開評価**する（JS 値は JSON 文字列 `["Y","Z"]` だが、単純文字列比較ではなく要素で判定）。実機: `チェックボックス IN ('X','Y')` は SIMPLE/FULL_SCAN とも同一行・`IN ('')` は両モードとも空チェックボックスにマッチ・有効値ドロップダウンも一致。
- **違うのは検証（エラー化）だけ**。**選択系フィールドに定義外の選択肢値**を渡すと、**SIMPLE（API）は `GAIA_IQ10`（項目が存在しない）でクエリ拒否・FULL_SCAN（JS）は 0 件で黙殺**する。同一 SQL が押し下げ有無で「実行エラー／0 件」に割れ得る（マッチ結果の食い違いではなく、無効値の扱いの差）。
- **B3 への含意**：この性質は**既存 IN の挙動で、B3 は展開後に継承するだけ**（新たに壊さない）。ただし**変数越しだと「@l に混じった定義外の選択肢値が押し下げ時だけエラーになる」ことが見えにくい**。v1 は挙動を既存 IN と一致させる（独自の実在検証は足さない）が、**受入条件で「選択系 IN @l に定義外値を含むと SIMPLE でエラー・FULL_SCAN で 0 件」を固定**し、ドキュメントに注意を書く。

### 3.3 空配列 `[]` と「空文字 1 要素」`['']` は別物（第一級の設計要件）

**要素数 0 の `[]` と、要素数 1 で中身が空文字の `['']` を厳密に区別する**（ユーザー指摘・実機で確認）。

**(a) `['']`（要素 1 個＝空文字）＝通常の `IN ('')`・送信する**
- `SET @a = ['']; … WHERE k IN @a` は `WHERE k IN ('')` へ展開＝**有効なクエリ**。kintone では複数値フィールドの「空」照会の定石（実機 EXPLAIN: `チェックボックス in ("")`・**空チェックボックスの行にマッチ**）。**定数化しない**。要素数 ≥ 1 は常に通常展開。

**(b) `[]`（要素 0 個）＝`IN ()` は API エラー・送ってはいけない**
- `SET @e = []; … WHERE k IN @e` を `in ()` に落とすと **kintone がクエリ構文エラーを返す**（ユーザー指摘）。無音で「条件無し（全件）」にも化けさせない（それは最悪の誤り・B1/B30 の無音回避と整合）。
- SQL 標準に合わせ**恒偽/恒真の定数述語へ変換**する：**`k IN @e`（空）＝0 件（恒偽）／`k NOT IN @e`（空）＝全件（恒真）**。
- 実装方針：**展開時に要素数 0 を検出**し、`IN` は恒偽・`NOT IN` は恒真の定数述語（既存の定数条件経路 or 専用フラグ）へ置換して**押し下げ前に確定**する（kintone へ `in ()` を送らない）。現状 `parseInValues`（[parser.ts:2005](../../src/parser/parser.ts)）は `do…while` で**最低 1 要素を要求**するためリテラルの空 `IN ()` は書けない＝**空 InList はプログラム的展開でしか生じない**ので、この定数化は展開経路にだけ実装すればよい。

> 用途例（チェックボックス等の複数値フィールド）: `SET @tags = ['X', 'Y']; SELECT $id FROM APP100 WHERE チェックボックス IN @tags`（実機: `in ("X","Y")` で選択値を含む行）。空の照会は `SET @tags = ['']`（`in ("")`）で、`[]` ではない。

### 3.4 数値配列（v1 対象外）
`ArrayLiteral.elements` は現状 `StringLiteral[]`。裸 `[1, 2]` を許すには要素へ `NumberLiteral` を足す拡張が要る。v1 は **STRING 要素のみ**（`['1','2']`）とし、数値配列は後続。理由＝複数値フィールド書込み（既存 `ArrayLiteral` 用途）は選択肢コード＝文字列で足り、拡張の副作用（INSERT/UPDATE 経路への波及）を避ける。

### 3.5 スカラー誤用のエラー
配列変数は **`IN @var`（および `NOT IN @var`）でのみ有効**。それ以外の位置＝スカラーを要求する箇所に配列変数を置いたら**実行前エラー**（無音で先頭要素等に化けさせない）：
- `WHERE k = @l`（等値の右辺）／`UPDATE SET f = @l`（SET 値）／`ASSERT @l …`／`IN (@l)`（カッコ付き要素列）／`CONCAT(@l, …)` 等の関数引数。
- 逆に**スカラー変数を裸 `IN @scalar` に置くのも型エラー**（配列でない変数を展開位置に置いた）。→ 明快なメッセージ（例: `TypeError: @l は配列変数のため IN @l でのみ使用できます` / `@x はスカラー変数のため IN (@x) と書いてください`）。

## 4. AST・パーサ変更

- **`ArrayLiteral` を SET RHS で受理**：`SetVariableStatement.expr`（[ast.ts:87](../../src/types/ast.ts)）は現状 `ScalarExpr`。`ArrayLiteral` は `ScalarExpr` に含まれないため、SET RHS を `ScalarExpr | ArrayLiteral` へ拡張（または SET 専用の RHS union）。`parseSetVariable`（[parser.ts:270](../../src/parser/parser.ts)）で先頭 `[` を見たら `parseArrayLiteral` を呼ぶ。
- **裸 `IN @var` の新パース形**：`parseInListOrSubquery`（[parser.ts:1989](../../src/parser/parser.ts)）は `IN` の直後に `(` を要求。`IN` の次が `VARIABLE` のとき新ノード `VariableInList { type:"VARIABLE_IN_LIST", name }`（`NOT` 情報は既存の NOT IN 経路に合わせる）を返す分岐を追加。`NOT IN @var` も同経路。
- **`InList` は不変**：展開後は既存 `InList`（[ast.ts:528](../../src/types/ast.ts)）を生成するので、消費側（evalWhere・selectToKintone・whereToKintone・EXPLAIN）は原則無改修（空配列の定数化のみ新規・§3.3）。

## 5. 実行・置換

- **`VarValue` に配列 variant を追加**（[execute.ts:745](../../src/execute.ts)）：`| { type:"array"; elements: Array<{type:"string";value:string} | {type:"number";value:number;raw?:string}> }`。
- **`evaluateScalarExpr` の隣に配列評価**（[execute.ts:1178](../../src/execute.ts)）：`SET @l = ['A','B']` を配列 `VarValue` へ評価し `variables` マップへ格納。
- **`resolveVariableRefs` の拡張**（[execute.ts:1199](../../src/execute.ts)）：現状は `{type:"VARIABLE"}` を一律「単一 STRING/NUMBER リテラル」へ置換。B3 では：
  1. `VARIABLE_IN_LIST` ノードに出会ったら、変数を引き、**配列なら要素を `InList.values` へ展開**（空なら §3.3 の恒偽/恒真定数化）、**スカラーなら型エラー**（§3.5）。
  2. 通常の `{type:"VARIABLE"}`（スカラー位置）に出会ったとき、**配列変数なら型エラー**（§3.5）。スカラーは従来どおり。
  - 置換は文ごと・実行前（execute.ts:911/958）。展開はこの置換フェーズで完了し、以降は既存 AST として流れる。

## 6. 押し下げ・面

- **展開後は通常の `IN (リテラル)`** なので、選択系/文字列/`$id` の**既存 IN 押し下げ**（SIMPLE 化）をそのまま継承。押し下げ不可なら FULL_SCAN で JS 評価（既存どおり）。
- **親 DML の WHERE でも可**：`IN (SELECT …)` は DML WHERE 不可だが、`IN @l` は展開後が**リテラル IN** なので `UPDATE/DELETE … WHERE k IN @l` が書ける（`WHERE k IN ('A','B')` と同一）。これは一時テーブル代替（`UPDATE … FROM`）より簡潔という B3 の数少ない明確な利点。
- **最大要素数の境界**：展開結果は kintone クエリ長・IN 要素数の実務上限に載る（既存 IN リストと同じ制約）。上限超過は**押し下げ時に fail-closed**（無音打ち切りしない）。v1 は既存 IN と同じ上限に従い、専用上限は設けない（要 codex 確認：既存 IN の上限/分割挙動）。
- **面**：engine 側の置換・評価のみ＝CLI/MCP/プラグイン全面同一。面配管不要。

## 7. 静的解析・エラー

- `analyzeBatch`（[batch.ts](../../src/core/batch.ts)）の変数参照集計に `VARIABLE_IN_LIST` を含める（未定義参照検出・`referencedBy`）。
- 静的に検出できるもの：未定義 `IN @undefined`、配列変数のスカラー誤用が**構文位置で確定する**ケース（`IN (@l)`・`SET f=@l` 等）。ただし変数の「配列かスカラーか」は**代入を評価するまで確定しない**場合がある（同名の再代入は 1a で禁止のため実際は代入 1 回＝静的に型が決まる）。→ **可能な限り静的、残りは置換時（実行前）にエラー**。
- 空配列を全件条件へ化けさせない（§3.3）ことをテストで固定。

## 8. 受入条件（テスト化）

- 定義：`SET @l = ['A','B','C']` が配列 `VarValue` になる・`SET @e = []` が空配列。
- 展開：`WHERE k IN @l` が `IN ('A','B','C')` と同一結果（SIMPLE 押し下げ時の kintone クエリ一致を EXPLAIN で確認）・`NOT IN @l`・FULL_SCAN 経路。
- **空文字 1 要素 `['']`**：`IN @a`＝`in ("")` を送信・複数値フィールドの空行にマッチ（定数化しない）。EXPLAIN で `in ("")` を確認。
- **空配列 `[]`（0 要素）**：`IN @e`＝0 件・`NOT IN @e`＝全件・**kintone へ `in ()` を送らない**（EXPLAIN で定数化を確認）。`['']` と `[]` が別挙動になることを固定。
- **DML WHERE**：`UPDATE/DELETE … WHERE k IN @l` が動く（`VALIDATE ONLY` 併用可）。
- **スカラー誤用**：`WHERE k = @l`・`SET f = @l`・`ASSERT @l`・`IN (@l)`・関数引数 が明快なエラー。逆にスカラー変数の裸 `IN @scalar` もエラー。
- 非回帰：`IN (@a,@b)`（R4）・`IN (@x)`（スカラー 1 要素）・`IN (SELECT …)`・`IN ('a', 'b')` リテラル・複数値フィールド書込みの `['..','..']`（既存 ArrayLiteral 用途）が不変。
- 全面一致（CLI/MCP/プラグイン）。

## 9. スコープ外（後続）

- **Phase 1b 連携＝サブクエリから配列代入** `SET @l = (SELECT code FROM #t)`（動的リストの持ち回り＝本来の主用途）。1b のスカラーサブクエリ代入を「N 行→配列」へ拡張する設計が要る。**B3 の価値はここで大きくなる**が、実装は 1b 完了が前提。
- 裸の数値配列 `[1, 2]`（§3.4）・再代入・SELECT 句/LIMIT での配列参照・`= ANY(@l)` 別構文。

## 10. 工数の目安（本 R1 の目的）

- **パーサ**：`SET` RHS の `ArrayLiteral` 受理＋裸 `IN @var` 分岐（小）。
- **AST**：`VariableInList` 追加・`SetVariableStatement.expr` 拡張（小）。
- **実行**：`VarValue` 配列 variant・`resolveVariableRefs` の展開＋型エラー・**空配列の恒偽/恒真定数化**（中＝正しさの肝）。
- **消費側**：展開後は既存 InList のため原則無改修（空配列の定数化のみ新規）。
- 総じて **B41 より軽い見込み**（読み取り経路も新文もほぼ無く、既存構造の再利用が大きい）。ただし §3.3 空配列と §3.5 型エラーが正しさの要。codex レビューで既存 IN 上限・置換フェーズでの展開の妥当性・空 IN の消費側挙動を裏取りして工数を確定する。

---

## 11. codex レビュー結果（R1・2026-07-19・HEAD 9a68fec・要 R2）

Claude がコードで裏取り済み（P1-1/P1-2/P1-3/P1-7/P2-1 を実ファイルで確認）。**判定＝R2 必須・R2 確定後に実装着手可**。基本設計は採用可。

### P1（正しさ・要修正）
1. **空配列を受ける「既存の定数述語経路」は無い**。`evalWhere` は空 `InList` を正しく評価（IN []=false・NOT IN []=true・[evalWhere.ts:129/142](../../src/engine/evalWhere.ts)）するが、押し下げ `convertInList` は空を `()` に変換して `in ()` を出す（[whereToKintone.ts:215](../../src/converter/whereToKintone.ts)）・通常 SELECT のモード判定は `IN_LIST` を JS 必須と見なさない（[selectToKintone.ts:90/123](../../src/converter/selectToKintone.ts)）・`WhereExpr` に定数ノードが無い（[ast.ts:373](../../src/types/ast.ts)）。→ §3.3 は**親 `BINARY` を見る boolean 簡約パス**が要る（`AND/OR/NOT/GROUP` 込みで恒偽=API呼ばず0件・恒真=WHERE除去 or constant-true・EXPLAIN も同一簡約）。`resolveVariableRefs` の leaf 分岐だけでは親演算子（IN/NOT_IN）が見えず不可（[execute.ts:1199](../../src/execute.ts)）。
2. **`NOT IN []`（恒真）＋親 DML＝全件更新/削除の安全契約迂回**。UPDATE/DELETE は WHERE 必須（[parser.ts:2327/2694](../../src/parser/parser.ts)）。恒真簡約で WHERE を消すと迂回。→ R2 で「親 DML の `NOT IN @empty` はエラー」か「全件許可＋`dmlMaxRows`/confirm/VALIDATE ONLY を安全ゲート必須」を明記。
3. **EXPLAIN は既存経路を継承できない**。EXPLAIN は非サブクエリ SET RHS を評価せず後続変数を文字列プレースホルダ登録（[execute.ts:5746/5767](../../src/execute.ts)）→ 配列 SET が型不整合・空 InList は `in ()` 表示（[execute.ts:5987/6007](../../src/execute.ts)）。→ R2 で「配列リテラル SET は EXPLAIN 時も副作用なく評価し配列登録・同一展開/簡約を通す」と明記。
4. **v1 の array/scalar は全件静的に決まる**（§7 の「評価するまで確定しない場合がある」は誤り）。`SET @l = ARRAY` だけが配列・他 RHS はスカラー・SET RHS の他変数参照禁止（[parser.ts:291](../../src/parser/parser.ts)）・同名再定義禁止（[batch.ts:242](../../src/core/batch.ts)）。→ `analyzeBatch` は参照名しか持たない（[batch.ts:225](../../src/core/batch.ts)）ので、**validate-all-first のため `scalar|array` 定義型を持たせ、配列の通常参照/スカラーの `IN @l` 参照を全件静的拒否**。置換時検査は二重チェックとして残す。
5. **IN 分岐は WHERE 以外の全条件位置に自動的に入る**（`parseWhereExpr` 共通）＝HAVING（[parser.ts:647](../../src/parser/parser.ts)）・CASE/IF（1231）・UPDATE CHECK WHEN（2373）・サブクエリ WHERE。→ R2 で対象/対象外を定義（全 `WhereExpr` 消費者対応か、構文コンテキストで拒否か）。
6. **既存 IN に要素数/クエリ長のローカル上限・分割は無い**。`convertInList` は全要素を無制限 join（[whereToKintone.ts:215](../../src/converter/whereToKintone.ts)）・CLI は単一 GET（[nodeKintoneClient.ts:157](../../src/cli/nodeKintoneClient.ts)）。→ §6 の「上限超過は fail-closed」は誤り。正しくは「専用上限なし・IN 分割なし・大きすぎれば API エラー」。受容か guard 追加を R2 で確定。
7. **`VARIABLE_IN_LIST` は `analyzeBatch` だけでは不足**。`findVariableRef` は `VARIABLE` のみ認識（[execute.ts:603/1221](../../src/execute.ts)）→ `collectVariableRefs`/`findVariableRef`/`resolveVariableRefs`/EXPLAIN 変数環境/AST exhaustive switch・表示・収集の visitor 更新が要る。

### P2（改善）
1. 参照行は現行 HEAD で一致。ただし**括弧を要求するのは `parseInListOrSubquery` でなく呼出し側**（[parser.ts:1753/1774](../../src/parser/parser.ts)）→ 実装は「IN/NOT IN 直後の呼出し側で `LPAREN` と `VARIABLE` を分岐」へ（§4 を修正）。
2. `IN (@l)` と `IN @l` を分けるには AST 上の区別（`VARIABLE_IN_LIST` か `InList` の spread variant）が必要。空配列処理は leaf でなく親 `BinaryExpr` 正規化に置く。
3. 親 DML 押し下げは全型無条件でなく schema-aware capability が `in/not in` を `EXACT_PUSHDOWN` と判定できる型に限る（[whereCapability.ts:120](../../src/core/optimization/whereCapability.ts)・[execute.ts:1573](../../src/execute.ts)）→ §6 は「literal IN と同じ制約を継承」と限定表現に。
4. 公開面（言語リファレンス/レシピ/台帳/CHANGELOG/全面回帰テスト）を工数に含める（§10 の「engine 側だけ」は過小）。SemVer は純加法 **minor** 妥当（現行 3.4.0）。

### 総合・工数
- **R2 必須**（上記 6 点）→ 確定後に実装着手。基本設計は採用可。
- 工数 **3.5〜6.5人日**（B41 の 4.5〜8.5 に対し 0.7〜0.8倍・B41 より軽い結論は維持）。主コスト＝空定数の親aware簡約・静的型解析・EXPLAIN・全条件位置の回帰。

### R1 実機補足（Claude・APP4221）
- JS/API の IN 一致を実機確認（§3.2.1）：複数値フィールドの「含む」意味論・空 `IN ('')` の空マッチが SIMPLE/FULL_SCAN 一致。選択系の**定義外値**のみ SIMPLE=`GAIA_IQ10` エラー／FULL_SCAN=0件で割れる（既存性質・B3 は継承）。
- `['']`（要素1個・`in ("")`・空行にマッチ）と `[]`（0要素・`in ()`＝API エラー・定数化対象）は別物（§3.3）。
