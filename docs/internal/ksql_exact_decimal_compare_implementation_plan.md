# B9: 最大30桁の厳密10進比較 実装計画

- ステータス: **実装完了・Claude レビュー承認・SemVer=major 確定（2026-07-18・[実機証跡](evidence/b9_exact_decimal_semver_probe.md)）**。primitive 検算 15/15・全 1,835 テスト green・実機で公開 v3.2.0 と MIN/MAX・ORDER BY が変わることを確認＝§8.3 の major 条件。**16桁超の比較結果が変わる互換性注意あり（従来は誤り）。ユーザー判断で v3.3.0 に含める・移行ガイドに明記**。
- 作成日: 2026-07-18
- 対象リリース: **v3.3.0 の土台（SemVer は §8 の実測 gate で確定。major 判定時は版番号を再計画）**
- 分担: **Claude=仕様レビュー・実機 SemVer 判定、Codex=実装・自動テスト**
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B9 / B29
- 課題文書: [B9 課題 R5](ksql_exact_decimal_compare_issue.md)（本計画の正）
- 後続仕様: [B29 数値精度・丸め仕様 R1](ksql_number_precision_semantics_spec.md)（B9 primitive の再利用側）
- 横断仕様: [文字列・比較の横断仕様](ksql_string_semantics.md) §4.5
- 参考書式: [v3 比較・ORDER BY 実装計画](ksql_v3_order_by_implementation_plan.md)、[B33 KORDER Cursor 実装計画](ksql_korder_cursor_implementation_plan.md)

---

## 1. 目的と完了条件

B9 は、kintone が文字列で返す最大30桁の NUMBER と SQL 数値リテラルを、比較完了まで binary64 に丸めずに扱う単一の有限10進 primitive を確立する。B29 はこの primitive を桁検証・量子化の土台として再利用し、別の decimal parser/comparator を作らない。

完了時は次を満たす。

1. 有限10進文字列の解析・正規化・比較を `Number()` / `parseFloat()` なしで行い、常に `-1 / 0 / 1` を返す。
2. SQL 数値リテラルの raw lexeme を lexer から AST、REST 変換、ローカル比較まで保持する。既存の `value: number` は算術・既存 DML consumer の互換用に残す。
3. typed number の固定バンド順は変えず、有限値バンド内部だけを厳密10進比較へ置換する。
4. WHERE / HAVING / CASE / サブテーブル UPDATE・DELETE・REORDER / ASSERT / BETWEEN / ORDER BY / MIN/MAX / GREATEST/LEAST の全経路を同じ primitive へ接続する。
5. SIMPLE raw REST と FULL_SCAN の結果が、同じ入力行列と明示的な `$id asc` tie で一致する。
6. JS 算術由来値について、B9 が保証する範囲と残る binary64 制限をテスト・文書で固定する。

## 2. 今回含めないもの

- `numberPrecision.digits` / `decimalPlaces` による書込み値検証
- `HALF_EVEN` / `UP` / `DOWN` の量子化と暗黙丸め
- `+ - * / %`、SUM/AVG、数値関数、CALC の任意精度10進評価
- 一般 NUMBER の `<=` / `>=` プレフィルタ押し下げ解禁。B9 では超集合性を再証明するだけで、allowlist 拡大は別変更とする
- typed string・型不明値を見た目で number に昇格する変更
- `$id` / `RECORD_NUMBER` 比較器の変更。これらは既に文字列ベースで厳密化済みである

## 3. 現行コードで確認した事実

行番号は 2026-07-18 の v3.2.0 working tree を基準とする。実装着手時に再度 `rg` で更新する。

### 3.1 binary64 で丸まる3経路

| 経路 | コード確定した現状 | 欠陥 |
|---|---|---|
| typed number の有限値バンド | `src/core/scalarCompare.ts:28-49`。`numberKey()` が `Number(value)` を作り、band 2 に `number` を保持し、`compareNumbers()` が `triCompare(a.value, b.value)` を呼ぶ | `9007199254740992` と `9007199254740993` が同値になる。`Number(" ") === 0` のため空白も有限値へ誤分類する |
| `GREATEST` / `LEAST` | `src/core/scalarCompare.ts:174-191`。`selectScalarExtreme()` が集合モード判定と大小比較の両方で `Number()` を直呼びする | 16桁超の異なる有限値が数値同値となり、コードポイント二次キーだけで勝者を決める |
| SQL 数値リテラル | `src/types/ast.ts:491-494` は `NumberLiteral.value: number` のみ。`src/parser/parser.ts:957-976,1034-1067,1769-1838,1863-1881,2095-2118` で `Number(tok.value)` またはその符号反転を行う | 比較器へ到達する前に raw lexeme を失う。WHERE/BETWEEN/IN、算術葉、ASSERT、INSERT/UPSERT VALUES が同じ型を共有するため波及範囲が広い |

