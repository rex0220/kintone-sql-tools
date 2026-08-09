# B53 Phase1 — `WITH RECURSIVE` / `CYCLE`（単一再帰 CTE）仕様

- 作成日: 2026-07-23
- ステータス: **仕様 R2・Claude レビュー済＝実装着手可能水準**（2026-07-23）。R1 レビュー指摘4件（§13）を R2 本文へ反映（§4.2 プッシュダウン限定／§7.1 CYCLE 列解決／§7.3 SET 文脈限定＋テスト／§11 path メモリ実測）＝再レビューで全数妥当・新規の綻びなし。公開意味論の2核心（論点1=CYCLE は爆発を止めない→3絶対上限常時 fail-closed／論点2=path スコープ循環判定）は不変。残は §11 の実装時精査のみ。**現在＝実需待ちで棚上げ**（仕様は実装着手可能な状態で凍結）。実装着手は BOM/循環の具体ユースケース確認後に判断（見積り 18〜29 人日の大型投資・B40 Phase1 spec と同じく「実装可能な状態で資産化」）。**【2026-08-09 追記】B160 同梱の R3 リフレッシュ決定**＝[事前調査報告](ksql_b53_b160_codex_investigation_report.md)（仕様 R2 と v3.65.0 の食い違い 11 項目）を反映する。設計 3 決定（オーナー承認）＝①キーワード＝§7.3 ソフト維持 ②境界エラー＝専用クラス＋構造化プロパティ（`KsqlEngineError` 公開 code union 不変・写像は当面 `EXECUTION_ERROR`・source 取得超過は既存 `FetchAllLimitError` のまま）③型整合＝planning 証明維持（静的型推論を新設）。**R3 完成（同日・Claude レビュー済）＝[ksql_b53_recursive_cte_cycle_phase1_spec_r3.md](ksql_b53_recursive_cte_cycle_phase1_spec_r3.md)。以後の正は R3・本書は R2 凍結版として保存。**
- 対象リリース: 未定（実装判断前）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B53
- 起草ブリーフ: [ksql_b53_phase1_spec_r1_brief.md](ksql_b53_phase1_spec_r1_brief.md)
- 評価: [ksql_b53_recursive_cte_cycle_evaluation.md](ksql_b53_recursive_cte_cycle_evaluation.md)
- 土台: B51/B52（v3.11.0 の実体化 CTE・effective alias・列別名/型メタ）および既存 `UNION ALL` / JOIN
- 関連: [横断: 文字列の扱い](ksql_string_semantics.md)・B14（temp 列型メタ伝播）

## 1. スコープ（Phase1）

SQL:1999 の再帰 CTE と SQL:2016 の `CYCLE` のうち、kSQL で安全に実行できる最小形を read-only の全実行面へ追加する。

### 1.1 対象

- `WITH RECURSIVE name [(列名, ...)] AS (seed UNION ALL 再帰項)` の**単一再帰 CTE**。
- seed 1個、再帰項 1個、両者を分ける集合演算は `UNION ALL` のみ。
- 再帰 CTE の自己参照は再帰項内の1回だけ。物理アプリまたは先行する非再帰 CTEとの `INNER JOIN` 1個、`ON` は単一等値。
- 再帰項では `WHERE`、フィールド/リテラル/既存スカラー式の射影、算術（例: `深さ + 1`、`累計員数 * 員数`）を許可する。
- 任意の `CYCLE <単一列> SET <mark列> TO '<循環値>' DEFAULT '<通常値>'`。循環行の mark 付与、path スコープの循環判定、当該 path の打ち切りを行う。
- 非再帰 sibling CTEとの共存、再帰結果を使う後続非再帰 CTE、外側 SELECT の WHERE / JOIN / GROUP BY / HAVING / ORDER BY / 集約。
- 実行戦略 B（参照アプリを先に1回だけ実体化し、以降はメモリ反復）。
- EXPLAIN、CLI、MCP、プラグインの同一意味論と同一の安全境界。

### 1.2 対象外

