# B128 Phase 2a `LAG` / `LEAD` 仕様 R1 codex レビュー 2

## 結論

**要修正（高 1・中 7・低 1）。現状の R1 のままでは実装着手不可。**

前回レビューのうち本スコープに残る 8 件は、方向としてはすべて R1 に現れている。特に前回の「高」4 件である positive discriminator、required-field、型メタ、第 3 引数 `default` の矛盾は、設計方針としては解消できている。

ただし、次の点が残る。

- `offset` がパーティション長を超えた場合について、§2.1 は空文字、§6-3 は「弾くかを決める」としており、規範が衝突している。
- `LAG` / `LEAD` の parser は soft keyword の方針だけでなく、comma-aware な引数終端と B129 の nested-window 検出まで仕様化しないと、既存 parser の延長では受入を満たさない。
- 「次の段で `CASE`」は実際に書けるが、それは月次集約、`LAG`、前月比の **3 段**である。§4.5 の「2 段構成」は数え方と SQL が一致しない。
- B127 の判定器は独立 helper ではなく RANGE 専用 warning 関数内の inline 判定なので、そのまま再利用はできない。
- §4.2 / §4.3 は内部実装を要求する文が混ざり、欠落を観測できる受入になっていない。

確認は静的コード照合と parser 単体相当の bundle 実行で行った。kSQL MCP、`npm test`、実機 API は使用していない。したがって実データでの値検算は **未確認**である。

---

## 指摘

### [重要度: 高] `offset` 超過時の規範が §2.1 と §6-3 で矛盾する

- 該当: R1 §2.1、§6-3、§4.1
- 内容: §2.1 は「パーティションの外に出たら空文字」と確定している一方、§6-3 は「パーティション長を超える値を弾くか、空文字で返すか」を未確定としている。実装者が §6-3 に従って reject すると §2.1 に違反する。受入にも `offset == partition.length` / `offset > partition.length` がないため、どちらで実装しても通り得る。
- コード根拠: 現行 `applyWindow` はソート後の `sorted` を index 順に処理する。

  ```ts
  // src/engine/process.ts:1068-1078
  for (let index = 0; index < sorted.length; index++) {
    // ...
    sorted[index].row[window.alias] = String(value);
  }
  ```

  VALUE window も `target = index ± offset` を計算し、`sorted[target]` がなければ `""` とするだけで `0`、長さと同じ値、長さ超過を一貫して扱える。safe integer の範囲なら巨大な配列確保も不要である。
- 提案: §6-3 を削除して「超過は空文字」に確定する。§4.1 に partition 長 `N` に対する `offset = N` と `N + 1` を追加する。将来 `@n` を許すかは「offset の値域」ではなく「offset operand の構文拡張」として別項目にする。

### [重要度: 中] VALUE window の完全入力理由は `AGGREGATE_WINDOW` ではなく `WINDOW_ORDER` になる

- 該当: R1 §0、§2、§5、`src/core/dmlGuard.ts:176-188`
- 内容: §0 は「完全入力を要求（`AGGREGATE_WINDOW`）」としているが、現行 guard は `windowKind === "AGGREGATE"` だけを `AGGREGATE_WINDOW` とし、それ以外の ORDER 付き window を `WINDOW_ORDER` とする。VALUE window は ORDER BY 必須なので、既存コードのまま `WINDOW_ORDER` により完全入力になる。完全入力という効果は正しいが、理由名が誤っている。
- コード根拠:

  ```ts
  // src/core/dmlGuard.ts:183-187
  if (column.type === "WINDOW_COL" && column.windowKind === "AGGREGATE") {
    reasons.add("AGGREGATE_WINDOW");
  } else if (column.type === "WINDOW_COL" && column.orderBy.length > 0) {
    reasons.add("WINDOW_ORDER");
  }
  ```

- 提案: §0 を「ORDER BY 必須のため `WINDOW_ORDER` で完全入力」に直す。VALUE を無理に `AGGREGATE_WINDOW` へ入れない。受入で complete-input reason も固定する。

### [重要度: 中] parser 方針が comma-aware な引数終端まで定義されていない