lexer の現行数値文法は `src/lexer/lexer.ts:152-176` の `digits [ '.' digits ]` だけであり、指数表記を NUMBER token として受理しない。`Token.value` 自体は `src/lexer/tokens.ts:307-310` で文字列なので、lexer から parser へ字句を渡す器は既にある。

### 3.2 既存 `compareDecimal` の能力と限界

`src/core/dmlValidation.ts:140-167` には次の既存実装がある。

- `isFiniteDecimal()` は符号付き整数、小数、`.5`、`1.` を正規表現で受理する
- `compareDecimal()` は符号、先頭ゼロ、`-0`、末尾ゼロを正規化し、整数部の桁数・辞書順と、小数部の右ゼロ padding で厳密比較する
- `validateAndNormalizeDmlValue()` の NUMBER 分岐（同 `:45-55`）が `minValue` / `maxValue` 検証に使用する
- 指数表記を解析しない。`compareDecimal("1e+21", ...)` は前提外であり、validation 前段の `isFiniteDecimal()` も拒否する
- 正規化処理が関数内 closure であり、B29 が桁数・scale・量子化へ再利用できる公開表現を返さない

したがって、別の比較器を新設せず、このアルゴリズムを「parse → normalized representation → compare」に分解して共通化する。

### 3.3 共有比較器の現行消費経路

- `src/engine/evalWhere.ts:108-157,323-341`: WHERE、HAVING、CASE WHEN と、同 evaluator を使う通常/サブテーブル DML の残余評価。数値リテラルは `String(value.value)` で既に丸め済み
- `src/parser/parser.ts:1597-1607`: WHERE BETWEEN は `>= AND <=` へ展開され、上記経路へ入る
- `src/execute.ts:1248-1297`: ASSERT と ASSERT BETWEEN は `compareScalarValues()` を直接使うが、`evalAssertOperand()` が `String(operand.value)` を返す
- `src/engine/process.ts:299-336`: MIN/MAX は直接フィールド値を保持し、`compareCanonicalValues()` を使う
- `src/engine/process.ts:565-588,1044-1068`: FULL_SCAN / WINDOW の ORDER BY は `compareCanonicalValues()` を使う
- `src/execute.ts:4870-4980`: サブテーブル REORDER は `compareCanonicalValues()`、WHERE は `evalWhere()` を使う
- `src/engine/evalFunc.ts:159-162`: GREATEST/LEAST は `selectScalarExtreme()` を使う

### 3.4 AST `value: number` の既存消費先

raw lexeme の追加時に壊してはならない主な consumer は次である。

- 算術評価: `src/engine/evalFunc.ts:20-32`、`src/engine/process.ts:353-370`、`src/converter/dmlToKintone.ts:403-430`
- ローカル比較・ASSERT: `src/engine/evalWhere.ts:323-341`、`src/execute.ts:1291-1297`
- INSERT/UPDATE 値: `src/converter/dmlToKintone.ts:598-606`、`src/core/dmlValidation.ts:82-103`、`src/core/dmlValidationCandidates.ts:83`
- REST query: `src/converter/whereToKintone.ts:182-199`
- 表示名・診断: `src/converter/selectToKintone.ts:683-687`、`src/engine/process.ts:373-377,885-897`、`src/execute.ts:6051,6066`
- batch 変数: `src/execute.ts:1162-1200`。数値変数は現状 `number` だけを保持し、AST へ戻す時にも raw を持たない

制御用整数（LIMIT/OFFSET/REJECT LIMIT 等）の `Number(tok.value)` は safe-integer 検証を持つ別契約であり、`NumberLiteral` raw lexeme 化の対象に混ぜない。

## 4. 目標アーキテクチャ

### 4.1 既存 `compareDecimal` を拡張・共通化する

第一候補かつ本計画の採用案は、新規 leaf module `src/core/exactDecimal.ts` へ既存 `compareDecimal` のロジックを移し、指数表記対応と再利用可能な正規形を加えることである。`exactDecimal.ts` は他の project module を import しない。依存方向を次に固定する。

```text
exactDecimal.ts  <-  scalarCompare.ts
       ^         <-  dmlValidation.ts
       ^         <-  B29 precision validator / quantizer（後続）
```

これにより、現在 `fieldSemantics` だけを参照する `scalarCompare.ts` の leaf 性を実質維持し、`dmlValidation -> execute -> scalarCompare` の循環を作らない。`dmlValidation.ts` は互換のため `compareDecimal` / `isFiniteDecimal` を re-export し、既存 import を一度に破壊しない。

公開する内部 interface は次を基本案とする。