- 複数の再帰 CTE、相互再帰、再帰項からの自己参照2回以上、非線形再帰、ネストした `WITH RECURSIVE`。
- 再帰 CTEを `UNION`（重複排除）で構成すること、3分岐以上の UNION chain。
- 再帰項内の集計、`GROUP BY`、`HAVING`、`DISTINCT`、window、OUTER JOIN、サブクエリ、別の JOIN、`KORDER BY` / `ORDER BY` / `LIMIT` / `OFFSET`。
- 複数列による `CYCLE`、`USING <path列>`、path 列の公開、`SEARCH`、探索順の指定、最短経路。
- 戦略 C（深さごとの targeted `IN` 取得）、不完全な母集合を使う反復。
- 再帰 CTE を DML の source にすること。Phase1 の外側文は `SELECT` または `UNION [ALL]` に限る。

## 2. 構文

```ebnf
with_recursive :=
  WITH RECURSIVE cte_definition (',' cte_definition)* outer_query

recursive_cte_definition :=
  cte_name [ '(' column_name (',' column_name)* ')' ]
  AS '(' seed_select UNION ALL recursive_select ')'
  [ cycle_clause ]

cycle_clause :=
  CYCLE cycle_column
  SET cycle_mark_column
  TO string_literal
  DEFAULT string_literal
```

`WITH RECURSIVE` 内で自己参照を含む定義を再帰 CTE、それ以外を非再帰 sibling と判定する。再帰 CTEはちょうど1個まで（0個なら従来の非再帰 `WITH` と同じ結果を返す）。名前の可視性は既存 `WITH` と同じく定義順であり、再帰 CTEは自分自身と先行 sibling を参照でき、後続 sibling は再帰 CTEを参照できる。後方参照と相互参照は planning error とする。

Phase1 の `CYCLE` 列は**単一列**に確定する。`TO` と `DEFAULT` は kSQL に真偽値リテラルがないため文字列リテラルに限定し、NULL不可、同値不可とする。mark 列は CTE の宣言列/seed/再帰項の射影には含めず、`CYCLE` が生成して再帰 CTE出力の末尾に追加する。既存出力列との同名は planning error とする。

例:

```sql
WITH RECURSIVE 部品展開
  (親品目, 子品目, 深さ, 累計員数) AS (
  SELECT 親品目, 子品目, 1, 員数
  FROM APP100
  WHERE 親品目 = 'P001'
  UNION ALL
  SELECT c.親品目, c.子品目, r.深さ + 1, r.累計員数 * c.員数
  FROM APP100 AS c
  INNER JOIN 部品展開 AS r ON c.親品目 = r.子品目
)
CYCLE 子品目 SET is_cycle TO 'Y' DEFAULT 'N'
SELECT 子品目, SUM(累計員数) AS 所要量
FROM 部品展開
WHERE is_cycle = 'N'
GROUP BY 子品目;
```

## 3. 意味論

### 3.1 反復と多重度

1. seed を1回評価し、結果を深さ0の frontier かつ累積結果とする。
2. 再帰項の自己参照には、累積結果全体ではなく**直前の frontier**だけを代入する。
3. 再帰項が生成した非循環行を次の frontier と累積結果へ加える。
4. 次の frontier が空になるまで繰り返す。外側 SELECT は再帰 CTEを完全に実体化した後に評価する。

`UNION ALL` なので行の重複排除は行わない。同じノードへ異なる path で到達した場合は別の出現であり、各出現を再展開する。出力順は保証しない。実装上 breadth-first で反復しても、利用者が順序を必要とする場合は外側 `ORDER BY` を必須とする。

### 3.2 CYCLE は path スコープ

循環判定は**各出力行が持つ現在の path 上の既出値集合**に対して行う。seed 行の path はその行の CYCLE 列値から始まり、子候補の CYCLE 値がその親行の path に既出なら循環である。比較は [文字列の扱い](ksql_string_semantics.md) と B14 の列型メタを使う既存の型付き等値とし、型メタを失った文字列比較へフォールバックしない。

これは global visited 集合ではない。例えば `A→B→D` と `A→C→D` の `D` は、どちらの path にもそれ以前の `D` がなければ両方とも非循環であり、2行として残り、それぞれ再展開される。global visited によって後者を落とす実装は禁止する。

循環候補は `mark = TO` として**1回だけ累積結果に含める**が、次の frontier には入れず、その path だけを打ち切る。非循環行（seed を含む）は `mark = DEFAULT` とし、更新済み path を行に内部保持する。path は行ごとの内部状態であり、Phase1 は列として公開しない。`CYCLE` のないクエリでは path による抑止を行わず、§5 の絶対上限だけが安全性を保証する。

### 3.3 CYCLE と爆発の関係