- 該当: R1 §2.2、§5、§6-1、`src/parser/parser.ts:1277-1450,2257-2340`
- 内容: R1 は parser に「分岐・offset 検証・第 3 引数拒否」を要求するが、現行 `parseAggregateArgExpr()` は引数終端を `)` / `SEPARATOR` としか認識しない。そのまま再利用すると `LAG(x, 2)` の comma で失敗する。また `LAG` / `LEAD` を hard token にすると、既存の非引用フィールド名 `LAG` / `LEAD` を壊す。
- コード根拠:

  ```ts
  // src/parser/parser.ts:2301-2303
  private isAggregateArgEnd(): boolean {
    return this.peek().kind === TokenKind.RPAREN || this.isSoftKeyword("SEPARATOR");
  }
  ```

  ```ts
  // src/parser/parser.ts:1430-1449
  // フィールド [AS alias]
  const field = this.parseColumnFieldRef();
  // ...
  return this.withAliasDisplay({ type: "FIELD", field, alias: ... }, parsedAlias);
  ```

  ```ts
  // src/lexer/lexer.ts:238-240
  const kind = KEYWORDS.get(upper) ?? TokenKind.IDENT;
  const value = kind === TokenKind.IDENT ? raw : upper;
  ```

- 提案:
  1. `LAG` / `LEAD` は soft keyword に確定する。
  2. `parseSelectColumn` の field fallback より前で、`IDENT(LAG|LEAD)` かつ次が `LPAREN` の場合だけ VALUE parser に入る。
  3. `parseAggregateArgExpr` を terminator predicate 付きにするか、同じ scalar grammar を comma-aware に読む専用入口を作る。
  4. `LAG`、`LAG AS alias`、`` `LAG` `` を通常 field として保つ互換テストを追加する。
  5. offset は既存 `parseUnsignedInt()` をそのまま使わない。同 helper は `Number.isInteger` しか確認しないため、§2.2 の `Number.isSafeInteger` を満たさない。

### [重要度: 中] B129 の nested-window 検出は VALUE window を自動では拾わない

- 該当: R1 §0、§1、§4.4-4、`src/parser/parser.ts:1313-1317,1456-1478,1564-1568`
- 内容: R1 は「ウィンドウ結果を同じ SELECT の式に含める形は B129 の診断のまま」とする。しかし現行 scanner は aggregate token map だけを見ている。soft keyword の `LAG` / `LEAD` 分岐を追加しただけでは、`ROUND(LAG(x) OVER (...), 1)` や `CASE ... LAG(...) ...` を B129 の診断へ送れない。
- コード根拠:

  ```ts
  // src/parser/parser.ts:1462-1470
  if (PARSER_AGGREGATE_FUNCTION_TOKEN_MAP[token.kind] !== undefined
    && this.tokens[index + 1]?.kind === TokenKind.LPAREN) {
    // ...
    if (next?.kind === TokenKind.IDENT && next.value.toUpperCase() === "OVER") return true;
  }
  ```

  aggregate window の直後の算術は別途明示的に B129 へ送っている。

  ```ts
  // src/parser/parser.ts:1564-1568
  if (this.isArithOp(this.peek().kind)) {
    throw new ParseError(WINDOW_RESULT_IN_EXPRESSION_MESSAGE, this.peek());
  }
  ```

- 提案: nested scanner に `IDENT(LAG|LEAD) + LPAREN ... RPAREN + OVER` を加え、VALUE parser 自身も後続の算術・連結等を B129 へ送る。受入を「関数で包む・算術に混ぜる・CASE の中」の 3 形に分け、単なる ParseError ではなく `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` の本文を固定する。

### [重要度: 中] `default` の代替は実行可能だが、仕様の「2 段」と完全 SQL が一致しない

