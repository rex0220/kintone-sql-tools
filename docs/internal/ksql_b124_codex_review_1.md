# B124 Phase 1 仕様 codex レビュー（1 回目）

## 結論

**要修正（高 4 件・中 4 件・低 2 件、計 10 件）。**

案 A1/A2 の方向性、fail-closed、SELECT と `HAVING` を対称にする判断、修飾参照を保持する AST 案は妥当である。一方、現 R1 のままでは次の 4 点で誤実装または誤った契約になる。

1. 文法は任意順のオペランドを許可しているが、既存の SELECT / `HAVING` は式が集計関数から始まる場合しか集計算術式の入口へ入らない。
2. `ROLLUP` / `CUBE` / `GROUPING SETS` がスコープから除外されておらず、キーが当該 grouping set に含まれない小計・総計では定数性が成立しない。
3. `SUM(a) * c = SUM(a * c)` は binary64 では一般に厳密一致せず、`c` が非数値なら現実装では外側が `NaN`、内側が `0` になり得る。
4. 専用 `AGG_VARIABLE` は既存の変数解決器・静的参照解析が認識しないため、「既存のバッチ変数解決に委ねる」だけでは動かない。

R2 では少なくとも上記を確定し、§7 と §8 を本レビューの列挙・受入案へ置き換えてから実装着手すべきである。

## 指摘

### [重要度: 高] 非集計オペランドから始まる式は提案変更だけではパーサ入口へ到達しない

- 該当: 仕様 §2 / §5.1 / §8、コードの `src/parser/parser.ts:1311-1322`, `src/parser/parser.ts:1357-1368`, `src/parser/parser.ts:2574-2586`
- 内容: §2 の文法は `<被演算子>` の並び順を制限していないため、`単価 * SUM(a)`、`@r * SUM(a)`、`(単価 + SUM(a))` も許可対象に読める。しかし SELECT は先頭が `@変数` なら `VARIABLE_COL`（かつ `AS` 必須）へ入り、集計算術式は先頭が集計関数のときだけ `continueAggArith(ref)` へ入る。`HAVING` 左辺も同様に集計関数開始時だけ `AGG_FIELD` を作る。
- 根拠:

  ```ts
  if (this.peek().kind === TokenKind.VARIABLE) {
    ...
    if (!this.consume(TokenKind.AS)) {
      throw new ParseError("SELECT 列のバッチ変数には AS alias が必要です", this.peek());
    }
  }
  ...
  const aggFunc = this.tryAggregateFunc();
  if (aggFunc !== null) {
    const ref = this.parseAggregateRef(aggFunc);
    if (this.isArithOp(this.peek().kind)) {
      const expr = this.continueAggArith(ref);
  ```

  `HAVING` 側も `const aggFunc = this.tryAggregateFunc(); if (aggFunc !== null) ... this.continueAggArith(ref)` である。
- 提案: 次のどちらかを仕様で選ぶ。
  1. 任意順を契約にするなら、SELECT 列・`HAVING`・CASE 結果・文字列関数引数の入口で「式全体に集計を含む」形を安全に振り分ける設計を §5 に追加する。
  2. Phase 1 を集計関数開始形に限定するなら、文法を `<集計関数呼び出し> ...` に狭め、`単価 * SUM(a)` と `@r * SUM(a)` は拒否と明記する。

  受入には少なくとも左右反転、括弧開始、単項マイナス、CASE/文字列関数内の各形を加える。

### [重要度: 高] grouping sets では「GROUP BY に書かれた列はグループ内で一定」が成立しない

