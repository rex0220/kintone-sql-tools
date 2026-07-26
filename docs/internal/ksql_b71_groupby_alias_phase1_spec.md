# B71 Phase1 — `GROUP BY` のエイリアス解決 仕様

- 作成日: 2026-07-26
- ステータス: **仕様 R2 確定＝実装着手可能**（2026-07-26）。R1（Claude 起草・プローブ）→ **codex レビューで「R1 はそのまま実装不可」判定** → Claude が実コードとプローブで全数裏取り → **§8 が R2**。オーナー方針＝**alias 解決**（MySQL 互換・Pro 要望の推奨案）は維持。**⚠ §2〜§4 は R1 本文であり、§8（R2）が上書き・訂正する**（特に §2 の C1 と §2.1-1 は**誤り**＝§8.1 参照）。次＝§8.8 の Step 1 から実装。
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
