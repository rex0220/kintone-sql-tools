# B53 Phase1 — `WITH RECURSIVE` / `CYCLE`（単一再帰 CTE）仕様 R3

- ステータス: ✅ **v3.66.0 リリース（2026-08-09・B160/B165/B166 同梱・BOM fixture 実機 394/394 全一致・publish はオーナー操作待ち）**。以下は R4 確定時の記録 — 設計 4 決定＝①4語は文脈限定ソフトキーワードを維持 ②3境界は専用エラークラス＋構造化プロパティで表現し公開 code union は不変 ③seed／再帰項の型整合は新設する静的型推論器により planning 時に証明 ④空キー×再帰（§4.6・[依頼元 §5-2](../../../ksql-analytics/docs/internal/kSQLエンジンへの依頼-20260809-再帰CTE.md) 起点）は**案 b＝B153 意味論維持＋実行時警告**（すべて 2026-08-09 オーナー判断）。**実装完了（同日・4 段階＋レビュー修正 3 巡＋B166 修正）**＝[実装依頼](ksql_b53_codex_impl_request.md)・B165/B166 同梱・全 6,104 テスト緑・**BOM fixture（APP4237/4238）実機 394/394 全一致・3 境界 fail-closed・EXPLAIN record API 0 回を実機確認**。リリース待ち。（ファイル名は `_r3` のまま＝改訂は git 履歴で追う）
- 作成日: 2026-07-23（R2 は [ksql_b53_recursive_cte_cycle_phase1_spec.md](ksql_b53_recursive_cte_cycle_phase1_spec.md) に凍結保存）
- R3 改訂日: 2026-08-09（依頼: [ksql_b53_codex_spec_r3_request.md](ksql_b53_codex_spec_r3_request.md)）
- 対象リポジトリ基準: `main`・v3.65.0
- 対象リリース: 未定（実装判断前）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B53
- 起草ブリーフ: [ksql_b53_phase1_spec_r1_brief.md](ksql_b53_phase1_spec_r1_brief.md)
- 評価: [ksql_b53_recursive_cte_cycle_evaluation.md](ksql_b53_recursive_cte_cycle_evaluation.md)
- R3 事前調査: [ksql_b53_b160_codex_investigation_report.md](ksql_b53_b160_codex_investigation_report.md)
- 同梱: [B160](ksql_b160_window_warning_generated_column_issue.md)
- 土台: B51/B52 の実体化 CTE・effective alias・列別名／型メタ、B149 の文 CTE、B155 の共有 leaf policy、既存 `UNION ALL` / JOIN
- 関連: [横断: 文字列の扱い](ksql_string_semantics.md)・B14（temp 列型メタ伝播）・[B140](ksql_b140_cte_groupby_total_order_spec_r2.md)・[B149](ksql_b149_generate_series_issue.md)

公開意味論の二つの核心は R2 から変更しない。

1. `CYCLE` は行ごとの現在 path を対象とし、global visited 集合を使用しない。
2. `CYCLE` の有無にかかわらず、深さ・結果行・中間展開の三つの絶対上限を常時 fail-closed で強制する。

## 1. スコープ（Phase1）

SQL:1999 の再帰 CTE と SQL:2016 の `CYCLE` のうち、kSQL で安全に実行できる最小形を read-only の全実行面へ追加する。

### 1.1 対象

- `WITH RECURSIVE name [(列名, ...)] AS (seed UNION ALL 再帰項)` の**単一再帰 CTE**。
- seed 1個、再帰項1個、両者を分ける集合演算は `UNION ALL` のみ。
- 再帰 CTE の自己参照は再帰項内の1回だけ。
- 再帰項は、物理アプリまたは先行する非再帰 CTE との `INNER JOIN` 1個を持てる。`ON` は単一等値に限定する。
- 再帰項では `WHERE`、フィールド、リテラル、既存スカラー式の射影、算術を許可する。代表例は `深さ + 1`、`累計員数 * 員数`。
- 任意の `CYCLE <単一列> SET <mark列> TO '<循環値>' DEFAULT '<通常値>'`。
- `CYCLE` は循環行へ mark を付け、行ごとの path で循環を判定し、その path の先だけを打ち切る。
- 非再帰 sibling CTE との共存、再帰結果を使う後続非再帰 CTE、外側 SELECT の `WHERE` / JOIN / `GROUP BY` / `HAVING` / `ORDER BY` / 集約。
- 実行戦略 B。参照する物理 source を反復開始前に1回だけ完全実体化し、以後はメモリ内で反復する。
- EXPLAIN、CLI、MCP、plugin、engine library の同一意味論と同一安全境界。
- B160 の全順序警告について、B140 の集約キー、B160 の生成列×JOIN、B53 の再帰 CTE 出力を同じ条件文で判断できる助言へ一般化する。

Phase1 の seed／再帰項の射影文法は、フィールド、リテラル、既存スカラー式および算術に限定される。この狭い文法を、§3.4 の planning 時静的型推論を新設可能とするスコープ根拠とする。

### 1.2 対象外

- 複数の再帰 CTE、相互再帰、自己参照2回以上、非線形再帰、ネストした `WITH RECURSIVE`。
- `UNION` による再帰、3分岐以上の UNION chain。
- 再帰項内の集計、`GROUP BY`、`HAVING`、`DISTINCT`、window、OUTER JOIN、サブクエリ、2個目以降の JOIN、`KORDER BY` / `ORDER BY` / `LIMIT` / `OFFSET`。
- 複数列による `CYCLE`、`USING <path列>`、path 列の公開、`SEARCH`、探索順指定、最短経路。
- 戦略 C（深さごとの targeted `IN` 取得）、不完全な母集合を使う反復。
- 再帰 CTE を DML の source にすること。Phase1 の外側文は `SELECT` または `UNION [ALL]` に限る。
- JOIN provenance、一意性 metadata、partition 内候補キーを新設して B160 の警告を機構的に抑止すること。
- 再帰 CTE の出力を「生成列」とみなして全順序警告を無条件に免除すること。

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

`WITH RECURSIVE` 内で自己参照を含む定義を再帰 CTE、それ以外を非再帰 sibling と判定する。再帰 CTE は1個までとする。0個なら従来の非再帰 `WITH` と同じ結果を返す。

名前の可視性は定義順とする。

- 再帰 CTE は自分自身と先行 sibling を参照できる。
- 後続 sibling は再帰 CTE を参照できる。
- 後方参照と相互参照は planning error とする。

Phase1 の `CYCLE` 列は単一列とする。`TO` と `DEFAULT` は文字列リテラルに限定し、NULL、同値、非文字列を認めない。

mark 列は CTE の宣言列、seed、再帰項の射影には含めない。`CYCLE` が生成し、再帰 CTE 出力の末尾へ追加する。既存出力列との同名は planning error とする。

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

1. seed を1回評価し、その結果を深さ0の frontier かつ累積結果とする。
2. 再帰項の自己参照には、累積結果全体ではなく直前の frontier だけを代入する。
3. 再帰項が生成した非循環行を、次の frontier と累積結果へ加える。
4. 次の frontier が空になるまで反復する。
5. 外側 SELECT は再帰 CTE を完全実体化した後に評価する。

`UNION ALL` なので重複排除は行わない。同じノードへ異なる path で到達した場合は別の出現であり、各出現を再展開する。

出力順は保証しない。実装が breadth-first で反復しても、それを公開順序の契約にしない。利用者が順序を必要とする場合は外側 `ORDER BY` を指定する。

### 3.2 `CYCLE` は path スコープ

循環判定は、各出力行が持つ現在の path 上の既出値集合に対して行う。

- seed 行の path は、その行の `CYCLE` 列値から始まる。
- 子候補の `CYCLE` 値が親行の path に既出なら循環とする。
- 比較には、[文字列の扱い](ksql_string_semantics.md) と B14 の列型メタを使う既存の型付き等値を使用する。
- 型メタを失った文字列比較へフォールバックしない。

これは global visited 集合ではない。例えば `A→B→D` と `A→C→D` の `D` は、それぞれの path にそれ以前の `D` がなければ、両方とも非循環の2行として残り、それぞれ再展開される。global visited により後者を落とす実装は禁止する。

循環候補は `mark = TO` として1回だけ累積結果に含めるが、次の frontier には入れない。非循環行は seed を含めて `mark = DEFAULT` とし、更新済み path を内部保持する。

path は行ごとの内部状態であり、Phase1 では列として公開しない。`CYCLE` のないクエリでは path による抑止を行わず、§5 の絶対上限だけが安全性を保証する。

### 3.3 `CYCLE` と爆発の関係

`CYCLE` は組み合わせ爆発を止める境界ではない。

