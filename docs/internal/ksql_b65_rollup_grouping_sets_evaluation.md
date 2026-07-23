# B65 — 小計・総計（`ROLLUP` / `GROUPING SETS` / `GROUPING()`）対応（評価）

- ステータス: 📝 **【A: 評価・方向判断】起票（2026-07-23）**。1 クエリ・1 結果セットで小計/総計行を出すための `GROUP BY ROLLUP` / `GROUP BY GROUPING SETS` と、集計行を判別する `GROUPING()` 関数の対応案。仕様前・実需/スコープの確認待ち。
- 種別: 機能（集計・GROUP BY 拡張）
- 優先: 中
- 関連: [B64 集計引数のスカラー値式（条件付き集計）](ksql_b64_aggregate_case_expression_issue.md) / [B56 統計集約](ksql_b56_statistical_aggregates_spec.md) / [B59 ORDER BY alias/合成名](ksql_b59_orderby_alias_fix_spec.md) / [B40 グラフ（有界 fail-closed 思想）](ksql_property_graph_evaluation.md) / 言語 §8 集計・§10 ORDER BY

## 1. 背景・課題

kSQL の `GROUP BY` は単一レベルの集計のみで、**小計（subtotal）・総計（grand total）行を同じ結果に含められない**。会社別の明細に「全体合計」を 1 行足す、地域×会社で階層小計を出す、といったレポート/ダッシュボードの定番が 1 クエリで書けない。

標準 SQL には次がある。

- `GROUP BY ROLLUP(a, b)` … `(a,b)` の明細に加え `(a)` 小計・`()` 総計を積む階層集計。
- `GROUP BY GROUPING SETS ((a,b),(a),())` … 出したいグループ化の集合を明示。
- `GROUP BY CUBE(a, b)` … 全部分集合（2^n 通り）。
- `GROUPING(col)` … その行で `col` が集約されているか（super-aggregate 行か）を `1/0` で返す。合計行のラベル付けやソートに使う。

現状の回避策は「明細クエリ＋総計クエリを `UNION ALL`」または「クライアント側で合算」。前者は総計行の grouped 列を定数リテラルで埋める・列を揃えるなど冗長で、階層が増えると破綻する。

## 2. 実測境界（現状・`ksql_validate`）

いずれも未対応で `ParseError`（`ROLLUP`/`GROUPING`/`GROUPING SETS` は通常識別子として解釈される）。

```sql
-- ❌ GROUP BY ROLLUP(会社名) → 「文の区切りには ; が必要です（トークン: 「(」）」
SELECT 会社名, SUM(売上) FROM APP4149 GROUP BY ROLLUP(会社名)

-- ❌ GROUP BY GROUPING SETS (...) → 「文の区切りには ; が必要です（トークン: 「SETS」）」
SELECT 会社名, SUM(売上) FROM APP4149 GROUP BY GROUPING SETS ((会社名), ())

-- ❌ GROUPING(会社名) → 「比較演算子（…）が必要です（トークン: 「(」）」
SELECT CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END, SUM(売上)
FROM APP4149 GROUP BY 会社名
```

現在できるのは B64 の条件付き集計までで、**明細行の中で列を横に割る**（受注済/見込を列で分ける）ことは可能。だが**行方向の小計/総計は出せない**。

```sql
-- ✅ 現状可能（B64・明細のみ・総計行は無い）
SELECT 会社名,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 1 ELSE 0 END) AS 受注件数
FROM APP4149
GROUP BY 会社名
ORDER BY 売上合計 DESC
```

## 3. 固有価値（欲しい形）

会社別の明細に **総計行を 1 行足して同じ結果に**（`GROUPING()` で合計行を判別・末尾へ）。B64 の条件付き集計とそのまま組み合わせられる。

```sql
-- ROLLUP + GROUPING（総計行つき）
SELECT
  CASE WHEN GROUPING(会社名) = 1 THEN '合計' ELSE 会社名 END AS 会社名,
  COUNT(*) AS 案件数,
  SUM(売上) AS 売上合計,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 売上 ELSE 0 END) AS 受注済売上,
  SUM(CASE WHEN 商談フェーズ IN ('提案中','内示') THEN 売上 ELSE 0 END) AS 見込売上,
  SUM(CASE WHEN 商談フェーズ = '受注' THEN 1 ELSE 0 END) AS 受注件数
FROM APP4149
GROUP BY ROLLUP(会社名)
ORDER BY GROUPING(会社名), 売上合計 DESC
```

