# B137 列数の違う `UNION` をエラーにする 仕様 R1 レビュー 1

## 結論

**要修正・6 件（高 2 / 中 4）。現状の R1 のままでは実装着手不可。**

方向（列数不一致を `ArgumentError` にする）、実行時の比較値（実体化後の `columns.length`）、通常経路と CTE/temp 経路の 2 境界で同じ検査をする方針は正しい。ただし、3 段連鎖の実行順について受入不能な記述があり、静的検出不能という中核前提も強すぎる。さらに `EXPLAIN` の契約、受入 surface、移行例、既存テストに関する記述を R2 で確定する必要がある。

レビューはコード・テスト・文書の読み取りと CLI `--dry-run` によるサンプル構文確認で行った。kSQL MCP、`npm test` は実行していない。

## 指摘

### H1（高）§2.3 / §3.1 / §3.3 — B 不一致でも C は実行開始されるため、「C まで到達しない」は現行並列契約と両立しない

R1 は `A(3) UNION B(5) UNION C(3)` について「B の段で落ちる（C まで到達しない）」とする。しかし、パーサが作る外側ノードは `UNION(UNION(A,B), C)` であり、`executeUnion` は外側ノードでも左の入れ子全体と C を同時に開始する。

根拠:

```ts
// src/parser/parser.ts:1272-1274
const right = this.parseSelect();
const union: UnionStatement = { type: "UNION", all, left, right };
return this.tryParseUnionChain(union);
```

```ts
// src/execute.ts:4869-4899
// 左辺（ネストした UNION 対応）と右辺を並列実行
const [leftResult, rightResult] = await Promise.all([
  stmt.left.type === "UNION"
    ? executeUnion(stmt.left, ...)
    : executeSelect(...),
  executeSelect(markCountTotalCountRoot(stmt.right), ...),
]);
```

外側 `Promise.all` の第 2 要素が C なので、内側 A/B の列数検査より前に C は開始済みになる。C が正常なら最終的に内側の B 不一致が返るが、「C まで到達しない」「C の API を消費しない」は成立しない。C 自身が先に別エラーで reject すれば、観測されるエラーも B の列数不一致とは限らない。

提案:

- §2.3 を「比較上は B のノードで不一致になる。ただし外側ノードの右枝 C も現行の並列実行により開始され得る」へ修正する。
- §3.1 の「3 段目まで到達しない」を削除し、「返るエラーの左右列数は内側ノードの 3/5 である」を固定する。
- C を開始させないことを要件にするなら逐次化が必要であり、§3.3 の `Promise.all` 維持と性能契約を変更する別判断にする。本件では現行並列を維持する方を推奨する。

### H2（高）§0.1 / §1 / §3.3 — 「静的検出は不可能」は偽。全形には使えないが、明示列だけの枝は列数を AST から確定できる

`DESCRIBE`、`SHOW APPS`、`SELECT *` のように実体化まで列数が確定しない形がある、という説明は正しい。しかし、`SELECT a, b ... UNION SELECT c ...` のように両枝が wildcard を含まない場合、各 `SelectColumn` は 1 出力位置なので `SelectStatement.columns.length` から不一致を判定できる。

根拠:

```ts
// src/parser/parser.ts:1277-1283
private parseSelectColumns(): SelectColumn[] {
  const cols: SelectColumn[] = [];
  do {
    cols.push(this.parseSelectColumn());
  } while (this.consume(TokenKind.COMMA));
  return cols;
}
```

```ts
// src/engine/process.ts:1335-1347
const hasWildcard = columns.some(
  (col) => col.type === "WILDCARD" || col.type === "PARENT_WILDCARD"
);
const outputKeys = hasWildcard ? null : computeOutputKeys(...);
...
if (hasWildcard && rows.length === 0) {
  return { rows: [], columns: computeExplicitOutputKeys(...) };
}
```

一方、静的に先に落とすと、現行の「両枝を実行してから」のタイミング、API 消費、未知フィールド等とのエラー優先順位が形によって変わる。単なる最適化ではなく observable contract の分岐になる。

提案:

- §0.1/§1 の「不可能」を「全構文を一律に静的判定することはできない」へ直す。
- B137 では一貫した意味論を優先し、明示列形も含めて**実体化後の共通検査だけ**にすることを明示する。その理由は「不可能」ではなく「形によるエラー時機・優先順位の分岐を作らない設計判断」とする。
- API 節約の静的 fast-fail を採るなら、wildcard 判定、エラー優先順位、`EXPLAIN`/validation との整合を別仕様で決める。

### M1（中）§3 / §4 — `EXPLAIN` の成功・失敗契約が未確定

現行 `EXPLAIN <UNION>` は `executeUnion` を通らず、枝ごとの計画を収集するだけなので、列数不一致でも計画を返す。

根拠:

```ts
// src/execute.ts:10585-10590
if (query.type === "UNION") {
  const lines = buildUnionPlan(query, ...);
  return includeFetchSummary ? addFetchSummary(lines, ...) : lines;
}
```

```ts
// src/execute.ts:11150-11166
const collect = (u: SelectStatement | UnionStatement): void => {
  if (u.type === "SELECT") { selects.push(u); return; }
  collect(u.left);
  selects.push(u.right);
};
...
lines.push(...buildSelectPlan(sel, `[union:${i + 1}]`, ...));
```

列数の比較も `executeUnion` 呼出しもない。`EXPLAIN` は records/cursor を使わないため、動的 schema を含む UNION の一致を一般には証明できない。

提案:

- R2 では「`EXPLAIN` は列数不一致を実行時エラーとして先取りせず、計画を返す」を推奨する。
- 計画に `union column count: validated at runtime` 相当を表示するかは実装範囲として決め、少なくとも受入に `EXPLAIN` は records/cursor API 0 回で成功し、実件数由来の左右列数を断定しないことを入れる。
- 明示列だけを `EXPLAIN` で拒否する案は H2 の hybrid fast-fail と同じ追加契約になるため、B137 へ暗黙に混ぜない。

### M2（中）§3 / §4 — 2 実装境界は足りるが、公開 surface と間接経路の受入が不足している

結果行を組み立てる箇所は `executeUnion` と `executeQueryWithCte` の 2 か所で足りる。単文/engine `runQuery` は前者、temp 参照・CTE・`CREATE TEMP TABLE AS UNION` は後者へ集約される。

根拠:

```ts
// src/execute.ts:1088-1096
case "UNION": return executeUnion(...);
case "WITH":  return executeWith(...);
```

```ts
// src/execute.ts:1828-1833
const result = await runSelectLike(resolvedStmt.query, ...);
tempTables.set(resolvedStmt.name, {
  rows: result.rows,
  columns: result.columns,
  ...
});
```

```ts
// src/execute.ts:1889-1900
/** CREATE TEMP TABLE の AS 句（SELECT / UNION / WITH）を...実行する */
async function runSelectLike(...) {
  if (query.type === "WITH") return executeWith(...);
  return executeQueryWithCte(query, ...);
}
```

ただし §3 は CTE だけを名指しし、`CREATE TEMP TABLE #t AS <mismatched UNION>`、temp table を片枝に使う UNION、engine-library `runQuery` / `runBatch` の envelope を固定していない。共通ヘルパーを 2 箇所に置いても surface 側の退行は検出しにくい。

また、直接の `INSERT ... SELECT ... UNION ...` / `UPSERT ... SELECT ... UNION ...` は現行文法では受理されない。ソースは `parseSelect()` だけで、`tryParseUnionChain()` を呼ばない。

```ts
// src/parser/parser.ts:3315-3330
if (this.peek().kind === TokenKind.SELECT) {
  const select = this.parseSelect();
  ...
  return { type: "INSERT_SELECT", ..., select, ... };
}
```

したがって DML の実際の影響は、先に `CREATE TEMP TABLE AS UNION` で実体化し、その temp を `INSERT ... SELECT FROM #t` に渡す間接形である。

提案:

- §3 に通常単文、CTE、temp 片枝、`CREATE TEMP TABLE AS UNION`、engine `runQuery`、engine `runBatch` の代表受入を追加する。
- §4 に「直接の INSERT/UPSERT source UNION は構文非対応。temp 経由は UNION 実体化時に止まる」と明記する。
- ヘルパーは `SelectResult` 全体ではなく `readonly string[]` の左右 `columns`（または左右の数）を受け取る。必要なのは長さだけであり、行・warnings・メタを渡す理由がない。

### M3（中）§3.1 / §5 — 仕様中の代表 SQL と移行 SQL は、そのままではパースできない

`SELECT c, ''` のリテラル追加自体はパースできる。CLI `--dry-run` で `SELECT 'a' AS a, 'b' AS b UNION SELECT 'c' AS c, ''` が成功することを確認した。

しかし R1 がコードブロックと受入入力に使う `FROM x` / `FROM y` は、kSQL の物理テーブル名として無効である。CLI `--dry-run -e "SELECT a, b FROM x UNION SELECT c, '' FROM y"` は `「x」は無効です` で失敗した。

根拠:

```ts
// src/parser/parser.ts:2373-2378
if (this.cteNames.has(name)) {
  ...
  return { appId: 0, alias, cteName: name };
}
const { appId, subtableCode } = extractTableRef(name, this.prev());
```

```ts
// src/parser/parser.ts:4341-4349
const m = name.match(/^[Aa][Pp][Pp](\d+)(?:\$(.+))?$/);
if (!m) {
  throw new ParseError(
    `テーブル名は APP + 数字...「${name}」は無効です`, tok
  );
}
```