**CYCLE は組み合わせ爆発を止める境界ではない。** CYCLE が防ぐのは、現在 path 上の同じ値へ戻る循環データによる無限反復だけである。循環のない DAG、特に同一部品を多数の親から再利用する BOM は、合流後も path ごとに再展開されるため行数が指数的に増え得る。

したがって「CYCLE または境界のどちらかを要求する」という契約にはしない。**CYCLE の有無にかかわらず、最大再帰深さ・最大総結果行・最大累積中間展開を常時有効な正整数として強制する。CYCLE は任意の早期打ち切りであり、安全境界の代替ではない。**

### 3.4 seed と再帰項の列

- CTE列名リストを指定した場合、列数は seed の列数と完全一致し、出力名はリストを正とする。省略時は seed の出力名を使い、重複名または参照不能な無名式があれば planning error とする。
- seed と再帰項は列数が一致しなければならない。
- 各位置の型は B14 の `MaterializedColumnMeta` 相当を seed と再帰項の両方から解決する。同じ型付き比較/算術カテゴリとして互換であることを planning 時に証明できなければ error とする。NULL リテラルだけは反対側の型を継承できる。
- 数値演算列は数値、文字列列は文字列など、確定したメタを全反復・外側クエリへ伝播する。未知型を黙って string にすることは禁止する。

### 3.5 `$id` / `RECORD_NUMBER`

再帰結果は物理アプリではなく実体化 CTE であり、固有の kintone record identity を持たない。したがって `$id` または `RECORD_NUMBER` を自動生成・再採番・特別解決しない。

seed/再帰項が物理アプリの `$id` / `RECORD_NUMBER` を明示的に射影した場合は、その値と B14 の record-number 型メタを持つ**通常の実体化列**として運ぶ。複数 source の同名を区別する必要がある場合は CTE 列名リストまたは `AS` で別名を付ける。これらを CYCLE 列や JOIN キーに使うことは、単一出力列として型が整合する限り許可する。

## 4. 実行・エンジン（戦略 B）

Phase1 は戦略 Bに固定する。

1. planning 時に seed、再帰項、許可された sibling が参照する物理アプリ/LAPP を解決し、必要フィールドの和集合を作る。
2. 同じ resolved app・profile・cache context はクエリ内で1つの物理 source として扱い、反復開始前に**1回だけ完全実体化**する。行フィルタを物理 source の取得へ押し下げられるのは、**そのアプリへの全参照（seed・再帰項の双方）に共通して安全であり、どの参照に必要な行も除外しないと planning 時に証明できる述語に限る**。seed 固有または再帰項固有の行フィルタは押し下げず、完全実体化した source に対してメモリ内で評価する。再帰クエリでは行フィルタのプッシュダウンは原則不可とし、通常の押し下げは全参照で必要フィールドを集約した**列射影の最小化に限定する**。自己参照値に依存する条件も必ずメモリ評価する。
3. 各物理 source の取得は既存 `fetchAll` / Cursor 切替 / request gate / `fetchParallel` を使う。`onLimit=truncate` は無効化し、各 source が `maxRecords` を超えた時点で error とする。部分母集合を CTE cache へ登録して反復してはならない。
4. B51/B52 後の `MaterializedTable`、effective alias、列メタ、FULL_SCAN JOIN、`UNION ALL` の射影対応を再利用し、frontier を自己参照 CTE名に注入してメモリ内で逐次反復する。
5. 反復終了後だけ、完成した再帰結果を通常の実体化 CTEとして後続 sibling と外側 SELECT に渡す。外側 GROUP BY / SUM 等は既存集計経路をそのまま使う。

複数の物理アプリを参照する場合、`maxRecords` は合計ではなく**各アプリ個別**に検査する。1つでも超過したら全体を失敗させる。API回数は深さに依存せず、distinct な参照アプリ `a` ごとに概ね `⌈R_a / P⌉`、全体で `Σ_a ⌈R_a / P⌉` である。同じアプリを各反復で再取得する戦略 Aは禁止する。

## 5. 境界・fail-closed

### 5.1 常時強制する3境界

| 境界 | 数え方 | Phase1 既定 |
|---|---|---:|
| `recursiveCteMaxDepth` | seed=深さ0。再帰項の適用で生成される行の最大深さ | 100 |
| `recursiveCteMaxRows` | seed、非循環行、mark付き循環行、`UNION ALL` 重複を含む再帰 CTE累積結果行 | 10,000 |
| `recursiveCteMaxExpansions` | 全反復を通じ、等値 JOIN 成立後・再帰項 WHERE/CYCLE 除外前に生成した候補ペアの累積数 | 100,000 |