```ts
export type DecimalSign = -1 | 0 | 1;

export interface ExactDecimal {
  sign: DecimalSign;
  coefficient: string; // 0、または先頭・末尾ゼロを除いた ASCII digits
  scale: number;        // value = sign * coefficient * 10^(-scale)。指数表記では負も可
}

export function parseExactDecimal(input: string): ExactDecimal | null;
export function isFiniteDecimal(input: string): boolean;
export function compareExactDecimal(left: ExactDecimal, right: ExactDecimal): CompareResult;
export function compareDecimal(left: string, right: string): CompareResult;
```

`CompareResult` は循環回避のため `exactDecimal.ts` 内で定義して `scalarCompare.ts` が type import/re-exportするか、依存なしの極小 type module へ置く。`compareDecimal()` は両入力が有限10進でない場合に黙って `NaN` や文字列比較へ落とさず `ArgumentError` とする。外側 domain の分類は caller の責務とする。

`scale` を signed にするのは、`1e+21` を巨大なゼロ文字列へ展開せず `{ coefficient: "1", scale: -21 }` と保持するためである。B29 は同じ表現から次を導出できる。

```text
integerDigits = max(coefficient.length - scale, 0)  // zero は 0
fractionDigits = max(scale, 0)
```

B29 の量子化は coefficient の切断位置と carry をこの scale 上で計算する。B29 が別 regex、別 exponent parser、別 comparator を持つことは禁止する。

### 4.2 有限10進の構文・正規化契約

primitive は trim 後の次を受理する。

```text
[+-]?(?:digits(?:\.digits*)?|\.digits)(?:[eE][+-]?digits)?
```

SQL lexer は後方互換を優先し、既存どおり数字で始まる mantissa に限定して `digits [ '.' digits ] [ e/E [+-] digits ]` を NUMBER token とする。すなわち primitive は `.5` / `1.` を受理できるが、SQL 数値字句として今回新たに受理するのは `1e3` / `1.2E-3` 等であり、先頭 dot と末尾 dot の SQL 文法は拡張しない。指数部の欠落、safe integer で表せない指数、途中の非数字は parse error とする。

正規化は次で固定する。

- `-0`、`+0.000e99` は `{ sign: 0, coefficient: "0", scale: 0 }`
- 先頭ゼロと値を変えない coefficient 末尾ゼロを除き、その分だけ scale を調整する
- `1.10` と `1.1`、`100e-2` と `1` は同じ正規形
- 比較は符号、10進小数点位置、coefficient の仮想 zero-padding の順で行い、巨大な指数に比例する文字列を生成しない
- 入力長と指数の算術は safe integer を検査し、overflow 時は fail-closed にする
- `Infinity`、`-Infinity`、`NaN`、空セル、その他非数値は parse しない

### 4.3 typed number の固定バンドを維持する

`scalarCompare.ts:numberKey()` は分類順を明示し、次の固定バンドを変えない。

```text
空セル < -Infinity < 有限10進 < +Infinity < "NaN" sentinel < その他非数値
```

変更は band 2 の payload を `number` から `ExactDecimal` へ替え、band 2 同士を `compareExactDecimal()` で比較することだけである。最後のバンドはコードポイント順を維持する。typed string と型不明は従来どおり numberKey を通らない。

現行 `Number(" ")` により空白文字が有限値 0 と同値になる挙動は §4.5 の「その他非数値」契約と不一致なので、B9 後は末尾バンドへ移す。これは高精度比較とは別に検出された既存実装ドリフトとして、Phase 1 の固定バンド回帰で明示する。

### 4.4 `GREATEST` / `LEAST` の集合モードを保つ

横断仕様 §4.5.3 の既存契約を変えないため、集合全体の numeric/string mode 判定は現行どおり一度だけ行う。numeric mode の比較では、両値が有限10進として parse できる時だけ `compareExactDecimal()` を使い、±Infinity や既存の `Number()` coercion だけが受理する値との比較は従来の三方比較を使う。数値同値ならコードポイント二次キーを必ず適用し、一意の元文字列を返す。

この adapter により、`GREATEST('20','100') = '100'`、引数順不変、空文字最小という B19/B26 契約を保ちつつ、16桁超の有限10進同士だけを厳密化する。GREATEST/LEAST 用に別の decimal parser/comparator は作らない。

### 4.5 AST の raw lexeme 保持と互換設計

`NumberLiteral` は次へ拡張する。

```ts
export interface NumberLiteral {
  type: "NUMBER";
  value: number; // 既存算術 consumer の互換。精度保証には使わない
  raw?: string;  // parser 生成ノードでは必須。符号・指数を含む元字句
}
```

型上 optional とするのは、外部/テストが構築する既存 AST object の source compatibility を保つためである。parser が生成する全 NumberLiteral では raw を必須とし、共通 helper を通す。

```ts
makeNumberLiteral(raw: string): NumberLiteral
numberLiteralText(node: NumberLiteral): string // node.raw ?? String(node.value)
```