`GROUPING SETS` なら出したい集合を明示できる（会社別だけ／総計だけ／両方）。多列にすれば地域小計＋会社明細＋総計のような階層レポートになる。

## 4. 設計案（たたき台）

### 4.1 実行モデル

kintone にサーバ側の ROLLUP は無いため、既存 `GROUP BY` と同じ **クライアント側 FULL_SCAN**。全行を 1 度取得し、**複数のグループ化セットを内部で評価して縦に結合**する。

- **`GROUPING SETS` を土台**にする。`ROLLUP(a,b)` = `GROUPING SETS((a,b),(a),())`、`CUBE(a,b)` = 全部分集合、として糖衣展開する。まず GROUPING SETS の実行を作り、ROLLUP/CUBE をその上に載せると素直。
- 各グループ化セットごとに既存の集計（B56 統計含む）・B64 条件付き集計を評価し、結果行に **どの列が集約されたか（grouping bitmask）** を付与して連結する。

### 4.2 `GROUPING(col)`

- その行のグループ化セットで `col` が**集約されている**（＝super-aggregate 行）なら `1`、グループキーとして残っていれば `0` を返すスカラー関数。
- 集計コンテキスト専用（`GROUP BY` を伴う文でのみ有効）。**SELECT 列・`ORDER BY`・`HAVING`** で使える。B64 で拡張したスカラー式評価（`CASE` 条件・`SELECT` 式）から参照できる必要がある。
- 予約語追加（`GROUPING`）。`ROLLUP`/`CUBE`/`GROUPING SETS`（複合キーワード `GROUPING SETS`）も文法トークン化。

### 4.3 super-aggregate 行の grouped 列の表現

- 標準 SQL では super-aggregate 行の grouped 列は `NULL`。kSQL は空セル＝空文字なので、**「実データの空セル」と「総計行の全体」を値だけでは区別できない**。ここが `GROUPING()` の存在意義：総計行では grouped 列を空文字にしつつ、`GROUPING(col)=1` で判別する。ラベルは `CASE WHEN GROUPING(col)=1 THEN '合計' ELSE col END` で付ける。
- 出力列の型メタは各セット共通（縦結合するため）。

### 4.4 ORDER BY / HAVING との整合

- `ORDER BY GROUPING(会社名), 売上合計 DESC` のように、**合計行を末尾へ寄せる**用途が定番。B59 で整えた ORDER BY の alias/合成名/値解決 planner に `GROUPING()` と grouping bitmask を供給する経路が要る。
- `HAVING` で `GROUPING()` や集計を参照する形も検討（Phase を分けてよい）。

### 4.5 爆発の抑制（有界 fail-closed）

- `GROUPING SETS` は明示個数、`ROLLUP(n 列)` は `n+1` セットで有界。**`CUBE(n 列)` は `2^n`** でセット数が急増するため、B40 と同思想で**セット数・出力行数の上限を設けて超過は fail-closed**。CUBE は Phase を分けるか、当面見送りも選択肢。

## 5. 論点

- **スコープ**: Phase1 を `GROUPING SETS` ＋ `ROLLUP`（単一列）＋ `GROUPING()` に絞るか、複数列 ROLLUP まで含めるか。`CUBE` は爆発リスクで別 Phase or 見送り。
- **`GROUPING()` の実装統合**: パーサ（予約語・複合キーワード）、集計エンジン（grouping bitmask の付与）、スカラー式評価（`CASE`/SELECT/ORDER BY/HAVING からの参照）の横断対応。実装規模は中〜大（集計エンジンが単一セット前提のため、複数セット評価と縦結合、フラグ付与への拡張が核）。
- **super-aggregate 行の表現**: grouped 列を空文字＋`GROUPING()=1` で区別する契約でよいか（実データの空セルとの取り違えを `GROUPING()` 前提で運用）。
- **ORDER BY GROUPING()**: B59 planner との整合、REST 押し下げ不可（FULL_SCAN 固定）で問題ないか。
- **完全入力（B56）との相互作用**: 統計集約を含む場合、各グループ化セットで完全入力必須が波及する。
- **実需**: 小計/総計付きレポートの需要規模（ダッシュボード/Excel 出力の下地）。

## 6. 段階案