3値はすべて positive safe integer に限る。0、負数、無制限を表す値、非整数は実行開始前に拒否する。上限を超える候補を1件でも検出した時点で固定コードの実行エラーとし、再帰 CTEの部分結果を返さない。外側 `LIMIT`、`CYCLE`、`onLimit=truncate` はこの契約を緩和しない。

固定エラーコードは次とする（メッセージには実効上限、検出値、CTE名を含める）。

- `RECURSIVE_CTE_MAX_DEPTH_EXCEEDED`
- `RECURSIVE_CTE_MAX_ROWS_EXCEEDED`
- `RECURSIVE_CTE_MAX_EXPANSIONS_EXCEEDED`
- source 取得超過は既存 `FetchAllLimitError` を維持する。

「ちょうど上限」は成功できる。深さ上限については、上限を超える深さの候補が実際に生成された場合だけ error とする。frontier が上限深さで自然終了するクエリは成功する。

### 5.2 設定経路

エンジンの `ExecuteOptions` / `BatchExecuteOptions` に上記3値を追加し、全実行面が同じ値を渡す。

| 面 | 設定名 |
|---|---|
| env | `KSQL_RECURSIVE_CTE_MAX_DEPTH` / `KSQL_RECURSIVE_CTE_MAX_ROWS` / `KSQL_RECURSIVE_CTE_MAX_EXPANSIONS` |
| profile | `profiles.<name>.query.recursiveCteMaxDepth` / `recursiveCteMaxRows` / `recursiveCteMaxExpansions` |
| CLI | `--recursive-cte-max-depth` / `--recursive-cte-max-rows` / `--recursive-cte-max-expansions` |
| MCP | `ksql_query` と `ksql_explain` の同名 camelCase input |
| plugin | 実行オプション UI の「再帰深さ」「再帰結果行」「再帰中間展開」。localStorage 保存値も同名 camelCase |

Node系の優先順位は `明示 input/CLI > env > profile > engine default`。plugin は `UI/保存値 > engine default`。設定を省略しても engine default が必ず入り、境界なしにはならない。`ksql_validate` は SQL の静的制約を検査し、実行時境界値を入力には持たない。

参照アプリの完全性境界は既存 `maxRecords` を使う。CLI/MCP の既定500、engine APIの既定10,000、pluginの実効値という既存の面ごとの差は維持するが、どの値でも再帰 query 中は常に `onLimit=error` とする。再帰 CTEの累積結果には `tempTableMaxRows` ではなく専用の `recursiveCteMaxRows` を適用し、両者を暗黙連動させない。

### 5.3 適用規模の目安（BOM／所要量展開）

R2 時点の**見積り目安**（実装時に実データ benchmark で確定。B65 の guard 値を Node benchmark で確定した前例と同じ扱い）。効くのは2レイヤー＝**取得（構成表アプリの全行）**と**展開（木を展開した生行数）**。深さは実 BOM 3〜15 段・組織図 〜20 段で上限 100 に対し実質非拘束。

| レイヤー | 効く境界 | 既定 | 実用レンジの目安 |
|---|---|---|---|
| 取得＝構成表アプリの行数 `R` | `maxRecords`／kintone 全件取得打ち切り(≈10万) | engine 10,000・CLI/MCP 500 | 〜1万リンクは無調整・〜数万は maxRecords 引き上げ・**10万接近は Phase1 外（戦略 C/アプリ分割）** |
| 深さ | `recursiveCteMaxDepth` | 100 | 実データでは当たらない（暴走循環の安全網） |
| 展開の生行数（UNION ALL・重複排除なし） | `recursiveCteMaxRows` | 10,000 | **最初に効きやすい**。ロールアップ**前**の経路出現行を数える |
| 中間展開数 | `recursiveCteMaxExpansions` | 100,000 | 生行数の 2〜5倍 |

**重要**: 3 guard が数えるのは**ロールアップ前の生の経路出現行**であり、外側 `GROUP BY 子部品 SUM(所要量)` 後の最終出力（ユニーク部品・数百〜1,000 行）ではない。同一部品の多所再利用は path ごとに出現するため、最終結果が小さくても中間の生行数は膨らむ。