- 該当: R1 §1.1、§2.3、§4.5、`src/parser/parser.ts:328-333,1231-1256`
- 内容: 「次の段で `CASE`」は現行 parser の構造上可能であり、`default` を取らない判断と B129 制約は矛盾しない。ただし、月次集約を 1 段、`LAG` を 2 段、前月比を 3 段と数える必要がある。§4.5 の「§1.1 の 2 段構成（月次集約 → LAG → 次段で前月比）」は 3 処理段を 2 段と呼び、§1.1 自体にも 3 段目の SQL がない。
- コード根拠: B129 の既存診断も window 結果の式を次の CTE へ置くよう案内する。

  ```ts
  // src/parser/parser.ts:328-333
  "ウィンドウ関数の結果は同じ SELECT の式では使えません。",
  "  ○ WITH w AS (SELECT SUM(x) OVER () AS 総計 FROM t) SELECT ROUND(総計, 1) AS a FROM w",
  "ウィンドウ結果を列として出し、それを使う式は次の段（CTE または一時テーブル）に書いてください",
  ```

  `parseWith()` は comma 区切りの複数 CTE を順に登録するため、3 段形を表現できる。

  ```ts
  // src/parser/parser.ts:1235-1254
  do {
    const name = this.parseIdentifier();
    // ... inner SELECT ...
    ctes.push({ name, query });
    this.cteNames.add(name);
  } while (this.consume(TokenKind.COMMA));
  const query = this.tryParseUnionChain(this.parseSelect());
  ```

- 検証: 現行 parser は当然ながら未実装の `LAG` を `「LAG」という関数はありません` で拒否した。一方、同じ CTE / window / CASE の構造で `LAG` 部分だけ既存 `SUM(...) OVER` に置き換えた 2 段形と 3 段形はどちらも parse した。したがって、周辺構文に構造的な blocker はないが、実装後の exact SQL 回帰が必要である。
- 提案: §1.1 を次の完全 3 段形にする。空文字判定は kSQL の NULL 相当を表す `IS NULL` を使う。

  ```sql
  WITH 月次 AS (
    SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月, SUM(個数) AS 出庫数
    FROM APP4228
    WHERE 入出庫区分 = '出庫'
    GROUP BY 年月
  ), 前月付 AS (
    SELECT 年月, 出庫数,
           LAG(出庫数) OVER (ORDER BY 年月) AS 前月
    FROM 月次
  )
  SELECT 年月, 出庫数, 前月,
         CASE WHEN 前月 IS NULL OR 前月 = 0 THEN ''
              ELSE ROUND((出庫数 - 前月) / 前月 * 100, 1)
         END AS 前月比
  FROM 前月付
  ORDER BY 年月
  ```

  これを parser test と full execute test の両方へ入れる。月が欠けた場合は「前レコード比」であり必ずしも暦上の前月比ではないことも recipe に明記する。

### [重要度: 中] B127 の判定はそのまま再利用できず、warning 方針も未確定のまま

- 該当: R1 §2.4、§3.4、§6-2、`src/execute.ts:2534-2575`
- 内容: B127 には独立した「全順序判定器」はない。`collectDefaultRangeWindowWarnings()` の中に、aggregate/default RANGE 専用条件と total-order の保守的 proof が一体で書かれている。VALUE window は `windowKind !== "AGGREGATE"` で入口から除外され、メッセージも RANGE peer 専用なので、そのまま呼べない。
- コード根拠:

  ```ts
  // src/execute.ts:2555-2567
  if (
    column.type !== "WINDOW_COL"
    || column.windowKind !== "AGGREGATE"
    || column.orderBy.length === 0
    || column.frame?.source !== "DEFAULT"
  ) continue;
  const hasTotalOrderKey = canProveSinglePhysicalInput && column.orderBy.some((item) => {
    if (item.key.type !== "FIELD_NAME") return false;
    const ref = aggregateFieldRef(item.key.name);
    return ref.field === "$id" || resolveField(ref)?.fieldType === "RECORD_NUMBER";
  });
  ```

  現行 sort は tie breaker を足さず、比較結果 `0` のまま `.sort(compare)` する。

  ```ts
  // src/engine/process.ts:921-925
  const compare = (a: DecoratedSortRow, b: DecoratedSortRow) =>
    compareDecoratedRows(a, b, orderBy, keyMeta);
  decorated.sort(compare);
  return { rows: decorated, compare };
  ```

