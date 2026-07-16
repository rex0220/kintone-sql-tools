# 評価: 主要 RDB（MySQL / Oracle / SQL Server）との SQL 機能比較と欠落機能の追加効果

- 作成日: 2026-07-16
- ステータス: **評価・提案（実装判断前）**
- 目的: kSQL の SQL 機能を主要 RDB と比較し、欠落機能ごとに「kintone 業務での効果 / 実装コスト / kintone 適合性」を評価して優先度を提言する。
- 対象版: v2.14.0
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 前提: kSQL は「kintone REST API + JS 実行エンジン」

比較の妥当性のため前提を明示する。kSQL は RDB ではなく、**kintone REST API へのクエリ変換器＋クライアント側 JS 実行エンジン**である。これが機能ごとの可否を決める:

| 制約 | 帰結 |
|---|---|
| kintone に JOIN・集計・ウィンドウ関数のサーバ実装がない | これらは**全て JS 側で計算**（FULL_SCAN）。→ **「API 制約で不可能」ではなく「実装すれば動く」**ものが多い |
| kintone にトランザクションがない | トランザクション・分離レベル・ロックは**原理的に不可能**（対象外） |
| kintone にサーバ側実行基盤がない | ビュー・ストアドプロシージャ・トリガー・インデックスは**対象外** |
| 全件取得が前提（`maxRecords` 上限） | 計算量が O(N) を超える機能（相関サブクエリ）は**性能設計が必須** |

したがって欠落機能の多くは「やる/やらない」の**費用対効果の判断**であって、技術的な不可能ではない。

## 2. 対応状況マトリクス

凡例: ✅ 対応 / 🔶 部分対応 / ❌ 非対応 / ➖ 対象外（kintone に概念がない）

### 2.1 クエリ（SELECT 系）

| 機能 | MySQL | Oracle | SQL Server | kSQL | 備考 |
|---|:--:|:--:|:--:|:--:|---|
| SELECT / WHERE / DISTINCT / AS | ✅ | ✅ | ✅ | ✅ | |
| INNER / LEFT / RIGHT JOIN | ✅ | ✅ | ✅ | ✅ | **等値結合のみ**（`ON a.x > b.y` 不可） |
| FULL OUTER JOIN | ✅(8.0で無) | ✅ | ✅ | ❌ | MySQL も非対応。LEFT+RIGHT+UNION で代替可 |
| 非等値・範囲結合 | ✅ | ✅ | ✅ | ❌ | |
| CROSS JOIN | ✅ | ✅ | ✅ | ❌ | |
| GROUP BY / HAVING | ✅ | ✅ | ✅ | ✅ | |
| 集計 COUNT/SUM/AVG/MAX/MIN | ✅ | ✅ | ✅ | ✅ | MIN/MAX の文字列・日時は **v2.14.0** で対応 |
| DISTINCT 付き集計 | ✅ | ✅ | ✅ | ✅ | |
| **文字列集約**（GROUP_CONCAT/LISTAGG/STRING_AGG） | ✅ | ✅ | ✅ | ❌ | **後述 T1-2** |
| **ウィンドウ関数**（OVER / PARTITION BY） | ✅ | ✅ | ✅ | ❌ | **後述 T1-1・最大の欠落** |
| ROLLUP / CUBE / GROUPING SETS | ✅ | ✅ | ✅ | ❌ | |
| ORDER BY（式・関数） | ✅ | ✅ | ✅ | ✅ | |
| LIMIT / OFFSET | ✅ | 🔶(FETCH) | 🔶(TOP/FETCH) | ✅ | |
| UNION / UNION ALL | ✅ | ✅ | ✅ | ✅ | |
| INTERSECT / EXCEPT(MINUS) | ✅(8.0) | ✅ | ✅ | ❌ | **後述 T2-2** |
| CTE（WITH・非再帰） | ✅ | ✅ | ✅ | ✅ | |
| 再帰 CTE | ✅ | ✅ | ✅ | ❌ | **後述 T3** |
| 非相関サブクエリ（IN/EXISTS/スカラー） | ✅ | ✅ | ✅ | ✅ | |
| **相関サブクエリ** | ✅ | ✅ | ✅ | ❌ | **後述 T1-3** |
| LATERAL / CROSS APPLY | ✅ | ✅ | ✅ | ❌ | 相関サブクエリの後 |
| PIVOT / UNPIVOT | ❌ | ✅ | ✅ | ❌ | MySQL も非対応 |
| CASE WHEN | ✅ | ✅ | ✅ | ✅ | SELECT/WHERE/UPDATE SET |