変更点は次のとおり。

- lexer: `readNumber()` に指数部を追加し、token.value に mantissa と exponent をそのまま残す
- parser: `Number(tok.value)` の散在を `makeNumberLiteral()` に集約する。単項 `+/-` は raw に符号を結合し、`-0` を失わない。数値単独を `parseSqlValue()` へ戻す際も object を作り直して raw を落とさない
- ast: `raw?: string` と共通 helper の配置を追加する。parser AST snapshot は raw 追加を意図的変更として更新する
- execute: ASSERT、batch `SET`/変数置換、サブテーブル代入で、比較・文字列化には `numberLiteralText()`、算術には `value` を使う。`VarValue` の number variant に `raw?: string` を伝播させる
- REST converter: WHERE/IN の数値を raw で直列化し、SIMPLE 経路でも丸めた字句を kintone へ送らない
- DML converter/validation: INSERT/UPSERT/UPDATE の単純 NumberLiteral は raw を送る。既存 `value:number` を読む算術式はそのまま binary64 とし、B9 の保証範囲外であることを分離する
- 表示名/診断: SQL 式の再構成は可能な限り raw を使うが、公開列名の互換 fixture を確認し、不要な表記変更を release 差分へ混ぜない

### 4.6 JS 算術由来値の保証境界

B9 では算術 engine を任意精度化しない。採用する契約は「制限を残す」であり、fail-closed へは変更しない。

- kintone の raw 数値文字列、raw を保持した単純 SQL 数値リテラル、`ExactDecimal` が生成した値は元の10進値を厳密比較する
- JS 算術・SUM/AVG・数値関数が返す `number` は、`String(number)` が表す既に丸め済みの有限10進値として比較する
- その文字列同士の比較は決定的かつ厳密だが、演算前の10進入力や数学上の正解を復元する保証はない
- `9007199254740992 + 1`、`0.1 + 0.2`、`1e21` を制限 fixture にし、前二者の precision loss を「B9 で直る」と誤認させない。`String(1e21) = "1e+21"` は指数 parser が受理する
- 任意精度算術は B29 v2 の所有範囲とする

## 5. 全消費経路の配線表

| 利用者経路 | 現行接続点 | B9 の配線 | 主な自動テスト |
|---|---|---|---|
| WHERE | `evalWhere.ts:108-157,323-341` | NumberLiteral 右辺は raw、typed number 左辺は band 2 exact comparator | `evalWhere.test.ts`、`execute.test.ts` |
| HAVING | `process.ts:1055-1056` から同 evaluator | 集計後の数値文字列と raw literal を同じ comparator へ | `process.test.ts`、`execute.test.ts` |
| CASE WHEN / IF | `evalWhere` を分岐条件に共有 | 条件比較を exact 化。結果値の NumberLiteral raw も保持 | `process.test.ts`、`execute.test.ts` |
| BETWEEN | `parser.ts:1597-1607` で `>= AND <=` | low/high の raw を保持し、展開後の2比較を exact 化 | `parser.test.ts`、`evalWhere.test.ts` |
| ASSERT / ASSERT BETWEEN | `execute.ts:1248-1297` | `evalAssertOperand()` が raw を返し、既存 shared comparator を使用 | `executeAssert.test.ts`、`parser/__tests__/assert.test.ts` |
| 通常 UPDATE / DELETE | 対象選定が `evalWhere` | WHERE の shared exact comparator へ集約 | `execute.test.ts` |
| サブテーブル UPDATE / DELETE | expanded row に対する `evalWhere` | 親/行 NUMBER metadata を維持した exact comparator | `execute.test.ts` |
| REORDER WHERE / BY | `execute.ts:4905-4925,4953-4968` | WHERE は shared evaluator、BY は canonical comparator の band 2 exact 化 | `execute.test.ts` |
| FULL_SCAN ORDER BY / WINDOW | `process.ts:565-588,1058-1068` | canonical comparator の有限値 band だけ exact 化。peer は `1`/`1.0` のまま | `process.test.ts`、`window.execute.test.ts` |
| MIN / MAX | `process.ts:299-336` | 物理 NUMBER 文字列を変換せず exact comparator へ | `process.test.ts`、`execute.test.ts` |
| GREATEST / LEAST | `evalFunc.ts:159-162`、`scalarCompare.ts:174-191` | §4.4 adapter で有限10進ペアを exact 化し、二次キーを維持 | `scalarCompare.test.ts`、`process.test.ts` |
| SIMPLE raw REST | `whereToKintone.ts:182-199` | NumberLiteral raw を送信し、parser 後の丸めを防ぐ | `whereToKintone.test.ts`、実機一致 gate |
| INSERT/UPSERT VALUES | `dmlToKintone.ts:598-606` | 単純 literal は raw を payload/validation へ渡す。`value:number` consumer は残す | `dmlUnarySign.test.ts`、`dmlValidation.test.ts`、`execute.test.ts` |
| CLI / MCP / plugin | 共有 parser/engine bundle | surface 独自 comparator を追加せず同じ module を bundle | build、surface smoke |