- 提案: `canProveTotalWindowOrder(orderBy, resolveField, context)` のような純粋 helper を抽出し、B127 と VALUE warning の両方から使う。VALUE 用メッセージは「同順内の前後関係は未規定。レコード番号等を追加」とする。暗黙 `$id` tie break を共有 comparator に加えてはならない。R2 で warning を出す方針まで確定し、direct single APP、JOIN、CTE の各 context を受入に入れる。

### [重要度: 中] §4.2 / §4.3 は内部要求を観測可能な受入へ落とせていない

- 該当: R1 §3.2、§3.3、§4.2、§4.3、`src/converter/selectToKintone.ts:551-620,778-784`、`src/execute.ts:4292-4338`
- 内容:
  - §4.2 の「メタのロードゲートを通る」は実装要求であり、期待結果ではない。`LAG(選択肢列)` の raw 値が返るだけなら、メタをロードしなくても通るため gate 漏れを検出できない。
  - §4.3 の「正しい値を返す」は plain field の gate 漏れは検出できるが、R1 が許す算術・文字列関数・CASE 条件 / result・連結の再帰 walker を個別には固定しない。
- コード根拠: 現行 walker 自体は対象式を再帰走査できる。

  ```ts
  // src/converter/selectToKintone.ts:603-609
  if (expr.type === "STRING_FUNC") { walkStringFunc(expr, phase); return; }
  if (expr.type === "SCALAR_ARITH" || expr.type === "CONCAT_OP") {
    walkScalar(expr.left, phase);
    walkScalar(expr.right, phase);
    return;
  }
  if (expr.type === "CASE_WHEN") walkCase(expr, phase);
  ```

  ```ts
  // src/converter/selectToKintone.ts:630-635
  for (const b of expr.branches) {
    walkWhere(b.condition, phase);
    walkCaseResult(b.result, phase);
  }
  if (expr.elseResult) walkCaseResult(expr.elseResult, phase);
  ```

  現行 WINDOW_COL gate は aggregate だけである。

  ```ts
  // src/converter/selectToKintone.ts:778-783
  case "WINDOW_COL":
    if (col.windowKind === "AGGREGATE" && col.arg.type !== "WILDCARD") {
      walkAggregateArg(col.arg, "select");
    }
  ```

  source metadata gate も aggregate MIN/MAX だけである。

  ```ts
  // src/execute.ts:4312-4322
  function selectNeedsSourceColumnMeta(stmt: SelectStatement): boolean {
    return stmt.columns.some((column) =>
      // ...
      || (column.type === "WINDOW_COL" && column.windowKind === "AGGREGATE"
        && (column.aggFunc === "MIN" || column.aggFunc === "MAX"))
    );
  }
  ```

- 提案:
  1. fetch mock の `fields` を直接検査し、引数にだけ現れる `a`, `b`, `cond`, `thenField`, `elseField` がすべて取得対象になることを固定する。
  2. plain、算術、文字列関数、CASE、`||`、解決済み変数を table-driven にする。
  3. direct APP の option 順が辞書順と異なる fixture を用い、`WITH w AS (SELECT LAG(選択肢) ... FROM APP...) SELECT ... FROM w ORDER BY 前値` の期待順を固定する。これなら metadata gate 欠落を結果で検出できる。
  4. number/date/string/option を CTE と一時テーブルへ materialize し、後段 ORDER BY / MIN / MAX / scalar-subquery variable のうち該当する consumer を通す。

### [重要度: 中] VALUE 引数の評価 helper と空値正規化を明記する必要がある