### 2.2 スカラー関数

kSQL の実装済み関数（コード確認済み・`src/types/ast.ts:246`）:
`UPPER` `LOWER` `TRIM` `LTRIM` `RTRIM` `LENGTH` `SUBSTRING` `CONCAT` `REPLACE` `COALESCE` `NULLIF` `ISNULL` `ROUND` `FLOOR` `CEIL` `CAST`/`CONVERT` `FORMAT` `YEAR` `MONTH` `DAY` `DATE_FORMAT` `DATEDIFF` `DATE_ADD` `ABS` `MOD` `POWER` `SQRT` `CURRENT_DATE` `CURRENT_TIMESTAMP` ＋ kintone 専用 `TODAY()` `NOW()` `LOGINUSER()`

> **文書漏れ**: `NULLIF` / `ISNULL` は実装済み（`evalFunc.ts:81`）だが**言語リファレンス §5 の関数表に未記載**。→ §6 で対応。

| 分類 | 主要 RDB にあり kSQL にない関数 | 効果 |
|---|---|---|
| 文字列 | `LEFT`/`RIGHT`・`LPAD`/`RPAD`・`INSTR`/`POSITION`/`CHARINDEX`・`REVERSE`・`REPEAT` | 中（`SUBSTRING`/`LENGTH` で代替可だが冗長） |
| 比較 | `GREATEST` / `LEAST` | 中（`CASE WHEN` で代替可） |
| 数値 | `SIGN`・`TRUNC`・`LOG`/`LN`/`EXP` | 小 |
| 日付 | `EXTRACT`・`DATE_SUB`・`LAST_DAY`・`ADD_MONTHS`・`TIMESTAMPDIFF`/`DATEPART` | **中〜大**（月次バッチで `LAST_DAY`・`DATE_SUB` が頻出） |
| 正規表現 | `REGEXP`/`RLIKE`/`REGEXP_LIKE` | 小（`LIKE`/`KLIKE` あり・ReDoS 懸念） |
| JSON | `JSON_EXTRACT` 等 | 小（kintone 側に JSON 列がない） |

### 2.3 更新系（DML）

| 機能 | MySQL | Oracle | SQL Server | kSQL | 備考 |
|---|:--:|:--:|:--:|:--:|---|
| INSERT VALUES / INSERT … SELECT | ✅ | ✅ | ✅ | ✅ | |
| UPDATE / DELETE | ✅ | ✅ | ✅ | ✅ | |
| UPSERT / MERGE | ✅(ON DUP) | ✅(MERGE) | ✅(MERGE) | ✅ | `ON DUPLICATE` で**カバー済み**。MERGE 構文の追加価値は小 |
| UPDATE … JOIN（汎用） | ✅ | 🔶 | ✅ | 🔶 | `UPDATE … FROM` の**単一等値のみ**（v2.12.0/v2.13.0） |
| 一時テーブルへの DML | ✅ | ✅ | ✅ | ❌ | `CREATE TEMP TABLE AS SELECT` のみ |
| トランザクション / ロック | ✅ | ✅ | ✅ | ➖ | **kintone API に無い＝原理的に不可** |
| ビュー / ストアド / トリガー | ✅ | ✅ | ✅ | ➖ | サーバ側実行基盤が無い。保存クエリが擬似ビュー |

### 2.4 kSQL 固有（3大 RDB に無い強み）

比較の公平性のため明記する。これらは kintone 特化で**主要 RDB より優位**:

`KLIKE`（kintone ネイティブ検索）／`VALIDATE ONLY`（書き込み前 Tier 0 検証）／`ON ERROR SKIP INTO #err`（行単位エラー隔離）／`REORDER`／サブテーブル仮想テーブル（`APP100$明細`）／`LAPP_<NAME>` 論理アプリ参照／`ASSERT`／`DECLARE`/`SET @var`／`EXPLAIN`（no-API）

## 3. 欠落機能の効果評価

評価軸: **効果**（kintone 業務価値）／**コスト**（実装規模）／**適合性**（kintone 制約下で成立するか）

### Tier 1: 追加価値が大きい

#### T1-1. ウィンドウ関数（`ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / 集計 `OVER`）— **最大の欠落**

- **効果: 大**。kintone 業務の定番「**顧客ごとの最新1件**」「ランキング」「累計」「前月比」が書けない。
  > **訂正（2026-07-16・実機確認）**: 当初ここに書いた `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (…) rn FROM APP300) WHERE rn = 1` は**動かない**。**kSQL は派生テーブル `FROM (SELECT …)` に非対応**（実測 `ParseError`）。ただし **`WITH` CTE で 1 文になる**（下記・実測で動作確認済み）ので、**「1 文」という評価自体は正しい**（書き方が違うだけ）。
  >
  > **効果の評価はむしろ上方修正**される。`MAX()` 方式が「最新行の他列を取れない」のは**回避不能**だと確認できた: 派生テーブルが無く、かつ **JOIN が複合キー結合に非対応**（実測: `ON a.k = t.k AND a.d = t.max_d` は `ParseError`）なため、`(グループキー, 最大値)` で元行へ結合し直す手段が無い。つまり「**各グループの最新 1 件を全列付きで取得する**」は**現状の kSQL では表現できない**。B17 はこれを初めて可能にする（＝「3文→1文」ではなく「**不可能→可能**」）。詳細は [B17 仕様 §0](ksql_window_function_spec.md)。

  ```sql
  -- 現状: グループキーと最大値しか取れない（その行の金額等は取得不能）
  CREATE TEMP TABLE #latest AS SELECT 顧客ID, MAX(受注日) AS 最新受注日 FROM APP300 GROUP BY 顧客ID;
  SELECT a.顧客名, t.最新受注日 FROM APP100 a INNER JOIN #latest t ON a.顧客ID = t.顧客ID;

  -- B17 後（CTE で 1 文）: 最新行の全列が取れる
  WITH ranked AS (
    SELECT 顧客ID, 受注日, 金額, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300
  )
  SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn = 1;
  ```
- **コスト: 中**。全て JS 側の計算で完結し、API 追加なし。既存 `applyGroupBy`（`src/engine/process.ts`）の隣に partition → sort → 採番の実装を足す形。パーサに `OVER (PARTITION BY … ORDER BY …)` を追加。
- **適合性: 高**。FULL_SCAN 前提と完全に整合（既に全件 JS 保持）。ソート種別は **v2.14.0 の `AggregateSortKindResolver` を再利用可能**（`ORDER BY` の型判定と同じ問題）。
- **推奨: 最優先**。ただし**サブセットから**（`ROW_NUMBER`/`RANK`/`DENSE_RANK` + `PARTITION BY`/`ORDER BY` のみ。フレーム句 `ROWS BETWEEN` は第2段）。「各グループ最新1件」が取れるだけで価値の大半を回収できる。

#### T1-2. 文字列集約（`GROUP_CONCAT` / `STRING_AGG` / `LISTAGG`）