- **Phase1**: `GROUP BY GROUPING SETS (...)` ＋ `GROUP BY ROLLUP(単一列)` ＋ `GROUPING(col)`（SELECT / ORDER BY）。総計行の grouped 列は空文字＋`GROUPING()=1`。B64 条件付き集計と併用可。
- **Phase2**: 複数列 `ROLLUP`、`HAVING` での `GROUPING()`、`CUBE`（有界 fail-closed）。

## 7. 次アクション

1. 実需の確認（小計/総計付きレポートをどれだけ求めるか。ダッシュボード/Excel 出力との組み合わせ）。
2. スコープ確定（Phase1 の範囲・CUBE の是非・super-aggregate 表現の契約）。
3. 方向が定まれば Phase1 仕様 R1 →（既存フロー）codex レビュー → R2 → 実装。

## codex 評価（2026-07-23）

### 1. 結論

**条件付きで実装可能。方向性は妥当だが、現案のまま仕様化すると不完全である。** kintone へ集計を押し下げず、1 回の FULL_SCAN 入力から複数の grouping set をローカル評価して縦結合する案は、現行実行パイプラインと整合する。`GROUPING SETS` を内部正規形とし、`ROLLUP` / `CUBE` を標準構文の糖衣として展開する方針も妥当である。

一方、実装の核は `applyGroupBy()` をセット数分呼ぶことだけではない。少なくとも次を Phase 1 の必須契約に加える必要がある。

1. grouping set の「全 grouping item」と「当該 set に残る item」を区別する AST／正規形
2. set から除外された grouped 列を空文字へ**明示上書き**し、任意の元行値を残さない処理
3. 行ごとの grouping 状態を SELECT・CASE・ORDER BY へ渡す内部メタデータ
4. B65 文を常に完全入力必須にする理由コードと、全 grouping-set 共通の set 数／生成行数上限

難易度は中ではなく**中〜大**である。複数集計自体より、`GROUPING()` を既存の分断された SELECT／CASE 条件／ORDER BY／将来 HAVING の式経路へ一貫して通す部分が主な工数と不確実性になる。

### 2. 現行コード上の実装可能性と具体的改修点

#### 2.1 AST と parser

- `SelectStatement.groupBy` は現在 `GroupByKey[]`、`GroupByKey` は `FIELD_NAME | ARITH_KEY | FUNC_KEY` の平坦な 1 セットだけである（`src/types/ast.ts:205-215, 592-609`）。`GROUPING SETS ((a,b),(a),())` の set 境界も、全 grouping item の集合も表現できない。`GroupByKey[][]` だけへ置換すると通常 GROUP BY、ROLLUP 展開種別、空 set、重複 set の保持が曖昧になるため、通常 GROUP BY と grouping sets を判別できる `GroupingSpec` 相当の discriminated union を推奨する。既存配列を残して別フィールドを足す案は変更量を抑えられるが、FULL_SCAN 判定や field walker が片方だけを見るドリフトを起こしやすい。
- `parseSelect()` は `GROUP BY` 後に `parseGroupByKeys()` を 1 回呼び、同関数はカンマ区切りの平坦なキー列を返す（`src/parser/parser.ts:1049-1056, 2457-2492`）。ここへ `GROUPING SETS`、`ROLLUP`、将来の `CUBE` を認識し、すべてを共通の grouping-set 正規形へ展開する入口が必要である。空 set `()`、set 内の複数キー、set／item のカンマ境界を通常の括弧算術式と混同しない専用 parser が要る。
- `parseScalarValueExpr()` は集計関数を拒否し、認識する関数は `tryStringFuncName()` 経由に限る（`src/parser/parser.ts:1431-1517`）。`GROUPING()` は通常の文字列関数へ追加するだけでは不十分である。通常行評価の `evalStringFunc()` は grouping 状態を受け取らず、WHERE や非集計 SELECT でも使えてしまうため、集計文脈専用の `GroupingRef` 相当として扱う方が安全である。
- 看板例の `CASE WHEN GROUPING(会社名) = 1 ...` は CASE の結果式ではなく `WhereExpr` の左辺を通る。現行 `parseFieldValue()` は文字列関数、集計関数、CASE、算術、通常フィールドを別分岐で処理する（`src/parser/parser.ts:2252-2287`）。したがって SELECT 列で `GROUPING()` を受理するだけでは例は動かず、CASE 条件／HAVING 用の `FieldValue` にも同じ grouping 参照を通す必要がある。
- `ORDER BY` は `FIELD_NAME | ARITH_KEY | FUNC_KEY` で、関数は `tryStringFuncName()` のみである（`src/parser/parser.ts:2494-2535`、`src/types/ast.ts:605-609`）。`ORDER BY GROUPING(col)` の直書きには専用キー、または group 段階で生成した canonical 合成名への安全な lowering が必要である。
- `ROLLUP` / `CUBE` / `GROUPING` / `SETS` をすべて hard keyword にすると、同名の既存フィールド／alias を壊す。現行 parser には `SEPARATOR` 等の soft keyword 前例がある。標準構文を変えずに soft keyword と文脈判定を使えるため、予約語化の互換性影響を調査してから決めるべきであり、現案の「予約語追加」は未確定事項とする。