- 該当: R1 §2.1、§3.2、§5、`src/engine/process.ts:648-674,1085-1099`
- 内容: 「集計の空値スキップを通さない」は正しいが、現行で AggregateArgExpr を行ごとに評価する `aggregateRowValues()` は aggregate function を受け取り、FIELD の空文字を MIN/MAX 以外で `null` にする。VALUE window からそのまま呼べない。新 helper の評価規則を明記しないと、empty / NaN / CASE の扱いが実装者依存になる。
- コード根拠:

  ```ts
  // src/engine/process.ts:649-670
  function aggregateRowValues(func: AggregateFunc, arg: AggregateArgExpr, rows: ProcessRow[]): (string | null)[] {
    return rows.map((row): string | null => {
      if (arg.type === "FIELD_REF") {
        const raw = row[arg.field];
        if (raw === undefined || (raw === "" && func !== "MIN" && func !== "MAX")) return null;
        // ...
      }
      // ... scalar evaluator も aggregate の skip 規則へ正規化する
    });
  }
  ```

- 提案: `evaluateValueWindowArg(arg, row): string` を別に置き、FIELD は `row[field] ?? ""` をそのまま返す。算術・文字列関数・CASE・連結は既存 scalar evaluator を共有し、`null` / `undefined` / 非数値結果を kSQL の NULL 相当 `""` へ正規化する。partition ごとではなく、ソート後行ごとに 1 回だけ評価する。`aggregateRowValues()` は呼ばない。

### [重要度: 低] 「`sortDecoratedRows` を共有」が計算結果共有にも読める

- 該当: R1 §0、§4.4、§5、`src/engine/process.ts:1050-1081`
- 内容: 現行は comparator 実装を共有しているが、partition 分割と sort 結果は window 列ごとに共有していない。同じ SELECT に順位、集計窓、LAG が 1 列ずつあれば、外側 loop が 3 回回り、各列について partition map を作り、各 partition を 1 回ずつ sort する。異なる PARTITION / ORDER を許すため正しさは保たれるが、「共有」が sort result cache の要件に読める。
- コード根拠:

  ```ts
  // src/engine/process.ts:1050-1063
  for (const window of windows) {
    const partitions = new Map<string, ProcessRow[]>();
    // window ごとに partition を再構築
    // ...
    for (const partition of partitions.values()) {
      const sortedResult = sortDecoratedRows(partition, window.orderBy, ...);
  ```

- 提案: 「比較器・意味型解決を `sortDecoratedRows` と共有する。sort 済み結果の window 列間 cache は本 Phase の要件外」と明記する。同一 normalized PARTITION / ORDER の cache は将来の最適化として分離する。

---

## 依頼の 7 点への回答

### 1. 前回の「高」4 件は潰せているか

#### 1-a. `isRankingWindow` の positive discriminator

**方向は正しい。直接利用者は現行 2 箇所だけで、どちらも VALUE 対応が必要。**

```ts
// src/types/ast.ts:320-323
/** windowKind 未設定の既存 AST も順位系として扱う。 */
export function isRankingWindow(column: WindowColumn): column is RankingWindowColumn {
  return column.windowKind !== "AGGREGATE";
}
```

全利用者:

1. `src/engine/process.ts:1062` — `applyWindow` の aggregate / ranking 二分岐。VALUE を aggregate へ誤送するため、R1 どおり 3 分岐にする。
2. `src/engine/process.ts:1836` — 出力 ORDER semantics。VALUE を number と誤認するため、VALUE は引数 semantics へ分岐する。

```ts
// src/engine/process.ts:1062-1064
if (!isRankingWindow(window)) {
  applyAggregateWindow(window, sortedResult, resolveAggSortKind);
  continue;
}
```

```ts
// src/engine/process.ts:1835-1840
} else if (column.type === "WINDOW_COL") {
  if (isRankingWindow(column) || column.aggFunc === "COUNT" || ...) {
    result.set(column.alias, syntheticSemantics("number"));
  } else if (column.arg.type !== "WILDCARD") {
```

helper を使わず同じ negative discriminator を書く箇所は `execute.ts:1699,2606,4296` にあり、§3.3 が別途列挙している。unknown kind は `assertNever` 相当で fail-closed にするべきで、R1 の記述は正しい。

#### 1-b. required-field 収集

**`VALUE` でも `walkAggregateArg(col.arg, "select")` を通せば、R1 が想定する式は収集できる。**