`CYCLE` が防ぐのは、現在 path 上の同じ値へ戻る循環データによる無限反復だけである。循環のない DAG、特に同一部品を多数の親から再利用する BOM は、合流後も path ごとに再展開されるため、結果行数が指数的に増え得る。

したがって、「`CYCLE` または境界のどちらかを要求する」という契約にはしない。

**`CYCLE` の有無にかかわらず、最大再帰深さ、最大総結果行、最大累積中間展開を常時有効な正整数として強制する。`CYCLE` は任意の早期打ち切りであり、安全境界の代替ではない。**

### 3.4 seed と再帰項の列・planning 時型証明

- CTE 列名リストを指定した場合、列数は seed の列数と完全一致し、出力名は列名リストを正とする。
- 列名リストを省略した場合は seed の出力名を使う。重複名または参照不能な無名式があれば planning error とする。
- seed と再帰項の列数は一致しなければならない。
- 各位置の型は、B14 の `MaterializedColumnMeta` 相当を seed と再帰項の双方から静的に解決する。
- 同じ型付き比較／算術カテゴリとして互換であることを planning 時に証明できなければ error とする。
- NULL リテラルだけは反対側の確定型を継承できる。
- 数値演算列は数値、文字列列は文字列として、確定したメタを全反復と外側クエリへ伝播する。
- 未知型を黙って string にすることは禁止する。

v3.65.0 の既存 `inferSelectColumnMeta()` は `outputColumns` と実行後の `SelectResult` を前提とし、通常 UNION のメタ merge も左右の実行後に行われる。EXPLAIN の既存静的 relation 処理は列名を推論するが、一般 SELECT の型 map は作らない。この既存経路だけでは、上記の planning 時証明を満たさない。

したがって、実装では seed／再帰項の射影を対象とする**静的型推論器を新設する**。

静的型推論器は少なくとも次を扱う。

- 物理 source、先行非再帰 CTE、自己参照 frontier の解決済み列。
- フィールド参照、リテラル、NULL リテラル。
- Phase1 で許可する既存スカラー式。
- 数値算術。
- 列別名と CTE 列名リストによる位置対応。
- B14 と同じ `fieldType` / `sortKind` / `semantics` の互換判定。
- 型不明、曖昧参照、未対応式の fail-closed planning error。

この推論器は実行後の `inferSelectColumnMeta()` を置き換えるものではない。再帰開始前の型整合証明と frontier schema の確定に使用し、実行後の既存メタ伝播と結果 schema の非回帰も維持する。

B143 の EXPLAIN warnings と静的推論基盤を共有できる可能性はあるが、B53 の依存条件にはしない。

### 3.5 `$id` / `RECORD_NUMBER`

再帰結果は物理アプリではなく実体化 CTE であり、固有の kintone record identity を持たない。したがって `$id` または `RECORD_NUMBER` を自動生成、再採番、特別解決しない。

seed／再帰項が物理アプリの `$id` / `RECORD_NUMBER` を明示的に射影した場合は、その値と record-number 型メタを持つ通常の実体化列として運ぶ。

複数 source の同名を区別する必要がある場合は、CTE 列名リストまたは `AS` で別名を付ける。これらを `CYCLE` 列や JOIN キーに使うことは、単一出力列として型が整合する限り許可する。

`$id` が元レコードを一意に識別することから、再帰結果の別列による `ORDER BY` が全順序であるとは推論しない。B140 R2 §7.3 の関数従属の切り分けを維持する。

## 4. 実行・エンジン（戦略 B）

Phase1 は戦略 B に固定する。

### 4.1 実行手順

1. planning 時に、seed、再帰項、許可された sibling が参照する物理アプリ／LAPP を解決する。
2. 全参照で必要なフィールドの和集合を作る。
3. 同じ resolved app、profile、cache context は、クエリ内で一つの物理 source として扱う。
4. 各物理 source を反復開始前に1回だけ完全実体化する。
5. 静的型推論器により seed／再帰項の列数、位置対応、型整合、frontier schema を確定する。
6. seed を評価し、frontier と累積結果を作る。
7. frontier を自己参照 CTE 名に注入して、再帰項をメモリ内で逐次反復する。
8. path、mark、三つの境界カウンタを各候補の規定計測点で更新する。
9. 反復終了後にだけ完成した再帰結果を通常の `MaterializedTable` として CTE cache へ登録する。
10. 後続 sibling と外側 SELECT を既存 CTE／FULL_SCAN／集計経路で評価する。

### 4.2 B155 共有 leaf policy と完全実体化

B155 の `supportedLeafPolicy` は、JOIN planner と fallback WHERE 抽出器が共有する leaf の可否判定として再利用する。ただし、leaf が既存 pushdown 文法で表現可能であることと、再帰 source の完全性を保ったまま押し下げ可能であることは別条件である。

再帰 source への行フィルタ押し下げは、次をすべて planning 時に証明できる場合だけ許可する。

- 同じ物理 source への seed／再帰項を含む全参照に共通する。
- どの参照に必要な行も除外しない。
- 自己参照 frontier の値に依存しない。
- JOIN キー由来の反復ごとの targeted `IN` 取得へ変換されない。
- 部分母集合を完全な CTE cache と誤認させない。

seed 固有または再帰項固有のフィルタは、完全実体化した source に対してメモリ内で評価する。再帰クエリでは行フィルタの pushdown は原則不可とし、通常の安全な最適化は全参照の必要フィールドを集約した列射影の最小化に限定する。

次の既存経路には、再帰 source を部分取得させない明示的な接続制約を設ける。

- 単一 CTE インライン化。
- runtime JOIN pushdown。
- fallback WHERE pushdown。
- JOIN キー由来の targeted `IN` 取得。
- CTE 参照付き FULL_SCAN。
- main／join fetch helper。
- kintone query への WHERE 合成。
- 取得フィールドの列射影。

再帰 CTE は `canInlineSingleCte()` の対象外とする。B155 の共有 leaf policy を複製せず利用する一方、再帰 source の完全性判定はその上位の専用 planning 規則として実装する。

### 4.3 source 取得

- 各物理 source の取得には既存 `fetchAll` / Cursor 切替 / request gate / `fetchParallel` を使う。
- `onLimit=truncate` は無効化し、各 source が `maxRecords` を超えた時点で error とする。
- 部分母集合を CTE cache へ登録して反復してはならない。
- 複数の物理アプリを参照する場合、`maxRecords` は合計ではなく各アプリ個別に検査する。
- 一つでも超過したら、再帰反復を開始せず全体を失敗させる。
- 同じアプリを各反復で再取得する戦略 A を禁止する。

distinct な参照アプリを `a`、取得行数を `R_a`、ページサイズを `P` とすると、API 回数は深さに依存せず、おおむね次になる。

```text
アプリ a ごと: ceil(R_a / P)
全体: Σ_a ceil(R_a / P)
```

### 4.4 `UNION ALL` 位置対応の統一

v3.65.0 では、通常 UNION と CTE cache 付き UNION に、列数検査、右辺から左辺列名への位置対応、`UNION ALL` 多重度、列メタ merge の処理が二系統存在する。

再帰実装で第三の位置対応処理を新設してはならない。

実装時に、両既存経路の位置対応と列メタ merge を同じ共有 helper へ抽出し、次の三経路を接続する。

1. 通常 UNION。
2. CTE cache 付き UNION。
3. 再帰 CTE の seed／再帰項。

共有 helper は次を一元化する。

- 列数一致検査。
- 左辺列名を正とする位置対応。
- `UNION ALL` の重複非排除。
- 静的に確定した型メタの互換検査。
- 実行後メタの merge。
- CTE 列名リストによる最終出力名の上書き。

再帰実行では、一般の `UnionStatement.left/right` を反復ごとに再解釈せず、AST が保持する seed／再帰項と planning 済み位置対応を使用する。

### 4.5 現行 CTE 実行入口との接続

v3.65.0 の `executeWith()` は定義順に、SHOW APPS、DESCRIBE、GENERATE_SERIES、SELECT／UNION を実体化する。GENERATE_SERIES には型メタと `uniqueGeneratedColumn` が付与される。

再帰 CTE は同じ文 CTE の discriminated union に新しい分岐として追加する。完成した再帰結果は既存の `MaterializedTable`、effective alias、列メタ、warnings 伝播へ接続する。

再帰実行中の一時 frontier は通常の完成済み CTE cache と区別し、後続 sibling または外側 query から途中結果を参照できないようにする。

### 4.6 空キー結合と再帰反復（R4 追補・[依頼元 §5-2](../../../ksql-analytics/docs/internal/kSQLエンジンへの依頼-20260809-再帰CTE.md) 起点）