- 該当: 仕様 §1 / §3.1 / §3.4 / §5.2 / §10、コードの `src/parser/parser.ts:1141-1160`, `src/engine/process.ts:323-395`, `docs/ksql_language_reference.md:1626`
- 内容: R1 は通常の `GROUP BY` と `ROLLUP` / `CUBE` / `GROUPING SETS` を区別していない。しかし grouping sets の小計・総計では、全 grouping item の一部が現在の set から外れる。外れた列はそのバケット内で一定ではなく、出力行では `""` に上書きされる。したがって `SUM(a) * key` の `key` を元行から読む SELECT 評価と、実体化行から読む `HAVING` 評価は一致しない。
- 根拠:

  ```ts
  const includedCanonicalIds = new Set(set.items.map((item) => item.canonicalId));
  ...
  for (const item of spec.allItems) {
    const value = includedValues.get(item.canonicalId) ?? "";
    outRow[item.directKey] = value;
  }
  ```

  また parser は ordinary `groupBy` と `grouping` を別プロパティに格納する。`ROLLUP` / `CUBE` / `GROUPING SETS` のとき `groupBy` は空のままである（`parser.ts:1138-1154`）。
- 提案: Phase 1 では `grouping !== undefined` の SELECT に `AGG_GROUP_KEY` を明示拒否するのが最も安全である。対応する拒否テストを `ROLLUP`、`CUBE`、`GROUPING SETS`、`HAVING` に置く。将来許可するなら「全 grouping set に含まれる列だけ」等の別仕様と、SELECT/HAVING が grouping-row membership を共有する評価設計が必要である。

### [重要度: 高] §3.1/§8.1/§9 の「同値」は binary64 と NaN 規則の両方で偽

- 該当: 仕様 §3.1 / §3.3 / §8.1 / §9 / §10、コードの `src/engine/process.ts:610-613`, `src/engine/process.ts:648-670`, `src/engine/process.ts:690-700`, `docs/ksql_language_reference.md:3149`
- 内容:
  - binary64 では `c × Σaᵢ` と `Σ(aᵢ × c)` の丸め位置・回数が違うため、厳密一致は保証されない。例えば JavaScript で `aᵢ = 0.1` を 10 件、`c = 0.1` とすると、外側は `0.09999999999999999`、内側は `0.10000000000000003` になる。
  - `c` が非数値のグループキーなら外側は `SUM(a) * NaN = NaN`。内側の `a * c` は各行で `NaN` となって集計入力から除外され、空の `SUM` は初期値 `0` を返す。よって R1 自身が許可する非数値キーで `NaN !== 0` になる。
- 根拠:

  ```ts
  // 集計引数の算術式
  const n = evalArithExpr(arg, row);
  if (isNaN(n)) return null;
  ...
  case "SUM": return nums.reduce((a, b) => a + b, 0);
  ```

  外側は `evalAggArithExpr` が両辺を Number としてそのまま `l * r` する。
- 提案:
  - 「数学的には同値。ただし binary64 の丸めと NaN/空入力規則により実行結果の厳密一致は保証しない」へ修正する。
  - APP4229/4228 の既知の整数データは既知期待値との一致を固定し、一般的な小数受入は相対/絶対許容誤差で比較する。
  - 非数値キーは外側 `NaN` を単独で受け入れ、内側回避形との同値を主張しない。`NaN`、空セル、全行 NaN、混在入力を独立テストにする。

### [重要度: 高] `AGG_VARIABLE` は既存の変数解決・静的参照解析を通らない

- 該当: 仕様 §4 / §6 / §8.2、コードの `src/execute.ts:2070-2132`, `src/execute.ts:2194-2211`, `src/core/batch.ts:154-180`
- 内容: 既存の実行前解決は `type === "VARIABLE"`、静的な未定義・前方参照・未使用解析は `VARIABLE` / `VARIABLE_COL` / `VARIABLE_IN_LIST` だけを認識する。新タグ `AGG_VARIABLE` は再帰走査されても値へ置換されず、参照としても数えられない。さらに現行の算術変数は非数値を `ArgumentError` にするが、R1 は `AGG_VARIABLE` の非数値時挙動を定義していない。
- 根拠:

  ```ts
  if (obj["type"] === "VARIABLE" && typeof obj["name"] === "string") {
    ...
    if (numericArithmeticOperand && value.type !== "number" ...) {
      throw new Error(`ArgumentError: variable @... is not numeric ...`);
    }
  }
  ```

  ```ts
  if ((type === "VARIABLE" || type === "VARIABLE_COL" || type === "VARIABLE_IN_LIST")
      && typeof obj["name"] === "string") {
    refs.push(...);
  }
  ```