- 算術: `walkArith` が left/right を再帰 (`selectToKintone.ts:551-568`)
- 文字列関数: `walkStringFunc` が全 args を再帰 (`:586-596`)
- CASE: condition と then/else を再帰 (`:623-635`)
- 連結 / scalar arithmetic: `walkScalar` が left/right を再帰 (`:598-609`)
- 変数: parser 上は AggregateArgExpr の `VARIABLE` として書ける。実行前に generic resolver が NUMBER / STRING へ置換する (`execute.ts:2092-2126`) ため、解決後は取得 field を増やさない。未解決変数を converter へ到達させない既存前提を維持する。

parser bundle で、既存 aggregate arg grammar に対し `数量 * 単価`、`CONCAT(商品, '-', 区分)`、`CASE WHEN 状態 = '完了' THEN 数量 ELSE 0 END`、`商品 || '-' || 区分`、`@n` はすべて parse することを確認した。

ただし受入 §4.3 は式種別ごとの取得 field を固定していないため、指摘のとおり補強が必要である。

#### 1-c. 型メタの 6 箇所

**挙げた論理経路に重大な不足は見つからないが、「6 箇所」という数え方は整理した方がよい。**

実際に分岐修正が必要なのは次である。

1. `execute.ts:1697-1715` — scalar subquery から batch variable を作る numeric 判定
2. `execute.ts:2598-2618` — alias semantics（union 型追加に伴う分岐修正。valid query での HAVING 到達性とは別）
3. `execute.ts:4292-4302` — `inferWindowColumnMeta`
4. `execute.ts:4312-4338` — direct physical APP の source metadata load gate
5. `process.ts:1826-1841` — engine の出力 ORDER semantics

`execute.ts:4453-4454` と `:5881-5882` はどちらも既に `inferWindowColumnMeta(column, resolveField)` を呼ぶ generic consumer であり、helper を正しく直せば呼び出し側の kind 分岐追加は不要である。「同期箇所」より「確認すべき consumer」と書く方が正確である。

```ts
// src/execute.ts:4453-4454
} else if (column.type === "WINDOW_COL") {
  meta = inferWindowColumnMeta(column, resolveField);
}
```

```ts
// src/execute.ts:5881-5882
} else if (column.type === "WINDOW_COL") {
  meta = inferWindowColumnMeta(column, resolveField);
}
```

型以外では EXPLAIN の window detail が `windowKind === "AGGREGATE"` に限定されている (`execute.ts:10909-10925`)。VALUE の detail を出す契約にするなら影響範囲へ追加が必要だが、現 R1 は VALUE の EXPLAIN 表示を要求していないため、本レビューでは必須指摘には数えていない。

#### 1-d. `default` を取らない判断

**判断は妥当で、利用者は次の CTE で `CASE` を書ける。B129 と矛盾しない。**

同じ SELECT で `CASE(... LAG ...)` とするのではなく、`LAG` を列として materialize した次の SELECT で `CASE WHEN 前月 IS NULL ...` とする。現行 `parseWith()` は複数 CTE を扱え、既存 B129 test も同じ回避形を parse している (`src/parser/__tests__/window.test.ts:138-142`)。

ただし利用者負担は CTE が 1 段増えることであり、R1 の「2 段」表記と完全例を直す必要がある。月次に欠けがある場合の意味も「直前に存在する月の行」であって必ずしも暦上の前月ではない。

### 2. 代表 SQL は実際にパースできるか

- 現行コードでは `LAG` 未実装のため、R1 §1.1 の exact SQL は `「LAG」という関数はありません` で reject する。これは実装前なので当然であり、機能の否定材料ではない。
- `LAG` を既存 aggregate window に置き換えた構造検証では、`GROUP BY` を含む CTE の外側で window を使う 2 段形は parse した。
- 月次 CTE、window CTE、外側 CASE の 3 段形も parse した。
- parser 自体にも `WITH 月別 AS (SELECT ... SUM(...) ... GROUP BY ...) SELECT * FROM 月別` の既存 test がある (`src/parser/__tests__/parser.test.ts:1042-1050`)。

したがって、**CTE の内側に GROUP BY、外側に window を置く構造は可能**である。実装後は上記の exact 3 段 `LAG` SQL を parser test と full execute test で固定する必要がある。実機実行は未確認。