規模例（ラジオ級の組立製品）:

- **セット製品1台**（AM 機 〜50・AM/FM 多バンド機 〜200〜400 リンク／深さ 3〜5／展開 数百〜1,000 行）＝**既定値で余裕**。
- **10製品の所要量展開**（seed を `親品目 IN (10製品)`・`製品` 列を経路で持ち回り1クエリで合算 or 製品別）＝生行数 数千〜1万行で**既定 `recursiveCteMaxRows=10,000` に肉薄**→ 多製品 MRP を主用途にするなら **rows≈5万・expansions≈20万へ引き上げ**を前提（メモリ・時間は B65 実測=5万行 131ms/70MiB のレンジで問題なし）。
- 取得側は**製品数に非依存**（戦略 B は構成表アプリ全体を1回取得）。律速は展開の生行数と、アプリに何製品分ため込むか。
- 数十〜百製品を合算、または大型 BOM で生行数が数十万に達する段階で、guard 引き上げでも頭打ちになり戦略 C（Phase2）/アプリ分割の検討ラインに入る。

## 6. 終了保証

終了は次のいずれかで起こる。

1. frontier が空になる自然 fixpoint。
2. `CYCLE` が path ごとの循環候補を mark 行として出力し、その path を frontier から除外する。
3. 深さ・総行・中間展開のいずれかの絶対上限、または source の `maxRecords` を超えて fail-closed error。

1または2だけに依存した無制限実行は存在しない。CYCLE付きでも DAG の組み合わせ爆発があり、CYCLEなしでも非循環の有限木は自然終了し得るため、構文の有無ではなく3つの絶対カウンタを実行器が常時監視する。timeout / batch deadline は追加の中断手段であって、上記境界の代替ではない。

## 7. パーサ・予約語・AST

### 7.1 パーサと静的拒否

`WITH` の直後だけ `RECURSIVE` を、recursive CTE定義の右括弧直後だけ `CYCLE ... SET ... TO ... DEFAULT ...` を認識する。再帰 CTE候補を一般の UNION chain として実行へ流さず、planning で次を検証する。

- 自己参照は seed に0回、再帰項にちょうど1回。
- 最上位形が `seed SELECT UNION ALL recursive SELECT` の2分岐。
- 再帰項が §1.1 の JOIN / WHERE / 射影だけで構成される。
- 列数、列名、型、CYCLE列、mark列が §2・§3.4 を満たす。
- `CYCLE` 列は CTE 列名リストを指定した場合はその宣言列、省略した場合は seed の射影名のいずれか1列へ一意に解決できる。物理 source の任意フィールドを直接参照することはできず、未解決・重複・曖昧な名前は planning error とする。
- recursive CTEは1個、依存グラフは定義順の有向非巡回（自己辺だけ例外）。

違反は曖昧な通常 CTEや物理アプリ参照へフォールバックせず、ParseErrorまたは planning error で fail-closed とする。

### 7.2 AST

既存 AST を次の意味で拡張する（名称は実装時に同等の discriminated union へ変更可）。

```ts
interface WithStatement {
  type: "WITH";
  recursive: boolean;
  ctes: CteDefinition[];
  query: SelectStatement | UnionStatement;
}

interface CteDefinition {
  name: string;
  columnAliases: string[] | null;
  query: SelectStatement | UnionStatement | ShowAppsStatement | DescribeStatement;
  recursiveSpec: {
    seed: SelectStatement;
    recursiveTerm: SelectStatement;
    unionAll: true;
    cycle: {
      column: string;
      markColumn: string;
      markValue: string;
      defaultValue: string;
      exposePath: false;
    } | null;
  } | null;
}
```

seed/再帰項の分離を AST に保持し、実行時に `UnionStatement.left/right` を再解釈しない。自己参照 `TableRef.cteName` は既存 CTE参照表現を使うが、planning 前の名前登録により定義中の自分自身だけを解決できるようにする。

### 7.3 ソフトキーワード

`RECURSIVE`、`CYCLE`、`TO`、`DEFAULT` は文脈依存のソフトキーワードにする。`SET` は既存のハードトークンを維持し、batch 変数の `SET @x` と `UPDATE ... SET` の字句・構文を変更しない。通常の SELECT 文脈では同名フィールドを従来どおり識別子として扱い、構文位置と衝突する同名フィールドはバッククォート（例: `` `CYCLE` ``、`` `SET` ``）で退避できることを保証する。既存構文でこれらの文字列を使う SQLを新たに一律拒否してはならない。