- 提案: `AGG_VARIABLE` を維持するなら、少なくとも batch analyzer、実行時 resolver、未解決変数 backstop、ラベル、SELECT/HAVING 両評価を §7 に列挙し、数値/文字列/配列/relative-date/未定義の規則を決める。より小さい設計は `VariableRef` を `AggOperand` に加え、既存 resolver が `AGG_ARITH.left/right` の `VARIABLE` を `NUMBER` へ置換する経路を再利用すること。その場合も非数値は既存の算術どおりエラーであり、§3.3 の「非数値は NaN」と区別して明記する。

### [重要度: 中] P1 の GROUP BY membership は文字列一致では既存の名前解決契約を表せない

- 該当: 仕様 §5.1-§5.3 / §11.4、コードの `src/types/ast.ts:710-714`, `src/core/optimization/plainGroupByPlan.ts:159-205`, `docs/ksql_language_reference.md:1409-1432`
- 内容: ordinary `GroupByKey` は `FIELD_NAME`、式、関数を持ち、`FIELD_NAME` は実行計画で物理フィールド優先、次に SELECT alias として解決される。JOIN の非修飾名は曖昧になり得る。パース直後の文字列だけでは、`x` と `m.x` が同じ物理列か、`GROUP BY x` が物理列か SELECT alias かを確定できない。仕様は「含まれる」の同一性規則と alias GROUP BY の扱いを定義していない。
- 根拠: `resolveFieldName` は qualifier と field code を分け、物理候補をスキーマで検索し、物理列が無い場合だけ非修飾名を SELECT alias へ fallback する（`plainGroupByPlan.ts:177-205`）。
- 提案: Phase 1 の安全な規則を明文化する。推奨は「ordinary GROUP BY の `FIELD_NAME` として書かれ、metadata-backed planning で同じ physical source/field に canonical 解決された参照だけ」。parser 後段では候補 AST と位置情報を保持し、最終 membership は plain GROUP BY resolution plan と同じ解決器で行う。ParseError を必須にするなら、パース時には厳密表記一致だけを許可するという意図的な狭い契約に変え、その制限を文書化する。

### [重要度: 中] §7 の走査一覧が production code の主要経路を欠いている

- 該当: 仕様 §7 / §11.2、コードの `src/converter/selectToKintone.ts:289-324`, `src/converter/selectToKintone.ts:568-582`, `src/converter/dmlToKintone.ts:250-275`, `src/engine/evalFunc.ts:703-731`, `src/engine/process.ts:1596-1702`, `src/execute.ts:3105-3124`, `src/execute.ts:3831-3864`, `src/execute.ts:4103-4111`
- 内容: 現一覧は `src/engine/evalFunc.ts` の実 evaluator、`src/execute.ts` の planner/meta/field-ref 走査、select converter の二系統の field collector、DML 共通 CASE/string collector 等を欠く。提案 union をそのまま足すと、複数箇所は TypeScript narrowing 後に新タグが残ってコンパイルエラーになり、別の箇所は黙って group-key field を収集しない。
- 根拠: 完全一覧と分類は後掲「§3.2」を参照。
- 提案: §7 を後掲一覧へ置き換える。特に型追加直後にコンパイルで壊れる箇所と、コンパイルは通るが field collection が欠落する箇所を分ける。

### [重要度: 中] `CaseResult` は `AggOperand` を含んでおらず、CASE 波及の記述が不正確