kSQL の JOIN では、正確な空文字列 `''` どうしは一致する。これは B153 で欠落を修正した公開意味論であり、物理表、非再帰 CTE、一時テーブル、再帰 CTE で共通とする。空白を trim して空とみなしてはならない。

再帰項の単一等値 JOIN で、現在の frontier 側キーと完全実体化済み source 側キーの双方に空値が存在すると、空キー行どうしが通常の JOIN 多重度で一致する。特に「親コード空＝ルート」の階層では、空キーを持つ frontier 行からルート群を再び展開し、次のいずれかを生じ得る。

- 展開が増大して三つの絶対上限のいずれかに達する。
- 上限に達しない小規模データで、重複した経路や集計値を正常結果として返す。

三つの絶対上限および `CYCLE` は、この意味論上の危険を診断する代替ではない。

#### seed 側と再帰項側

seed が出力した空キーは、深さ0の frontier に最初から存在するため、source 側にも空キーがあれば第1反復から対象となる。利用者が空キーを再帰対象に含める意図を持たない場合は、seed の `WHERE` で明示的に除外できる。

再帰項が生成した空キーは、次の frontier に入った反復で同じ危険を生じる。seed だけを検査または除外しても、空キー葉など、後続反復で初めて空キーが現れる形は防げない。

エンジンは seed または再帰項を暗黙に書き換えず、空キー行を自動除外しない。

#### `CYCLE` 列が空値の場合

`CYCLE` の path 判定でも、既存の型付き等値により空値どうしは一致する。seed の `CYCLE` 値が空であれば path は空値から始まり、後続候補の `CYCLE` 値が空になった時点で循環行として mark し、その先を展開しない。

ただし、次の場合には `CYCLE` は空キー JOIN の再展開を防がない。

- `CYCLE` 列と再帰 JOIN キーが異なる。
- 空キー JOIN で生成された各候補の `CYCLE` 値が現在 path に未出である。
- `CYCLE` 句を指定していない。

したがって、空の `CYCLE` 値による偶発的な打ち切りを空キー JOIN の安全策として扱ってはならない。

#### 案 a〜d の評価

| 案 | 帰結 | B153との整合 | 受入テスト形 |
|---|---|---|---|
| a. 再帰項だけ空キー不一致 | 空を終端として自然停止できる一方、同じ等値 JOIN が再帰項だけ異なる意味になる。空を正当なキーとして使うデータを警告なく欠落させる | B153 の正しさ修正を再帰スコープだけ反転するため、説明費用と非回帰リスクが大きい | 空キールートと空キー葉が再展開されないこと、正当な空キー対照が一致せず欠落すること、非再帰 JOIN では従来どおり一致することを固定する |
| b. 現行意味論＋警告 | 行と多重度を変更せず、上限未満の誤集計を少なくとも silent ではなくする。警告を無視すれば誤結果を利用できること、および後続の上限エラー時には警告結果を返せないことは残る | 空=空一致を全 JOIN で維持し、B153 と最も整合する | 空キールートと空キー葉で警告が1件だけ出ること、正当な空キー対照では一致行を保持したまま警告すること、片側だけ空の場合は警告しないことを固定する |
| c. 空キー検出で fail-closed | 誤結果は返さないが、「親コード空＝ルート」を含む通常の階層や、空を正当なキーとするデータまで一律に停止し得る。source 側だけの検出では、実際に空 frontier が到達しないクエリも拒否する | 等値自体は変えないが、B153 が回復した一致を再帰では利用不能にする | 空キールート、空キー葉、正当な空キー対照をすべて部分結果0の専用エラーとし、片側検出だけで拒否する境界も固定する |
| d. 現状維持＋上限エラーへのヒント | 大規模な展開の診断は改善するが、上限未満の誤集計は警告なしで残る | B153 とは整合するが、再帰固有の silent wrong result を扱わない | 大規模形では既存上限エラーに空キーヒントが入ること、小規模な空キールート／空キー葉では警告なく現行結果を返すこと、正当な空キー対照が従来どおり一致することを固定する |

**推奨は案 b とする。** 案 a は同じ JOIN 演算子の意味を再帰項だけ変更し、別の silent data loss を導入する。案 c は正しさを守るが、空親を持つ通常の階層に対する拒否範囲が広すぎる。案 d は本追補の起点である上限未満の silent wrong result を可視化できない。案 b は危険を完全には禁止しないものの、B153 の公開意味論と既存データの結果を維持しながら、実際に危険な組合せへ到達したことを通知できる。

#### 案 b の警告契約

EXPLAIN は record API を呼ばないため、データ中の空値の存在を断定しない。再帰 JOIN ごとに次の趣旨を表示する。

```text
empty-key recursive join: runtime checked (empty keys compare equal; warning on two-sided exposure)
```

source の完全実体化後には source 側キーの空値有無を検査できるが、後続反復で生成される frontier は planning 時および反復開始前には確定しない。このため、実際の危険を偽陽性なく実行前に一律警告することはできない。

実行時は各反復の JOIN 評価前に、現在の frontier 側キーと実体化済み source 側キーを検査する。双方に空値が存在した最初の反復で、CTE 名、JOIN の両キー、最初の検出反復、および「空キーどうしは一致し、ルート群を再展開し得る」旨を `SelectResult.warnings` に1件だけ追加する。以後の反復では同じ警告を重複追加しない。

警告は JOIN 行、多重度、path、mark、frontier または集計値を変更しない。三つの絶対上限も従来どおり強制し、警告を上限エラーへ置き換えない。利用者が空キー一致を意図しない場合は、seed または再帰項の `WHERE` で明示的に除外する。

**決定欄: 案 b 採用（2026-08-09 オーナー判断）。**

## 5. 境界・fail-closed

### 5.1 常時強制する三境界

| 境界 | 数え方 | Phase1 既定 |
|---|---|---:|
| `recursiveCteMaxDepth` | seed=深さ0。再帰項の適用で生成される行の最大深さ | 100 |
| `recursiveCteMaxRows` | seed、非循環行、mark 付き循環行、`UNION ALL` 重複を含む再帰 CTE 累積結果行 | 10,000 |
| `recursiveCteMaxExpansions` | 全反復を通じ、等値 JOIN 成立後・再帰項 WHERE／CYCLE 除外前に生成した候補ペアの累積数 | 100,000 |

三値はすべて positive safe integer に限る。0、負数、無制限を表す値、非整数、safe integer を超える値は実行開始前に拒否する。

上限を超える候補を1件でも検出した時点で専用エラーを投げ、再帰 CTE の部分結果を返さない。外側 `LIMIT`、`CYCLE`、`onLimit=truncate` はこの契約を緩和しない。

「ちょうど上限」は成功できる。深さ上限については、上限を超える深さの候補が実際に生成された場合だけ error とする。frontier が上限深さで自然終了するクエリは成功する。

三境界の超過は、概念上次の専用エラークラスで表現する。名称は実装時に同等のものへ変更できるが、構造化プロパティの契約は維持する。

```ts
class RecursiveCteLimitError extends Error {
  readonly kind: "DEPTH" | "ROWS" | "EXPANSIONS";
  readonly limit: number;
  readonly detected: number;
  readonly cteName: string;
}
```

要件は次のとおり。

- `kind`、実効上限、検出値、CTE 名を readonly プロパティで持つ。
- `name` またはクラス identity により、通常の `Error` と区別できる。
- メッセージは日本語とし、実効上限、検出値、CTE 名を含める。
- R2 の `RECURSIVE_CTE_MAX_DEPTH_EXCEEDED`、`RECURSIVE_CTE_MAX_ROWS_EXCEEDED`、`RECURSIVE_CTE_MAX_EXPANSIONS_EXCEEDED` をメッセージ文頭へ露出しない。
- 必要な内部識別はクラスと `kind` で行う。
- `src/engine-library/errors.ts` の `KsqlEngineError` 公開 code union へ新しい code を追加しない。
- `normalizeEngineError()` は当面このエラーを `EXECUTION_ERROR` へ写像する。
- 将来 Pro 等で機械判定の実需が確認された場合に限り、公開 code への昇格を別件で検討する。
- source 取得超過は既存 `FetchAllLimitError` のままとする。

メッセージ例:

```text
再帰 CTE「部品展開」の結果行数が上限 10000 行を超えました（検出値: 10001 行）。
```

B158／B159 の `ArgumentError:` を本文に埋め込む通常 `Error` の流儀には合わせない。B53 は実行中の三種類の境界超過を構造化して扱う必要があるため、専用クラスを使用する。

### 5.2 設定経路

エンジンの `ExecuteOptions` / `BatchExecuteOptions` に三値を追加し、全実行面が同じ値を渡す。