#### 2.2 集計エンジン

- `applyGroupBy()` は全行を `groupByKeys.map(...).join("\x00")` で 1 個の `Map<string, ProcessRow[]>` に分け、各 bucket を 1 行へ集約する単一-set 実装である（`src/engine/process.ts:240-305`）。各 set ごとに同じ集計 evaluator を再利用すること自体は可能で、`evalAggregate()`、`evalAggArithExpr()`、B64 の `resolveAggInScalarValue()` を作り直す必要はない。
- ただし出力行は `{ ...groupRows[0] }` から始まる（同 `:263-267`）。総計 set `()` や `(a)` 小計で除外された `b` を明示上書きしなければ、先頭レコードの `a` / `b` が総計・小計行へ残る。**これは現案で最も直接的な correctness hole である。** 全 grouping item の出力キーを canonical 化し、当該 set に無い item はフィールドキー／式の合成名とも `""` に上書きする必要がある。
- 逆に、実データ `a=""` の detail group と、`a` を除外した grand-total set は別の set の Map で生成すれば別行として保持できる。同じ Map に sentinel 付き文字列キーを詰める場合は衝突しない構造キーが必要である。内部状態は表示用の空文字とは別に持たなければならない。
- grouping bitmask は概念として妥当だが、JavaScript の bitwise number は 32 bit であり 31/32 item 境界を持つ。上限をそれ以下に固定しないなら `bigint`、boolean vector、または canonical grouping-item ID の `Set` を使うべきである。`GROUPING(col)` に必要なのは「当該 item が set に含まれるか」であり、Phase 1 では `Set` の方が誤実装しにくい。bit の順序、修飾名、同じ式の重複、alias と物理名の同一性も仕様化が要る。
- `runFullScan()` は group → HAVING → DISTINCT → ORDER BY → LIMIT → project の順である（`src/engine/process.ts:1352-1389`）。複数 set を group stage で縦結合し、各行へ grouping 状態を付ければ、HAVING／DISTINCT／ORDER BY／LIMIT が全体結果へ作用する順序は正しい。grouping 状態は project 前まで失わず、通常の出力キーと衝突しない内部メタとして保持する必要がある。
- 空入力では、非空 grouping key の set は 0 行、空 set `()` は既存の「GROUP BY なし集計は 0 件でも 1 行」を再利用して 1 行となる（`src/engine/process.ts:255-260`）。これは望ましい。全 set に一律で仮想行を足してはならない。
- 現行は非集計 SELECT 列が grouping key であるかを厳密検証せず、先頭行コピーに依存できる構造である。B65 では少なくとも、super-aggregate 行に出す裸の列／式が grouping-item 全体に属するか、`GROUPING(arg)` の arg が grouping item と同一かを fail-closed で検証しないと、任意値と空文字契約が混在する。この検証範囲は仕様 R1 で明示すべきである。

#### 2.3 converter／planner／合成名