- 該当: 仕様 §7 / §8.4.3、コードの `src/types/ast.ts:349-355`, `src/types/ast.ts:401-412`, `src/types/ast.ts:1125-1144`, `src/parser/parser.ts:1946-1973`
- 内容: `StringFuncArg = ScalarValueExpr | AggOperand` は正しいが、`CaseResult` は `... | AggregateRef | AggArithExpr` であり `AggOperand` そのものではない。したがって `AggGroupKeyRef` / `AggVariableRef` を追加しても CASE の direct result union には自動伝播しない。現 parser も CASE result が集計関数で始まる場合だけ `continueAggArith(ref)` を使う。
- 根拠:

  ```ts
  export type StringFuncArg = ScalarValueExpr | AggOperand;
  export type CaseResult = ArrayLiteral | ScalarValueExpr | ArithNode | AggregateRef | AggArithExpr;
  ```
- 提案: 「CASE の集計算術式内部に新 leaf が現れる」ことと、「CASE result 自体が新 leaf になる」ことを分ける。Phase 1 で前者だけなら `CaseResult` union は変えないと明記し、`CASE ... THEN SUM(a) * key` と左右反転形を受入へ具体化する。

### [重要度: 中] 受入条件が parser routing・変数基盤・名前解決の誤実装を落とせない

- 該当: 仕様 §8
- 内容: 現受入はすべて `SUM(...) * key` の集計開始形であり、§2 が許す逆順を検出しない。未定義/前方参照/未使用警告、非数値/配列変数、修飾・非修飾の組合せ、alias GROUP BY、grouping sets、集計式のネスト、0 件入力も未固定である。§8.2 の「0 行にならない」は閾値次第で正しい 0 行もあり得るため、期待行 ID/値を固定しないと弱い。
- 根拠: parser routing と variable analyzer のコード根拠は高指摘 1/4、名前解決は中指摘 1 のとおり。
- 提案: §8 に次を追加する。
  - 左右反転・括弧・単項マイナス・四則/% の AST と実行値。
  - `m.x`/`x` の同一・不一致、JOIN 同名曖昧、GROUP BY alias。
  - 未定義・前方参照・未使用警告、数値/文字列/配列/relative-date 変数。
  - grouping sets の明示拒否。
  - 小数は tolerance、非数値/空/NaN は個別期待値。
  - `HAVING` は閾値ではなく残る具体的なキー集合を direct/alias で一致比較。

### [重要度: 低] 修飾名の HAVING 取得は成立するが、「applyGroupBy がグループキー列を書く」という根拠は不正確

- 該当: 仕様 §0 / §3.4 / §6.1 / §11.1、コードの `src/engine/process.ts:291-306`, `src/engine/process.ts:95-108`, `src/engine/evalFunc.ts:734-742`
- 内容: ordinary `applyGroupBy` は `FIELD_NAME` のグループキーを個別に出力行へ書いていない。`outRow = { ...groupRows[0] }` で元行の全列をコピーし、式キーだけを上書きする。JOIN/alias 行は `flatten` が `m.仕入価格` と非修飾 `仕入価格` の両方を持ち、`resolveFieldRef` も修飾名から非修飾名へ fallback する。このため修飾名取得は現コードで成立するが、仕様の説明は実装と違う。
- 根拠:

  ```ts
  const outRow: ProcessRow = { ...groupRows[0] };
  ...
  if (alias) {
    row[`${alias}.${field}`] = strVal;
    row[field] = strVal;
  }
  ```

  `resolveFieldRef` はまず `row[field]`、次に dot 後の非修飾キーを引く。
- 提案: §0/§3.4/§6.1 を「ordinary GROUP BY 出力行は先頭入力行をコピーするため、検証済みグループキーの修飾/非修飾値を保持する」に直す。これは grouping sets には適用しない。

### [重要度: 低] evaluator の所在と line anchor が現コードとずれている