`CYCLE` 節の曖昧性は次の文脈限定手順で解消する。

1. recursive CTE 定義の右括弧を読み終えた位置でだけ、次の非引用 lexeme `CYCLE` を節開始として判定する。それ以外の位置の `CYCLE` は識別子として扱う。
2. `CYCLE` に続く `cycle_column` を識別子として1個消費した直後に限り、次の既存 `SET` ハードトークンを CYCLE 節の区切りとして要求する。この位置以外の `SET` は既存文法へ渡す。
3. mark列の識別子を消費した直後に非引用 lexeme `TO`、続く文字列リテラルの直後に非引用 lexeme `DEFAULT` を順に要求する。期待位置以外の `TO` / `DEFAULT` は識別子として扱う。
4. この順序に一致しない不完全な CYCLE 節は、通常の CTE、SELECT、batch `SET`、UPDATE `SET` へフォールバックせず ParseError とする。キーワードと同名の列を各構文位置で使う場合はバッククォートを必須とする。

専用パーサテストでは、正常な CYCLE 節、キーワードと同名のバッククォート列、通常 SELECT の `CYCLE` / `TO` / `DEFAULT` 識別子、既存の batch `SET @x`、UPDATE `SET` を正例として固定する。語順欠落・重複・`cycle_column` 直後に `SET` がない形・引用された `` `SET` `` を区切りに使う形を負例とし、既存構文へ誤フォールバックしないことも検証する。

## 8. 面（CLI / MCP / plugin）

- engine が意味論・反復・カウンタ・error code を一元実装し、CLI/MCP/pluginで結果を分岐させない。
- CLI は read-only query / `EXPLAIN` で対応する。再帰 CTEを含む query では `--on-limit truncate` を指定しても完全入力必須として error動作へ固定し、その旨を診断へ出す。
- MCP は `ksql_query` / `ksql_explain` / `ksql_validate` で構文を認識する。`ksql_mutate` は Phase1 の再帰 CTE source を拒否する。
- plugin は Cursor capability の有無にかかわらず戦略 Bを使う。source が `maxRecords` 内に完全取得できなければ error とし、ブラウザ独自の短縮結果を返さない。
- バッチ内の再帰 CTEも文スコープであり、CTE自体は次の文へ残らない。既存 temp tableへ再帰結果を書き出す構文は Phase1対象外である。

## 9. EXPLAIN と受入条件（テスト化）

### 9.1 EXPLAIN

EXPLAIN は record APIを呼ばず、実件数を断定しない。少なくとも次を表示する。

```text
recursive cte: 部品展開
strategy: B (materialize each source once, iterate in memory)
union: UNION ALL
self reference: once
cycle: path-scoped on 子品目, mark is_cycle ('Y'/'N'), cycle row emitted, expansion stopped
limits: depth=100, rows=10000, expansions=100000 (always fail-closed)
complete input: required (onLimit=truncate disabled)
source APP100: R unknown, pageSize=500, estimated calls=ceil(R/500), maxRecords=<effective>
iteration rows: unknown until execution
```

複数 source は個別行を出す。取得回数は `⌈R/P⌉` の記号見積りと、実効 `maxRecords` から導ける最大ページ数を併記してよい。実行前に R を読むための追加 API は発行しない。`CYCLE` なしでも `cycle: none (absolute limits still enforced)` と表示する。

### 9.2 正例

- **BOM多段展開**: 親→子を frontier が空になるまで展開し、利用者の深さ列を `+1`、累計員数を `親累計 * 子員数` で持ち回る。外側 `GROUP BY 子品目` + `SUM(累計員数)` が既存集計経路で正しい所要量を返す。
- **組織図**: 親部署/社員から子を可変深さで展開し、自然終了する。
- **循環**: `A→B→C→A` で最後の A 行だけが `is_cycle='Y'`、それ以前が `N`、mark行の先は展開しない。
- **pathスコープ**: `A→B→D` と `A→C→D` は D を2行とも非循環として残す。片方を global visited で循環扱いする実装は不合格。
- **同一値でも別seed/path**: seedごとにpath状態を共有せず、片方の訪問が他方を抑止しない。
- **非再帰 sibling**: 先行非再帰 CTEをseed/再帰項から参照でき、後続非再帰 CTEが再帰結果を集約できる。再帰 CTEは1個だけ。
- **system列**: 明示射影した `$id` / `RECORD_NUMBER` の値と型メタが反復・外側比較まで保持され、自動生成されない。