- `resolveSelectMode()` は `stmt.groupBy.length > 0` だけを FULL_SCAN 条件にしている（`src/converter/selectToKintone.ts:59-84`）。AST を別フィールドへ拡張した場合、ここを更新しないと empty set だけの GROUPING SETS 等が SIMPLE に誤分類される。B65 構文は grouping set の形や set 数にかかわらず FULL_SCAN 固定とする。
- `collectRequiredFieldsByTable()` は平坦な `stmt.groupBy` を走査し、SELECT／HAVING／ORDER BY の FIELD_NAME では alias と集計合成名を物理取得対象から除外する（同 `:412-442, 597-695`）。全 grouping set の item を漏れなく一度収集し、`GROUPING(col)` 自体は「物理列参照」ではなく grouping-item 参照として検証する walker が必要である。
- B59 の値解決は、group 後・project 前の行へ書かれた集計 alias／合成名を `buildOrderByAliasEvaluator()` が読む（`src/engine/process.ts:722-780`）。`GROUPING()` も group stage で数値文字列 `"0"/"1"` を materialize するか、同 evaluator に grouping 状態 resolver を与えれば同じ構造へ載る。ただし direct `ORDER BY GROUPING(col)` は alias evaluator だけでは解決しない。
- `buildOrderSemanticsForSelect()` は FIELD_NAME の物理列／SELECT alias から比較意味論を作り、未解決キーは canonical planner が `ORDER_KEY_UNRESOLVED` で拒否する（`src/execute.ts:4228-4325`、`src/core/optimization/canonicalOrderPlanner.ts:46-96`）。`GROUPING()` の出力／直接キーへ number semantics を明示しなければ、値を生成しても planner で拒否されるか文字列扱いになる。B59 と同様に「構文・値・型メタ・planner」の4層を同時に揃える必要がある。
- 集計合成名は HAVING 直接参照の橋渡しにも使われる。`GROUPING(col)` を合成名へ lower する場合は、SELECT／CASE／ORDER BY／HAVING／field collection が同じ canonical serializer を共有し、空白・大小文字・修飾名で別キーにならないことが条件である。

### 3. 意味論評価

#### 3.1 `GROUPING(col)` の 0/1

提案の意味論は正しい。結果値ではなく、**現在の grouping set に canonical な `col` grouping item が含まれるなら 0、含まれず集約されたなら 1** と判定する。`col` の実値が空文字かどうかを判定材料にしてはならない。

Phase 1 が simple field のみを grouping item／`GROUPING()` 引数として受けるなら実装は明確である。既存 GROUP BY が許す算術式・文字列関数まで対象にする場合、`GROUPING(expr)` の構文と AST 同値性、修飾あり／なし、alias 参照、重複 item を定義する必要があり規模が増える。初期版は **GROUPING SETS／ROLLUP の item と `GROUPING()` 引数を物理または修飾フィールド参照に限定**するのが安全である（標準構文のサブセットであり、独自構文ではない）。grouping item に存在しない引数は 1 を返すのではなく planning 時に拒否すべきである。

#### 3.2 空文字と実データ空セル

内部的には grouping 状態が別にあるため、detail の実データ空セル（`value="", GROUPING=0`）と subtotal／total（`value="", GROUPING=1`）を取り違えず区別できる。B65 の契約は横断仕様の「未設定スカラー値は空文字」を壊さない。

ただし、**出力値だけでは区別できない。** 利用者が grouped 列だけを SELECT し `GROUPING()` または衝突しない discriminator を出力しなければ、クライアントは両者を判別不能である。`CASE ... THEN '合計'` も実データに `'合計'` があれば表示ラベルだけでは衝突する。機械的な判別が必要な利用例では `GROUPING(col) AS ...` も出力することを文書化すべきである。`SELECT DISTINCT` が discriminator を投影しない同値行を畳むことは、SELECT の投影結果に対する DISTINCT としては整合する。

#### 3.3 B64 条件付き集計

各 grouping set の bucket に対して既存 `evalAggregate()` を独立に呼べば、B64 の CASE／`||`／nullable 評価はその set の入力行だけへ適用される。`SUM(CASE ...)`、`COUNT(CASE ...)`、`DISTINCT` を含む条件付き集計の結果は正しくなる。grand-total set は filter 後の全入力、subtotal は対応 bucket が対象であり、set 間で DISTINCT 集合や accumulator を共有してはならない。

破綻し得るのは、性能最適化で複数 set の accumulator を共有し、B64 の式評価・NULL 除外・関数別 DISTINCT 単位を set ごとに分離しない場合である。初期版は既存 evaluator の set 単位再利用を優先する方が安全である。

#### 3.4 ORDER BY と HAVING

`ORDER BY GROUPING(col), 集計式` は、group stage が grouping 値と集計 alias／合成名を同じ中間行へ書き、両方へ number semantics を供給すれば現行 local ORDER で実現できる。REST 押し下げ不可、FULL_SCAN 後の全結果ソートで正しい。