- 該当: 仕様 §0 / §6 / §7、コードの `src/engine/evalFunc.ts:717-731`, `src/engine/evalWhere.ts:340-355`, `src/core/aggregateExpression.ts:126-130`
- 内容: `evalMaterializedAggregateOperand` は `src/core/aggregateExpression.ts` ではなく `src/engine/evalFunc.ts` にある。`core/aggregateExpression.ts` はラベル生成を担当する。`process.ts:688` なども現行行では数行ずれている。
- 根拠: `evalWhere.ts:347` は `evalMaterializedAggregateOperand` を呼び、定義は `evalFunc.ts:718`。`aggregateExpression.ts:126` は `aggregateOperandLabel`。
- 提案: R2 のファイル表を現コードへ更新し、関数名を主 anchor、行番号を補助にする。

## §3 の 6 点への回答

### 3.1 修飾名 `m.仕入価格` は HAVING 側の出力行から引けるか

**ordinary GROUP BY では引ける。SELECT と同じ raw 値になる。**

- `flatten(record, "m")` は `m.仕入価格` と `仕入価格` の両キーへ同じ文字列を書く（`process.ts:95-108`）。
- `applyGroupBy` は `outRow = { ...groupRows[0] }` とする（`process.ts:291-306`）。したがって qualified key は出力行に残る。
- `resolveFieldRef(row, "m.仕入価格")` は direct key、無ければ `仕入価格` を引く（`evalFunc.ts:734-742`）。

ただし、新 evaluator が `row[node.field]` を直接読むだけでなく `resolveFieldRef` と同じ規則を使うことが条件である。また grouping sets は別で、set から外れた item を `""` に上書きするため同じ結論にならない。

### 3.2 `AggOperand` / `AGG_ARITH` / `AGG_REF` の走査箇所と分類

分類は依頼書どおり、(a) 新メンバーを足しても影響なし、(b) 新メンバーの処理が要る、(c) 提案 union を足すと TypeScript narrowing/プロパティ参照が壊れる、である。production `.ts` を対象とした。