IN/NOT IN の typed number 等価判定も `Set<string>` の字面一致のままにせず、B9 の「typed number の等価判定を共有」の対象として監査する。`evalWhere.ts:126-138` の `typedInContains()` が型別に exact equality を使うこと、`1` / `1.0` / 指数同値が peer になることを専用テストで固定する。

## 6. 実装フェーズと変更ファイル

各 Phase は独立 review 単位とし、fail-first test → 実装 →対象 suite の順で進める。本書作成作業では以下のコード・テスト変更を行わない。

### Phase 0: baseline fixture と契約固定

- v3.2.0 で `9007199254740992` / `9007199254740993` が偽同値になる unit fixture を追加する
- typed number 固定バンド、GREATEST/LEAST の集合モード・二次キー、DML min/max の既存挙動を characterization test にする
- SQL exponent の受理/拒否境界と raw AST shape を fail-first で固定する
- **変更ファイル**: `src/core/__tests__/scalarCompare.test.ts`、`src/core/__tests__/dmlValidation.test.ts`、`src/lexer/__tests__/lexer.test.ts`、`src/parser/__tests__/parser.test.ts`、`src/parser/__tests__/dmlUnarySign.test.ts`
- **新規ファイル**: `src/core/__tests__/exactDecimal.test.ts`、`src/core/__tests__/exactDecimal.property.test.ts`
- **テストファイル**: 上記7ファイル

### Phase 1: 既存 primitive の拡張・leaf 化

- `compareDecimal` の normalize closure を `parseExactDecimal()` へ分解し、指数表記、signed scale、zero canonicalization を実装する
- `compareExactDecimal()` を符号・小数点位置・仮想 padding で実装し、常に `-1/0/1` を返す
- `dmlValidation.ts` は新 module を利用・re-exportし、既存 min/maxValue 検証の結果を維持する
- `scalarCompare.ts` の band 2 を `ExactDecimal` へ変更し、固定バンド全体を回帰する
- GREATEST/LEAST adapter を exact finite pair へ接続する
- **変更ファイル**: `src/core/dmlValidation.ts`、`src/core/scalarCompare.ts`、Phase 0 で追加済みの `src/core/__tests__/exactDecimal.test.ts` / `exactDecimal.property.test.ts`、`src/core/__tests__/dmlValidation.test.ts`、`src/core/__tests__/scalarCompare.test.ts`
- **新規ファイル**: `src/core/exactDecimal.ts`
- **テストファイル**: `exactDecimal*.test.ts`、`scalarCompare.test.ts`、`dmlValidation.test.ts`

### Phase 2: lexer / parser / AST raw lexeme

- exponent tokenization と不正指数の LexError を追加する
- `NumberLiteral.raw?: string`、`makeNumberLiteral()`、`numberLiteralText()` を追加する
- parser 内の全 NumberLiteral 生成箇所を helper へ寄せ、単項符号、IN、BETWEEN、ASSERT、INSERT/UPSERT VALUES、UPDATE SET、算術/集計算術葉で raw を保持する
- batch `VarValue` へ raw を伝播し、literal 変数の parse→compare 区別を維持する。JS 算術結果には `String(value)` 由来だけを付ける
- 既存 `value:number` を読む consumer と programmatic AST fixture を compile gate で維持する
- **変更ファイル**: `src/lexer/lexer.ts`、`src/lexer/tokens.ts`（コメント）、`src/types/ast.ts`、`src/parser/parser.ts`、`src/execute.ts`、parser/lexer/ASSERT/batch test と snapshot
- **新規ファイル**: 必要なら `src/types/numberLiteral.ts`（helper を ast.ts から分離する場合のみ）
- **テストファイル**: `src/lexer/__tests__/lexer.test.ts`、`src/parser/__tests__/parser.test.ts`、`parser_compat.test.ts`、`dmlUnarySign.test.ts`、`assert.test.ts`、`src/__tests__/executeBatch.test.ts`、`executeAssert.test.ts`

### Phase 3: 全消費経路の配線