ただし Phase 1 の direct `ORDER BY GROUPING(col)` は B59 の alias 修正へ自然には乗らない。最小版では `SELECT GROUPING(col) AS g ... ORDER BY g` だけを先に受ける選択肢があり、これは標準 SQL の範囲内である。direct 形も Phase 1 の受入条件にするなら、専用 OrderByKey／合成名 lowering と number meta を同時実装する必要がある。

HAVING は縦結合後に適用されるため段階位置は正しい。ただし現行 HAVING の直接集計参照は、同じ集計が SELECT にあり group stage で合成名が生成される場合に限るという B56 の既存制約がある。`HAVING GROUPING(col)=...` を Phase 2 に送る判断は妥当で、導入時はこの制約と grouping resolver の両方を明記する必要がある。

### 4. 既存機能との相互作用

- **B56 完全入力**: 統計集計を含む場合、現行 `completeInputReasons()` の再帰検出により 1 回の元入力取得全体が完全入力必須となり、その完全な入力を各 set が共有できる。set ごとに再 fetch する必要はない。ただし B65 は `SUM` / `COUNT` だけでも subtotal が全入力依存である。現行理由は ORDER BY、window、統計集計等だけで、通常 GROUP BY 自体は `onLimit=truncate` を禁止しない（`src/core/dmlGuard.ts:62-67, 139-152`）。**`GROUPING_SETS` 等の新しい complete-input reason を追加し、B65 文は常に truncate 禁止にすべきである。**
- **FULL_SCAN**: B65 は常に FULL_SCAN。WHERE の安全な押し下げは既存どおり可能だが、grouping／ORDER／LIMIT はローカルで完結させる。LIMIT は全 grouping-set 結合・HAVING・ORDER BY の後に適用する。
- **DISTINCT 集計**: `COUNT(DISTINCT x)` 等は set ごとの `groupRows` 内で既存規約どおり評価する。統計集計の数値同値 DISTINCT と既存集計の文字列単位 DISTINCT の差も B56 のまま維持する。SELECT DISTINCT は全 set の縦結合後に作用する。
- **HAVING**: 各 set の集計行へ適用する。GROUPING を使わない既存 HAVING は原則そのまま動くが、SELECT に無い直接集計を計算しない既存制約も残る。
- **GROUP BY 無し集計／0 件**: 通常の `SELECT COUNT(*) ...` は従来 AST／経路を維持する。GROUPING SETS に `()` がある場合だけ 0 件でもその set が 1 行を生成し、非空 set は 0 行。`GROUPING SETS (())` は GROUP BY 無し集計と集計値が一致するが grouping 状態を持つ。
- **GROUP BY 式／alias**: 現行の `ARITH_KEY` / `FUNC_KEY` と B59 alias 解決まで初期版へ含めると canonical identity と空文字上書き対象が増える。フィールド item 限定で開始し、式 grouping set は別受入にするのが妥当である。

### 5. スコープと段階化の推奨

現案の「Phase 1 は単一列 ROLLUP、Phase 2 は複数列 ROLLUP」という境界はやや不自然である。grouping-set engine が `(a,b)`, `(a)`, `()` を処理できれば、複数列 ROLLUP は parser で `n+1` set へ展開する小さな追加であり、主な難所ではない。一方、`GROUPING()` の SELECT／CASE／ORDER BY 統合は単一列でも必要である。

推奨する正式 Phase 1 は次である。

- simple field item の `GROUPING SETS`（空 set、複数 item、明示順、重複 set の扱いを仕様化）
- 同じ基盤上の単一列および複数列 `ROLLUP`
- `GROUPING(field)` を SELECT、CASE 条件、トップレベル ORDER BY で利用可能
- FULL_SCAN／完全入力固定
- set 数と生成行数の共通 fail-closed guard
- CUBE、HAVING 内 GROUPING、式 grouping item、ネストした grouping element、`GROUPING_ID` は対象外

さらに小さく需要検証を先行するなら、**Phase 0 として `ROLLUP(単一フィールド)` + SELECT／CASE の `GROUPING(field)` + `ORDER BY` はその SELECT alias 経由のみ**に絞れる。内部表現は最初から grouping sets 正規形にし、公開する標準構文面だけを狭くする。この案なら GROUPING SETS の括弧文法と direct ORDER BY 経路を後送できる。ただし明示的な set 選択という B65 の汎用価値はまだ提供しない。