### 9.3 境界・負例

- **DAG再利用の爆発**: 循環のない多段diamond/BOMで CYCLE が一行もmarkしなくても、総行または累積中間展開の絶対上限で固定errorとなり、部分結果0。
- 深さ101の候補、結果10,001行目、中間展開100,001件目をそれぞれ独立に検出し、対応する固定error code。上限ちょうどと自然終了も固定する。
- CYCLEありでも3境界が常時監視される。CYCLEなしでも境界設定は省略不可（既定が入る）。
- 参照アプリごとの `maxRecords` 超過は `FetchAllLimitError`。複数アプリの一方が超過しても反復0回・部分結果0。
- `onLimit=truncate`、外側 `LIMIT` で上限を回避できない。
- `UNION`、列数/型不一致、自己参照0回/2回、seedの自己参照、OUTER JOIN、集計/window/DISTINCT/subquery/nested recursive、複数/相互再帰、複数CYCLE列、`USING` を静的拒否する。
- mark列の衝突、`TO`/`DEFAULT` の同値・NULL・非文字列を拒否する。

### 9.4 実行面・非回帰

- 同じ fixture と実効境界で CLI/MCP/plugin の行・mark・error code が一致する。
- EXPLAIN は record API 0回で、戦略、path scope、全境界、fail-closed、sourceごとの `⌈R/P⌉` を表示する。
- B51: aliasなしCTE間 JOIN、明示alias、0行スキーマ、欠落JOINキーの fail-closedを非回帰。
- B52: 改名列/式CTEの実体化、単純CTEの既存インライン化を非回帰。
- 既存の非再帰 `WITH`、CTE内 `UNION [ALL]`、temp table、通常 JOIN/集約は AST・結果・EXPLAINを不変に保つ。

## 10. Phase2 引き継ぎ（対象外）

- 複数/相互再帰、複数の再帰 member、`UNION` 重複排除。
- `CYCLE (col1, col2, ...)`、標準完全形の `USING path_col` と path値の公開。
- `SEARCH DEPTH/BREADTH FIRST`、安定した探索順、最短経路。
- 戦略 C（frontier keyによる深さ別 targeted `IN`）と、全件実体化が非現実的な大規模アプリ。
- 再帰項内の複数 JOIN、OUTER JOIN、集計/window/subquery、再帰 CTEを使うDML。
- statement-local な SQL 構文での境界上書き（例: `MAX RECURSION LEVEL`）は、全実行面の設定だけで運用上不足する実需が確認された場合に検討する。ただし無制限指定は将来も導入しない。

## 11. 工数見積り

R2時点の概算は **18〜29人日**。B51/B52の実体化資産は再利用できるが、反復・path状態・3境界・全実行面の設定配管は新規である。

| 作業 | 目安 |
|---|---:|
| パーサ、ソフトキーワード、AST、静的制約 | 3〜5人日 |
| seed/再帰項の列名・型整合、B14メタ伝播 | 2〜4人日 |
| 戦略Bのsource収集/1回実体化、frontier反復 | 4〜6人日 |
| pathスコープCYCLE、mark、3つのfail-closed counter | 3〜5人日 |
| ExecuteOptions、env/profile/CLI/MCP/plugin配管 | 2〜3人日 |
| EXPLAIN、診断、docs | 1〜2人日 |
| unit/integration/browser smoke・B51/B52非回帰 | 3〜4人日 |

実装着手前のR2レビューでは、特に (a) 中間展開を JOIN成立後・WHERE/CYCLE前で数える計測点、(b) 物理sourceの同一性/cache key、(c) 型不明時にplanning errorへ閉じる範囲、(d) plugin UIに3項目を追加する操作性、(e) 深い BOM を含む代表データで行ごとに保持する path 集合のメモリ使用量の実測をコード単位で再確認する。これらは実装詳細の精査事項であり、本R2の公開意味論（path scope、CYCLE行の扱い、常時3境界、戦略B）を未決に戻すものではない。

## 12. 判断論点の決着表