- `evalWhere.resolveValue()`、ASSERT、REST/DML converter の NumberLiteral 文字列化を `numberLiteralText()` へ置換する
- WHERE/HAVING/CASE/BETWEEN、通常・サブテーブル UPDATE/DELETE、REORDER、ORDER BY/WINDOW、MIN/MAX の数値 metadata が canonical comparator まで届くことを経路別に検査する
- typed number IN/NOT IN の等価判定を exact primitive へ寄せる
- GREATEST/LEAST の高精度、`-0`、末尾ゼロ、指数同値と全順列不変を固定する
- 単純 INSERT/UPSERT VALUES は raw を API payload へ保持し、算術結果は従来の `value:number` 経路に残す
- **変更ファイル**: `src/engine/evalWhere.ts`、`src/engine/evalFunc.ts`、`src/engine/process.ts`、`src/execute.ts`、`src/converter/whereToKintone.ts`、`src/converter/dmlToKintone.ts`、`src/converter/selectToKintone.ts`、`src/core/dmlValidationCandidates.ts` と対応 test
- **新規ファイル**: 共有直積 fixture が必要なら `src/core/__tests__/fixtures/exactDecimalCases.ts`
- **テストファイル**: `evalWhere.test.ts`、`process.test.ts`、`execute.test.ts`、`executeAssert.test.ts`、`window.execute.test.ts`、`whereToKintone.test.ts`、`selectToKintone.test.ts`、`dmlValidation.test.ts`

### Phase 4: 数値プレフィルタの超集合性再証明

- `src/core/optimization/wherePredicatePushdown.ts:26-31,159-169` の現行 allowlist（一般 NUMBER は `=` と safe-integer の strict `<`/`>`）を、raw REST serialization と exact local residual の組合せで再検証する
- `<=` / `>=`、unsafe integer、fraction、指数 literal が一般 NUMBER の safe leaf に入らないことを固定する
- `=` の exact literal が raw のまま REST へ渡ること、strict safe-integer 境界が local exact 結果の超集合を欠落させないことを table-driven test で証明する
- AND の安全 leaf 抽出、OR/NOT での非抽出を維持する。押し下げ allowlist は拡張しない
- SIMPLE raw REST と FULL_SCAN の同一 fixture を `$id asc` 付きで比較する
- **変更ファイル**: 原則テストのみ。必要な診断コメントがあれば `src/core/optimization/wherePredicatePushdown.ts`
- **新規ファイル**: なし
- **テストファイル**: `src/core/optimization/__tests__/wherePredicatePushdown.test.ts`、`whereCapability.test.ts`、`src/converter/__tests__/whereToKintone.test.ts`、`src/__tests__/execute.test.ts`

### Phase 5: 文書・surface・release gate

- JS 算術制限、指数表記、raw literal、SemVer 実測結果を言語リファレンス・CHANGELOG・移行ガイドへ同期する
- CLI / MCP / plugin の同じ SQL/fixture が同じ結果になることを smoke で確認する
- B29 の S0 gate に、公開 interface と exactDecimal test suite を引き継ぐ
- **変更ファイル**: `README.md`、`CHANGELOG.md`、言語リファレンス、`docs/ksql_issue_tracker.md`、必要な MCP description/schema、version/manifest/release artifact（実測後に確定）
- **新規ファイル**: 実機証跡を残す場合は redact 済み `docs/internal/evidence/b9_exact_decimal_semver_probe.md`
- **テストファイル**: 自動 suite 全体、CLI/MCP smoke、Firefox/Chromium plugin smoke

## 7. 自動テスト計画と受入条件対応

### 7.1 primitive の境界直積

課題 R5 §6 を shared fixture にし、少なくとも次の軸を直積化する。

- 桁: 1桁、15/16/17桁、30桁、30桁境界の直前/境界
- 小数: 0桁、1桁、最大10桁、10桁境界、整数部と合わせて最大30桁
- 符号: 正、負、明示 `+`、`0`、`-0`
- 表現: 先頭ゼロ、末尾ゼロ、整数/小数、指数なし、`e/E`、指数の明示 `+/-`
- 値関係: 小さい/同値異表記/大きい、桁上がり境界、小数点位置が大きく異なる値
- 不正入力: 空、空白のみ、Infinity、NaN、指数欠落、複数 dot、Unicode digit、指数 overflow

必須例に `9007199254740992 < 9007199254740993`、`-9007199254740993 < -9007199254740992`、`1.10 = 1.1`、`-0 = 0`、`1e21 = 1000000000000000000000` を含める。

### 7.2 property test

外部依存を追加せず、seed を表示できる deterministic generator で canonical decimal と異表記を生成する。

- `cmp(a,a) = 0`
- 反対称: `cmp(a,b) = -cmp(b,a)`
- 推移: `a <= b && b <= c => a <= c`
- 同値推移: `a = b && b = c => a = c`
- 同じ canonical 値から生成した符号/zero/末尾ゼロ/指数表記が同値
- typed number 固定バンドを混ぜた全組でも上記性質を満たす
- GREATEST/LEAST は引数全順列で同じ元文字列を返す

### 7.3 parse 直後から比較完了までの保持

lexer token、parser AST、batch variable substitution、REST query string、FULL_SCAN `resolveValue()` の各 checkpoint で2^53前後の2値が別文字列のまま残ることを検査する。AST では `value` が丸めで同じになり得ても `raw` が異なり、比較・REST・単純 DML が `raw` を選ぶことを assertion にする。

