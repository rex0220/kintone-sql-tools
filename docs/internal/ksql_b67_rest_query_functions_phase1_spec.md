# B67 Phase1 — kintone REST クエリ関数（相対日付）押し下げ仕様

- 作成日: 2026-07-24
- ステータス: **仕様 R2・Claude レビュー済＝実装着手可能水準**（2026-07-24）。方針 A（押し下げ専用・server-only・fail-closed）を維持し、R1 レビュー指摘（§14）を §5.2/§5.3/§10.4 へ反映＝再レビューで妥当（backstop 挿入点 `evalWhere.ts:348` の `case "KINTONE_FUNC": resolveKintoneFunc(value.name)` をコードで確認・現状 default なし switch の silent undefined を明示 throw 化する要件と bypass テストが入った）。未決の公開意味論なし。**次＝実装着手可否の判断**（見積り 6〜10 人日）。
- 方針: **A — 押し下げネイティブ**。相対日付関数は kintone REST クエリへそのまま出力し、kintone に評価させる。client 評価へはフォールバックしない。
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B67
- 起草ブリーフ: [ksql_b67_phase1_spec_r1_brief.md](ksql_b67_phase1_spec_r1_brief.md)
- 評価: [ksql_b67_rest_query_functions_evaluation.md](ksql_b67_rest_query_functions_evaluation.md)
- 引数・サーバ意味論の正: [kintone クエリの関数](https://cybozu.dev/ja/kintone/docs/overview/query/#function)

## 1. スコープ（Phase1）

相対日付を表す kintone REST クエリ関数を kSQL の物理アプリ `WHERE` で受理し、関数呼び出しを kintone クエリへ押し下げる。時刻・タイムゾーン・週境界・月末・存在しない月日の繰越は kSQL が再計算せず、リクエストを受けた kintone のサーバ意味論に委ねる。

### 1.1 対象

| 分類 | Phase1 関数 |
|---|---|
| 日 | `YESTERDAY()`、`TOMORROW()` |
| 相対期間 | `FROM_TODAY(n, DAYS\|WEEKS\|MONTHS\|YEARS)` |
| 週 | `THIS_WEEK([曜日])`、`LAST_WEEK([曜日])`、`NEXT_WEEK([曜日])` |
| 月 | `THIS_MONTH([1-31\|LAST])`、`LAST_MONTH([1-31\|LAST])`、`NEXT_MONTH([1-31\|LAST])` |
| 年 | `THIS_YEAR()`、`LAST_YEAR()`、`NEXT_YEAR()` |

Phase1 の利用位置は、物理 kintone アプリのトップレベル日付系フィールドを左辺、上表の関数を右辺とする `WHERE` 比較に限定する。対象 statement 内に複数の SELECT がある場合は、関数を含む各 SELECT ノードを個別に検査する。

通常 SELECT、`WITH` / `UNION` 内の SELECT、SELECT source を持つ文、およびトップレベルレコードを REST query で選択する UPDATE / DELETE の既存経路は、§5 の全条件を満たす場合に限り対象となる。構文を受理することと、個々の実行計画で押し下げ可能であることは分けて判定する。

### 1.2 対象外

- `PRIMARY_ORGANIZATION()`。B54 User API との整理を含め Phase2 とする。
- 相対日付関数の client 評価。FULL_SCAN、JOIN 後の残余 WHERE、派生表・一時表・実体化 CTE、サブテーブル行、`VALIDATE` の取得後 WHERE 再評価を含む。
- SELECT 出力、SET / VALUES、CHECK、HAVING、JOIN ON、CASE、任意のスカラー式、関数引数、GROUP BY、ORDER BY / KORDER BY のキーに相対日付関数を置くこと。
- `TIME` フィールド、非日付フィールド、サブテーブル内フィールド、関連レコード内フィールドとの比較。
- `IN` / `NOT IN` に相対日付関数を入れること、`NOT BETWEEN`、関数を左辺に置く比較。
- 相対日付関数を kSQL の固定日時リテラルへ展開すること。

既存の `TODAY()` / `NOW()` / `LOGINUSER()`、エンジンの SQL 比較意味論、B26 の client 比較、LIKE / KLIKE、通常の SIMPLE / FULL_SCAN routing は変更しない。本機能は新しい関数名だけを追加する純加法である。

### 1.3 現行実装の裏取り

R1 は次の現行コード契約を前提にする。

| 実コード | 確認した現行契約 | B67 の接続点 |
|---|---|---|
| `src/types/ast.ts` | `KintoneFunction` は `{ type: "KINTONE_FUNC"; name: "TODAY" \| "NOW" \| "LOGINUSER" }` だけを持つ | legacy branch の形を保ち、新規 branch だけに引数を追加する |
| `src/converter/whereToKintone.ts` | `convertValue` が `KINTONE_FUNC` を `convertKintoneFunc` へ渡し、`${v.name}()` で素通しする | legacy serializer を変更せず、相対日付 serializer を隣接追加する |
| `src/engine/evalWhere.ts` | `resolveKintoneFunc` が3関数だけを client 解決する | union・switchを相対日付へ広げず、到達自体を planner と防御guardで拒否する |
| `src/lexer/tokens.ts` / `src/parser/parser.ts` | 3関数は専用 token、`PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP`、引数なし `parseSqlValue` で受理される | legacy parseを変えず、相対日付はWHERE値位置の専用文法とsoft keywordで追加する |
| `src/core/optimization/whereCapability.ts` | B32 が型×演算子を `EXACT_PUSHDOWN` / residual / unsupported に分類し、現在は右辺型 `KINTONE_FUNC` を一括でpush可能候補にする | 型×演算子×**関数名**のallowlistへ拡張し、相対日付はserver-onlyを別途強制する |
| `src/core/optimization/korderPlanner.ts` | `KORDER BY` は `staticMode=SIMPLE` と `whereCapability=EXACT_PUSHDOWN` を必須にし、native / cursorを選ぶ | 既存条件を満たす相対日付WHEREだけを両KORDER経路へ通す |
| `src/execute.ts` | FULL_SCAN と `VALIDATE` を含む複数経路が、押し下げ後にも元WHEREを `evalWhere` で再評価する | 「serialize可能」だけで許可せず、client再評価のない物理計画を必須にする |

## 2. 構文

### 2.1 文法

以下の EBNF を Phase1 の公開文法とする。キーワードは ASCII 大文字小文字を区別せず、シリアライズ時は表記を大文字へ正規化する。

```ebnf
relative_date_function ::=
    "YESTERDAY" "(" ")"
  | "TOMORROW" "(" ")"
  | "FROM_TODAY" "(" signed_integer "," period_unit ")"
  | week_function "(" [ weekday ] ")"
  | month_function "(" [ month_day ] ")"
  | year_function "(" ")"

week_function  ::= "THIS_WEEK" | "LAST_WEEK" | "NEXT_WEEK"
month_function ::= "THIS_MONTH" | "LAST_MONTH" | "NEXT_MONTH"
year_function  ::= "THIS_YEAR" | "LAST_YEAR" | "NEXT_YEAR"

period_unit ::= "DAYS" | "WEEKS" | "MONTHS" | "YEARS"
weekday ::=
    "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY"
  | "THURSDAY" | "FRIDAY" | "SATURDAY"
month_day ::= integer_1_to_31 | "LAST"
signed_integer ::= ["-"] decimal_digits
```

空引数の関数へ引数を渡す形、必須引数の欠落、余分な引数、末尾カンマ、文字列リテラルで囲んだ単位・曜日・`LAST`、変数、フィールド参照、算術式、小数、指数表記は ParseError とする。

```sql
-- 正
WHERE 作成日時 < FROM_TODAY(5, DAYS)
WHERE 日付 = FROM_TODAY(-2, WEEKS)
WHERE 更新日時 = THIS_WEEK(MONDAY)
WHERE 日付 = LAST_MONTH(LAST)
WHERE 日付 = NEXT_YEAR()

-- 誤
WHERE 日付 = FROM_TODAY(1.5, DAYS)
WHERE 日付 = FROM_TODAY(1e2, DAYS)
WHERE 日付 = FROM_TODAY(5, 'DAYS')
WHERE 日付 = THIS_WEEK('MONDAY')
WHERE 日付 = THIS_MONTH(0)
WHERE 日付 = THIS_YEAR(2026)
```

### 2.2 `FROM_TODAY` の `n`

`n` は負値・0・正値を受理する、符号なしまたは先頭に `-` を1個だけ持つ10進整数とする。`+5`、小数、指数表記、桁区切り、式、変数は受理しない。

kintone 公式リファレンスは引数を「数字」とし、公開上限を定めていない。このため、kSQL は公式にない日数・週数等の業務上限を発明しない一方、現行 AST の `number` と安全に往復できる境界として次を固定する。

```text
-9,007,199,254,740,991 <= n <= 9,007,199,254,740,991
```

すなわち `Number.isSafeInteger(n)` を必須とする。範囲外は ParseError とし、丸めて受理しない。先頭ゼロと `-0` を受理した場合も AST の正規値と REST 出力はそれぞれ符号なし最短10進表記（`0`）へ正規化する。kintone がサーバ側の日付範囲等を理由に正規な整数を拒否した場合、その REST error を通常どおり返し、client 計算へ切り替えない。

### 2.3 `BETWEEN` と `IN`

比較演算子は `=`、`!=`、`<>`、`<`、`<=`、`>`、`>=` を受理する。`<>` は既存どおり REST の `!=` へ正規化する。

`BETWEEN low AND high` は現行 parser が `field >= low AND field <= high` の2比較へ展開するため、両境界が §4・§5 を満たす場合に限り Phase1 で受理する。片方だけが相対日付関数でもよい。展開後の2比較を B32 能力判定へ渡し、どちらか一方でも押し下げ不能なら文全体を fail-closed にする。

```sql
WHERE 日付 BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()
```

上記は次の REST 条件になる。

```text
日付 >= FROM_TODAY(-7, DAYS) and 日付 <= TODAY()
```

`IN` / `NOT IN` は日付系フィールドに対する kintone 公式能力に含まれず、現行 `InList` も関数ノードを値要素に持たない。Phase1 では分解・書換えを行わず ParseError とする。`NOT BETWEEN` も新設しない。

## 3. サーバ意味論

### 3.1 評価主体

相対日付関数は、SQLを実行した Node、CLI、MCP、ブラウザの時計ではなく、REST query を評価する kintone の意味論に従う。kSQL は関数名と検証済み引数をシリアライズするだけで、日付値へ解決しない。

- `YESTERDAY()` / `TOMORROW()` は API 実行日の前日 / 翌日。
- `FROM_TODAY(n, unit)` は API 実行日から、指定した `DAYS` / `WEEKS` / `MONTHS` / `YEARS` 単位で起算した期間。
- 週関数は当週 / 前週 / 翌週を表す。曜日引数なしはその週の全日、引数ありは指定曜日を表す。
- 月関数は当月 / 前月 / 翌月を表す。引数なしはその月の全日、`LAST` は月末、1〜31は指定日を表す。
- 指定月に該当日が存在しない場合の繰越は、公式リファレンスの規則を kintone が適用する。kSQL は月末補正を行わない。
- 年関数は当年 / 前年 / 翌年を表す。

この仕様はサーバの時刻基準、ドメイン / ユーザー設定、週の内部境界規則を再定義しない。公式挙動が変わった場合も、Phase1 の kSQL は REST へ同じ関数表現を渡す。

### 3.2 SQL 意味論との境界

関数が返す値・期間の解釈と比較結果は kintone が所有する。`=` 等を client の単一文字列比較へ読み替えない。特に引数なしの週・月・年関数が表す期間を kSQL 側で開始・終了日時へ展開してはならない。

## 4. 型・位置・演算子の制約

### 4.1 許可型

B32 の `whereCapability` が解決する次のトップレベルフィールド型だけを allowlist とする。

| 解決済み型 | 相対日付関数 | 演算子 |
|---|---|---|
| `DATE` | 全 Phase1 関数 | `=` `!=` `<` `<=` `>` `>=` |
| `DATETIME` | 全 Phase1 関数 | `=` `!=` `<` `<=` `>` `>=` |
| `CREATED_TIME` | 全 Phase1 関数 | `=` `!=` `<` `<=` `>` `>=` |
| `UPDATED_TIME` | 全 Phase1 関数 | `=` `!=` `<` `<=` `>` `>=` |

`TIME` は範囲演算子自体を受理するが、公式の利用可能関数表に相対日付関数がないため拒否する。型メタデータ不明、未知型、LOOKUP のコピー元型を確証できないもの、関連レコード、サブテーブルも拒否する。値形状が日付らしい文字列であることを根拠に許可しない。

### 4.2 許可位置

許可する基本形は次だけである。

```ebnf
date_field comparison_operator relative_date_function
date_field "BETWEEN" relative_or_literal "AND" relative_or_literal
```

`date_field` は対象の物理アプリへ一意に解決できる直接フィールド参照でなければならない。関数を左辺へ置いた比較、field-to-field 比較、算術・文字列関数・CASE の内側、alias / 式列 / CTE列との比較は拒否する。

既存 `TODAY()` / `NOW()` / `LOGINUSER()` の許可型・位置・演算子は本表で狭めない。相対日付関数の判定を既存3関数へ逆適用してはならない。

## 5. 押し下げと fail-closed

### 5.1 必須条件

相対日付関数を含む比較は、次をすべて満たす場合だけ実行できる。

1. parser が §2 の専用文法で関数と引数を確定している。
2. B32 の schema-aware 判定で、フィールド型・演算子・関数の組が `EXACT_PUSHDOWN` である。
3. 関数を含む WHERE が対象物理アプリの REST query へ実際に serialize される。
4. 取得後に同じ関数ノードを `evalWhere` / `resolveKintoneFunc` へ渡さないことを、物理計画が保証する。
5. EXPLAIN と実行が同じ判定結果を使う。

現行 `whereCapability.ts` は右辺型が `KINTONE_FUNC` なら、型別 native operator のみで `EXACT_PUSHDOWN` にできる。B67 ではこれを「関数名まで含む型 × 演算子 × 関数 allowlist」へ拡張し、§4.1 の組だけを exact とする。

### 5.2 計画単位の拒否

現行 FULL_SCAN は、元 WHERE が REST へ押し下げられていても最終パイプラインで WHERE 全体を再評価する。`VALIDATE` も取得レコードを `evalWhere` で再絞り込みする。Phase1 は client 評価を実装しないため、相対日付関数を含む SELECT / statement が次の経路へ入る場合は、record / cursor API 呼び出し前に拒否する。

- JOIN、集約、window、DISTINCT、通常 `ORDER BY`、ローカル式等により FULL_SCAN になる SELECT。
- main / join のどちらかに関数付き比較が残る JOIN。
- 一時表、実体化 CTE、派生結果、サブテーブルをローカル評価する経路。
- `VALIDATE` の既存レコード監査 WHERE。
- UPDATE FROM、サブテーブル UPDATE / DELETE、APPLY 親選択、REORDER 等、取得後に WHERE を再評価する経路。
- B32 が `SUPERSET_PREFILTER` / `LOCAL_ONLY` / `UNSUPPORTED` を返す WHERE。

この到達経路の網羅は二段で担保する。第一段は planner 側の型 × 演算子 × 関数 allowlist と plan walk で、相対日付関数を含む計画を `EXACT_PUSHDOWN` か取得前拒否のどちらかに確定する。第二段は §5.3 の runtime backstop で、planner の経路列挙に漏れや将来 drift があっても、`evalWhere` に到達した相対日付関数を silent-wrong-result にしない。backstop は最後の砦であり、第一段の網羅検査を省略する理由にはしない。両段を §10.4 の受入条件とする。

通常 SELECT は、関数を含む SELECT ノードが SIMPLE であり、REST query の結果を WHERE 再評価なしで利用できる場合に限り許可する。`KORDER BY` は `korderPlanner.ts` が要求する `staticMode=SIMPLE` かつ `whereCapability=EXACT_PUSHDOWN` を満たす場合、`KORDER_NATIVE` / `KORDER_CURSOR` の双方で許可する。Cursor へ切り替わっても同じ WHERE query をサーバへ渡し、client 評価を追加しない。

トップレベル UPDATE / DELETE は、既存 B32 DML 境界が WHERE 全体の `EXACT_PUSHDOWN` を要求し、取得後の相対関数評価を行わない経路だけを許可する。`VALIDATE ONLY` を付けた DML でも対象選択経路が同じ条件を満たさなければならない。

### 5.3 エラーと副作用境界

次の reason code を B32 の理由集合と EXPLAIN / runtime 診断で共用する。

| reason code | 条件 |
|---|---|
| `WHERE_RELATIVE_DATE_ARGUMENT_INVALID` | 引数個数・値・範囲が関数契約外 |
| `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED` | §4.1 以外の型、型不明、非物理列 |
| `WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED` | 6比較 / 許可 BETWEEN 展開以外 |
| `WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED` | WHERE 比較右辺以外の位置 |
| `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` | 残余評価、FULL_SCAN、JOIN、派生等で server-only を保証できない |

parse 時に確定する誤りは ParseError、schema / plan 時に確定する誤りは `ArgumentError` とする。公開メッセージには少なくとも関数名と reason code を含める。DML は既存 error envelope に reason code を保持してよいが、SELECT と異なる受理判定を持ってはならない。

「取得前」とはレコード取得・Cursor作成・mutation・confirm の前を指す。型解決に必要なフォームメタデータ API は許可する。拒否時は records GET / Cursor POST・GET・DELETE / record mutation / confirm が0回で、部分結果を返さない。

現状コードには、この runtime backstop は存在しない。`src/engine/evalWhere.ts:348` の `KINTONE_FUNC` 評価は無条件に `resolveKintoneFunc(value.name)` へ dispatch し、同 `resolveKintoneFunc`（同ファイル:429）は `name: "TODAY" | "NOW" | "LOGINUSER"` に対する default 節なしの switch である。このため、型境界を越えて `FROM_TODAY` 等の相対日付関数名が渡ると、どの case にも一致せず `undefined` を silent 返却する。さらに `src/execute.ts:1070` の取得後 WHERE 再評価は `evalWhere(stmt.where, ...)` を呼ぶため、planner から漏れた関数が誤った比較値として使われ得る。

したがって実装では、`evalWhere` の `KINTONE_FUNC` dispatch または `resolveKintoneFunc` のいずれか、すなわち相対日付関数が client 値へ変換される前の共通評価境界に明示 backstop を必ず追加する。相対日付関数名を受けた場合は、必ず関数名と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むエラーを throw し、`undefined`、空文字、現在時刻その他の client 値へ解決してはならない。既存 `TODAY()` / `NOW()` / `LOGINUSER()` の3 case はそのまま維持する。この防御は §5.2 の planner allowlist / plan walk の代替ではなく、列挙漏れがあっても silent-wrong を防ぐ最後の砦である。

## 6. serialize

`whereToKintone.ts` は検証済み AST を次の規則でシリアライズする。

- 関数名、単位、曜日、`LAST` は大文字。
- 引数区切りは `, `（カンマ＋半角空白）。
- 引数なしは `NAME()`。
- `FROM_TODAY` の `n` は §2.2 の最短10進表記。
- field は既存 `convertField` / `quoteIdentifier`、演算子は既存 `convertOp` を使う。
- 関数引数を SQL 文字列として quote / escape しない。

| AST | REST 出力 |
|---|---|
| `YESTERDAY` | `YESTERDAY()` |
| `FROM_TODAY`, `-5`, `DAYS` | `FROM_TODAY(-5, DAYS)` |
| `THIS_WEEK`, `MONDAY` | `THIS_WEEK(MONDAY)` |
| `THIS_WEEK`, 引数なし | `THIS_WEEK()` |
| `LAST_MONTH`, `LAST` | `LAST_MONTH(LAST)` |
| `NEXT_MONTH`, `31` | `NEXT_MONTH(31)` |
| `THIS_YEAR` | `THIS_YEAR()` |

代表例:

```text
作成日時 < FROM_TODAY(5, DAYS)
更新日時 = THIS_WEEK(MONDAY)
日付 = LAST_MONTH(LAST)
```

### 6.1 既存3関数の byte 不変

現行 `convertKintoneFunc` は `TODAY()` / `NOW()` / `LOGINUSER()` を `${v.name}()` で出力する。一般化ではこの legacy 分岐をそのまま先に残し、相対日付専用 serializer を別分岐として後置する。

次を byte-for-byte snapshot で固定する。

- parse 後 JSON: `{ "type": "KINTONE_FUNC", "name": "TODAY" }`、`NOW`、`LOGINUSER` に `args` その他の property を追加しない。
- `whereToKintone` の出力文字列。関数名、括弧、空白、論理式の括弧付けを変更しない。
- SELECT / UPDATE / DELETE / EXPLAIN で生成される既存3関数入り kintone query。
- `resolveKintoneFunc("TODAY" | "NOW" | "LOGINUSER")` の入力 union と既存挙動。

相対日付対応を理由に既存3関数を共通の可変長 `args?: ...` ノードへ書き換えない。

## 7. パーサ・ソフトキーワード・AST

### 7.1 lexer / parser

現行 `tokens.ts` は `TODAY` / `NOW` / `LOGINUSER` を専用 TokenKind と keyword map に持ち、`parser.ts` の `PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP` が引数なし呼び出しへ変換する。相対日付関数は既存3関数の分岐を変更せず、WHERE 右辺専用の contextual function parser を追加する。

純加法を守るため、次の語は新しいグローバル予約語にしない。

- `DAYS`、`WEEKS`、`MONTHS`、`YEARS`
- `SUNDAY`、`MONDAY`、`TUESDAY`、`WEDNESDAY`、`THURSDAY`、`FRIDAY`、`SATURDAY`
- `LAST`

これらは該当関数の引数位置で、非引用 IDENT の value を大文字比較するソフトキーワードとする。関数名自体も、WHERE の値位置で直後が `(` の場合だけ相対日付関数として扱える contextual spelling 集合に置き、通常のフィールド位置では従来どおり IDENT として扱う。これにより `FROM_TODAY` 等と同名の既存フィールドも壊さない。

関数文脈で keyword と同名のフィールドを引数として解釈することはない。フィールド名が `DAYS`、`WEEKS`、曜日語、`LAST`、または関数名と衝突し、構文位置が曖昧になる場合はバッククォートで退避できる。

```sql
SELECT `DAYS`, `WEEKS`, `MONDAY`, `LAST`, `FROM_TODAY`
FROM APP100
WHERE `DAYS` = '営業日'
```

バッククォート付き `` `DAYS` `` を `FROM_TODAY` の単位として受理してはならず、文字列 `'MONDAY'` も曜日として受理しない。不完全な関数呼び出しを通常フィールドやスカラー関数へフォールバックせず ParseError とする。

### 7.2 AST

既存ノードを legacy branch として形ごと保持し、新規 branch だけに引数を持たせる。

```ts
interface LegacyKintoneFunction {
  type: "KINTONE_FUNC";
  name: "TODAY" | "NOW" | "LOGINUSER";
}

type RelativeDateFunction =
  | {
      type: "KINTONE_FUNC";
      name: "YESTERDAY" | "TOMORROW"
        | "THIS_YEAR" | "LAST_YEAR" | "NEXT_YEAR";
      args: { kind: "NONE" };
    }
  | {
      type: "KINTONE_FUNC";
      name: "FROM_TODAY";
      args: {
        kind: "FROM_TODAY";
        offset: number;
        offsetText: string;
        unit: "DAYS" | "WEEKS" | "MONTHS" | "YEARS";
      };
    }
  | {
      type: "KINTONE_FUNC";
      name: "THIS_WEEK" | "LAST_WEEK" | "NEXT_WEEK";
      args: {
        kind: "WEEK";
        weekday: "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY"
          | "THURSDAY" | "FRIDAY" | "SATURDAY" | null;
      };
    }
  | {
      type: "KINTONE_FUNC";
      name: "THIS_MONTH" | "LAST_MONTH" | "NEXT_MONTH";
      args: {
        kind: "MONTH";
        day: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
          | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20
          | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31
          | "LAST" | null;
      };
    };

type KintoneFunction = LegacyKintoneFunction | RelativeDateFunction;
```

名称は実装時に同等の discriminated union へ変更してよいが、次は必須である。

- legacy branch は `type` と `name` だけで、生成 JSON が既存と byte 一致する。
- 関数名と引数形の不正な組を型で表現不能にする。
- `offsetText` は安全整数検証後の正規化済み最短10進表記であり、serializer は `number` の再丸めを行わない。
- 相対日付 branch を `ScalarValueExpr` や assignment の一般関数位置へ広げない。WHERE 右辺の `SqlValue` としてだけ生成する。

## 8. カタログ・docs 同期

B55 / B60 の完全関数カタログへ12関数を `contextual` として追加する。

```text
YESTERDAY TOMORROW FROM_TODAY
THIS_WEEK LAST_WEEK NEXT_WEEK
THIS_MONTH LAST_MONTH NEXT_MONTH
THIS_YEAR LAST_YEAR NEXT_YEAR
```

同期対象:

- `PARSER_FUNCTION_SPELLINGS`。IDENT contextual spellings を含められるよう一般化する。
- `KSQL_FUNCTION_CATALOG.contextual`。
- `KSQL_FUNCTION_SQL_FIXTURES`。各関数に公式引数形を満たす parse fixture を1つ以上持つ。
- catalog ⇔ parser ⇔ fixture の双方向 drift guard。
- MCP instructions の complete function catalog。
- `docs/ksql_language_reference.md` の WHERE / 日付関数節。関数一覧だけでなく server-only、許可型・演算子、引数、fail-closed、バッククォート退避を記す。
- CLI / MCP / plugin の help や schema description に関数一覧を重複保持する箇所があれば同じ catalog から生成するか、同一性 guard を置く。

現行 instructions guard は実測529語・上限550語で、余裕は21語である。12関数名を contextual catalog に追加した場合の単純増は12語で、他の文言が不変なら541語となり上限内である。Phase1 は server-only の長い説明を instructions 本文へ重複追加せず、既存の `Use ksql_docs for arguments and constraints.` から言語リファレンスへ誘導する。実装時には期待値を実測値へ更新し、`<= 550` guard を維持する。550語を超える場合は意味を削らず、既存文の重複を圧縮してから公開する。

## 9. 面（Node / CLI / MCP / plugin）

parser、schema-aware planner、`whereToKintone`、fail-closed guard は engine に一元化し、Node engine library、CLI、MCP、plugin で受理 SQL、REST query、reason code を一致させる。

- API実行時刻・タイムゾーンは全て kintone サーバが評価する。Node / MCP のローカル TZ や plugin ブラウザ TZを使わない。
- `LOGINUSER()` の既存 client 文脈差は変更しない。相対日付関数には同様の client resolver を追加しない。
- MCP `ksql_validate` は構文・引数形を検査できるが、型・物理計画を確定できない経路では「実行可能」と断定しない。metadata を使う `ksql_query` / `ksql_explain` と実行は同じ schema-aware 判定を行う。
- 保存 query、batch、engine libraryも別 parser / serializer を持たず、同じ engine 契約を使う。
- plugin の Firefox / Chrome 実ブラウザ smoke では、同じ SQL が同じ query 文字列で records API または Cursor API に渡ることを確認する。

## 10. EXPLAIN と受入条件（テスト化）

### 10.1 EXPLAIN

EXPLAIN はフォームメタデータ以外の record / cursor / mutation API を呼ばず、少なくとも次を表示する。

```text
relative date function: FROM_TODAY
evaluation: kintone server
field: 作成日時 (CREATED_TIME)
operator: <
where capability: EXACT_PUSHDOWN
client evaluation: forbidden
kintone query: 作成日時 < FROM_TODAY(5, DAYS)
```

拒否計画は実行可能な GET / Cursor plan を表示せず、関数名と §5.3 の reason code を表示する。KORDER は既存の `KORDER_NATIVE` / `KORDER_CURSOR` と `KORDER_WHERE_NOT_EXACT` 契約を維持しつつ、B67 の拒否理由を先に失わない。

### 10.2 parser / AST / serialize 正例

- 全12関数の大文字・小文字入力が parse され、REST 出力は大文字へ正規化される。
- `WHERE 作成日時 < FROM_TODAY(5, DAYS)` が `作成日時 < FROM_TODAY(5, DAYS)` へ serialize される。
- `FROM_TODAY(-5, WEEKS)`、`FROM_TODAY(0, MONTHS)`、安全整数の上下限を受理する。
- `THIS_MONTH()`、`THIS_WEEK(MONDAY)`、`LAST_MONTH(LAST)`、`NEXT_MONTH(31)`、`THIS_YEAR()` を正確に serialize する。
- `日付 BETWEEN FROM_TODAY(-7, DAYS) AND TODAY()` が2比較の AND へ展開され、両方を押し下げる。
- `DAYS` / `WEEKS` / 曜日語 / `LAST` / 関数名と同名のフィールドが通常位置で使え、バッククォート退避も使える。

### 10.3 引数・型・位置の負例

- `FROM_TODAY` の欠落 / 余分引数、未知単位、文字列単位、小数、指数、式、変数、安全整数外を ParseError。
- 週関数の未知曜日 / 文字列曜日 / 複数曜日、月関数の0 / 32 / 負値 / 文字列 `LAST`、年・日関数の引数ありを ParseError。
- `TIME`、文字列、数値、選択系、型不明、サブテーブル、関連レコードとの比較を record API 前に `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED`。
- SELECT列、HAVING、SET、CHECK、CASE、算術、ORDER key、関数左辺を `WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED`。
- `IN (FROM_TODAY(...))` / `NOT IN` / `NOT BETWEEN` を拒否する。

### 10.4 押し下げ・fail-closed

- SIMPLE SELECT の全相対日付比較で records GET の query に関数が入り、client evaluator 呼出し0。
- planner の型 × 演算子 × 関数 allowlist と plan walk が、JOIN残余、集約、window、DISTINCT、通常 ORDER BY、CTE実体化、VALIDATE、サブテーブル DML、UPDATE FROM、APPLY、REORDER を含む取得後評価計画を record API 前に `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で拒否する。records / cursor / mutation / confirm 0。
- planner を test seam で意図的に bypass し、相対日付関数を FULL_SCAN / `evalWhere` へ到達させても、`undefined`、空文字、現在時刻その他の誤値で評価せず、関数名と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むエラーを throw して fail-closed する。
- planner allowlist / plan walk と runtime backstop の両テストを必須とし、経路列挙漏れや将来 drift があっても silent-wrong-result を許さない。
- AND / OR の一部だけが exact でも、statement が WHERE 全体を client 再評価する計画なら拒否する。
- KORDER の SIMPLE + exact 条件は native / cursor の双方で同じ WHERE query を使用する。非exact条件は existing KORDER fallback をせず拒否する。
- EXPLAIN と実行の capability / reason code が一致する。
- サーバが正規な関数 query を REST error にした場合、FULL_SCAN / client 評価へ retry しない。

### 10.5 既存3関数・全面・docs の非回帰

- `TODAY()` / `NOW()` / `LOGINUSER()` の parse AST JSON、`whereToKintone` 単体出力、SELECT / DML / EXPLAIN query を変更前 snapshot と byte 比較する。
- `resolveKintoneFunc` の既存3ケースと Node / MCP の `LOGINUSER` 既存挙動を変更しない。
- B32 の既存型 × 演算子 matrix、B26 client 比較、KORDER planner の既存 reason code を回帰試験する。
- Node / CLI / MCP / Firefox plugin / Chrome plugin で同じ SQL の REST query と拒否 reason code が一致する。
- catalog ⇔ parser ⇔ fixture drift guard、docs resource guard、MCP instructions の実測語数期待値と `<= 550` guard が green。

## 11. Phase2 引き継ぎ（対象外）

### 11.1 最優先候補: SUPERSET_PREFILTER（相対日付 prefilter ＋ 残余のみ client 評価）

**実機で最初に踏まれた制約（2026-07-24・v3.20.0 browser smoke）**。次のような、相対日付 exact 述語と押し下げ不能述語の AND は Phase1 では文全体が fail-closed になる。

```sql
SELECT 都道府県, 更新日時 FROM APP730
WHERE 更新日時 >= YESTERDAY()      -- exact 押し下げ可能
AND   LENGTH(都道府県) > 1          -- 押し下げ不能（client scalar）→ FULL_SCAN 化
-- → YESTERDAY: WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN
```

Phase1 は「WHERE 全体が exact でなければ拒否」に倒したが、これは実用上かなり制約的で、利用者が自然に踏む。理想は **SUPERSET_PREFILTER**＝相対日付 exact leaf（`更新日時 >= YESTERDAY()`）を kintone へ**プレフィルタとして押し下げ**（サーバ評価は1回）、取得した superset に対して**残余の押し下げ不能述語（`LENGTH(都道府県) > 1`）だけを client 評価**する。相対日付関数は client で再評価しない（サーバ結果を再利用）。

- 実装の難所: 現行 FULL_SCAN / SUPERSET_PREFILTER の client 再評価は WHERE **全体**を `evalWhere` で再評価する。相対日付 leaf を「押し下げ済み＝client 側では常に真」として残余評価から**除外**する plan surgery が要る（LIKE の safe-leaf prefilter に相対日付 leaf を組み込み、残余評価では当該 leaf を skip）。B67 の runtime backstop はそのままにし、残余評価に相対日付 leaf を到達させない。
- 忠実性: プレフィルタはサーバ評価なので superset は正しい。残余は非日付述語だけなので client 評価で問題ない。相対日付の TZ / 週境界 / 月末は Phase1 と同じくサーバに委ねる。
- 対象: AND の一部だけ exact なケース（`相対日付 exact AND 非押し下げ`）。OR や JOIN 後残余は別途慎重に判断。
- Phase1 の回避策（記録）: 押し下げ可能な述語へ置換（例 `都道府県 != ''`）／リテラル日付化（server-相対を失う）。CTE / temp 二段は Phase1 では拒否（相対日付は materialized 経路も対象外）。

### 11.2 その他

- `PRIMARY_ORGANIZATION()` と、B54 User API / 実行ユーザー文脈の整理。
- 相対日付関数の client 評価。kintone と一致するタイムゾーン、週境界、月日繰越、期間比較を公式根拠と実機で固定した場合に限り検討する。
- FULL_SCAN、JOIN後残余、VALIDATE、派生 / temp / CTE列、サブテーブル、関連レコードでの利用。
- SELECT / SET / CHECK / HAVING / CASE / ORDER BY 等の一般スカラー関数化。
- `IN` / `NOT IN`、`NOT BETWEEN`、関数左辺比較、式を引数に取る拡張。
- kintone が将来公開する `FROM_TODAY` の数値上限を、kSQL の安全整数境界より狭い事前検証へ取り込むこと。公式契約または実機で安定した上限が確認できた場合に別途判断する。

## 12. 工数見積り

Phase1 R1 の概算は **6〜10人日**。

| 作業 | 目安 |
|---|---:|
| WHERE専用 parser、soft keyword、AST、引数検証 | 1.5〜2.5人日 |
| serializer、legacy byte snapshot | 0.5〜1人日 |
| B32 型 × 演算子 × 関数能力、plan walk、fail-closed | 1.5〜2.5人日 |
| EXPLAIN、KORDER / DML経路整合 | 0.5〜1人日 |
| catalog、fixture、instructions、言語リファレンス | 0.5〜1人日 |
| unit / integration / CLI・MCP・両ブラウザ smoke | 1.5〜2人日 |

実装時の主要リスクは、(a) FULL_SCAN / VALIDATE / DML補助経路での暗黙 `evalWhere` 到達を全て列挙すること、(b) 関数名を field identifier と両立させる contextual parse、(c) legacy AST / query の byte snapshot、(d) B32 と EXPLAIN の判定重複を作らないことである。

## 13. 判断論点の決着表

| # | ブリーフの判断論点 | R1 の決着 |
|---:|---|---|
| 1 | 評価戦略 / 押し下げ不可 | **A: server-only**。RESTへ押し下げ、client 評価へフォールバックしない。取得後再評価を含む計画は record API 前に `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`（§3、§5）。 |
| 2 | 型 | `DATE` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` のトップレベル物理フィールドだけ。`TIME`・未知型・非物理列は取得前拒否（§4）。 |
| 3 | 位置・演算子 / BETWEEN / IN | WHERE の field-left / function-right、6比較だけ。`BETWEEN` は既存の `>= AND <=` 展開を両辺exactの場合だけ許可。`IN` / `NOT IN` は非対応（§2.3、§4）。 |
| 4 | 引数文法・soft keyword・`n` | 公式の単位・7曜日・`LAST` / 1〜31を厳格化。引数語と関数名は文脈認識、同名fieldはバッククォート退避。`n` は負値可の10進安全整数、式・小数・指数不可（§2、§7）。 |
| 5 | serialize | 検証済み関数を大文字、`, `区切り、最短10進でRESTへ出力。field / operator は既存 converter を再利用（§6）。 |
| 6 | AST | legacy branch `{type,name}` を形ごと保持し、新規 relative branch だけ discriminated `args` を持つ（§7.2）。 |
| 7 | catalog / docs | contextual catalogへ12関数、parser / fixture双方向guard、言語リファレンス同期。529→概算541語で `<=550` を維持し実測固定（§8）。 |
| 8 | 面 | engine一元実装で Node / CLI / MCP / plugin 同一。評価主体は全てkintoneサーバ、両ブラウザsmokeをgate化（§9、§10）。 |

R1 として公開意味論上の未解決論点はない。実装着手前の R2 レビューでは、§12 の4リスクと、公式に数値上限が公開されていない `FROM_TODAY` を安全整数境界とした実装可能性を再確認する。これは R1 の Phase1 契約（server-only、safe integer、fail-closed）を未決に戻すものではない。

## 14. Claude レビュー（R1→R2 申し送り）

2026-07-24・Claude レビュー。方針 A（押し下げ専用・fail-closed）は妥当で採用。安全性の3前提を実コードで裏取り済み＝①B32 `whereCapability.ts:140-145` は右辺 `KINTONE_FUNC` を関数名で区別せず一律 `EXACT_PUSHDOWN`（＝§5.1 の型×演算子×関数 allowlist 拡張が必須）②`execute.ts:1070` の FULL_SCAN は `evalWhere(stmt.where, ...)` で WHERE 全体を再評価（＝相対日付関数が漏れると client 側で誤評価）③`parser.ts:2215` が WHERE `BETWEEN` を `>= AND <=` へ展開（§2.3 の前提どおり）。以下は R2 で確定させる指摘。

1. **【最重要・正しさ／R2 必須】§5.3 の runtime backstop は現状コードに存在しないので明示追加を必須要件化する。** `resolveKintoneFunc`（`src/engine/evalWhere.ts:429`）は `name: "TODAY" | "NOW" | "LOGINUSER"` に対する **default 節のない switch** であり、相対日付名（例 `FROM_TODAY`）が万一 evalWhere 経由で渡ると**どの case にも一致せず `undefined` を silent 返却**する（fail-closed しない＝silent-wrong-result）。§5.3 は「evalWhere に到達したら `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で内部 fail-closed」と意図を書いているが、これは**実装で明示的に throw を足さない限り成立しない**。R2 で「`resolveKintoneFunc`（または evalWhere の `KINTONE_FUNC` dispatch）で相対日付名は必ず throw する」を要件として明記し、受入条件（§10.4）に「planner を test seam で意図的に bypass し相対日付関数を FULL_SCAN へ通しても、`undefined` や誤値でなく `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で fail-closed する」テストを追加する。これで §5.2 の経路列挙漏れ（§12(a) リスク）に対する真の防御網になる。
2. **【R2 で強調】§5.2 の evalWhere 到達経路の網羅は planner 側 allowlist と backstop の二段で担保する。** 経路列挙（FULL_SCAN/JOIN 残余/VALIDATE/temp・CTE/サブテーブル DML/UPDATE FROM/APPLY/REORDER）は planner の drift に弱いので、指摘1の backstop を「列挙漏れがあっても silent-wrong にならない最後の砦」と位置づけ、両方を受入条件にする。

**R1→R2 で反映済み**（指摘1＝§5.3 / §10.4、指摘2＝§5.2 / §5.3 / §10.4）。上記レビュー原文は申し送りと反映状況の記録として維持する。それ以外の公開意味論・判断、および §13 の決着表は R1 から変更しない。