| 分類 | ファイル:行 / 関数 | 判定 |
|---|---|---|
| (b) | `src/parser/parser.ts:1282-1378` `parseSelectColumn` | 非集計先頭形を許すなら入口変更が必要。集計先頭限定なら拒否契約が必要 |
| (b) | `src/parser/parser.ts:1614-1669` `continueAggArith*` / `parseAggPrimary` | 2 leaf の parse、token 位置保持が必要 |
| (a) | `src/parser/parser.ts:1563-1593` aggregate detection | 式全体の top が `AGG_ARITH` なら既存判定で集計扱い。新 leaf 単独は集計ではない |
| (b) | `src/parser/parser.ts:2105-2129` `parseStringFuncArg` / `hasAggregateOperand` | 新 leaf を含む式の fallback/aggregate 判定を受入で固定。非集計先頭形を許すなら routing 変更 |
| (b) | `src/parser/parser.ts:1946-1973` CASE result | 集計開始形しか `continueAggArith` へ入らない。任意順なら入口変更 |
| (b) | `src/parser/parser.ts:2574-2596` HAVING `AGG_FIELD` | 集計開始形しか `AGG_FIELD` にならない |
| (b) | `src/parser/parser.ts:1123-1208` `parseSelect` | ordinary GROUP BY membership の local validation、HAVING を含む走査、grouping sets 拒否を置く候補 |
| (c) | `src/engine/process.ts:685-701` `evalAggArithExpr` | NUMBER/AGG_REF 以外を無条件に `AGG_ARITH` として `left/right` 参照するため新 leaf で壊れる。両 leaf の評価が必要 |
| (a) | `src/engine/process.ts:455-488` generic `collectAggregateRefs` | object recursion で `AGG_REF` だけ収集。新 leaf は再帰しても副作用なし |
| (c) | `src/engine/process.ts:1596-1600` `stringFuncDefaultKey` | AGG_REF/AGG_ARITH 以外を `ScalarValueExpr` と見なすため expanded `StringFuncArg` と不整合 |
| (a) | `src/engine/process.ts:1617-1637` aggregate-presence helpers | top `AGG_ARITH` の既存形は維持。`CaseResult` union 自体は自動拡張されない |
| (b) | `src/engine/process.ts:1644-1702` string/CASE aggregate resolution | 内部 `evalAggArithExpr` 更新で集計開始形は評価可能。任意順/direct leaf を許すなら tag 分岐も更新 |
| (c) | `src/engine/evalFunc.ts:703-714` `evalStringFuncArg` | 新 StringFuncArg tag が既存2 tagで除外されず `evalScalarValueExpr` へ渡る |
| (c) | `src/engine/evalFunc.ts:717-731` `evalMaterializedAggregateOperand` | NUMBER/AGG_REF 以外を `AGG_ARITH` と仮定。`AGG_GROUP_KEY` の `resolveFieldRef` と変数規則が必要 |
| (a) | `src/engine/evalWhere.ts:340-355` `AGG_FIELD` 入口 | wrapper は `AggOperand` evaluator を呼ぶだけで不変 |
| (c) | `src/core/aggregateExpression.ts:126-130` `aggregateOperandLabel` | NUMBER/AGG_REF 以外を `AGG_ARITH` と仮定。`key` と `@var` の安定ラベルが必要 |
| (c) | `src/core/aggregateExpression.ts:72-95` CASE/string labels | `StringFuncArg` 拡張後、新 tag が `scalarValueLabel` へ流れる。CASE direct union は自動拡張されない |
| (c) | `src/converter/selectToKintone.ts:289-324` simple field collector | 新 StringFuncArg tag が scalar collector へ流れる。`AGG_GROUP_KEY` は source field として収集が必要、変数は不要 |
| (b) | `src/converter/selectToKintone.ts:568-582` source-aware `walkAgg` / `walkStringArg` | `AGG_GROUP_KEY` は `addFieldRef` が必要。`AGG_VARIABLE` は field なし。StringFuncArg narrowing は更新が必要 |
| (a) | `src/converter/selectToKintone.ts:616-650` CASE/`AGG_FIELD` wrappers | top `AGG_ARITH` を `walkAgg` へ渡す構造は維持。leaf 処理は `walkAgg` 側 |
| (c) | `src/converter/dmlToKintone.ts:250-286` shared string/CASE field collectors | expanded StringFuncArg を scalar collector へ渡せなくなる。DML では集計到達は本来拒否だが共通 union の narrowing 更新が必要 |
| (a) | `src/converter/dmlToKintone.ts:597-617` DML CASE evaluator | CaseResult direct union が変わらない限り既存 aggregate rejection は不変 |
| (b) | `src/execute.ts:2070-2132` variable resolver | `AGG_VARIABLE` を維持するなら認識・置換・numeric context が必要。`VARIABLE` 再利用なら既存再帰を利用可能 |
| (b) | `src/execute.ts:2194-2211` unresolved-variable finder | 専用 tag を維持するなら追加が必要 |
| (b) | `src/core/batch.ts:154-188` variable-use collector | 専用 tag を維持するなら未定義/前方参照/未使用解析へ追加が必要 |
| (c) | `src/execute.ts:3105-3124` string/CASE field-presence | expanded StringFuncArg の新 tag が scalar pathへ残る。group key を field と数えるか用途別に決める必要 |
| (a) | `src/execute.ts:3831-3864` aggregate sort-ref collector | MIN/MAX/MODE の aggregate argument metadataだけが目的。新 group-key leaf はここでは収集不要 |
| (a) | `src/execute.ts:3869-3885` generic CASE aggregate-ref walker | object recursion で AGG_REF のみ処理し新 leaf は害なし |
| (b) | `src/execute.ts:4103-4111` CASE result metadata | top `AGG_ARITH` は number のまま。CaseResult direct leaf を許す場合だけ追加が必要 |
| (a) | `src/core/groupingValidation.ts:66-129` generic grouping/aggregate walkers | 現目的では AGG_ARITH を aggregate boundary として扱う。ordinary B124 membership の実装先にはそのまま流用できない |
| (a) | `src/core/dmlGuard.ts:96-124` statistical/ordinary aggregate detection | recursive object scanで AGG_REF を検出。新 leafは判定に影響なし |
| (a) | `src/core/applyPatchScope.ts:507-546` forbidden aggregate tags | 親 `AGG_ARITH` / `AGG_REF` で拒否するため既存禁止範囲は維持 |
| (a) | `src/converter/whereToKintone.ts:166-184` `AGG_FIELD` pushdown拒否 | wrapper tagで拒否するため不変 |
| (a) | `src/core/optimization/plainGroupByPlan.ts:39-45` aggregate marker補助 | 新 leaf単独は集計ではなく、親AGG_ARITHで既存判定可能 |