### 7.4 SIMPLE raw REST と FULL_SCAN の一致

同一アプリ/fixture に、30桁境界、小数10桁、正負、zero、末尾ゼロ、指数同値を入れる。SIMPLE は raw REST の WHERE/ORDER 結果、FULL_SCAN は local comparator の結果を取得し、必ず `$id asc` を明示して行列を比較する。

SIMPLE と FULL_SCAN の planner 差や暗黙 tie による偽差分を避け、ASC/DESC、`=`、strict range、MIN/MAX の各結果を比較する。Node mock は request query が raw literal を保持することを証明し、実機は kintone の保存値・raw REST 順を証明する。

### 7.5 全消費経路の回帰

§5 の各行について、16桁超の非同値ペアと同値異表記ペアを最低1本ずつ通す。特に課題文書で当初漏れていた GREATEST/LEAST を独立 gate とし、WHERE の共有テストだけで代替しない。REORDER は WHERE 選定と BY 並びの双方、サブテーブル UPDATE/DELETE は対象親/行 ID まで検証する。

### 7.6 JS 算術由来値の制限固定

次を test 名と期待値に明記する。

- raw literal 同士の比較は 16〜30桁を区別する
- `9007199254740992 + 1` は B9 でも binary64 のため元値を復元しない
- `0.1 + 0.2` は `0.3` と数学的同値を保証しない
- `String(1e21)` の指数表記は primitive が有限10進として処理し、例外や非数値バンドへ落とさない
- 算術由来の±Infinity/`"NaN"` sentinel は固定バンドを維持する

## 8. SemVer 判定手順（Claude 実機担当）

B9 は偽同値の解消により、従来返っていた行、MIN/MAX の代表値、ORDER BY の peer 順が変わり得る。単なる内部精度改善と仮定せず、Claude が v3.2.0 と B9 candidate を同じ実機 fixture で比較して major/minor を確定する。

### 8.1 fixture と前提確認

1. `numberPrecision.digits >= 16` の隔離アプリを使う。APP4221 は12桁設定なので使わない
2. raw REST で `9007199254740992` / `9007199254740993` の保存値が区別されることを確認する
3. `$id` と挿入順を記録し、token/cookie/error id は証跡から redact する
4. 必要なら挿入順を逆にした2組を作り、偽同値時の stable sort/代表値が偶然正解に見えない fixture にする

### 8.2 v3.2.0 と candidate の比較

同じデータに対し、CLI または plugin で次を双方の版から実行し、SQL、結果行、列値、実行 mode、版番号を保存する。

1. **WHERE `=`**: `NOT (数値列 != 9007199254740993)` 等、一般 NUMBER の equality prefilter が結果を先に狭めない FULL_SCAN 形を使い、v3.2.0 の偽同値による2行一致と candidate の1行一致を測る。EXPLAIN で local residual を確認する
2. **MIN/MAX**: 挿入順を逆にした組を使い、v3.2.0 で同値扱いにより誤った代表値が残り、candidate で数学的な min/max に変わることを双方確認する
3. **ORDER BY**: FULL_SCAN の `ORDER BY 数値列 ASC, $id ASC` と DESC を使い、v3.2.0 の偽 peer と candidate の厳密順を比較する。canonical tie の `$id` と数値キーの効果を混同しない
4. 対照として raw REST の `=`, ASC, DESC を取得し、candidate が kintone の10進結果へ一致することを確認する

### 8.3 判定規則

- 公開済み v3.2.0 と同じ SQL/保存データで、WHERE の行集合、MIN/MAX 値、ORDER BY の非同値グループ順が変わることを実測した場合は **major** と判定し、v3.3.0 の release label をそのまま使わず v4.0.0 相当へ再計画する
- 実機で当該値が保存不能、または公開経路で結果差を再現できず、互換変更がないと証明できた場合だけ **minor** を維持できる。未実測は minor の根拠にしない
- 判定結果を台帳、CHANGELOG、移行ガイド、本計画の status に同期してから release version を変更する

## 9. B29 への引き継ぎ

B9 完了時に B29 へ次を公開・固定する。

1. `ExactDecimal`、`parseExactDecimal()`、`compareExactDecimal()`、`compareDecimal()`、`isFiniteDecimal()`
2. signed `scale` の意味、zero canonicalization、指数 overflow の fail-closed 契約
3. 30桁×小数10桁×符号×zero×末尾ゼロ×指数の shared fixture
4. `integerDigits` / `fractionDigits` の導出方法。B29 はこれを `digits` / `decimalPlaces` 検証へ使う
5. coefficient と scale 上で切断位置・discarded digits・carry を扱う拡張点。B29 の `quantizeDecimal()` は同じ parse 結果を受け取る
6. original input/raw lexeme は診断用に別保持し、正規化結果で利用者入力を書き換えない契約
7. JS 算術値は既に丸め済みという provenance 制限。B29 v1 の桁検証は表示文字列を検査できるが、B29 v2 まで演算精度を保証しない