| # | ブリーフの判断論点 | R1の決着 |
|---:|---|---|
| 1 | CYCLEと爆発 | **CYCLEは爆発を止めない。3絶対上限をCYCLE有無にかかわらず常時fail-closed**（§3.3、§5） |
| 2 | 循環判定scope | **行ごとの現在path**。global visited禁止（§3.2） |
| 3 | CYCLE subset | `CYCLE col SET mark TO 'x' DEFAULT 'y'`、**単一列**、`USING`なし（§2） |
| 4 | 再帰項制約 | 自己参照1回、INNER単一等値JOIN、WHERE/射影算術のみ。列挙された高度構文は拒否（§1） |
| 5 | 列整合 | 列数一致、B14型メタ伝播、互換性を証明不能ならplanning error（§3.4） |
| 6 | sibling CTE | 非再帰sibling許可、再帰CTEは1個、定義順参照、相互再帰なし（§2） |
| 7 | 外側集約 | 実体化結果を既存集計へ渡し、BOM roll-upを必須受入条件化（§4、§9） |
| 8 | 戦略B境界 | 各参照アプリを個別に`maxRecords`/errorで完全取得。戦略CはPhase2（§4、§5） |
| 9 | 既定と設定 | depth=100、rows=10,000、expansions=100,000。env/profile/CLI/MCP/pluginを定義（§5） |
| 10 | `$id`/`RECORD_NUMBER` | 自動identityなし。明示射影時だけ通常の型付き実体化列として保持（§3.5） |
| 11 | 予約語/AST | 5語を可能な限りsoft化、バッククォート退避、seed/再帰項をASTで分離（§7） |

R1として公開意味論上の未解決論点はない。§11末尾の4点はR2でコード実現性を再確認する実装精査事項である。

## 13. Claude レビュー（R1→R2 申し送り）

2026-07-23・Claude レビュー。核心2論点（path スコープ／3絶対上限常時）は妥当で採用。以下は R2 で決着させる指摘。

1. **【正しさ・最重要】§4.2 のプッシュダウン許容が「1回だけ完全実体化」と矛盾しうる（under-fetch の罠）。** 戦略 B は再帰項が参照アプリの**全行**を要求する。seed の `WHERE 親品目='P001'` のような行フィルタを共有 source の取得に押し下げると、再帰に必要な子孫行（`親品目≠'P001'`）を取りこぼす。§4.2 の「アプリだけで安全に評価できる固定述語は押し下げてよい」は、**そのアプリへの全参照（seed・再帰項の双方）に共通して安全な述語に限る**と狭める。seed 固有／再帰項固有のフィルタはメモリ評価のみ。実質、再帰クエリでは行フィルタのプッシュダウンは原則不可とし、押し下げは列射影の最小化に限定する旨を明記する。
2. **【明確化】CYCLE 列は CTE の出力列に解決必須。** §3.2 は CYCLE 列値が出力行ごとに存在する前提だが、§7.1 の静的検証に「CYCLE 列＝宣言列 or seed 射影名に解決し、物理 source の任意フィールドは不可」を明示していない。検証リストへ追記する。mark 列の同名衝突（§2 で規定済）と対で、CYCLE 列の解決規則も固定する。
3. **【パーサ】`SET` は既存ハードトークン**（`src/lexer/tokens.ts:47`・batch 変数 `SET @x` と UPDATE SET で使用）。CYCLE 節の `SET`/`TO`/`DEFAULT` の soft 化は「cycle_column 直後の文脈限定」で方向は正しいが、既存 `SET` と隣接するため R2 で**曖昧性解消の具体規則＋専用テスト**を要件化する（「可能な限り soft 化」の曖昧さを残さない）。`RECURSIVE`/`CYCLE`/`TO` は現状トークン非存在（新規）。
4. **【小・R2 実測】path の行内保持（§3.2）のメモリ**は 3 境界（rows/expansions）で有界だが、深い BOM で path 集合が行ごとに嵩む。§11(a) の計測点確認に「path 保持のメモリ実測」も加える。

指摘1・2は正しさ／受理範囲に直結、3はパーサ健全性、4は実測項目。1〜3を R2 本文へ反映すれば実装着手可能水準。

**R1→R2 で反映済み（2026-07-23、Claude 再レビュー待ち）。** 指摘1は §4.2、指摘2は §7.1、指摘3は §7.3、指摘4は §11へ反映した。§12 の決着および公開意味論の2核心（path スコープ／3絶対上限常時）は変更していない。