### 3. `applyWindow` の 3 分岐と `LAG` の実装位置

**`applyValueWindow` の新設が素直であり、順位系ループへの相乗りは勧めない。**

- ranking は peer 比較と rank / dense-rank state を持つ。
- aggregate window は accumulator と frame semantics を持つ。
- VALUE は target index の行で引数式を評価し、境界外を空文字にする。

状態と出力型が異なるため、dispatch だけ共有し、処理 helper は分ける方が fail-closed にしやすい。

`sortDecoratedRows` の comparator / metadata 経路を使うのは B125 と同じで正しい。ただし現行は sort **結果**を window 列間で共有しない。同じ SELECT に ranking、aggregate、LAG が 1 列ずつあれば、3 回 partition map を構築し、各 window の各 partition を 1 回ずつ sort する。異なる ORDER BY の正しさは保たれる。同じ spec の cache は最適化であり、本 Phase の必須条件にしなくてよい。

### 4. `offset` の扱い

- `0` を自身とする契約は `target = index ± offset` と自然に一致し、現行 window の 0-based loop と整合する。
- partition 長以上は index 範囲外として空文字にすべきである。§2.1 と一致し、§6-3 は削除する。
- safe integer literal の限定は正しい。既存 `parseUnsignedInt()` は safe integer を確認しないため専用検証が必要。
- 将来 `@n` を許す余地は残る。AST を今は `offset: number` としても union へ拡張できるが、R2 では「値域は同じ、operand を literal から resolved variable へ拡張する」と書いておくとよい。

### 5. 非全順序 `ORDER BY` の決定性

**B127 の判定ロジックは抽出すれば共有できるが、現状の関数をそのまま再利用はできない。**

共有できる核は、direct single physical APP で ORDER key に `$id` または RECORD_NUMBER が 1 つでもある場合に total order を証明する conservative proof である。aggregate/default RANGE の入口条件と warning 文は共有できない。代替案は純粋 helper を抽出し、VALUE 固有 warning を別に組み立てること。JOIN / CTE は現行 B127 と同様に証明不能として警告するのが保守的である。

### 6. 受入条件の穴

穴がある。

1. §4.2 の「ロードゲートを通る」は内部要求で、結果から欠落を検出できない。
2. direct APP の option metadata は、辞書順と option 順が異なる fixture を後段 ORDER BY して初めて検出しやすい。
3. numeric / date / string / option は raw 表示だけでなく、CTE / temp の後段 consumer を通す必要がある。
4. §4.3 は plain field だけでなく、算術、文字列関数、CASE condition/result、連結、解決済み変数を table-driven にする必要がある。
5. B129 は「ParseError」だけでなく指定診断本文を確認する。
6. offset `N` / `N+1` がない。
7. B127 warning の direct / JOIN / CTE context がない。
8. §4.5 は完全 3 段 SQL と独立期待値を記載する必要がある。

### 7. `LAG` / `LEAD` を soft keyword にするか

**soft keyword にするべきである。**

現行 lexer は keyword map にない語を IDENT とし、parser の soft keyword は `IDENT` の大文字比較で判定する (`parser.ts:3853-3855`)。したがって `IDENT(LAG|LEAD) + LPAREN` のときだけ function と解釈すれば、フィールド `LAG` / `LEAD` を壊さない。hard keyword にすると `parseIdentifier()` が IDENT / BIDENT しか受けないため、非引用 field が回帰する。

---

## 前回レビュー 16 件の反映確認

前回 16 件のうち、移動フレーム固有として棚上げした 8 件は本 R1 の実装条件から外れている。残る 8 件の確認結果は次のとおり。