B29 側の呼出し形は概念上次とする。

```ts
const decimal = parseExactDecimal(input);
if (decimal === null) return ERR_TYPE_NUMBER;
const shape = decimalShape(decimal); // B29 が exactDecimal 上へ追加
validatePrecision(shape, precision);
quantizeDecimal(decimal, targetScale, mode); // 明示経路のみ
```

`decimalShape` / `quantizeDecimal` は B29 が同 module または一方向依存の precision module へ追加する。parse/comparison regex を B29 側へ複製しない。

## 10. 実装レビュー gate

- [ ] `9007199254740992 < 9007199254740993` が primitive と全代表経路で成立する
- [ ] parser 生成の全 NumberLiteral が raw を持ち、単項符号・IN・BETWEEN・ASSERT・INSERT で失わない
- [ ] `NumberLiteral.value:number` を読む既存算術 consumer が compile/test 互換を保つ
- [ ] DML min/max が拡張後の単一 `compareDecimal` を使い、二重実装がない
- [ ] typed number の空セル/±Infinity/有限/NaN/その他非数値のバンド順と peer が不変
- [ ] その他非数値バンド内がコードポイント順で、typed string を数値昇格しない
- [ ] GREATEST/LEAST が exact finite pair を使い、集合モード・二次キー・全順列不変を維持する
- [ ] WHERE/HAVING/CASE/サブテーブル UPDATE・DELETE・REORDER/ASSERT/BETWEEN/ORDER BY/MIN/MAX の経路 test がある
- [ ] 30桁・小数10桁・正負・0/-0・末尾ゼロ・指数の直積と property test が通る
- [ ] SIMPLE raw REST と FULL_SCAN が `$id asc` 明示で一致する
- [ ] JS 算術由来値の保証範囲と制限が test/文書に固定される
- [ ] 一般 NUMBER の `<=` / `>=` 押し下げを B9 に混ぜて解禁していない
- [ ] Claude の実機 SemVer gate が完了し、release version と移行文書が判定に一致する
- [ ] B29 が再利用する interface と shared fixture がレビュー承認される

## 11. 検証コマンド（実装時）

```powershell
npx jest --runInBand src/core/__tests__/exactDecimal.test.ts src/core/__tests__/exactDecimal.property.test.ts
npx jest --runInBand src/core/__tests__/scalarCompare.test.ts src/core/__tests__/dmlValidation.test.ts
npx jest --runInBand src/lexer/__tests__/lexer.test.ts src/parser/__tests__/parser.test.ts src/parser/__tests__/dmlUnarySign.test.ts
npx jest --runInBand src/engine/__tests__/evalWhere.test.ts src/engine/__tests__/process.test.ts
npx jest --runInBand src/__tests__/execute.test.ts src/__tests__/executeAssert.test.ts src/__tests__/window.execute.test.ts
npx jest --runInBand src/core/optimization/__tests__/wherePredicatePushdown.test.ts src/core/optimization/__tests__/whereCapability.test.ts
npm test
npm run build
npm run mcp:verify
```

plugin の Firefox/Chromium smoke は Node/build と別 gate とし、実機出力を release 証拠にする。

## 12. 指摘（正資料は本作業では変更しない）

1. **リリース番号の条件付き不整合**: 台帳は「次回 v3.3.0 = B9+B29+B20」とする一方、同じ台帳と本タスクは B9 が major の可能性を認めている。§8 の実測で major なら v3.3.0 では出せないため、本計画では v3.3.0 を暫定 label とし、実測後に版番号を再計画する。
2. **現行コードと固定バンド仕様のドリフト**: `scalarCompare.ts:numberKey()` は `Number(" ")` を有限値 0 と分類し、既存 `scalarCompare.test.ts:64` もそれを期待する。しかし横断仕様 §4.5.5 と B9 R5 §4 は有限10進以外を「その他非数値」バンドとする。本計画は正資料を優先して末尾バンドへ移すが、高精度ペア以外にも挙動差が出るため SemVer/回帰説明へ含める必要がある。
3. **SQL 指数字句の明文化不足**: B9 R5 §4 は「受理するなら正規化」とし、B29 は指数表記入力を前提にするが、SQL lexer が指数を新たに受理するかは明示決定していない。本計画 R1 は B29 の raw lexeme/指数 fixture を成立させるため SQL の `digits[.digits][e±digits]` を受理する案を採用する。レビューで不採用なら、primitive の指数対応は維持しつつ SQL lexer 拡張と SQL exponent test だけを分離する。
