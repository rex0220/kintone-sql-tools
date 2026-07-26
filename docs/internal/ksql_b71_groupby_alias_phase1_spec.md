# B71 Phase1 — `GROUP BY` のエイリアス解決 仕様

- 作成日: 2026-07-26
- ステータス: **✅ リリース済み（v3.23.0・2026-07-26）**。feat PR #274→tag v3.23.0→GitHub Release→npm publish（latest 3.23.0）。**実機 PASS**＝デプロイ済み MCP で alias GROUP BY が実フィールド指定と完全一致。§9（R3）が実装された設計（§1〜7＝R1・一部誤り／§8＝R2・§9 が上書き）。
- 課題: [B71 issue](ksql_b71_groupby_alias_wrong_result_issue.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B71
- 関連: B59（ORDER BY alias 黙殺修正・v3.13.0・`buildOrderByAliasEvaluator`）／B65（ROLLUP・GROUPING SETS）／B51（silent wrong results の前例）

## 1. 目的

`GROUP BY` に SELECT のエイリアスを書いたとき、**エラーにならず全行が1グループへ潰れる**（silent wrong results）現象を解消する。方針は **alias を解決して正しく集計する**（拒否ではない）。

## 2. 現状の実挙動（プローブ実測 2026-07-26）

レコード3件（区分 A,A,B／金額 100,200,300／日付 2026-01,2026-01,2026-02）。

| # | ケース | 現状 | 評価 |
|---|---|---|---|
| A1 | `DATE_FORMAT(日付,'%Y-%m') AS 年月 … GROUP BY 年月` | `[{年月:"2026-01",c:"3"}]` | ❌ **誤集計**（正は2グループ） |
| A2 | `区分 AS g … GROUP BY g` | `[{g:"A",c:"3"}]` | ❌ **誤集計** |
| A3 | `金額*2 AS m … GROUP BY m` | `[{m:"200",c:"3"}]` | ❌ **誤集計**（正は3グループ） |
| A4 | `'X' AS lit … GROUP BY lit` | `[{lit:"X",c:"3"}]` | ⭕ 偶然正しい（全行同値） |
| B1 | `COUNT(*) AS c … GROUP BY c` | `[{区分:"A",c:"3"}]` | ❌ **SQL 的に不正なのにエラーにならず誤結果** |
| B2 | `ROW_NUMBER() OVER(...) AS rn … GROUP BY rn` | ParseError（window と GROUP BY の併用不可） | ✅ 既に拒否 |
| B3 | `(SELECT COUNT(*) …) AS sc … GROUP BY sc` | `[{sc:"3",c:"3"}]` | ⭕ 偶然正しい（全行同値） |
| C1 | `金額 AS 区分 … GROUP BY 区分`（alias が実フィールド名と衝突） | n=2・実フィールド `区分` でグループ化 | ⚠ **この評価は誤り → §8.1 で訂正**（全フィールドを返すモックの artifact。実 kintone の fields 指定では `区分` が fetch されず誤結果） |
| D1 | `GROUP BY ROLLUP(年月)`（alias） | `ArgumentError: B65 field 年月 does not exist in a physical APP source.` | ✅ 既に拒否 |
| D2 | `GROUP BY GROUPING SETS ((年月),())`（alias） | 同上 | ✅ 既に拒否 |
| E1 | `HAVING c > 1`（集計 alias） | `[{区分:"A",c:"2"}]` | ✅ 正常（集計後の行を評価） |
| E2 | `ORDER BY c DESC`（alias・B59） | 正常 | ✅ 正常 |
| F1 | `GROUP BY DATE_FORMAT(日付,'%Y-%m')`（式） | 2グループ | ✅ 正解形 |

### 2.1 判明した重要事実

1. ~~**実フィールドは正しく優先されている**（C1）。バグは「入力行に存在しない名前」のときだけ。~~ **⚠ 誤り → §8.1 で訂正**。実 kintone と同じ fields 指定の取得では、GROUP BY 名が alias と一致すると**実フィールドでも fetch から除外**されるため shadow ケースも誤結果になる。
2. **B65（ROLLUP / GROUPING SETS）は別経路で既に拒否**（`applyGroupingSets` は `evalGroupByKey` を使わない）。本 Phase1 の対象外で現状維持。
3. **HAVING / ORDER BY は既に正常**。変更しない。
4. **集計 alias の GROUP BY（B1）も現状は誤結果**。SQL 的に不正なので、本 Phase1 で**明示拒否**する。

## 3. 公開意味論（確定規則）

### 3.1 `GROUP BY <名前>` の解決順

1. **入力行に存在するフィールド**（実フィールド・システム列）→ 従来どおりその値でグループ化（**既存挙動を一切変えない**）。
2. 1 に該当せず、**SELECT に同名の alias があり、それが「グループ化前の入力行から評価できる式」**であれば、その式を評価した値でグループ化する。
3. どちらでもない → 従来どおり `ArgumentError: unknown field code(s): …` で拒否。

「実フィールド優先」は標準 SQL / MySQL と一致し、C1 の既存挙動を保つ。ORDER BY（B59）が alias 優先なのは出力行に対する操作だからで、GROUP BY（入力行に対する操作）とは前提が異なる。**両者の優先順位が違うことは意図した設計**として明記する。

### 3.2 解決できる alias（グループ化前の入力行から評価可能）

| alias の種別 | 扱い |
|---|---|
| 文字列/日付関数（`DATE_FORMAT` / `SUBSTRING` 等・A1） | **解決する** |
| 単純フィールド参照（`区分 AS g`・A2） | **解決する** |
| 算術式（`金額*2 AS m`・A3） | **解決する** |
| リテラル（`'X' AS lit`・A4） | **解決する**（結果は現状と同じ1グループ） |
| スカラーサブクエリ（B3） | **解決する**（実行前に解決済みの定数。結果は現状と同じ） |
| `CASE` 式 | **解決する**（入力行から評価可能） |

### 3.3 拒否する alias（グループ化前に確定しない）

| alias の種別 | 扱い |
|---|---|
| 集計関数（`COUNT(*) AS c`・`SUM` / `MIN` / `MAX` / `GROUP_CONCAT` 等・B1） | **明示エラーで拒否**（グループ化前に値が確定しないため。MySQL も拒否） |
| ウィンドウ関数（B2） | 既存の「window と GROUP BY は併用不可」エラーを維持（本仕様で新規対応しない） |
| `GROUPING()` 列 | **拒否**（grouping 状態は集計時に確定するため） |

拒否時のメッセージは、原因が分かる形にする（案: `ArgumentError: GROUP BY cannot reference the aggregate alias "c"; group by the underlying expression instead.`）。文言は R2 で確定する。

### 3.4 対象外（Phase1 スコープ外・現状維持）

- **B65 `ROLLUP` / `GROUPING SETS` の grouping item への alias**（D1/D2）＝既に `B65 field … does not exist in a physical APP source.` で拒否済み。Phase1 では挙動を変えない（必要ならメッセージ改善のみ別途）。
- `HAVING` / `ORDER BY` の alias（既に正常）。
- JOIN・CTE / 一時テーブル由来の列との alias 衝突規則（既存の解決規則に従う）。

## 4. 実装方針

`evalGroupByKey` に、B59 の `buildOrderByAliasEvaluator`（**project 前の入力行から SELECT alias を評価する事前コンパイル resolver**）と同型の evaluator を供給する。ただし **ORDER BY と優先順位が逆**（実フィールド優先）なので、適用は次の形にする。

```text
FIELD_NAME の評価:
  if (name が入力行に存在) return row[name];          // 既存挙動（実フィールド優先）
  if (alias evaluator に name がある) return evaluator(name, row);
  return "";                                          // 到達しない（検証で弾かれる）
```

- evaluator は `applyGroupBy` の引数として渡す（`runFullScan` が構築）。`applyGroupingSets`（B65）へは渡さない。
- 集計 alias / GROUPING alias の拒否は**取得前の planning 段階**で行う（`validateSelectFieldCodes` 近傍、または静的検証 `analyzeBatch` にも入れて `ksql_validate` で見えるようにする。R2 で位置を確定）。

### 4.1 Step 分割（安全を先に、能力を後で）

| Step | 内容 | この時点の挙動 |
|---|---|---|
| 1 | **拒否を閉じる**＝集計 alias / GROUPING alias の `GROUP BY` を planning で明示エラー化 | B1 が誤結果 → 明示エラー（安全側へ倒れる） |
| 2 | **解決を開く**＝`applyGroupBy` へ alias evaluator を供給し、実フィールド優先で解決 | A1/A2/A3 が正しい集計に |
| 3 | 受入・非回帰・docs（言語リファレンス §8/§9 の GROUP BY 節に alias 可否を明記） | — |

Step 2 を先に行うと拒否すべき alias まで解決してしまうため、**Step 1 → Step 2** の順を必須とする。

## 5. 受入条件

### 5.1 正例

- A1/A2/A3 が式指定（F1 相当）と**同一結果**になる。
- A4/B3 は現状と同じ結果（1グループ）。
- 複数キー（`GROUP BY 年月, g`）・alias と実フィールドの混在で正しく動く。

### 5.2 拒否

- B1（集計 alias）が原因の分かる明示エラー。`SUM` / `MIN` / `MAX` / `GROUP_CONCAT` / 統計集約 / `MODE` でも同様。
- `GROUP BY 存在しない列` は従来どおり `unknown field code(s)`。

### 5.3 非回帰（最重要）

- **C1（alias が実フィールド名と衝突）の結果が不変**＝実フィールド優先。
- 通常の `GROUP BY <フィールド>` / `<式>`・`HAVING`・`ORDER BY`（B59）・B65 `ROLLUP`/`GROUPING SETS`（D1/D2 の拒否含む）が不変。
- snapshot 不変・全 npm test green。

## 6. SemVer

**minor**。従来「動いていた」alias `GROUP BY` の**結果が変わる**（誤 → 正）が、B59（ORDER BY alias 黙殺修正・v3.13.0 minor）と同じ前例に倣う。CHANGELOG に「従来 alias GROUP BY が返していた値は誤りであり、結果が変わる」ことを明記する。

## 7. codex レビュー観点

1. §3.1 の解決順（実フィールド優先 → alias）で、C1 を含む既存挙動が本当に不変か。JOIN の修飾/非修飾列・CTE / 一時テーブル由来列・システム列（`$id` 等）で破綻しないか。
2. §3.2 の「解決できる alias」の判定を、B59 の `buildOrderByAliasEvaluator` がそのまま満たすか（対応していない SELECT 列種別はないか。`CASE` / scalar subquery / `||` 連結など）。
3. §3.3 の拒否を **planning 段階**で行う適切な位置（`validateSelectFieldCodes` 近傍か、`analyzeBatch` の静的検証にも入れるべきか）。`ksql_validate` で見えるようにする価値。
4. B65 `applyGroupingSets` が `evalGroupByKey` を使わないこと、および D1/D2 の拒否が Phase1 で不変であることの確認。
5. 集計 alias 拒否の網羅（全12集計・`GROUPING()`・window・`ARITH_AGG_COL` などの合成列）。
6. Step 1 → Step 2 の順序で、Step 1 単独 merge 時に「誤結果 → 明示エラー」以外の挙動変化が出ないか。
7. 見落としている silent wrong results の類似経路（例: `GROUP BY` に alias を書いた `INSERT ... SELECT` の source、CTE 内 SELECT、UNION 枝）。

---

## 8. R2（codex レビュー反映・Claude 裏取り済み）

R1 に対し codex がレビューし、**「R1 はそのまま実装不可」**と判定。Claude が主要指摘を実コードとプローブで裏取りし、**R1 の中核前提の誤りを確認**した。以下を R2 の確定事項とし、§2〜§4 の該当箇所を上書きする。

### 8.1 【最重要】C1（alias が実フィールド名を shadow）の訂正 — R1 は誤り

R1 §2 の C1 は「実フィールド優先で正しく動いている（既存挙動として保つ）」としたが、**誤り**。初回プローブのモックが**要求に関係なく全フィールドを返していた**ための artifact だった。

**実 kintone と同じ「`fields` 指定で取得」を再現したプローブ（2026-07-26）**:

| クエリ | fetch された fields | 結果 |
|---|---|---|
| `SELECT 金額 AS 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分` | `["金額","$id"]`（**`区分` が除外**） | `[{区分:"100",c:"3"}]` ❌ **1グループへ潰れる** |
| `SELECT 区分, COUNT(*) AS c FROM APP100 GROUP BY 区分` | `["区分","$id"]` | ✅ 2グループ（正） |

原因は `selectToKintone.ts:440` が「GROUP BY の名前が SELECT alias に一致すれば取得不要」と判断し、**実フィールドが存在しても fetch 対象から落とす**こと。したがって:

- **shadow ケースも現状は誤結果**（R1 の「既存挙動として保つ」は成立しない）。
- 「実フィールドが行に存在するか」を**実行時に見る方式は採れない**（そもそも fetch されていないため）。

### 8.2 解決方式の変更 — planning 時に解決種別を確定し fetch へ反映

R1 §3.1/§4 の「`row[name] !== undefined` なら実フィールド」は**撤回**する。代わりに:

1. **planning 時に schema-aware で各 `FIELD_NAME` の解決種別を1回だけ確定**する（クエリ単位・行ごとに変わらない）:
   `PHYSICAL`（物理列・CTE/temp の実体化列を含む）／`ALIAS`（SELECT alias で pre-group 評価可能）／`REJECT`（集計依存等）／`UNKNOWN`（従来どおり unknown field エラー）／`AMBIGUOUS`（下記 8.5）。
2. 解決順は **PHYSICAL 優先 → ALIAS**（標準 SQL / MySQL と同じ）を維持する。
3. **`PHYSICAL` と確定した GROUP BY 列は必ず fetch / materialize 対象に含める**（`selectToKintone.ts:440` の alias 除外を、解決種別が ALIAS のときだけに限定する）。これが 8.1 の修正の本体。
4. `applyGroupBy` へは「単なる evaluator」ではなく**確定済みの解決計画**（キーごとの種別＋ALIAS の場合の evaluator）を渡す。

### 8.3 pre-group-safe な alias 分類器が必要（ORDER BY evaluator の流用は不可）

R1 §3.2 は `buildOrderByAliasEvaluator` の流用を前提にしたが、**そのままでは同じ silent collapse が残る**（codex 指摘・コードで確認）:

- `STRFUNC_COL` は `FORMAT(SUM(x), …)` のように**集計を内包**できる。
- `SCALAR_VALUE_COL` も `FORMAT(SUM(x),'0') || 'y'` を内包できる。
- これらの evaluator は未 materialize の値を行評価へ落とし、`evalStringFuncArg()` が pre-group の `AGG_REF`/`AGG_ARITH` を `""` にする（`src/engine/evalFunc.ts:705-715`）。

よって **pre-group-safe な alias だけを登録する専用の classifier / builder** を用意する。ORDER BY 用の無制限 evaluator を GROUP BY へ渡してはならない。判定には既存 `isAggregateMaterializedAlias()`（`src/core/groupingValidation.ts:121-137`・AGGREGATE / ARITH_AGG / 集計内包 STRFUNC・SCALAR を識別）を一般化して用いる。

### 8.4 拒否対象の完全化

R1 §3.3 に加え、次も拒否する:

- `ARITH_AGG_COL`（集計を含む算術列）
- **集計を内包する** `STRFUNC_COL` / `SCALAR_VALUE_COL`
- **alias なしの集計合成名**（例: `` GROUP BY `SUM(x)` ``）。converter は synthetic aggregate name も取得対象から除外するため（`selectToKintone.ts:443-445`）、現状は黙って1グループになる（codex プローブで確認）。
- `GROUPING()` 列（plain GROUP BY では既存 static validation が拒否済み・`groupingValidation.ts:193-219`）。window + GROUP BY も既存 parser 拒否を維持。

**注意**: 拒否は「名前が集計 alias と一致するか」だけで判断してはならない。**同名の物理列が存在する shadow ケースでは PHYSICAL が優先**され、有効なクエリを壊してはならない（8.2 の解決種別確定を先に行う）。

### 8.5 曖昧性の規則（R1 未定義・要確定）

- **同名の SELECT alias が複数ある場合**: 現行 evaluator は `Map.set()` の後勝ち（`process.ts:837-891`）。R2 では **曖昧として拒否**する（後勝ちの暗黙採用は silent wrong results の温床）。
- **JOIN の非修飾列で複数ソースに同名がある場合**: 既存の ambiguous column 規則（B51/v3.0.0）に合わせて拒否する。

### 8.6 検証の配置と `ksql_validate` の責務

- `validateSelectFieldCodes()` 単独では不十分（fetch 直前の物理検査であり、**CTE/temp source は `executeFullScanWithCte()` から直接進みこの関数を通らない**）。
- **runtime planning は `validateStatementGroupingPlanning()` の再帰 walker（`execute.ts:2458-2478`）を plain GROUP BY へ拡張**するのが自然。
- `analyzeBatch()`（`src/core/batch.ts:170-181,196-210`）は全 query level を再帰走査できるが **schema-free**。`ksql_validate` は kintone API を呼ばない契約（`src/mcp/index.ts:133-137`）なので、**shadow 解決（PHYSICAL か ALIAS か）は静的には確定できない**。
- **確定**: 構文だけで判断できる拒否（集計 alias の GROUP BY・GROUPING・重複 alias）は **static validate でも拒否**し、shadow 解決を要するものは **EXPLAIN / runtime planning で確定**する（`ksql_validate` は「schema-aware 判定が必要」旨に留める）。

### 8.7 nested SELECT の同一バグ（R1 未記載・P1）

codex のプローブで、同じ collapse が **CTE body / UNION 両枝 / scalar subquery body** にも存在することを確認（scalar subquery では誤った値が scalar として成立するため特に危険）。実行経路は共有のため、`runFullScan()` / `applyGroupBy()` 側の修正で原則すべて直る:

- UNION 枝: `executeSelect()`（`execute.ts:3819-3825`）
- CTE: `executeQueryWithCte()`（同 `:3886-3904`）
- INSERT/UPSERT … SELECT source: `materializeDmlSource()`（同 `:6565-6596`）
- scalar subquery: `runSubquery()`（同 `:8222-8232`）
- CREATE TEMP TABLE AS SELECT: `runSelectLike()`（同 `:1670-1684`）

ただし**拒否側**は共有経路に載らないため、8.6 の再帰 walker で全 query level をカバーすること。受入にこれら5経路を含める。

### 8.8 Step 分割の改訂（R1 §4.1 を置換）

| Step | 内容 |
|---|---|
| 1 | **解決種別の planning 確定**（PHYSICAL / ALIAS / REJECT / UNKNOWN / AMBIGUOUS）＋ **PHYSICAL を fetch 対象へ含める**。この時点で **8.1 の shadow 誤結果が直る** |
| 2 | **aggregate-dependent alias の拒否**（8.4）を再帰 walker で全 query level に適用 |
| 3 | **pre-group-safe alias evaluator を有効化**（8.3）＝ A1/A2/A3 が正しく集計される |
| 4 | 受入・非回帰（5 nested 経路含む）・docs |

R1 の「拒否 → 解決」の2段は、**解決種別の確定（Step 1）を最初に置く**形へ改める。名前だけで拒否すると shadow の有効クエリを壊すため。

### 8.9 受入の追加（R1 §5 に追加）

- **fields 指定を尊重するモック**（実 kintone と同じ projection 挙動）で全ケースを検証すること。全フィールドを返すモックでは 8.1 のバグが再現しない。
- shadow ケース（`金額 AS 区分 … GROUP BY 区分`）が**物理列でグループ化**され、`区分` が fetch されること。
- CTE body / UNION 両枝 / scalar subquery / DML source SELECT / CREATE TEMP TABLE AS SELECT の各経路で alias GROUP BY が正しく集計されること。
- 重複 alias・JOIN 非修飾曖昧列が拒否されること。
- 空セル・キー欠落行が従来どおり同一グループ（`""`）に入ること（B71 前後で不変）。

### 8.10 ステータス

**R2 確定＝実装着手可能**。R1 からの主要変更は「shadow ケースも壊れていた」「実行時判定を撤回し planning 時確定＋fetch 反映へ」「ORDER BY evaluator 流用不可」「拒否対象と検証配置の是正」「nested 5 経路」。

**教訓**: 初回プローブのモックが実 kintone の `fields` projection を再現しておらず、**バグを隠していた**。今後 GROUP BY / fetch 周りのプローブは **fields 指定を尊重するモック**で行う。

---

## 9. R3（codex 起草）

### 9.1 位置付け・R2 からの変更

本節を **B71 Phase1 の実装規範**とする。§1〜§7 は R1 の履歴、§8 は R2 の履歴として保存するが、実装判断が競合する場合は本節を優先する。

R3 は R2 の次の決定を明示的に上書きする。

1. §8.6 の「集計 alias・集計合成名・重複 alias を static validate でも拒否」は撤回する。これらは同名の物理列が存在すれば有効な `PHYSICAL` 参照になるため、schema-free な時点では拒否しない。`ksql_validate` は kintone API を呼ばない契約である（`src/mcp/index.ts:133-137`）。
2. §8.6 の再帰 walker を B71 の plan 作成場所にはしない。現行の statement-level walker は `MaterializedTable` を受け取らず SELECT を先回りする（`src/execute.ts:2458-2478`）一方、CTE は本体を順番に実行してから `rows` と `columns` を cache する（同 `:3883-3904`）。B71 の plan は **各 SELECT の source schema が利用可能になった直後、fetch より前**に just-in-time で作る。
3. §8.5 の「同名 alias が複数なら常に拒否」は狭める。拒否するのは、`GROUP BY <name>` が物理列に解決せず、SELECT alias に解決しようとした時点で同名候補が複数ある場合だけである。
4. §8.3 の aggregate dependency 判定を `STRFUNC_COL` / `SCALAR_VALUE_COL` の追加判定ではなく、**alias を持つ全 `SelectColumn` の再帰検査**へ一般化する。少なくとも `CASE_COL`、`ARITH_COL`、`ARITH_AGG_COL`、`STRFUNC_COL`、`SCALAR_VALUE_COL` を同じ walker で扱う。
5. §8.8 の Step 1〜3 は、単独 merge 時の安全性が明示されていないため、本節 §9.10 の fail-closed staging に置き換える。

最終公開方針は変更しない。Phase1 の end state はオーナー決定どおり **`PHYSICAL` 優先、次に pre-group-safe な SELECT alias を解決する MySQL 互換の挙動**であり、拒否だけを最終状態にはしない。

### 9.2 決定的な再現事実

FULL_SCAN の取得列は `fetchTableRecordsForFullScan()` 内で `selectToFetchAllFields()` により決まる（`src/execute.ts:4156-4185`）。converter は現状、`groupBy` phase の名前が SELECT 出力名に一致すると取得対象から無条件に除外する（`src/converter/selectToKintone.ts:411-445,628-637`）。一方、plain GROUP BY の値評価は `row[key.name] ?? ""` だけである（`src/engine/process.ts:418-423`）。したがって、alias と判定して fetch を省いたのに alias 値を評価しない、という二層不整合が silent collapse の原因である。

fields projection を尊重するモックで得た次の結果を設計の固定入力とする。

| case | SQL の要点 | 現在の取得列 | R3 最終結果 |
|---|---|---:|---|
| S1 | `金額 AS 区分, 区分 ... GROUP BY 区分` | `金額, 区分, $id` | 実列 `区分` で 2 groups（不変） |
| S2 | `区分 AS 区分 ... GROUP BY 区分` | `区分, $id` | 実列 `区分` で 2 groups（不変） |
| S3 | `金額 AS 区分 ... GROUP BY 区分` | `金額, $id` | schema 上の実列 `区分` を追加 fetch し、実列で 2 groups |
| S4 | `DATE_FORMAT(...) AS 区分, 区分 AS orig ... GROUP BY 区分` | `区分, $id` | 実列 `区分` で 2 groups（不変） |
| A1〜A3 | source にない `年月` / `g` / `m` alias | alias の依存列のみ | alias 式を pre-group 評価し正しく grouping |
| B1 | `COUNT(*) AS c ... GROUP BY c`、source に `c` なし | `$id` 等 | 明示エラー |

S1/S2/S4 は「GROUP BY 名と alias が一致すれば拒否」という schema-free 規則が既存の正しい結果を壊す反例である。S3 は「実際に fetch された row に名前があるか」で `PHYSICAL` を決める規則が不十分である反例である。**解決は source schema で先に決め、その同じ plan を fetch と group 評価で共有しなければならない。**

### 9.3 公開解決意味論

対象は plain `GROUP BY` の `FIELD_NAME` item だけとする。`ARITH_KEY` / `FUNC_KEY` は従来どおり式そのものを評価する。AST 上も plain key は `SelectStatement.groupBy` にあり、B65 は別の `grouping` property である（`src/types/ast.ts:205-220`）。

各 `GROUP BY <name>` は SELECT 単位で次の順序により一度だけ解決する。

1. **PHYSICAL lookup**
   - 修飾名なら指定 source だけを検索する。修飾名は SELECT alias 候補にしない。
   - 非修飾名なら FROM/JOIN の全 source schema を検索する。
   - 一致が 1 source なら `PHYSICAL`。
   - 一致が複数 source なら既存 B51 と同じ JOIN ambiguity error。SELECT alias へ fallback しない。
2. **ALIAS lookup**
   - 物理一致が 0 の非修飾名だけ、SELECT の同名出力候補を調べる。
   - 候補が 1 つで aggregate 非依存なら `ALIAS_SAFE`。
   - 候補が 1 つで aggregate 依存、`GROUPING_COL`、window 等の pre-group 不可列なら `ALIAS_REJECT`。
   - 同じ明示 alias の候補が複数なら `ALIAS_AMBIGUOUS`。
3. **aggregate synthetic lookup**
   - 物理一致も明示 alias 一致もなく、名前が alias なし集計列の合成出力名（例: `` `SUM(金額)` ``）に一致すれば `ALIAS_REJECT`。集計列の既定出力名は projection と同じ `aggregateSyntheticName()` で作られている（`src/engine/process.ts:1014-1020,1272-1301`）。文字列を別実装で再構成してはならない。
4. どれにも一致しなければ `UNKNOWN` とし、既存の `ArgumentError: unknown field code(s): ...` 系で拒否する。

最終状態の動作は次のとおりとする。

| resolution | fetch | group key evaluation |
|---|---|---|
| `PHYSICAL` | 解決した source の列を必ず取得・実体化 | plan に保存した source/runtime key を読む |
| `ALIAS_SAFE` | GROUP BY 名自体は取得しない。alias 式の依存列は SELECT 列 walker が従来どおり取得 | alias 元 `SelectColumn` を入力 row 上で評価 |
| `ALIAS_REJECT` | records API 前に拒否 | 到達不可 |
| `ALIAS_AMBIGUOUS` | records API 前に拒否 | 到達不可 |
| `UNKNOWN` | records API 前に拒否 | 到達不可 |
| `DEFERRED` | EXPLAIN 表示専用。実行には渡さない | 到達不可 |

`evalGroupByKey()` の現行 `""` fallback（`src/engine/process.ts:419-423`）は、**plan 済み `PHYSICAL` の実データ欠落・空セル**にだけ残す。未解決名や拒否対象を `""` に落としてはならない。

#### 9.3.1 `PHYSICAL` に含める列

`PHYSICAL` は「kintone の通常フィールド」だけを意味しない。次を source schema の列として扱う。

- 物理 APP: `getFieldsCached()` が返す field code と、kSQL が既知の system column（少なくとも `$id` / `$revision`）。metadata cache は `cacheContext + appId` 単位で Promise 自体を再利用する（`src/execute.ts:4468-4477`）。
- サブテーブル仮想 source:
  - 子 field code。
  - `_pid` / `_rid` / `_idx`。
  - `_p.<parent-field>`。`_p.` を外した親 field code が APP schema に存在するときだけ一致とする。
  - これらの仮想列は展開時に実際に `_pid` / `_rid` / `_idx` / `_p.<field>` として生成される（`src/converter/subtableAdapter.ts:8-45`）。`_p.<field>` の fetch は親 field、子列と virtual system column の fetch は subtable 本体で満たされる（`src/converter/selectToKintone.ts:389-405,447-458`）。
- CTE / temp source: 実行時 `MaterializedTable.columns` に含まれる列。空結果でも columns は保持される契約である（`src/execute.ts:340-355`）。row の有無で schema を推定しない。

非修飾名が複数 source に存在する場合は ambiguity であり、「最初の table」や flatten 後の後勝ち値を採用しない。現行 `flatten()` は alias 付き source に修飾・非修飾の両キーを作る（`src/engine/process.ts:84-106`）ため、plan は source identity と runtime key を保持し、raw `name` の読み取りへ戻してはならない。

S1/S2/S3/S4 の `区分` はすべて APP schema に存在するため `PHYSICAL` である。SELECT list に `区分` が別用途で現れるか、偶然 records mock が全列を返すかは判定に影響しない。

#### 9.3.2 alias 候補・重複・衝突

- alias 候補は、その SELECT 自身の `SelectColumn` に明示された同名 alias とする。外側 SELECT、CTE 本体の alias、ORDER BY evaluator の map は共有しない。
- `PHYSICAL` が 1 件あれば常にそれを採用する。同名の aggregate alias、safe alias、同名 alias 複数があっても GROUP BY 解決を理由には拒否しない。S1/S2/S4 を守るためである。
- 重複 alias を拒否するのは、物理一致 0 かつ `GROUP BY` がその名前を alias として解決しようとし、候補が 2 件以上のときだけである。GROUP BY が参照しない重複 alias、projection、DISTINCT、HAVING、ORDER BY の現行挙動は変更しない。
- JOIN の非修飾物理列が複数 source に一致する場合は alias 候補の有無にかかわらず既存 ambiguity error。修飾物理名は対応 source がなければ unknown であり、alias fallback しない。
- alias なし集計合成名は「重複 alias」ではなく aggregate-dependent synthetic candidate として拒否する。

推奨エラーは次の reason code を持たせる。表層文言の微修正は許すが、テストは reason code と対象名を固定する。

```text
ArgumentError: GROUP BY alias c depends on aggregate evaluation (reason=GROUP_BY_ALIAS_AGGREGATE).
ArgumentError: GROUP BY alias g is ambiguous across 2 SELECT columns (reason=GROUP_BY_ALIAS_AMBIGUOUS).
ArgumentError: GROUP BY field code is ambiguous across multiple sources (reason=GROUP_BY_FIELD_AMBIGUOUS).
```

### 9.4 pre-group-safe alias classifier

既存 `containsAggregate()` は `AGG_REF` / `AGG_ARITH` を再帰検出し、nested `SELECT` / `SCALAR_SUBQUERY` 境界へ入らない（`src/core/groupingValidation.ts:121-127`）が、`isAggregateMaterializedAlias()` は列種別を `AGGREGATE` / `ARITH_AGG_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` に限定している（同 `:130-137`）。R3 ではこれを次の pure helper へ一般化する。

```ts
type PreGroupAliasClass =
  | "SAFE"
  | "AGGREGATE_DEPENDENT"
  | "POST_GROUP_ONLY";

classifyPreGroupAlias(column: SelectColumn): PreGroupAliasClass
```

判定規則:

1. alias を持つ **全 `SelectColumn`** を同じ再帰 aggregate walker に通す。列種別 allowlist だけで安全とみなさない。
2. `AGGREGATE` / `ARITH_AGG_COL`、または column subtree に `AGG_REF` / `AGG_ARITH` があれば `AGGREGATE_DEPENDENT`。
3. `GROUPING_COL` / `WINDOW_COL` は `POST_GROUP_ONLY`。window + GROUP BY は parser が既に拒否する（`src/parser/parser.ts:1140-1154`）が classifier 側も fail-closed にする。
4. nested `SELECT` / `SCALAR_SUBQUERY` の内部集計は外側 row の aggregate dependency と数えない。scalar subquery alias は SELECT 実行前に解決済み定数として `scalarCache` から評価できる。現行 ORDER evaluator も `SCALAR_SUBQUERY_COL` を column index の cache で評価する（`src/engine/process.ts:830-891`）。
5. `FIELD` / `LITERAL_COL` / `ARITH_COL` / `CASE_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` は、再帰 walker が aggregate node を見つけなければ `SAFE`。
6. `VARIABLE_COL` は batch resolver 後の AST へ残らないことを前提とし、残っていれば internal error。wildcard は alias を持たず候補外。

2026-07-26 の一時 Jest probe で、次がそれぞれ `CASE_COL` / `ARITH_AGG_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` になり、すべて aggregate dependency を持ち得ることを確認した。一時 test file は probe 後に削除済みである。

```sql
CASE WHEN SUM(金額) > 0 THEN 'Y' ELSE 'N' END AS g
SUM(金額) + 1 AS g
FORMAT(SUM(金額), '0') AS g
FORMAT(SUM(金額), '0') || '円' AS g
```

alias evaluator は `buildOrderByAliasEvaluator()` をそのまま流用しない。同関数は aggregate/window/grouping を含む全出力 alias を評価対象にし、同名 alias は `Map.set()` の後勝ちである（`src/engine/process.ts:830-891`）。代わりに、plan が選んだ単一の `SAFE` column だけを `evaluateSelectColumnValue()` と同じ field type / semantics / scalar cache context で評価する。これにより `ARITH_COL` / `CASE_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL` / scalar subquery の評価規則を projection と共有できる（同 `:980-1066`）。

### 9.5 plan の型・作成場所・受け渡し

実装上は、概ね次の情報を持つ immutable plan を導入する。名前は実装時に調整可だが、source identity・group item index・runtime key・alias column index を失ってはならない。

```ts
interface PlainGroupByResolutionPlan {
  readonly items: readonly PlainGroupByResolution[];
}

type PlainGroupByResolution =
  | { kind: "EXPRESSION" }
  | { kind: "PHYSICAL"; sourceIndex: number; fieldCode: string; runtimeKey: string }
  | { kind: "ALIAS_SAFE"; columnIndex: number }
  | { kind: "ALIAS_REJECT"; reason: "AGGREGATE" | "POST_GROUP_ONLY" | "DUPLICATE" }
  | { kind: "UNKNOWN"; name: string }
  | { kind: "DEFERRED"; name: string; reason: string };
```

#### 9.5.1 runtime: SELECT ごとの just-in-time planning

plan は statement 全体の先行 generic walk ではなく、次の 2 入口で source schema が揃った時点に作る。

1. APP だけの通常 SELECT: `executeSelect()` が `cteCache` を受け取った後、field validation と mode 別 fetch の前。現行では `executeSelect()` が planning、ORDER plan、`validateSelectFieldCodes()` を経て実行へ進む（`src/execute.ts:2364-2443`）。
2. CTE/temp source を含む SELECT: `executeFullScanWithCte()` 冒頭で `cteCache` を受け取った後、物理 APP fetch の前。現行もこの関数は `cteCache` を受け、materialized source の存在確認後に APP fetch を始める（`src/execute.ts:3967-4008,4062-4121`）。

CTE 本体は定義順に実行・materialize され、その後の CTE/最終 SELECT に `columns` が渡る（`src/execute.ts:3883-3904`）。temp table は `CREATE TEMP TABLE AS SELECT` の結果 `rows` / `columns` を保存する（同 `:1670-1684`）。したがって runtime では `DEFERRED` を残す必要はない。schema が得られなければ records API 前に internal/planning error とし、`row[name] ?? ""` へ fallback しない。

現行 `validateStatementGroupingPlanning()` は B65 の既存再帰検証のため残してよいが、B71 plain plan をそこへ保存してはならない。特に `CREATE TEMP TABLE AS SELECT` は `runSelectLike()` から `executeQueryWithCte()` へ進み（`src/execute.ts:1670-1684,1730-1742`）、statement-level `validateStatementGroupingPlanning()` を通らない。この経路差は SELECT-local planning で吸収する。

#### 9.5.2 fetch-field converter への受け渡し

`selectToFetchAllFields(stmt, table, plainGroupByPlan?)` のように plan を明示引数で渡す。AST を書き換えたり module-global な current plan を置いたりしない。

- converter の変更は `phase === "groupBy"` の `FIELD_NAME` 処理だけに限定する。`orderBy` / `having` の alias 除外、SELECT/WHERE の field collection は変更しない。現行は 3 phase を一つの条件で除外しているため（`src/converter/selectToKintone.ts:439-445`）、B71 実装では `groupBy` を分離する。
- `PHYSICAL` は plan の source にだけ field を追加する。S3 のように SELECT 式が別 field しか要求しなくても `区分` を追加する。
- `ALIAS_SAFE` は GROUP BY 名を追加しない。alias 元列の dependency は SELECT column walker が既に収集する。
- reject/unknown/deferred plan を runtime converter に渡さない。
- fetch fields は実際には `fetchTableRecordsForFullScan()` 内で計算されるため（`src/execute.ts:4156-4169`）、同じ plan を main/JOIN の全呼び出しへ渡す。EXPLAIN の fields 表示も `selectToFetchAllFields()` を直接呼ぶ（同 `:9250-9290`）ので、後述の explain plan を渡して表示と実行を一致させる。

#### 9.5.3 `applyGroupBy()` への受け渡し

同じ plan を `FullScanInput` に追加し、両方の `runFullScan()` 呼び出しから渡す。現行の通常 FULL_SCAN は `src/execute.ts:3786-3802`、CTE/temp FULL_SCAN は同 `:4125-4145`、consumer は `src/engine/process.ts:1475-1495,1560-1578` である。

`runFullScan()` は plain grouping の場合だけ plan を `applyGroupBy()` へ渡す。`applyGroupBy()` は item index で resolution を参照し、`PHYSICAL` は確定 runtime key、`ALIAS_SAFE` は確定 column index の evaluator を使う。GROUP BY → HAVING → window → DISTINCT → ORDER BY → project という既存順序は変えない（`src/engine/process.ts:1616-1678`）。これにより B59 ORDER BY、projection、DISTINCT の evaluator/precedence は変更されない。

#### 9.5.4 EXPLAIN と deferred materialized schema

EXPLAIN は records API を呼ばないが schema-aware metadata API は使う契約である（`src/mcp/index.ts:139-142`）。現行の explain walker は各 SELECT に対し metadata-backed planning を行う（`src/execute.ts:8392-8430`）。R3 ではこの walker に **materialized schema environment** を渡し、依存順で次を行う。

1. direct APP source は `getFieldsCached()` 相当の traced `getFields` から確定する。
2. CTE は定義順に output schema descriptor を作り、後続 CTE と最終 query へ渡す。UNION の materialized schema は runtime と同じく左 branch の出力列を採る（runtime の remap は `src/execute.ts:3919-3937`）。
3. batch EXPLAIN は文順に temp schema descriptor を追跡する。`CREATE TEMP TABLE AS SELECT` の output schema を後続文へ登録し、DROP で除く。batch 自体も文順に処理している（`src/execute.ts:8797-8858`）。
4. `SELECT *` / `_p.*`、SHOW/DESCRIBE 由来など、records を materialize せず output columns を確定できない source が残る場合、その source と競合し得る group key は `DEFERRED` とする。EXPLAIN は拒否も alias 解決断定もせず、`group key <name>: deferred (materialized schema unavailable)` を表示する。fields 表示も provisional であることを明記する。
5. `DEFERRED` は EXPLAIN 専用であり runtime plan には許可しない。runtime は実体化後の `MaterializedTable.columns` で再 planning する。

これにより EXPLAIN は false rejection を出さず、確定可能な direct APP/既知 materialized schema では実行と同じ `PHYSICAL` / `ALIAS_*` 判定を表示する。

### 9.6 static validation と schema-aware validation の分離

#### schema-free (`analyzeBatch()` / `ksql_validate`)

`analyzeBatch()` は全 query level の `SELECT` に `validateGroupingStatic()` を適用する（`src/core/batch.ts:170-181,196-210`）。ここでは次だけを扱う。

- parser/AST だけで確定する既存 B65 規則（plain GROUP BY での `GROUPING()` 禁止、window 併用禁止等）。
- plan 型の構造検査など、source schema と無関係な invariant。

次は **static では拒否しない**。

- GROUP BY 名と aggregate alias / aggregate synthetic name の一致。
- GROUP BY 名と safe alias の一致。
- 同名 SELECT alias の重複。
- GROUP BY 名と SELECT alias の衝突。
- JOIN の同名物理列 ambiguity。

いずれも同名の物理列が存在すれば `PHYSICAL` が優先されるためである。`ksql_validate` は構文を受理し、必要なら「最終解決は ksql_explain/runtime の schema-aware planning で行う」という既存 tool description の責務を維持する（`src/mcp/index.ts:133-137`）。新たな warning API は Phase1 の必須条件にしない。

#### schema-aware (`ksql_explain` / runtime)

source schema を得た後、次を records API 前に確定・拒否する。

- `PHYSICAL` / `ALIAS_SAFE` / `ALIAS_REJECT` / `ALIAS_AMBIGUOUS` / `UNKNOWN`。
- JOIN ambiguity。
- alias なし aggregate synthetic name。
- fetch source と runtime key。

これが唯一の B71 拒否判断である。static と runtime に同じ alias-name-only 判定を二重実装しない。

### 9.7 metadata API コストと test mock 方針

`getFieldsCached()` は同一 `cacheContext + appId` の Promise を再利用する（`src/execute.ts:4472-4477`）。通常 FULL_SCAN は `validateSelectFieldCodes()` が `selectToFetchAllFields()` の結果に user field を含む APP の `getFieldsCached()` を既に呼ぶ（同 `:2849-2888`）。したがって B71 plan が同 helper を使う場合:

- 通常は **追加 network call 0**。先行/後続の field validation と cache を共有する。
- 従来 `$id` だけを fetch し field validation が metadata を省略していた SELECT では、最悪 **distinct physical APP ごとに 1 回**の `getFields` が新規に必要。
- 行数に比例する call、group key ごとの call、main fetch と JOIN fetch の重複 callは禁止。
- LAPP は Node runtime が logical source を mapped APP に正規化し（`src/node/appProfiles.ts:342-380`）、`getFields` を binding 先 profile/client/physical app へ route する（`src/node/runtime.ts:499-504`）。B71 専用の LAPP resolver や別 cache key を作らない。

`KintoneClient.getFields` は production interface の一部である（`src/execute.ts:251-260,4472-4477`）。既存 test mock に `getFields` が欠けている場合、空 schema fallback で correctness を弱めず、影響する mock に `async getFields() { return [...] }` を追加する。特に GROUP BY 実行 test は、実クエリが要求した `fields` だけを records から返す mock と組み合わせる。

### 9.8 nested SELECT 5 経路

B71 plan は「トップレベル statement の prewalk」ではなく「実際に SELECT を実行/説明する入口」に置くため、次を同じ意味論で処理する。

1. **CTE body**: CTE は定義順に `executeQueryWithCte()` で実行される（`src/execute.ts:3883-3904`）。
2. **UNION branches**: 通常 UNION は両 branch の `executeSelect()`、CTE-aware UNION は各 branch の `executeQueryWithCte()` へ再帰する（`src/execute.ts:3819-3825,3919-3923`）。
3. **scalar subquery body**: `runSubquery()` が CTE cache の有無に応じて `executeQueryWithCte()` / `executeSelect()` へ渡す（`src/execute.ts:8219-8232`）。
4. **DML source SELECT**: `materializeDmlSource()` が SELECT/CTE source を `executeSelect()` / `executeQueryWithCte()` で materialize する（`src/execute.ts:6565-6596`）。
5. **CREATE TEMP TABLE AS SELECT**: `runSelectLike()` → `executeQueryWithCte()` / `executeWith()`（`src/execute.ts:1670-1684,1730-1742`）。この経路は statement-level `validateStatementGroupingPlanning()` を通らないため、SELECT-local planning が必須である。

各経路で alias resolution plan は SELECT ごとに独立し、外側 SELECT の alias map や schema を混ぜない。

### 9.9 B65・他機能との境界

B65 ROLLUP / GROUPING SETS は Phase1 の対象外とする。

- `normalizeGroupingSpec()` が B65 を `GROUPING_SETS`、plain GROUP BY を `PLAIN` として分離し、`runFullScan()` は前者を `applyGroupingSets()`、後者を `applyGroupBy()` へ送る（`src/engine/process.ts:1616-1636`）。
- `applyGroupingSets()` は `ResolvedGroupingSpec` を消費する別実装であり（`src/engine/process.ts:300-320`）、plain の `evalGroupByKey()` を使わない。
- B71 plan は `grouping.type === "PLAIN"` のときだけ作成・注入する。B65 の physical-field-only 規則、alias 拒否、candidate/output guard、EXPLAIN 表示を変えない。

同様に HAVING、B59 ORDER BY、projection、DISTINCT、KORDER planner の precedence/結果は変更しない。converter の修正を `phase === "groupBy"` に限定し、engine の evaluator を plain group stage にだけ注入することがこの境界の実装条件である。

### 9.10 実装 Step（各 Step 単独 merge で安全）

R3 は **開発上の staging を推奨**する。ただし Step 2 を単独リリースすることは必須ではなく、通常は Step 1〜4 を連続 merge して一つの minor release にする。各 Step は、単独 merge した状態でも silent wrong result を新たに増やさない。

| Step | 変更 | merge 時の公開挙動 | 見積 |
|---|---|---|---:|
| 1. pure foundation | `PlainGroupByResolutionPlan`、source schema resolver、全 `SelectColumn` 対象 classifier、output-name helper の共通化を追加。未配線。unit test と一時 probe 相当の恒久 test を追加 | **完全不変**。未配線なので結果変更なし | 1.5〜2.0 人日 |
| 2. schema-aware fail-closed | SELECT-local JIT plan、EXPLAIN deferred env、`PHYSICAL` fetch 反映、plan threading を追加。`PHYSICAL` は従来評価、alias-only は safe/aggregate を問わず一時的に明示拒否。S1/S2/S3/S4、JOIN ambiguity、nested 5 経路、fields-respecting mock test を同時追加 | S1/S2/S4 は不変、S3 は正しい physical grouping。A1〜A4/A2/A3/B3 は「誤りまたは偶然正しい1 group」から明示エラー、B1/合成名も明示エラー。**誤結果を返さない安全な中間状態** | 3.0〜4.0 人日 |
| 3. safe alias resolution | `ALIAS_SAFE` の evaluator を `applyGroupBy()` に有効化。`ALIAS_REJECT` / duplicate / unknown は拒否を維持。A1〜A4/A2/A3/B3、CASE、scalar concat、複数 key、nested 5 経路の positive test を追加 | オーナー決定の最終意味論。safe alias は正しく解決、aggregate-dependent alias は明示拒否 | 2.0〜3.0 人日 |
| 4. non-regression / docs / release | fetched-fields snapshot、DISTINCT、B59 ORDER BY、KORDER、subtable virtual columns、CTE/temp、LAPP routing、B65、CLI/MCP/plugin surface、CHANGELOG/言語 reference を検証・更新 | 意味論は Step 3 と同じ。release gate を閉じる | 1.5〜2.5 人日 |

Step 1 は未配線、Step 2 は fail-closed、Step 3 は classifier が `SAFE` と証明した alias だけを開くため、どの Step も「未解決名を `""` にして結果を返す」状態を作らない。総見積は **8〜11.5 人日**。

別 release として Step 2 の rejection-only 状態を公開することは可能だが、A4/B3 のように現在偶然正しい query も一時的に拒否するため推奨しない。推奨は **merge 単位だけを分け、Step 1〜4 を同一 minor に同梱**することである。

### 9.11 受入条件

#### 9.11.1 必須 mock 契約

- records mock は request の `fields` を尊重し、指定外 field を返さない。全 field を常時返す mock だけで B71 を合格にしてはならない。
- `getFields` mock は APP ごとの実在 field を返す。欠落 mock を空 schema fallback で通さない。
- spy で `getRecords` の fields と `getFields` call count を検証する。S3 では `区分` が追加 fetch されること、通常 cache hit では metadata network call が増えないことを固定する。

#### 9.11.2 正例・shadow

- S1/S2/S4 は結果と fetched fields が不変。
- S3 は `区分` を fetch し実列で 2 groups。
- A1 `DATE_FORMAT(...) AS 年月`、A2 `区分 AS g`、A3 `金額*2 AS m`、literal、CASE、string function、scalar concat、scalar subquery alias が direct expression と同じ group/result。
- 複数 group key で `PHYSICAL` / `ALIAS_SAFE` / direct expression を混在できる。
- 空セルまたは plan 済み physical key 欠落は従来どおり `""` group に入る。
- subtable の子列、`_pid`、`_rid`、`_idx`、`_p.<親field>` が alias shadow より優先され、必要な親 field/subtable 本体が fetch される。
- CTE/temp の materialized column が同名 alias より優先される。空 materialized result でも `columns` により同じ判定になる。

#### 9.11.3 拒否

- `COUNT` / `SUM` / `AVG` / `MIN` / `MAX` / `GROUP_CONCAT` / statistical aggregate / `MODE` 等の aggregate alias。
- `ARITH_AGG_COL`、集計を内包する `CASE_COL` / `STRFUNC_COL` / `SCALAR_VALUE_COL`、alias なし aggregate synthetic name。
- `GROUPING_COL`、既存 parser が到達を許す場合の window alias。
- 物理一致 0 で GROUP BY 対象になった重複 alias。
- JOIN の非修飾 physical ambiguity、unknown field。
- いずれも records API call 0 で reason code を伴う。

#### 9.11.4 narrow ambiguity 非回帰

- 重複 alias があっても GROUP BY がその名を参照しなければ新規拒否しない。
- 重複 alias と同名の physical field が 1 source にあれば `PHYSICAL` として受理。
- GROUP BY の変更により ORDER BY の alias 後勝ち、projection key、DISTINCT tuple を変更しない。ORDER BY evaluator の現行適用位置は DISTINCT 後、project 前である（`src/engine/process.ts:1645-1678`）。
- qualified GROUP BY field は SELECT alias に fallback しない。

#### 9.11.5 経路・surface 非回帰

- CTE body、UNION の左右 branch、scalar subquery body、DML source SELECT、CREATE TEMP TABLE AS SELECT の 5 経路で positive/reject/shadow を少なくとも 1 件ずつ確認。
- EXPLAIN direct APP は runtime と同じ resolution/fetch fields を表示し、materialized schema 不明時は `DEFERRED` を表示して false rejection しない。runtime は同じ query を materialize 後に最終判定する。
- fetched-fields の既存 converter snapshot、DISTINCT、B59 ORDER BY、KORDER（受理/拒否を含む既存契約）、subtable、LAPP/profile routing、B65 ROLLUP/GROUPING SETS の全 regression test。
- `ksql_validate` は S1〜S4、safe alias、aggregate alias、重複 alias を schema-free な名前一致だけで拒否せず、`ksql_explain` / runtime が最終判定する。
- 全 Jest、build、MCP smoke、CLI/plugin の該当 smoke が green。

### 9.12 SemVer・リリース判断

**minor** とする。alias-only query は silent wrong result から正しい result へ変わり、S3 は取得列と grouping 結果が変わる。これは B59 が `ORDER BY alias` の wrong result を修正して v3.13.0 minor で出した前例と同種である（`docs/internal/ksql_b59_orderby_alias_fix_spec.md:1-7`）。

CHANGELOG と言語 reference には次を明記する。

- GROUP BY は source column (`PHYSICAL`) 優先、存在しない場合だけ SELECT alias。
- aggregate-dependent alias / duplicate alias resolution / ambiguous physical column は error。
- 従来 alias-only GROUP BY が返した 1 group は誤結果であり、結果が変わる。
- B65 ROLLUP/GROUPING SETS は対象外で physical-field-only のまま。

### 9.13 残るオーナー判断

意味論上の blocker はない。オーナー決定「alias を解決する」は R3 の最終状態に反映済みである。

残る非 blocking の release 選択は、Step 2 の rejection-only 中間状態を別 release で出すかどうかだけである。R3 の推奨は **別 release にせず、Step 1〜4 を監査可能な merge 単位として分けつつ同一 minor に同梱**すること。理由は、Step 2 は安全ではあるが A4/B3 のような現在結果が偶然正しい alias query まで一時拒否するためである。