| 面 | 設定名 |
|---|---|
| env | `KSQL_RECURSIVE_CTE_MAX_DEPTH` / `KSQL_RECURSIVE_CTE_MAX_ROWS` / `KSQL_RECURSIVE_CTE_MAX_EXPANSIONS` |
| profile | `profiles.<name>.query.recursiveCteMaxDepth` / `recursiveCteMaxRows` / `recursiveCteMaxExpansions` |
| CLI | `--recursive-cte-max-depth` / `--recursive-cte-max-rows` / `--recursive-cte-max-expansions` |
| MCP | `ksql_query` と `ksql_explain` の同名 camelCase input |
| plugin | 実行オプション UI の「再帰深さ」「再帰結果行」「再帰中間展開」。localStorage 保存値も同名 camelCase |

B158／B159 の 10,000 行ガードは固定定数であり、設定配管の前例にはしない。五面を通る可変設定の実装前例は `maxRecords` とする。

三値は `maxRecords` と同様、次の接続点を全数対象とする。

#### env／profile

- CLI の env 解決。
- Node／MCP runtime の env 解決。
- Node profile 型。
- CLI profile 型。
- CLI の profile 読み出しと優先順位解決。
- MCP runtime の profile 読み出しと優先順位解決。

#### CLI

- help。
- args 状態。
- option parse。
- positive safe integer 検証。
- 実効値解決。
- 単文 execute。
- 単文 dry-run。
- batch dry-run plan。
- batch execute。

#### MCP

- 共通 input schema。
- `ksql_explain` input。
- `ksql_query` input。
- Node runtime の実効値解決。
- explain single。
- explain batch。
- query single。
- query batch。

`ksql_validate` は SQL の静的制約を検査するが、実行時境界値を入力には持たない。

#### plugin

- UI 初期値。
- 保存値復元。
- UI 変更時の状態更新。
- localStorage schema。
- load／save。
- 入力 UI。
- DOM 値解決。
- 単文 execute。
- batch execute。
- 単文 EXPLAIN。
- batch plan。

実行オプションは `src/ui/config.ts` のプラグイン設定画面ではなく、desktop UI 側へ追加する。

#### engine library

- 単文 execute。
- 単文 EXPLAIN。
- batch execute。
- `buildBatchExplainPlans()`。

Node 系の優先順位は次とする。

```text
明示 input / CLI > env > profile > engine default
```

plugin は次とする。

```text
UI / 保存値 > engine default
```

設定を省略しても engine default が必ず入り、境界なしにはならない。

参照アプリの完全性境界は既存 `maxRecords` を使う。CLI／MCP の既定500、engine API の既定10,000、plugin の実効値という面ごとの差は維持するが、再帰 query では常に `onLimit=error` とする。

再帰 CTE の累積結果には `tempTableMaxRows` ではなく専用の `recursiveCteMaxRows` を適用し、両者を暗黙連動させない。

### 5.3 適用規模の目安

| レイヤー | 効く境界 | 既定 | 実用レンジの目安 |
|---|---|---:|---|
| 取得 source 行数 | `maxRecords`／kintone 全件取得打ち切り | engine 10,000・CLI/MCP 500 | ～1万リンクは無調整、数万は引き上げ、10万接近は Phase1 外 |
| 深さ | `recursiveCteMaxDepth` | 100 | 一般的な BOM 3～15段、組織図～20段では実質非拘束 |
| 展開の生行数 | `recursiveCteMaxRows` | 10,000 | 最初に効きやすい。ロールアップ前の path 出現行を数える |
| 中間展開数 | `recursiveCteMaxExpansions` | 100,000 | 生行数の2～5倍が目安 |

三境界が数えるのはロールアップ前の生の path 出現行であり、外側 `GROUP BY` 後の最終出力行数ではない。同一部品の多所再利用は path ごとに出現するため、最終結果が小さくても中間行数は膨らみ得る。

既定値と実用レンジは実装時 benchmark で再確認する。代表データでは、反復時間だけでなく、行ごとに保持する path 集合のメモリ使用量も測定する。

## 6. 終了保証

終了は次のいずれかで起こる。

1. frontier が空になる自然 fixpoint。
2. `CYCLE` が path ごとの循環候補を mark 行として出力し、その path を frontier から除外する。
3. 深さ、総行、中間展開のいずれか、または source の `maxRecords` を超えて fail-closed error になる。

自然終了または `CYCLE` だけに依存する無制限実行は存在しない。timeout／batch deadline は追加の中断手段であり、三境界の代替ではない。

## 7. パーサ・予約語・AST

### 7.1 パーサと静的拒否

`WITH` の直後だけ `RECURSIVE` を認識する。recursive CTE 定義の右括弧直後だけ `CYCLE ... SET ... TO ... DEFAULT ...` を認識する。

planning で次を検証する。

- 自己参照は seed に0回、再帰項にちょうど1回。
- 最上位形は `seed SELECT UNION ALL recursive SELECT` の2分岐。
- 再帰項は §1.1 の JOIN、WHERE、射影だけで構成される。
- 列数、列名、型、`CYCLE` 列、mark 列が §2・§3.4 を満たす。
- `CYCLE` 列は、CTE 列名リストを指定した場合は宣言列、省略した場合は seed の射影名のいずれか1列へ一意に解決できる。
- `CYCLE` 列から物理 source の任意フィールドを直接参照できない。
- recursive CTE は1個。
- 依存グラフは定義順の有向非巡回で、自己辺だけを例外とする。
- 後方参照と相互参照を拒否する。

違反時は、通常 CTE や物理アプリ参照へフォールバックせず、ParseError または planning error で fail-closed とする。

### 7.2 現行 parser からの変更点と AST

v3.65.0 の現行 parser は次の状態にある。

- CTE 名の直後に `AS` を要求し、CTE 列名リストを受理しない。
- AST に `columnAliases` がない。
- CTE 名は定義本体と右括弧を読み終えた後に登録される。
- 再帰項内の自己名は、現状では CTE ではなく物理テーブル名として解釈される。
- `WithStatement.recursive` と `CteDefinition.recursiveSpec` は存在しない。
- CTE query union には SELECT／UNION／SHOW APPS／DESCRIBE に加え、GENERATE_SERIES が追加済みである。

したがって、単なるソフトキーワード追加では実装できない。次を parser／AST の明示的な変更対象とする。

1. CTE 名の直後で任意の列名リストを解析する。
2. 再帰 CTE 候補名を、定義本体の解析前に自己参照専用の仮登録状態へ置く。
3. 仮登録した名前は当該定義の再帰項からだけ CTE として解決できるようにする。
4. seed からの自己参照、他 CTE からの前倒し参照、相互参照へ仮登録を流用しない。
5. parse または planning が失敗した場合に仮登録を確実に破棄する。
6. seed、再帰項、`CYCLE` を AST に保持し、実行時に一般 UNION を再解釈しない。
7. GENERATE_SERIES を含む現行 query union を欠落させない。

概念 AST は次とする。名称は同等の discriminated union へ変更できる。

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
  query:
    | SelectStatement
    | UnionStatement
    | ShowAppsStatement
    | DescribeStatement
    | GenerateSeriesStatement;
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

通常 CTE の AST と結果は不変に保つ。`recursive=false`、`recursiveSpec=null`、`columnAliases=null` の既存形は従来どおり扱う。

### 7.3 ソフトキーワード

`RECURSIVE`、`CYCLE`、`TO`、`DEFAULT` は文脈依存のソフトキーワードにする。直近の `CROSS` のハード予約語方式には合わせない。

理由は次のとおり。

- 四語は v3.65.0 の `TokenKind` / keyword map に存在せず、現在は `IDENT` としてフィールド名、CTE 名、alias に使用できる。
- ハード予約語化すると、既存フィールド名 `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` を破壊する。
- 現行文法で `TO` / `DEFAULT` を句区切りとして使う文脈は0件であり、CYCLE 節内の限定位置で安全に認識できる。
- 現行 parser には CREATE、DROP、DECLARE、VALIDATE、IMPORT、GENERATE_SERIES、CHECK、VALIDATE ONLY 等の文脈限定判定の前例がある。

`SET` は既存のハードトークンを維持し、batch 変数の `SET @x` と `UPDATE ... SET` の字句・構文を変更しない。通常の識別子位置で `SET` を使う場合にバッククォートが必要な既存契約も変えない。

`CYCLE` 節は次の文脈限定手順で解析する。