| 前回の指摘 | R1 反映 | 判定 |
|---|---|---|
| `isRankingWindow` が VALUE を ranking と誤判定 | §3.1 positive discriminator、3 分岐、unknown fail-closed | **反映済み** |
| VALUE 引数 field が required-field から漏れる | §3.2 で VALUE に `walkAggregateArg` | **反映済み**。受入の式 matrix は補強要 |
| VALUE が number 扱い、source meta gate 外 | §3.3 で経路列挙 | **概ね反映済み**。受入を観測可能にする必要あり |
| 任意 default と引数型継承が矛盾 | §2.3 で第 3 引数を非対象 | **反映済み**。3 段完全例が必要 |
| parser 分岐 / soft keyword が未定義 | §5 と §6-1 | **一部反映**。soft 方針と comma-aware parser が未確定 |
| offset の整数が safe integer まで固定されていない | §2.2 で safe integer | **反映済み**。超過規範の矛盾は新たに修正要 |
| raw 値評価に既存 aggregate helper をそのまま使えない | §2.1 で skip しない旨 | **一部反映**。専用 evaluator の契約が不足 |
| 非全順序 ORDER BY の決定性契約がない | §2.4、§3.4、§6-2 | **一部反映**。warning 方針と helper 抽出が未確定 |

したがって、**8 件は漏れなく言及されているが、完成度としては 4 件反映済み、4 件一部反映**である。

棚上げ側へ移した 8 件（旧代表 SQL の移動平均部分、7 日と 7 行、frame bounds、clipping、prefix sum、単調キュー、oracle、moving-frame 受入）は、現 R1 の `LAG` / `LEAD` 実装には不要であり、棚上げ判断は妥当である。ただし旧代表 SQL 指摘のうち B129 の「window 結果を同じ SELECT の式に入れない」という一般部分は本スコープにも関係するため、今回の 3 段 SQL と B129 診断受入として残すべきである。

---

## 仕様が正しかった点

R2 で消さない方がよい点は次のとおり。

1. 移動フレームを棚上げし、実需が明確な `LAG` / `LEAD` に絞ったスコープ判断。
2. `ValueWindowColumn` を ranking / aggregate と分け、positive discriminator と unknown fail-closed を採る方針。
3. legacy の `windowKind === undefined` だけを ranking 互換として残す方針。
4. VALUE 引数を既存 AggregateArgExpr 相当とし、required-field walker と型推論を再利用する方針。
5. 引数型を出力型として継ぎ、第 3引数 `default` を本 Phase で取らない方針。
6. `offset` を省略時 1、非負 safe integer、`0` は自身とする契約。
7. partition 越境を禁止し、境界外と参照先の空セルを空文字にする契約。
8. VALUE は aggregate の空値 skip を通さないという区別。
9. `applyValueWindow` を独立 helper とし、`sortDecoratedRows` の comparator / metadata を共有する方針。
10. ranking、aggregate window、VALUE window を同じ SELECT に混在でき、別々の ORDER BY を持てる受入。
11. `GROUP BY` / aggregate との同一 SELECT 併用拒否、`SELECT DISTINCT` 併用維持、AS alias 必須、B129 維持。
12. direct APP の source metadata gate、CTE / 一時テーブルの型伝播、引数だけに現れる field を明示的に受入対象へ挙げたこと。
13. 非全順序 ORDER BY を黙って決定的とみなさず、B127 と同じ問題として扱ったこと。

---

## R2 の最小修正チェックリスト

1. offset 超過を空文字に確定し、§6-3 を削除、`N` / `N+1` 受入を追加する。
2. 完全入力理由を `WINDOW_ORDER` と明記する。
3. `LAG` / `LEAD` を soft keyword に確定し、`IDENT + LPAREN` 分岐と field 互換を仕様化する。
4. comma-aware な value arg parser と safe-integer 専用検証を明記する。
5. B129 nested scanner と direct arithmetic reject を VALUE 対応し、診断本文を受入で固定する。
6. §1.1 / §4.5 を完全 3 段 SQL に直し、parser / full execute / 実機独立検算へ同じ SQL を置く。
7. B127 の total-order proof を helper 化し、VALUE warning 方針を確定する。
8. VALUE 専用の行引数 evaluator と空値正規化を明記する。
9. metadata gate と required-field を観測可能な fixture / mock assertion に直す。
10. `sortDecoratedRows` の共有は comparator 実装共有であり、sort result cache は非要件と明記する。