提案:

- §3.1 と §5 の実行例を `APP100` / `APP200` に置換する。例: `SELECT a, b FROM APP100 UNION SELECT c, '' FROM APP200`。
- 単なる疑似コードなら SQL fence から外して「概念例」と明記する。ただし CHANGELOG の移行案内にはコピー可能な有効 SQL を推奨する。
- 右が多い例も「同上」で済ませず、実際の SQL を記載する。

### M4（中）§0 / §4 — 「padding に依存する既存テストはない」と B130 characterization test の存在が矛盾する

R1 §0 は「既存テストで padding に依存しているものは無い」とする一方、§4 は `b130DescribeFlags.test.ts` の該当テストをエラー期待へ変えるとしている。現在のテストは明示的に 4 列の空文字 padding を期待している。

根拠:

```ts
// src/__tests__/b130DescribeFlags.test.ts:194-209
// B137: 列数の違う UNION は現状「右辺の不足を空文字で補い、余りを黙って捨てる」。
...
test("B130: 7列のDESCRIBEと3列SELECTのUNIONは現状どおり...", async () => {
  ...
  // 右辺は 3 列しか無いので、残る 4 列は空文字で埋まる（現状挙動）
```

起票時の「5,426 tests 全通」は列数検査を一時実装した時点の測定で、その後に B130 の現状固定テストが追加された、と読める。現時点の事実として「1 件も無い」は成立しない。

提案:

- §0 を「B130 で後から追加した意図的な characterization test 1 件を除き、既存テスト依存は測定時点でなかった」へ直す。
- §4 の「置き換える」は正しい。履歴を残すならテスト名・コメントを B137 の新契約へ更新し、古い padding 期待だけを削除する。

## 依頼の 7 点への回答

### 1. 判定を入れる場所は 2 か所で足りるか

**足りる。** 実際に右辺行を左辺 schema へ remap し結果を構築するのは次の 2 箇所だけである。

```ts
// src/execute.ts:4902-4916（通常）
const leftCols = leftResult.columns;
const rightCols = rightResult.columns;
const remappedRight = rightResult.rows.map(...);
...
const rows = stmt.all ? combined : deduplicateRows(combined, leftCols);
```

```ts
// src/execute.ts:5013-5026（CTE/temp）
if (query.type === "UNION") {
  const [leftResult, rightResult] = await Promise.all(...);
  const leftCols = leftResult.columns;
  const rightCols = rightResult.columns;
  const remapped = rightResult.rows.map(...);
  ...
}
```

- engine-library `runQuery` / 通常単文は `executeParsedStatement` の `executeUnion` へ行く。
- temp 参照、CTE、batch の `CREATE TEMP TABLE AS UNION` は `executeQueryWithCte` へ行く。
- `CREATE TEMP TABLE` は独自に UNION 行を結合せず、返った `SelectResult` を保存するだけ。
- 直接の `INSERT/UPSERT ... SELECT ... UNION` は現行 parser で非対応。temp 経由だけが影響する。

`mergeUnionColumnMeta` は列数不一致を拒否せず、左列を走査して同位置の右列が無ければ unknown string meta に落とす。

```ts
// src/execute.ts:4472-4488
left.columns.forEach((column, index) => {
  const rightColumn = right.columns[index];
  const b = rightColumn === undefined ? undefined : rightMeta?.get(rightColumn);
  ...
  else meta = unknownStringColumnMeta();
});
```

これは現行 padding と整合している。列数 assert を remap より前に置けば、不一致時に meta merge へ到達しないため矛盾しない。一致時は全 index に右列があり、従来どおりである。

共通ヘルパーの推奨引数は `leftResult.columns` / `rightResult.columns`。`SelectResult` 全体は不要である。

### 2. 3 段以上の連鎖

- AST は確実に左結合。`tryParseUnionChain(union)` が、既に作った union を次の left として再帰する。
- `WITH c AS (...)` の括弧は CTE 定義の区切りで、その中でも同じ `tryParseUnionChain` を使う（`parser.ts:1238-1248`）。UNION operand 自体を括弧で囲んで右結合にする文法はない。右枝は常に `parseSelect()` である（`parser.ts:1272`）。
- 比較ノードの基準列数が最左 SELECT に残る説明は正しい。
- ただし実行開始順は H1 のとおり木の評価順と同じではない。B 不一致でも C は並行開始されるため、「C まで到達しない」は誤り。

### 3. 実行タイミング

- wildcard、`DESCRIBE`、`SHOW APPS`、実体化 schema を含む一般形は実行後でなければ分からない。
- 両枝が明示列だけなら AST から一部静的判定できる。
- 本件では静的 fast-fail の性能益より、形によって API 消費・エラー優先順位を変えない一貫性を優先し、現行 `Promise.all` 後にだけ assert することを推奨する。
- その場合、2 箇所とも `const [leftResult, rightResult] = await Promise.all(...)` の直後、remap / deduplicate / meta merge より前に同じ helper を呼べば、並列形は変えずに済む。