1. recursive CTE 定義の右括弧を読み終えた位置でだけ、次の非引用 lexeme `CYCLE` を節開始として判定する。
2. `CYCLE` に続く `cycle_column` を識別子として1個消費した直後にだけ、既存 `SET` ハードトークンを要求する。
3. mark 列を消費した直後に非引用 lexeme `TO` を要求する。
4. `TO` に続く文字列リテラルの直後に非引用 lexeme `DEFAULT` を要求する。
5. `DEFAULT` に続く文字列リテラルを消費して節を閉じる。
6. この順序に一致しない不完全な CYCLE 節は、通常 CTE、SELECT、batch `SET`、UPDATE `SET` へフォールバックせず ParseError とする。

期待位置以外の `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` は従来どおり識別子として扱う。構文位置と衝突する同名列はバッククォートで退避できることを保証する。

専用 parser テストでは次を固定する。

- 正常な CYCLE 節。
- キーワードと同名のバッククォート列。
- 通常 SELECT の `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` 識別子。
- CTE 名、alias、列名で四語を使う既存形。
- batch `SET @x`。
- UPDATE `SET`。
- 語順欠落、重複、`cycle_column` 直後に `SET` がない形。
- 引用された `` `SET` `` を区切りに使う形。
- 不完全な CYCLE 節が既存構文へ誤フォールバックしないこと。

## 8. 面（CLI / MCP / plugin / engine library）

- engine が意味論、反復、カウンタ、専用エラーを一元実装し、面ごとに結果を分岐させない。
- CLI は read-only query と EXPLAIN で対応する。
- 再帰 CTE を含む CLI query では `--on-limit truncate` を指定しても完全入力必須として error 動作へ固定し、その旨を診断へ出す。
- MCP は `ksql_query` / `ksql_explain` / `ksql_validate` で構文を認識する。
- `ksql_mutate` は Phase1 の再帰 CTE source を拒否する。
- MCP の `ksql_validate` は静的構文検査面であり、DML の `VALIDATE ONLY` 実行経路とは別である。
- plugin は Cursor capability の有無にかかわらず戦略 B を使う。
- source が `maxRecords` 内に完全取得できなければ error とし、ブラウザ独自の短縮結果を返さない。
- engine library の単文／batch も CLI／MCP／plugin と同じ実効境界と error 正規化を使用する。
- バッチ内の再帰 CTE は文スコープであり、次の文へ残らない。
- **既存** temp table へ再帰結果を書き込む構文（`INSERT INTO #t ...` の source 等）は対象外とする。
  **`CREATE TEMP TABLE #t AS WITH RECURSIVE ...` は対象（可）**＝B149 で確立した
  「`CREATE TEMP TABLE ... AS WITH ...`」の temp 実体化契約にそのまま乗る
  （完成した再帰結果の実体化であり反復途中の書き出しではない。実機確認 2026-08-09・
  回帰テストは b53RecursiveCteStage2 の temp materialization 節）。
- plugin bundle は parser、engine、EXPLAIN 文言を含むため、実装時には `prod/js/desktop.js` を正規 build で再生成する。

## 9. EXPLAIN と受入条件

### 9.1 EXPLAIN

EXPLAIN は record API を呼ばず、実件数を断定しない。少なくとも次を表示する。

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

複数 source は個別行を出す。取得回数は `ceil(R/P)` の記号見積りと、実効 `maxRecords` から導ける最大ページ数を併記してよい。

実行前に `R` を取得する追加 API は発行しない。`CYCLE` がない場合も次を明示する。

```text
cycle: none (absolute limits still enforced)
```

再帰専用表示は既存 `buildWithPlan()` 系へ接続し、通常 SELECT CTE、GENERATE_SERIES CTE、外側 query、インライン化された実効 plan の表示を壊さない。

空キー（§4.6・案 b 採用時）については次を満たす。

- 全八経路で `empty-key recursive join: runtime checked` の趣旨を表示し、空キーが実在すると断定しない。
- EXPLAIN／dry-run は空キー検査のための record API を発行しない。
- `CYCLE` の有無にかかわらず、空キー JOIN の runtime check を表示する。

### 9.2 正例

- BOM 多段展開。frontier が空になるまで展開し、深さ列を `+1`、累計員数を `親累計 * 子員数` で持ち回る。
- 外側 `GROUP BY 子品目` + `SUM(累計員数)` が既存集計経路で正しい所要量を返す。
- 組織図が可変深さで自然終了する。
- `A→B→C→A` で最後の A 行だけが `is_cycle='Y'`、それ以前が `N` になり、mark 行の先を展開しない。
- `A→B→D` と `A→C→D` の D を2行とも非循環として残す。
- seed ごとに path 状態を共有しない。
- 先行非再帰 CTE を seed／再帰項から参照できる。
- 後続非再帰 CTE が再帰結果を集約できる。
- 明示射影した `$id` / `RECORD_NUMBER` の値と型メタが反復と外側比較まで保持され、自動生成されない。
- CTE 列名リストあり／なしの双方で列名と位置対応が正しい。
- Phase1 の全許可射影について planning 時型推論が成功する。
- 空キーを正当な JOIN キーとして使う対照データでは、B153 と同じ空=空一致、多重度および集計結果を維持し、警告を1件返す（§4.6 案 b 採用時）。
- JOIN キーの片側だけが空の場合は一致せず、空キー再帰警告も返さない。
- seed の `WHERE` で空キーを除外した場合は、空 frontier が後続反復でも生成されない限り警告を返さない。

### 9.3 境界・負例

- 循環のない多段 diamond／BOM でも、総行または中間展開上限で専用エラーとなり、部分結果を返さない。
- 深さ101の候補、結果10,001行目、中間展開100,001件目を独立に検出する。
- 各専用エラーの `kind`、`limit`、`detected`、`cteName` を検証する。
- 日本語メッセージに実効上限、検出値、CTE 名が含まれる。
- `normalizeEngineError()` の公開 code が `EXECUTION_ERROR` である。
- メッセージ文頭に R2 の固定識別子を露出しない。
- 上限ちょうどと上限深さでの自然終了を成功として固定する。
- `CYCLE` の有無にかかわらず三境界が常時監視される。
- 参照アプリごとの `maxRecords` 超過は既存 `FetchAllLimitError` となる。
- 複数アプリの一方が超過した場合も、反復0回、部分結果0とする。
- `onLimit=truncate` または外側 `LIMIT` で境界を回避できない。
- `UNION`、列数／型不一致、自己参照0回／2回、seed の自己参照を静的拒否する。
- OUTER JOIN、集計、window、`DISTINCT`、subquery、nested recursive、複数／相互再帰を静的拒否する。
- 複数 CYCLE 列、`USING`、mark 列衝突を拒否する。
- `TO` / `DEFAULT` の同値、NULL、非文字列を拒否する。
- 静的型推論で型を証明できない式を実行へ進めない。
- CTE 名の仮登録が parse error 後に残存しない。
- 空キールート変種で、空 frontier と空親 source が最初に共存する反復を検出し、結果の一部として警告を1件だけ返す（§4.6 案 b 採用時。BOM の当該変種はフィクスチャ追加待ち）。
- 空キー葉変種で、seed には空キーがなくても後続反復で空 frontier が生成された時点を検出し、警告を返す。
- 空キーによる展開が三境界のいずれかを超えた場合も、既存の専用上限エラー、構造化プロパティ、部分結果0を変更しない。
- `CYCLE` 列が空の seed、後続候補、および JOIN キーとは別列である形を分け、空値の path 一致と空キー JOIN 警告が独立に判定されることを固定する。
- 空白だけのキーを trim して空値扱いせず、B153 後の逐語キー意味論を維持する。

### 9.4 EXPLAIN／dry-run の八経路

次の八経路を全数受入対象とする。

1. **SQL 文としての `EXPLAIN WITH RECURSIVE ...`**
   - parser の EXPLAIN。
   - execute dispatch。
   - WITH plan dispatch。
2. **CLI 単文 `--dry-run`**
   - SQL へ EXPLAIN を前置する経路。
3. **CLI 複文 dry-run**
   - metadata 要否判定。
   - client 選択。
   - `buildBatchExplainPlans()`。
4. **B155 静的 typed plan を使う CLI 単文**
   - 単文が batch explain builder 側へ入る経路。
5. **B161 の WITH metadata 要否判定**
   - WITH／UNION／subquery の再帰走査。
   - CTE 内物理 SELECT の検出。
6. **MCP `ksql_explain`**
   - single。
   - batch。
7. **plugin EXPLAIN ボタン**
   - 単文の EXPLAIN 前置。
   - batch plan mode。
8. **engine library**
   - 単文 EXPLAIN execute。
   - batch `buildBatchExplainPlans()`。

全経路で次を満たす。