`aggregateOperandLabel` の推奨ラベルは `AGG_GROUP_KEY` が修飾を保持した `m.仕入価格`、`AGG_VARIABLE` が `@税率`。これにより `SUM(金額)*m.仕入価格` / `SUM(金額)*@税率` が alias 無しの `aggArithDefaultKey` になる。ラベルは parser が保持した表記と同じ canonical ruleを一つに決め、SELECT materialization、HAVING synthetic参照、ORDER BY、列 meta で共用する必要がある。

### 3.3 GROUP BY キー検証のタイミング

- **読み順の前提は正しい。** `parseSelect` は columns → FROM/JOIN → WHERE → GROUP BY → HAVING → ORDER/KORDER → LIMIT/OFFSET の順（`parser.ts:1123-1188`）。
- **既存併用チェックと同じ `parseSelect` 終端に local validation を置くことはできる。** この時点では columns、ordinary `groupBy`、`having` が全てある。
- **HAVING は同じ走査で拾える。** `having` は `SelectStatement` の同一ノードに格納される。ただし SELECT columns だけを走査してはならない。
- **WITH / UNION / scalar subquery は各 `parseSelect` 呼出しで local validation すればスコープを分離できる。** generic object walk で親 SELECT から子 `SELECT` / `SCALAR_SUBQUERY` へ降りる実装は不可。既存の `nodeHasAggregate` や grouping walkersもこの境界で return している（例 `parser.ts:1575-1577`, `groupingValidation.ts:73`, `127`）。
- **ただし parser 終端だけでは metadata-backed physical identity は分からない。** 厳密な同一性を求めるなら候補を保持し、plain GROUP BY planning と同じ resolver で最終検証する必要がある。ParseError を絶対条件にするなら、parser では表記一致だけを認める狭い契約になる。
- **grouping sets は ordinary `groupBy` と別 AST なので明示拒否が必要。**

### 3.4 §0 の実測 8 項目の裏取り

| 項目 | 判定 | コード根拠 |
|---|---|---|
| 現 AggOperand は集計関数・数値・括弧・単項マイナスのみ | CORRECT | `parser.ts:1642-1669` |
| `@変数` も拒否 | CORRECT | `parseAggPrimary` に VARIABLE 分岐がなく最後に ParseError (`parser.ts:1657-1669`) |
| HAVING の集計開始式も同じ `parseAggPrimary` を使う | CORRECT（限定付き） | `HAVING` は `continueAggArith(ref)` (`parser.ts:2574-2586`)。ただし式が集計関数で始まる場合のみ |
| raw 値がグループ内で一定 | CORRECT（ordinary GROUP BY のみ） | `evalGroupByKey` は row の文字列または式評価文字列を返し、`\x00` 連結で Map key化 (`process.ts:267-280`, `493-527`)。B71 physical pathも `row[resolution.runtimeKey]` を返す。canonical化なし |
| 通常算術の非数値は NaN | CORRECT | 算術 evaluator は `Number` 化した値を演算する契約。言語refも binary64/空セル規則を記載 (`docs/ksql_language_reference.md:3149`) |
| SELECT 側は group rows を持つ | CORRECT | `evalAggArithExpr(node, rows, ...)` (`process.ts:685-701`) |
| HAVING 側は materialized row を持つ | CORRECT（所在修正） | `evalWhere.ts:347` → `engine/evalFunc.ts:718`。ordinary出力行は先頭元行コピー |
| AGG_FIELD は押し下げ拒否 | CORRECT | `whereToKintone.ts:172-174` |