- **効果: 大**。1対多の集約表示（「顧客ごとの担当者一覧」「明細の商品名連結」）を可能にする。**B12 の `#err` メッセージ集約の本命**でもある（`MIN($err_message)` で代用しようとして v2.13.0 で NaN 化が発覚したのが B13 の発端＝[B13 spec §7](ksql_string_min_max_aggregate_spec.md)）。B16 実装前の回避策は `DISTINCT` + 定数フラグで**具体的メッセージを捨てていた**。
- **コスト: 小**。`evalAggregate`（process.ts:280）に集約関数を1つ足すだけ。区切り文字・`DISTINCT` は既存の集約基盤に乗る。返り値 `number|string` 化は **v2.14.0 で完了済み**＝**下地ができている**。
- **適合性: 高**。
- **推奨: 高**。**T1-1 より安い**ので先に入れる価値あり。
  > **訂正（2026-07-16）**: 当初「B14（temp 列型メタ）が前提」としていたが**誤り**。`evalAggregate` は各行の値を**生の文字列として収集**するため（[process.ts:293](../../src/engine/process.ts#L293)）、`GROUP_CONCAT` は `join` するだけで**型メタを参照しない**。`MIN`/`MAX` が型メタを要したのは「数値順か辞書順か」の判断があったからで、連結にはそれが無い。**B14 と B16 は独立**しており、`GROUP_CONCAT` は B14 なしでも `#err` を含む一時テーブルで動く。詳細は [B16 仕様 §0](ksql_group_concat_spec.md)。

#### T1-3. 相関サブクエリ

- **効果: 大**。`WHERE EXISTS (SELECT 1 FROM b WHERE b.key = a.key)` 形が書けない。差分検出・親子突合の表現力が上がる。
- **コスト: 大**。**性能設計が本体**。素直に実装すると外側 N 行 × 内側クエリ = N 回評価＝ API 呼び出し爆発。実用には「内側を一度実体化してハッシュ結合へ書き換える」最適化（= 実質 semi-join 化）が要る。
- **適合性: 中**。上記の書き換えが効く形（等値相関）に**限定すれば**成立する。任意の相関は FULL_SCAN でも重い。
- **推奨: 条件付き**。**等値相関のみを semi-join へ落とす限定実装**なら価値あり。ただし `IN (SELECT)` / `NOT IN (SELECT)` で大半は代替でき、費用対効果は T1-1/T1-2 に劣る。**後回し**。

### Tier 2: 中程度

#### T2-1. 日付関数の拡充（`LAST_DAY` / `DATE_SUB` / `EXTRACT` / `ADD_MONTHS` / `TIMESTAMPDIFF`）

- **効果: 中〜大**。月次バッチで「先月末日」「N日前」が頻出。現在 `DATE_ADD(x, INTERVAL -1 DAY)` で代替できるが `LAST_DAY` 相当は式が煩雑。バッチ変数（`DECLARE @since`）との相性も良い。
- **コスト: 小**。既存 `evalFunc.ts` に足すだけ。
- **推奨: 高（低コスト・確実）**。まとめて 1 リリースに束ねるのが効率的。

#### T2-2. `INTERSECT` / `EXCEPT`

- **効果: 中**。差分バッチの「A にあって B にない」が素直に書ける。ただし **`NOT IN (SELECT)` でほぼ代替可能**。
- **コスト: 小**。`UNION` の実装基盤（FULL_SCAN・列数検証）にセット演算を足すだけ。
- **推奨: 中**。安いので T2-1 と同梱候補。

#### T2-3. `FULL OUTER JOIN`

- **効果: 中**。両側の欠落を1文で検出（マスタ照合）。`LEFT` + `RIGHT` + `UNION` で代替可。**MySQL も非対応**なので「3大 RDB の標準」とまでは言えない。
- **コスト: 小〜中**。`applyJoin` に片側未マッチ行の合成を足す。
- **推奨: 中**。

#### T2-4. スカラー関数の拡充（`GREATEST`/`LEAST`・`LEFT`/`RIGHT`・`LPAD`/`RPAD`・`INSTR`）

- **効果: 中**（個別は小、積み上げで効く）／**コスト: 小**／**推奨: 中**。T2-1 と同梱。

### Tier 3: 低優先・対象外

| 機能 | 判定 | 理由 |
|---|---|---|
| 再帰 CTE | 低 | 組織階層・部品表は kintone では稀。コスト中・効果小 |
| ROLLUP / CUBE / GROUPING SETS | 低 | kintone 標準の集計画面と用途が重複 |
| PIVOT / UNPIVOT | 低 | 同上。MySQL も非対応 |
| `MERGE` 構文 | 不要 | `UPSERT … ON DUPLICATE` で**カバー済み**。構文追加の価値なし |
| 非等値・範囲 JOIN | 低 | JS では実装可能だが O(N×M)。需要が立証されてから |
| `REGEXP` | 低 | `LIKE`/`KLIKE` あり。ReDoS リスクを負う価値が薄い |
| CROSS JOIN | 低 | 需要が乏しく、事故（デカルト積）リスク |
| 一時テーブルへの DML | 低 | `CREATE TEMP TABLE AS SELECT` の再作成で代替 |
| **トランザクション / ロック** | **対象外** | kintone API に無い＝**原理的に不可能**（文書化済み） |
| **ビュー / ストアド / トリガー / インデックス** | **対象外** | サーバ側実行基盤が無い。保存クエリ（B4 `:name`）が擬似ビュー |

## 4. 提言（優先順）

| 順 | 機能 | 効果 | コスト | 根拠 |
|---|---|:--:|:--:|---|
| 1 | **文字列集約 `GROUP_CONCAT`** | 大 | 小 | 最良の費用対効果。B12 看板レシピの本命。v2.14.0 で `number\|string` 化済み＝下地あり。B14 とは独立 |
| 2 | **ウィンドウ関数サブセット**（`ROW_NUMBER`/`RANK`/`DENSE_RANK` + `PARTITION BY`/`ORDER BY`） | 大 | 中 | 最大の欠落。「各グループ最新1件」を1文化。`MAX()` 回避策は他列を取れず真の代替になっていない。v2.14.0 の型解決を再利用可 |
| 3 | **関数拡充バンドル**（日付 `LAST_DAY`/`DATE_SUB`/`EXTRACT` ＋ `GREATEST`/`LEAST`/`LEFT`/`RIGHT`/`INSTR`） | 中 | 小 | 低コスト・確実。1リリースに束ねる |
| 4 | `INTERSECT` / `EXCEPT` ＋ `FULL OUTER JOIN` | 中 | 小〜中 | 差分バッチの表現力。代替手段はあるが安い |
| 5 | 相関サブクエリ（等値相関→semi-join 限定） | 大 | 大 | 性能設計が本体。`IN (SELECT)` で大半代替可のため後回し |

### 既存バックログとの関係

- **B14（temp/CTE 列の型メタ伝播）と B16 は独立**（当初「B14 が前提」としていたのは誤り。→ [B16 仕様 §0](ksql_group_concat_spec.md)）。B14 は `#err` を含む temp 列の `MIN`/`MAX` を正しくする価値、B16 は連結そのものの価値で、**どちらの順でも単独で成果が出る**。同じ集約領域なので 1 リリースに束ねるのは**利便性の理由としては妥当**。
- 2（ウィンドウ関数）は B14 と独立して着手可能（実アプリ列で価値が出る）。
- 3〜4 は他と独立。

## 5. 結論

- kSQL の欠落で**業務価値が大きいのは 2 つ**: **ウィンドウ関数**と**文字列集約**。いずれも kintone API 制約ではなく「未実装」であり、FULL_SCAN 前提と整合するため**技術的障害はない**。
- 逆に**トランザクション・ビュー・ストアド系は原理的に対象外**であり、比較上の「欠落」として扱うべきでない。
- `MERGE`・PIVOT・ROLLUP は kintone 側機能や既存構文でカバー済み/代替可であり、追加価値は小さい。
- kSQL は kintone 特化機能（`KLIKE`・`VALIDATE ONLY`・`ON ERROR SKIP`・サブテーブル仮想テーブル・`ASSERT`）で主要 RDB に無い価値を持つ。**汎用 SQL 機能の網羅より、バッチ実務の完成度（B12・B14・GROUP_CONCAT）を優先する方が費用対効果が高い**。

## 6. 副次: 文書の是正（本評価で発見）

- `NULLIF` / `ISNULL` が実装済み（`src/engine/evalFunc.ts:81`・`src/types/ast.ts:249`）なのに**言語リファレンス §5 の関数表に未記載**。利用者が使えると気づけないため追記する。