- record API 0回。
- strategy B を表示する。
- path scope を表示する。
- 三境界と実効値を表示する。
- `CYCLE` の有無にかかわらず fail-closed を表示する。
- source ごとの `ceil(R/P)` と `maxRecords` を表示する。
- 再帰 CTE 内の物理 source が metadata 必要判定から漏れない。
- CLI／MCP／plugin／engine library で plan の意味が一致する。

### 9.5 実行面・非回帰

- 同じ fixture と実効境界で CLI／MCP／plugin／engine library の行、mark、エラー構造が一致する。
- B51 の alias なし CTE 間 JOIN、明示 alias、0行 schema、欠落 JOIN キーの fail-closed を非回帰とする。
- B52 の改名列／式 CTE の実体化、単純 CTE の既存インライン化を非回帰とする。
- B149 の GENERATE_SERIES CTE、型メタ、`uniqueGeneratedColumn`、警告抑止条件を非回帰とする。
- B155 の共有 leaf policy と既存 JOIN／fallback pushdown を、非再帰 query について変更しない。
- 通常 UNION と CTE cache 付き UNION の行、列名、多重度、列メタを共有 helper 抽出前後で不変にする。
- 既存の非再帰 `WITH`、CTE 内 `UNION [ALL]`、temp table、通常 JOIN／集約の AST、結果、EXPLAIN を不変に保つ。
- CLI／MCP／plugin／engine library で、同じ fixture に対する空キー警告の有無、内容、重複抑止が一致する（§4.6 案 b 採用時）。
- 空キー警告は完成した再帰 CTE から後続 sibling、外側 SELECT および既存 CTE／一時テーブル warning merge 経路へ失われず伝播する。
- 非再帰 JOIN、通常 CTE JOIN、一時テーブル JOIN について、B153 の空=空一致および `in ("")` の取得結果を変更しない。

### 9.6 Phase2 引き継ぎ

- 複数／相互再帰。
- 複数の再帰 member。
- `UNION` 重複排除。
- `CYCLE (col1, col2, ...)`。
- `USING path_col` と path 値の公開。
- `SEARCH DEPTH/BREADTH FIRST`。
- 安定した探索順。
- 最短経路。
- 戦略 C と、全件実体化が非現実的な大規模アプリ。
- 再帰項内の複数 JOIN、OUTER JOIN、集計、window、subquery。
- 再帰 CTE を使う DML。
- statement-local な境界上書き。

statement-local な境界上書きは、全実行面の設定だけでは不足する実需が確認された場合に検討する。無制限指定は将来も導入しない。

## 10. B160 同梱 — 全順序警告の免除条件文言

### 10.1 目的

B140 の現行助言は、元の集約キーをすべて `ORDER BY` に含める形を判断できる一方、次の二形へ十分な判断基準を与えない。

- GENERATE_SERIES の生成列を JOIN 後に並べる形。
- 再帰 CTE の出力列を並べる形。

B140、B160、B53 の三形を、機構ごとの特例ではなく、同じ一般条件で利用者が判断できる文言へ改訂する。

### 10.2 一般化する公開文言

派生 relation に対する全順序警告の末尾助言を、次の意味へ一般化する。

> この警告は、派生元の一意性を静的に証明できない場合にも表示されます。ウィンドウの各パーティション内で、`ORDER BY` に指定した値の組が入力行を一意に識別するとクエリ構造または保証済みのデータ制約から確認できる場合に限り、この警告は無視できます。例えば、元の集約キーをすべて含む場合、または JOIN 後も同じ系列値が各パーティション内で高々1行になることを保証できる場合です。生成列、再帰の深さ列、または `$id` に由来する列であるという理由だけでは無視できません。

文言の判定規則は次の一条件に集約する。

```text
各 window partition 内で、ORDER BY 値の組が入力行を一意に識別することを
利用者がクエリ構造または保証済み制約から確認できる場合に限り、警告を無視できる。
```

### 10.3 三形への適用確認

#### B140: 集約キー

- `GROUP BY k1, k2` の結果で、window `ORDER BY` が `k1, k2` をすべて含む場合は無視できる。
- `k1` だけの場合は無視できない。
- grouping equality と window comparator の equality が一致しない可能性がある型では、単に「集約キーだから」と判断せず、実際の一意性保証を確認する。
- `$id` が元行を一意に識別していても、別の出力列だけの `ORDER BY` が一意になるとは限らない。

#### B160: GENERATE_SERIES × JOIN

- GENERATE_SERIES の生成列を JOIN なしで直接読む既存形は、厳密単調な系列として現行機構が警告を抑止する。
- JOIN 後は、同じ生成値に複数行が対応し得るため、生成列であるだけでは無視できない。
- 集約により生成値ごとに1行へ戻り、その生成値を `ORDER BY` に含める形は、一般条件を満たすと判断できる。
- 非集約 JOIN でも、JOIN 条件と保証済み制約により、同じ生成値が各 partition 内で高々1行と確認できる場合だけ無視できる。
- JOIN cardinality または一意性を確認できない場合は無視できない。

#### B53: 再帰 CTE 出力

- `深さ` は同じ深さの複数行が通常存在するため、単独では一意でない。
- 同じノードへ異なる path で到達できるため、ノード列も単独では一意とは限らない。
- `UNION ALL` の重複と mark 付き循環行を含むため、「再帰が生成した列」という理由だけでは無視できない。
- `ORDER BY` 列組が各 path occurrence を partition 内で一意に識別すると利用者が確認できる場合だけ無視できる。
- Phase1 は内部 path を公開しないため、一般には再帰結果の全順序を静的にも利用者にも証明しにくい。確認できない場合は警告を維持する。

以上により、三形のいずれも「生成列か」「集約列か」「再帰列か」ではなく、partition 内で `ORDER BY` 値の組が入力行を一意に識別するかという同じ条件で判断できる。

### 10.4 案 B を採らない

警告判定点には次の情報が存在しない。

- 通常 CTE を越えた生成列 provenance。
- JOIN 出力列が GENERATE_SERIES 由来であるという provenance。
- JOIN cardinality。
- JOIN 後に同じ生成値が複数行になるか。
- partition ごとの unique key。
- GROUP BY 候補キー。
- relation-level の一意性証明。

`MaterializedColumnMeta` にも一意性または generated provenance はない。

このため、B160 案 B の機構的な抑止拡大は採用しない。B53 の実装に、JOIN provenance や partition 内一意性 metadata の新設を混在させない。

### 10.5 警告伝播

再帰結果は完成後に通常の `MaterializedTable` として CTE cache へ登録する。consumer の window 警告は既存の CTE／一時テーブル FULL_SCAN 経路を通す。

- CTE 本体の warnings を `executeWith()` が収集する。
- 外側結果へ warnings を merge する。
- 外側 window が CTE を読む場合は既存の CTE consumer 警告生成点を通る。
- 一時テーブル参照も同じ警告経路を維持する。
- 再帰 CTE 専用に警告を消す分岐を作らない。

### 10.6 文言逐語テスト

文言変更が触れる次の8 assertion site、パラメータ展開後10ケースを更新し、完全な警告文字列を固定する。

1. RANGE direct: `src/__tests__/window.execute.test.ts:272-282`
2. VALUE direct: `src/__tests__/window.execute.test.ts:442-445`
3. GENERATE_SERIES JOIN 後 LAG: `src/__tests__/b149GenerateSeries.test.ts:74,173-174`
4. GENERATE_SERIES JOIN 後 RANGE: `src/__tests__/b149GenerateSeries.test.ts:75,175-176`
5. month／year 通常 JOIN: `src/__tests__/b159GenerateSeriesMonthYear.test.ts:67,203-206`
6. month／year 一時テーブル: `src/__tests__/b159GenerateSeriesMonthYear.test.ts:67,209-220`
7. CTE VALUE の派生 relation 助言: `src/__tests__/window.execute.test.ts:480-493`
8. CTE RANGE の派生 relation 助言: `src/__tests__/window.execute.test.ts:480-502`

5と6はそれぞれ2ケースの `test.each` であり、展開後ケース数を落とさない。

追加受入では、次を固定する。

- B140 の全集約キーを含む形で、新文言から無視条件を判断できる。
- B140 の複合キーの一部だけでは無視できないと判断できる。
- B160 の JOIN 後重複キー形では無視できないと判断できる。
- B160 の集約後1系列値1行形では無視できると判断できる。
- B53 の `ORDER BY 深さ` だけでは無視できないと判断できる。
- B53 の複数 path が同じノードへ到達する形では、ノード列だけで無視できないと判断できる。
- 既存の GENERATE_SERIES 直接読み、JOIN なしの警告抑止を変更しない。
- warning 以外の値、列、行順、件数を変更しない。

## 11. 工数見積り

R3 の概算は **20～32人日** とする。R2 の18～29人日から、下限を2人日、上限を3人日増やす。