`CUBE` を Phase 2 または見送りとする判断は妥当である。ただし爆発は CUBE 固有ではなく、明示 GROUPING SETS も大量 set／重複 set で `入力行数 × set 数` 級になり得る。したがって guard は全構文へ共通適用する。

- planning 時: 糖衣展開後の set 数を上限検査し、CUBE は `2^n` を安全に計算して展開前に拒否する
- runtime: HAVING 前に生成した集計行数を上限検査し、超過時は部分結果を返さずエラー
- 必要なら grouping item 数にも上限を設け、bitmask 表現の限界と一致させる
- 閾値は既存 `maxRecords` の流用と決め打ちせず、入力上限、メモリ使用量、典型的 group cardinality の benchmark から決める。set 上限と出力行上限は別パラメータ／別理由として EXPLAIN とエラーに出す

具体値は現時点のコード／実測からは導けないため未決とする。B40 の前例どおり、無音打切りや「上限までの小計」を返す方式は不可である。

### 6. 実装規模見積り

前提は「simple field grouping item、既存 UI 設定追加なし、CLI／MCP／plugin 共通 core、契約テスト・文書同期を含む」である。

| 範囲 | 見積り |
|---|---:|
| Phase 0（単一列 ROLLUP、GROUPING は SELECT／CASE、ORDER BY alias、完全入力・guard） | 8〜13 人日 |
| 推奨 Phase 1（明示 GROUPING SETS、複数列 ROLLUP、direct ORDER BY GROUPING を含む） | 13〜21 人日 |
| Phase 2 増分（HAVING GROUPING、CUBE、上限・EXPLAIN・追加実機検証） | 6〜10 人日 |
| Phase 1 + 2 合計 | 19〜31 人日 |

最大の不確実性は、複数 set の集計計算そのものではなく、**`GROUPING()` を既存の複数の式 AST／評価器／型メタ／planner にどう一元化するか**である。次点は grouping item の同一性（修飾名・式・alias）と、出力行上限の妥当な既定値である。式 grouping item まで Phase 1 に含める、または設定 UI／MCP schema まで同時追加する場合は上振れする。

### 7. 代替案の評価

既存 `UNION ALL` による「明細 + 総計」は、1 階層だけで件数が少ない実需には有効であり、B65 の需要確認用 workaround として残せる。標準構文を追加せず、各枝で同じ B64 条件付き集計も使える。

ただし正式な代替にはならない。

- 同じ WHERE／集計式を枝ごとに重複し、階層が増えるほど保守性が急落する
- grouped 列へラベル／空文字と discriminator を手作業で揃える必要がある
- 枝ごとに入力を再評価し得て、1 回の入力から全 set を作る実装より高コストになりやすい
- 現行 UNION は結果全体の最終再ソート段を持たず、B59 仕様も各分岐の ORDER BY として扱っているため、「全明細を並べて総計を末尾」の表現力が弱い
- 多列 ROLLUP／CUBE は UNION ALL の枝数と SQL 重複が急増する

したがって、実需が「会社別 + 全体合計」だけなら B65 を急がず UNION ALL の recipe／生成支援で満たす判断は合理的である。地域→会社→総計、`GROUPING()` による機械判別、同一結果全体のソートが複数利用者に必要なら、B65 を正式実装する価値がある。

### 8. 仕様 R1 前に要判断の未解決論点

1. Phase 1 を推奨範囲（field-only GROUPING SETS + 複数列 ROLLUP）にするか、需要検証用 Phase 0 に縮めるか
2. `GROUPING()` 引数を field-only に固定するか、既存 GROUP BY の算術／関数式まで初期対応するか
3. hard keyword 化による既存 field／alias 互換性を受け入れるか、文脈付き soft keyword で維持するか
4. direct `ORDER BY GROUPING(col)` を Phase 1 必須にするか、まず SELECT alias 経由だけにするか
5. machine-readable な利用では grouping discriminator の SELECT を必須推奨とする文書契約でよいか
6. grouping set 数、grouping item 数、生成行数の上限と設定面。全 grouping-set 構文に共通適用し、超過を fail-closed にすること自体は必須
7. 明示した重複 grouping set を重複行として保持するか。標準互換を優先するなら保持し、`SELECT DISTINCT` はその後に適用する
8. B65 専用の complete-input reason を追加し、統計集計や ORDER BY が無い場合も `onLimit=truncate` を禁止する契約で確定するか