### 4. `EXPLAIN`

- 現行は列数不一致でも枝の計画を返し、`executeUnion` の列数検査候補には到達しない。
- 動的 schema を一般に確定できないため、B137 では計画を返し「列数は実行時検査」とする契約を推奨する。
- R1 はこれを決めていないため R2 で明文化・受入追加が必要。

### 5. 受入条件の穴

- B130 のような「意図どおり検出される」という要求/確認の両義的表現は、R1 §3 には残っていない。エラー/従来どおりが分かれている点は良い。
- ただし「3 段目まで到達しない」は確認事項ではなく現行実装と矛盾する要求になっている（H1）。
- 固定追加を推奨する形:
  - 通常経路と CTE/temp 経路それぞれで右不足・右過剰
  - `UNION` / `UNION ALL`
  - 0 行の明示列、0 行 `SELECT *` の schema 復元後
  - temp table を片枝にする形、`CREATE TEMP TABLE AS UNION`
  - engine `runQuery` / `runBatch`
  - `EXPLAIN` の非実行契約
  - エラー時も左右枝が開始される並列 characterization
- `deduplicateRows` が `leftCols` だけを見るのは列数 assert 後なら問題ない。右行は同じ長さで左列名へ位置 remap 済みなので、UNION の出力 tuple は左 schema で完全に表現できる。列名重複時の既存 object-key semantics は本件非対象であり変えない。

### 6. 移行案内

- `SELECT c, ''` の空文字リテラル追加はパース可能。
- `FROM x` / `FROM y` はパース不能なので、R1 の例全体はそのまま使えない（M3）。
- 移行が必要な形は、右不足へのリテラル追加だけではない。
  - 右過剰: 不要列を削るか、左へ対応列を追加する。
  - `SELECT *`: 両アプリの schema 変更で再び不一致になり得るため、必要列を両枝で明示する。
  - `DESCRIBE` / `SHOW APPS`: version で列が増える面は `SELECT *` を避け、CTE で必要列へ射影してから UNION する。
  - temp/CTE: 実体化前の各 UNION node で揃える。後段 INSERT の target 列を増減しても、手前の UNION 不一致は直らない。
  - 3 段以上: 全枝を最左枝と同じ位置・列数へ揃える。

### 7. 影響範囲

- 現状 padding を明示期待するテストとして確認できたのは `src/__tests__/b130DescribeFlags.test.ts:194-215` の 1 件。UNION 関連テストを横断検索した範囲では、ほかは左右同数か parser/plan のテストであり、padding 依存は確認できなかった。
- ただし `npm test` は依頼どおり未実行なので、「ほかにない」の最終確認は実装後の full test に委ねる。
- 公開レシピ `docs/ksql_batch_recipes.md:240-243` の R5 は全枝 2 列で一致しており変更不要。
- 言語リファレンスの代表例 `docs/ksql_language_reference.md:1970-1986`、CTE 例 `:2036-2053` も左右同数で変更不要。
- 言語リファレンスは既に `:1967` で「両辺の列数が一致しない場合はエラー」と記載している。§4 の作業は新規要求の追記ではなく、実装との整合確認と、実行後判定・移行上の `SELECT *` 注意の補強として書くべきである。
- 列数の違う UNION を成功例として載せた公開言語リファレンス/レシピは、上記横断検索では確認できなかった。内部の B130/B137 経緯文書は意図的な不一致例である。

## R1 で正しかった点（R2 で消さない）

1. 列数不一致を黙って padding/truncate せず `ArgumentError` にする方向。
2. `UNION` と `UNION ALL` で列数規則を分けないこと。
3. 実体化後の `leftResult.columns.length !== rightResult.columns.length` を最終的な真実とすること。
4. 通常 `executeUnion` と CTE/temp の `executeQueryWithCte` の両方に同じ共通 helper を置くこと。
5. assert を `Promise.all` 後、remap / deduplicate / `mergeUnionColumnMeta` 前に置くこと。
6. 出力列名・列順は左辺由来のままにし、型互換性は本件で扱わないこと。
7. AST が左結合で、比較 schema が結果的に最左 SELECT 由来になる説明。
8. エラーに左右の実列数と修正方針を含めること。列名全列の列挙は不要で、列数だけを推奨する。
9. `deduplicateRows` のロジック自体を変えないこと。
10. 破壊的な挙動変更として CHANGELOG に移行案内を出すこと。
11. `SELECT *` / `DESCRIBE` / `SHOW APPS` のような動的 schema では API/実体化後にしか判定できないこと。
12. B130 の characterization test を B137 のエラー期待へ置き換えること。