| 作業 | R3 目安 |
|---|---:|
| parser、ソフトキーワード、CTE列名リスト、自己参照仮登録、AST、静的制約 | 3～5人日 |
| seed／再帰項の静的型推論器、列名・型整合、B14メタ伝播 | 3～5人日 |
| 戦略Bの source 収集／完全実体化、pushdown 制御、frontier 反復、UNION位置対応統一 | 4～6人日 |
| path スコープ CYCLE、mark、三つの fail-closed counter、専用エラー | 3～5人日 |
| ExecuteOptions、env／profile／CLI／MCP／plugin／engine library 配管 | 2～4人日 |
| EXPLAIN、B160 文言、診断、文書同期 | 2～3人日 |
| unit／integration／CLI／MCP／browser smoke、既存 CTE／UNION／warning 非回帰 | 3～4人日 |
| **合計** | **20～32人日** |

§4.6 案 b の採用（2026-08-09 確定）により、空キー検出、警告の重複抑止、EXPLAIN 表示、全実行面への warning 伝播、および三種の fixture／受入追加として **1～2人日**を加算し、全体概算を **21～34人日**とする。source は戦略 B により既に完全実体化され、frontier も反復単位で保持されるため、新しい取得戦略または API 呼び出しは不要である。

増加要因は次のとおり。

- CTE 列名リストと定義中自己参照は現行 parser に存在しない。
- planning 時型整合に利用できる一般 SELECT の静的型推論経路がなく、新設が必要。
- 再帰 source の完全性を、インライン化、WHERE／JOIN pushdown、targeted `IN`、列射影の各経路で守る必要がある。
- 三設定値を `maxRecords` と同等の全接続点へ配管する必要がある。
- EXPLAIN／dry-run の八経路を受け入れる必要がある。
- B160 の文言変更が8 assertion site、展開後10ケースへ影響する。
- 専用エラークラスと engine library 正規化の受入が必要。

減少要因は次のとおり。

- GENERATE_SERIES により、文 CTE の別 query 種別、実体化、型メタ、EXPLAIN、static relation 処理の前例がある。
- B155 の共有 leaf policy を再利用できる。
- `MaterializedColumnMeta`、既存 UNION 位置対応、メタ merge を再利用できる。
- CTE／一時テーブルの warning 収集・伝播経路を再利用できる。
- CLI／MCP／plugin／engine library の batch EXPLAIN builder が共有されている。

実装着手時には特に次を精査する。

- 中間展開を JOIN 成立後、WHERE／CYCLE 前で数える計測点。
- 物理 source の同一性と cache key。
- 型不明時に planning error へ閉じる範囲。
- plugin UI に三設定を追加した場合の操作性。
- 深い BOM における path 集合のメモリ使用量。
- 通常 UNION と CTE cache 付き UNION の共有 helper 抽出による非回帰。
- `RecursiveCteLimitError` の全実行面での保持と `EXECUTION_ERROR` 正規化。

これらは実装詳細の精査事項であり、path scope、三境界常時 fail-closed、戦略 B、planning 時型証明を未決に戻すものではない。

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
| 12 | R3 キーワード方式 | `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` はソフトキーワードを維持。`SET` は既存ハードトークンのまま。`CROSS` のハード予約語方式には合わせない（§7.3） |
| 13 | R3 境界エラー | 三境界は専用エラークラスと readonly 構造化プロパティで識別。公開 `KsqlEngineError` code union は不変、当面 `EXECUTION_ERROR` へ写像（§5.1） |
| 14 | R3 型整合 | planning 時証明を維持し、Phase1 の狭い射影文法を対象とする静的型推論器を新設（§3.4、§4） |
| 15 | B160 同梱 | 集約キー、生成列×JOIN、再帰出力を partition 内の `ORDER BY` 一意性という単一条件文で判断。機構的抑止拡大は行わない（§10） |
| 16 | R4 空キー結合×再帰 | **案 b 採用（2026-08-09 オーナー判断）**＝B153 の空=空 JOIN 意味論を維持し、frontier／source の両側空値へ実際に到達した最初の反復で結果 warning を1件返す。EXPLAIN は値を断定せず runtime check を表示する（§4.6、§9） |

既存11行は R2 から書き換えていない。R3 の決定は12～15行、R4 追補（空キー）の論点は16行として追記した。

## 13. 文書同期・出荷チェックリスト

実装と出荷時には、次を全数同期する。

### 13.1 言語リファレンス

- [ ] `docs/ksql_language_reference.md:2485` の再帰 CTE 非対応記述を Phase1 の対応範囲へ更新する。
- [ ] `docs/ksql_language_reference.md:3559` の非対応一覧または WITH 範囲を更新する。
- [ ] `WITH RECURSIVE`、CTE 列名リスト、`CYCLE`、対象外構文を記載する。
- [ ] 三境界の既定値と常時 fail-closed を記載する。
- [ ] `CYCLE` が組み合わせ爆発の境界ではないことを記載する。
- [ ] path scope と global visited 禁止を記載する。
- [ ] engine library の公開 code は当面 `EXECUTION_ERROR` であることを、公開エラー契約に必要な範囲で記載する。
- [ ] B160 の一般化した全順序警告助言を反映する。

### 13.2 plugin spec

- [ ] `docs/internal/kintone_sql_plugin_spec.md:188-193` の WITH／再帰 CTE 対応範囲を更新する。
- [ ] desktop 実行オプション UI の三設定を記載する。
- [ ] localStorage の三つの camelCase 値を記載する。
- [ ] `onLimit=truncate` が再帰 query では無効になることを記載する。
- [ ] plugin EXPLAIN と browser smoke の受入を記載する。

### 13.3 内部評価・比較資料

- [ ] `docs/internal/ksql_b53_recursive_cte_cycle_evaluation.md:27` を実装後の対応状態へ更新する。
- [ ] `docs/internal/ksql_property_graph_evaluation.md:30` の再帰 CTE 非対応前提を更新する。
- [ ] `docs/internal/ksql_sql_feature_comparison_evaluation.md:48` の SQL 機能比較を更新する。

### 13.4 B149 仕様

- [ ] `docs/internal/ksql_b149_generate_series_spec_r1.md:1617` の「別件 B53」記述を更新する。
- [ ] `docs/internal/ksql_b149_generate_series_spec_r2.md:1981` の「別件 B53」記述を更新する。
- [ ] GENERATE_SERIES は B53 を待たず既に提供済みであることを維持する。
- [ ] JOIN なし直接生成列だけを対象とする既存警告抑止範囲を維持する。
- [ ] B160 の JOIN 後助言文言を同期する。

### 13.5 MCP instructions

- [ ] `src/mcp/index.ts:89-99` の対応 statement family を更新する。
- [ ] `src/mcp/index.ts:151-154` の `ksql_query` WITH 説明を更新する。
- [ ] read-only の `WITH RECURSIVE` と `CYCLE` の Phase1 範囲を記載する。
- [ ] DML source が対象外であることを記載する。
- [ ] `ksql_query` / `ksql_explain` の三境界 input を記載する。

### 13.6 tool schema

- [ ] `src/mcp/schemas.ts:20-22` 相当の共通 schema に三設定を追加する。
- [ ] `src/mcp/schemas.ts:56-61` の validate 説明へ静的認識範囲を反映する。
- [ ] `src/mcp/schemas.ts:63-70` の explain input／説明を更新する。
- [ ] `src/mcp/schemas.ts:72-92` の query input／説明を更新する。
- [ ] `src/mcp/schemas.ts:193-195` の saved query 説明で WITH 対応範囲を確認する。
- [ ] positive safe integer、既定値、優先順位を schema 説明と runtime で一致させる。

### 13.7 statement syntax catalog

- [ ] `src/mcp/statementSyntaxCatalog.ts:36-42` の supported family 宣言へ再帰 CTE を追加する。
- [ ] `src/mcp/statementSyntaxCatalog.ts:50-57` の WITH template に `WITH RECURSIVE` と `CYCLE` の Phase1 例を追加する。
- [ ] 通常 WITH、GENERATE_SERIES CTE、再帰 CTE の三形を区別する。
- [ ] 対象外構文を誤って生成させない制約を記載する。

### 13.8 境界既定値の docs parity

- [ ] depth=100、rows=10,000、expansions=100,000 を実装側の export 済み定数とする。
- [ ] 言語リファレンスの境界既定値表を heading と列構造で特定する。
- [ ] B136 型の docs parity テストを1本追加し、文書表と export 済み定数を配列または構造化値で比較する。
- [ ] 旧既定値または stale な設定名が文書に残っていないことも検査する。
- [ ] B141 の集計空入力値 parity 形式は、境界表の構造に合わないため流用しない。