「8 項目すべて確定」の表題は、raw 一定と出力行取得に ordinary GROUP BY 限定を付け、HAVING の説明に集計開始形限定を付ければコードと一致する。

### 3.5 受入条件で検出できないもの

§8.1 の実データ比較で検出できるのは、APP4229/4228 の当該整数データについて、qualified group key の取得、外側乗算、JOIN 行集合、既知 8 行の materialization が正しいことだけである。

検出できないもの:

- 非集計オペランドが左に来る parser routing。
- 小数の丸め差。binary64 の厳密一致は不可。
- 非数値 key の外側 `NaN` と内側 `0` の差。
- 空セル、全 NaN、0 件グループ、除算ゼロ、 `%`。
- undefined/forward/array/string/relative-date variable と未使用警告。
- qualified/unqualified identity、JOIN 曖昧、GROUP BY alias。
- grouping sets の小計/総計。
- direct HAVING と alias HAVING が具体的に同じキー集合を返すか（単なる「0 行ではない」では弱い）。

浮動小数は `Object.is` / `===` を使わず、既知整数データだけ exact、一般小数は `abs(a-b) <= atol + rtol * max(abs(a), abs(b))` のような規則にする。NaN は tolerance 比較に混ぜず期待カテゴリを別にする。

### 3.6 仕様そのものへの回答

- **専用 AST の妥当性**: `AGG_GROUP_KEY` は「membership 検証済み」を型で示せるため妥当。ただし metadata-backed 検証まで終わる前に同タグを使うなら `candidate` と `validated` の区別は型だけでは保証されない。`AGG_VARIABLE` は既存 variable infrastructure から外れる費用が大きく、`VariableRef` 再利用の方が小さい。
- **HAVING 許可**: ordinary GROUP BY では妥当。SELECT alias と direct 式の非対称を作らない判断も正しい。grouping sets は除外が必要。
- **非数値を NaN**: group-key leaf の外側算術としては既存通常算術と整合する。ただし aggregate-argument の内側算術は NaN を skip するため、回避形との同値は成立しない。変数は現行 arithmetic resolver が非数値をエラーにするので別規則を明記する。
- **抜け**: parser routing、grouping sets、physical identity、variable analyzer/resolver、binary64/NaN、0 件、逆順/入れ子受入が主な抜けである。

## 仕様が正しかった点

- 現行の拒否は `parseAggPrimary` の意図的な fail-closed であり、静かな誤結果を返す既存バグではない。
- `@変数` と ordinary GROUP BY の物理フィールドキーは、許可対象を狭く定義すればグループ内定数として扱える。
- GROUP BY に無いフィールドや GROUP BY 自体が無い場合を拒否し、機能従属性を推論しない方針は安全である。
- SELECT と direct `HAVING` の両方を対象にし、alias 経路との非対称を作らない方針は妥当である。
- SELECT evaluator と HAVING materialized evaluator の二系統を両方変更する必要があるという指摘は正しい（定義ファイルだけ `engine/evalFunc.ts` へ修正が必要）。
- ordinary GROUP BY の raw grouping key は canonical 化されず、B71 physical resolution path も runtime row の raw 文字列を返す。
- ordinary GROUP BY では qualified key が出力行に残り、`resolveFieldRef` の fallback もあるため、`m.仕入価格` の HAVING 取得は実装可能である。
- `AGG_FIELD` は kintone query pushdown を明示拒否しており、新たな押し下げ設計は不要である。
- alias 無しの合成キーを一貫して生成しないと materialization / HAVING / ORDER BY が壊れるという警戒は正しい。
- 既存 ParseError 本文、B119-B122、alias 消失、CASE/文字列関数、ORDER BY/UNION/CTE を回帰対象にする方向は正しい。ただし具体ケースの追加が必要である。
- 言語リファレンス §8/§9 に許可形と拒否形の両方を書く方針は正しい。