### 13.9 出荷成果物

- [ ] parser／engine／EXPLAIN／警告文言の変更後に `prod/js/desktop.js` を正規 build で再生成する。
- [ ] plugin 配布物に再生成済み bundle が入っていることを確認する。
- [ ] CLI／MCP／engine library／plugin の version と manifest を対象リリースへ揃える。
- [ ] B160 の警告文言を固定する8 assertion site、展開後10ケースを更新する。
- [ ] ブラウザ smoke で、再帰 query、EXPLAIN、三境界、B160 文言、既存 GENERATE_SERIES 抑止を確認する。
- [ ] source 取得超過が `FetchAllLimitError` のままであることを確認する。
- [ ] 三境界超過が engine library では `EXECUTION_ERROR` になることを確認する。

## 14. R2 から R3 への変更点

| R3 の変更箇所 | 変更内容 | 事前調査との対応 |
|---|---|---|
| ステータス・前提 | v3.65.0 へ rebase し、B160 同梱と設計3決定を明記 | 結論、R2差分全体 |
| §1.1、§3.4 | Phase1 の狭い射影文法を静的型推論器のスコープ根拠として明記 | B-3、差分5 |
| §3.4 | 実行後型推論だけでは planning 時証明できない事実を明記し、seed／再帰項用静的型推論器を新設 | B-3、差分5 |
| §3.4 | B143 の静的 warnings 基盤との相乗り可能性を備考化し、依存にはしない | B-3 |
| §4.2 | B155 共有 leaf policy を再利用しつつ、再帰 source の完全性判定を上位規則として規定 | B-2 |
| §4.2 | インライン化、WHERE／JOIN pushdown、targeted `IN`、列射影の全接続点を明記 | B-2、見積り増加要因 |
| §4.4 | 通常 UNION と CTE cache 付き UNION の二系統を共有 helper へ統一し、再帰実装を第三経路として接続 | B-4、差分6 |
| §4.5 | GENERATE_SERIES 分岐と `uniqueGeneratedColumn` を含む現行 `executeWith()` へ rebase | B-1、差分7 |
| §5.1 | R2 の固定コード列挙を、専用エラークラスと `kind` / `limit` / `detected` / `cteName` の readonly プロパティへ変更 | F-1、差分10、決定2 |
| §5.1 | 固定識別子をメッセージ文頭へ出さず、公開 `KsqlEngineError` code union を変更しないと規定 | 決定2 |
| §5.1 | `normalizeEngineError()` は当面 `EXECUTION_ERROR`、source 超過は `FetchAllLimitError` のままと規定 | 決定2 |
| §5.1 | B158／B159 の `ArgumentError:` 流儀には合わせないと明記 | F-1、差分10 |
| §5.2 | 固定ガードの B158／B159 ではなく、可変値 `maxRecords` を三設定配管の前例に変更 | C-2、差分8 |
| §5.2 | env、profile、CLI、MCP、plugin、engine library の schema／runtime／UI／保存／単文／batch 接続点を全数化 | C-2、C-3、差分8 |
| §7.2 | 現行 parser が CTE 列名リストを受理しないことを明記 | A-4、差分1 |
| §7.2 | CTE 名が本体解析後に登録され、現状では自己参照を解決できないことを明記 | A-4、差分2 |
| §7.2 | 現行 AST に `recursive` / `recursiveSpec` がなく、GENERATE_SERIES が query union に追加済みである事実へ rebase | A-4、差分3 |
| §7.2 | 列名リスト解析、自己参照仮登録、失敗時破棄を parser 変更点として追加 | A-4、差分1・2 |
| §7.3 | `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` のソフトキーワード方式を維持 | A-2、A-3、差分4、決定1 |
| §7.3 | 直近の `CROSS` ハード予約語方式には合わせない理由を明記 | A-3、差分4 |
| §7.3 | 現行文法で `TO` / `DEFAULT` を句区切りに使う文脈が0件であることを根拠として追記 | A-2、決定1 |
| §9.4 | EXPLAIN／dry-run の八経路を全数受入条件として列挙 | D-1、差分9 |
| §9.4 | B161 の WITH metadata 要否判定を受入対象へ追加 | D-1、差分9 |
| §9.5 | GENERATE_SERIES、B155、二系統 UNION、既存 warning 伝播の非回帰を追加 | B-1、B-2、B-4、E-4 |
| §10 | B160 同梱節を新設 | E-1～E-4、B160 |
| §10.2 | B140／B160／B53 を partition 内の `ORDER BY` 一意性という単一条件文へ一般化 | E-3、B140 §4・§7.3、B160 §4 |
| §10.3 | JOIN により同一生成値が複数行になる形を無条件免除しないと明記 | E-3、B160 §4 案A |
| §10.3 | 再帰 CTE の深さ列やノード列では同順が通常発生し、生成列扱いできないと明記 | B160 同梱条件、B53 意味論 |
| §10.4 | provenance／partition 内一意性が警告点に存在しないため案Bを採らないと決定 | E-3 |
| §10.5 | 再帰 CTE を既存 CTE／一時テーブル warning 伝播へ接続 | E-4 |
| §10.6 | 文言変更対象の8 assertion site、展開後10ケースを列挙 | E-2 |
| §11 | 見積りを18～29人日から20～32人日へ更新 | 見積り増減要因 |
| §11 | 静的型推論、parser 構造変更、全設定配管、八 EXPLAIN 経路、B160 を増加要因へ反映 | A-4、B-3、C-2、D-1、E-2 |
| §11 | GENERATE_SERIES、B155、列メタ、UNION、warning 伝播、共有 plan builder を減少要因へ反映 | B-1～B-4、D-1、E-4 |
| §12 | 既存11行を変更せず、R3 のキーワード、エラー、型推論、B160 決定を追記 | 決定1～3、B160 |
| §13 | 文書同期・出荷チェックリストを新設 | F-2、差分11 |
| §13.1～§13.7 | 言語リファレンス2箇所、plugin spec、内部資料、B149仕様2件、MCP instructions、tool schema、statement syntax catalog を全数列挙 | F-2、差分11 |
| §13.8 | 境界既定値表に B136 型 docs parity テスト1本を追加 | F-3 |
| §13.9 | plugin bundle 再生成と全実行面の出荷確認を追加 | D-3、F-2 |
| §4.6、§9、§11、§12（R4 追補） | 空キー JOIN と再帰反復の相互作用を規定。案 a〜d を比較し、B153 の意味論を維持する案 b を推奨。seed／再帰項、空の `CYCLE` 値、runtime warning、EXPLAIN、三種の受入形を追加。最終決定はオーナー判断待ち | [R4 追補依頼](ksql_b53_codex_spec_r4_request.md) §1～§2、依頼元依頼書 §5-2、B153 |

## 15. Claude レビュー（R3・2026-08-09）

決定 3 点への閉じ込め、公開意味論 2 核心（path スコープ／3 絶対上限常時 fail-closed）の不変、§12 既存 11 行の不変、調査報告の食い違い 11 項目の反映（§14 で全数照合）を確認。**実装着手可能水準。** 付記 2 件は実装時に扱う（R3 本文の変更は不要）。

1. **§10.2 の公開文言の長さ**。B100 の教訓（小さい表示領域では先頭 1〜2 文しか見えない）に照らし、実装時の最終文言では「無視できる条件」を第 1 文に置く語順を保ったまま短縮を検討する。
2. **B140 クローズの根拠を弱めないこと**。§10.3 の「単に『集約キーだから』と判断しない」という但し書きは正しいが、B140 は「集約キー全含みなら無視してよい」という判定可能な文言でクローズし依頼元がそれに依存している。最終文言では**集約キー全含みの形を引き続き肯定例として明示**する（§10.6 受入 1 項目目「B140 の全集約キーを含む形で、新文言から無視条件を判断できる」がこれを固定している）。§4.4 の UNION 共有 helper 統一は実装規模を増やすが、規則複製の凍結残存（B155 の教訓）を防ぐ判断として妥当。

**R4 追補レビュー（同日）**: §4.6 の適用を確認。4 案とも帰結・B153 整合・受入テスト形が揃い、推奨 b の論拠（案 a は別の silent data loss を導入・案 c は「親コード空＝ルート」の通常階層まで拒否・案 d は起点の「上限未満の silent wrong result」を残す）は妥当。**`CYCLE` 列空値と JOIN キー空値を独立に判定する指摘は R3 に無かった観点**。警告の「両側空値へ実際に到達した最初の反復で 1 件だけ」という契約は、B140 の「結果の一部としての warnings」流儀と偽陽性回避を両立している。決定欄（§4.6 末尾・§12 の 16 行目）はオーナー判断待ち。