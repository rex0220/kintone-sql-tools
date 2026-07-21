# B56 仕様 — 統計集約関数（STDDEV_POP / STDDEV_SAMP / VAR_POP / VAR_SAMP / MEDIAN）

- ステータス: 🚧 **実装済み・CLI 実機 PASS・リリース待ち（2026-07-22・codex 実装→Claude コードレビュー承認・全 2,769 テスト green・mcp:smoke/pack-smoke ok・[実機証跡](evidence/b56_statistical_aggregates_smoke.md)＝統計6値の外部照合一致・全9ケース PASS）**。仕様 R2.1（ユーザー承認済＝R2-Q1 空文字規約 / R2-Q2 ArgumentError 規約・§10 の主要 RDB 前例調査が根拠）
- 起票: [B56 issue](ksql_b56_statistical_aggregates_issue.md)
- 種別: 改善（集計関数の拡充）／SemVer: **minor**（純追加・既存挙動不変）
- 関連: B55（MCP 全量関数カタログ同期）／B14（型メタ）／B9（厳密10進・本機能は binary64）／B30（完全入力 fail-closed の前例）
- R1→R2 の主な変更（codex レビュー全9項目反映・Claude がコードで裏取り一致確認）: `*` 拒否 2 箇所化・HAVING 制約の明文化・truncate 契約を B30 整合へ・completeInputReasons 分離・統計集約の再帰検出 walker・非数値入力 ArgumentError 化・未定義統計量=空文字・型メタ第5経路（`SET @var`）・合成名 regex / CHECK regex 同期・誤差基準修正

## 1. 目的

ばらつき・分布の統計量（標準偏差・分散・中央値）をエンジン側で集計し、MCP クライアント（Claude Desktop 等）の分析用途で生データ全件転送を不要にする。

## 2. スコープ

### 2.1 追加する関数（5つ）

| 関数 | 定義 | 計算 |
|---|---|---|
| `VAR_POP(x)` | 母集団分散 | Welford 単一パス・`m2/n` |
| `VAR_SAMP(x)` | 標本分散 | `m2/(n-1)` |
| `STDDEV_POP(x)` | 母集団標準偏差 | `SQRT(VAR_POP)` |
| `STDDEV_SAMP(x)` | 標本標準偏差 | `SQRT(VAR_SAMP)` |
| `MEDIAN(x)` | 中央値 | 全値保持・数値昇順ソート・奇数件=中央値・偶数件=中央2値の binary64 平均 |

浮動小数点誤差対策: Welford の分散は最終段で `max(0, v)` に丸める（近接値で微小負になり得るため）。

### 2.2 追加しないもの（明示）

- **無印 `STDDEV` / `VARIANCE`**: 追加しない。MySQL（母集団）と SQL Server（標本）で意味が割れており、無印を提供すると either の利用者が静かに誤る。集計として認識されず未消費トークンで ParseError になる（parser.ts:318・codex 裏取り済）。B55 カタログ・言語リファレンスに「**無印は別名ではなく非対応**」と明記する。
- **`PERCENTILE_CONT`**: 対象外（`WITHIN GROUP` 構文の導入コストが大きい。実需が出たら別課題）。
- **ウィンドウ形 `STDDEV_POP(...) OVER (...)`**: 非対応。現行構造では集計として閉じた後の `OVER` が未消費トークンとなり **ParseError になる**（専用メッセージは出さない＝現行の未消費トークンエラーのまま。受入テストで固定）。

## 3. 構文

```sql
SELECT STDDEV_POP(金額) AS sd, MEDIAN(金額) AS med FROM APP100 GROUP BY 部署
SELECT VAR_SAMP(金額 * 1.1) AS v FROM APP100          -- 式引数可
SELECT MEDIAN(DISTINCT 金額) AS m FROM APP100          -- DISTINCT 可
```

- 引数は既存集計と同じ `parseArithAddSub` 経由（フィールド・算術式・関数呼び出し）。**厳密に 1 引数**。
- **`*` は ParseError。拒否分岐は 2 箇所**（SELECT 側 `parseAggregateRef`＝parser.ts:1818 と **HAVING 側 `parseFieldValue`＝parser.ts:2170**。HAVING は集計引数を別実装でパースしており片側だけでは `HAVING MEDIAN(*) > 0` が通る）。`aggregateAcceptsWildcard(func)` 相当の共通 helper に集約する。
- `DISTINCT` 可。**統計 5 関数の重複除去は Number 化後の数値同値単位**（`"1"` と `"01"` は同値）。既存 6 集計の文字列単位 DISTINCT（process.ts:347）は**不変**。差分は言語リファレンスに明記（`1, 01, 10` の MEDIAN が単位の取り方で変わるため）。
- **HAVING の制約（現行構造の明文化）**: HAVING 内の直接集計参照は**同じ集計が SELECT 列にも存在する場合に限り**機能する（GROUP BY 段階で計算されるのは `stmt.columns` の集計のみ＝process.ts:275。HAVING は集計済み行への評価＝process.ts:430）。新 5 関数もこの制約に従う。HAVING 専用集計の追加計算は**本件のスコープ外**（構文拡張なし）。式引数の統計量は SELECT の alias 参照で書く。
- 使用可能位置: SELECT 列・HAVING（上記制約下）・（alias 経由で）ORDER BY。WHERE 内は既存集計と同じく不可。

## 4. 意味論

### 4.1 入力規約（収集は SUM/AVG と同一・数値化はより厳格）

値の収集は `process.ts:329-348` の既存経路を共有する（単純フィールド参照=空文字のみスキップ・算術式=NaN スキップ・非空値を保持）。その後の数値化が既存と異なる:

- **統計 5 関数は、収集済みの値に Number 変換不能（NaN）または非有限（±Infinity）が含まれる場合、実行時 `ArgumentError`**（関数名・当該値をメッセージに含める）。SUM/AVG の「NaN が静かに結果へ伝播する」挙動は踏襲しない。
- 根拠: 統計量の主対象は NUMBER / 数値 CALC で、kintone の NUMBER フィールドに非数値は入らない。汚染が起きるのは temp/CTE・テキスト列への誤適用であり、**静かな NaN より fail-closed（kSQL 原則・B30/B32 前例）**が適切。分析クエリで NaN 文字列が返っても MCP クライアントは数値処理できない（codex 指摘採用）。
- この判定により MEDIAN のソート汚染（NaN 比較で入力順依存の誤中央値）も構造的に発生しない。
- 既存 SUM/AVG の挙動は**変更しない**（後方互換）。

### 4.2 出力規約

- 戻り値は JS number（binary64）。既存 SUM/AVG と同じ経路で文字列化。
- **B9 厳密10進の対象外**（平方根・除算を含むため binary64 で閉じる）。言語リファレンスの算術精度注記（IEEE754）へ追記。
- 外部照合の受入基準（0 付近でも判定可能な複合基準）: `abs(actual − expected) <= 1e-12 + 1e-9 * abs(expected)`。`MEDIAN` の中央値選択は完全一致、偶数件平均は binary64 一致。

### 4.3 定義できない統計量＝空文字（kintone 空セル相当）

| 状況 | 値 |
|---|---|
| 0 件（GROUP BY なしの 1 行返却含む）× 5 関数 | `""`（空文字） |
| `VAR_SAMP` / `STDDEV_SAMP` の 1 件（n−1=0） | `""`（空文字） |
| `VAR_POP` / `STDDEV_POP` / `MEDIAN` の 1 件 | 定義どおり（分散 0・中央値=その値） |

- 方針: **数学的に定義できない統計量は「値なし」＝空文字**で表す。kSQL に NULL 出力概念はなく、空文字は kintone の空セル（NUMBER フィールドの未入力）と同型で、v3 canonical band でも空セルとして扱われる。
- R1 の「0 を返す」案は**撤回**（`SUM`/`AVG` の 0 件=0 は既存前例として不変だが、「標本分散 0」は誤った分析値＝偽値であり §4.1 の fail-closed 方針と矛盾するため。codex 指摘採用）。クエリを落とさない（`ArgumentError` にしない）のは、singleton グループはデータ品質問題ではなく正常な分布だから。
- `SET @v = (SELECT STDDEV_SAMP(...))` で空文字が返る場合は既存の `Number.isFinite` ガード（execute.ts:1469）により文字列変数になる＝安全側。

### 4.4 完全入力契約（B30 整合）

統計 5 関数を含む文は**完全入力必須**とする。契約は B30 と同一構造:

- `onLimit=truncate` 指定時は**実効モードを `error` に差し替える**（execute.ts:2274-2277 の既存機構）。取得件数が `maxRecords` 以内なら成功し、**上限到達時に `FetchAllLimitError`**。部分集合の統計値は返さない。「実行前エラー」ではない（R1 の記述を訂正）。
- **検出は再帰 walker**: 直接の `AGGREGATE` 列だけでなく、`ARITH_AGG_COL` 内の `AGG_REF`・`STRFUNC_COL` 内の集計・`SCALAR_VALUE_COL` 内の集計・HAVING・CTE・UNION 各枝・スカラーサブクエリを検査し、**統計 5 関数を含むか**を判定する（selectToKintone.ts:74 の集計内包形の列挙と同じ範囲）。
- **理由の分離**: `requiresCompleteInput` の boolean を `completeInputReasons(stmt): Set<"LOCAL_ORDER" | "WINDOW_ORDER" | "STATISTICAL_AGGREGATE" | ...>` へ拡張し、実行時エラーと EXPLAIN で共有する。現行の `FetchAllLimitError` メッセージは「ORDER BY の正しい結果には〜」**固定**（execute.ts:2296）のため、統計起因の場合に理由が誤表示になる問題を同時に解消する。
- 既存 `SUM`/`AVG` 等の truncate 契約は**互換性のため変更しない**。新規統計関数では正確性を初期契約とし、既存集計の完全入力化は別課題とする（新旧非対称は意図的・仕様に明記）。

### 4.5 型メタ（明示 2 経路＋既定分岐 2 経路＋第 5 経路）

新 5 関数の結果は数値型（§4.3 の空文字は「数値型列の空セル」として整合）。

| 経路 | 対応 |
|---|---|
| materialized 列メタ（execute.ts:3112・COUNT/SUM/AVG 明示列挙） | **明示追加** |
| ORDER BY 用型推論（process.ts:1118 の明示列挙） | **明示追加** |
| HAVING alias 型推論（execute.ts:2149・「GROUP_CONCAT 以外は number」） | 既定分岐で乗る＝**非回帰確認** |
| alias 型推論の別経路（execute.ts:4209・同上） | 既定分岐で乗る＝**非回帰確認** |
| **`SET @var = (SELECT ...)` のスカラーサブクエリ型判定（execute.ts:1462-1471・COUNT/SUM/AVG のみ number）** | **明示追加**（漏れると統計結果が文字列変数になる・codex 指摘） |

temp/CTE 経由の再集計・ORDER BY・`SET @var` 後段利用で数値比較になることを受入条件に含める。

## 5. 実行計画・EXPLAIN

- 統計集約を含む SELECT は既存集計と同じく **FULL_SCAN**（selectToKintone.ts:74 の AGGREGATE 分岐に自然に乗る・codex 裏取り済）。押し下げなし・常にローカル計算。
- EXPLAIN: `completeInputReasons` を共有し、次を表示する:

```text
complete input: required
complete input reason: STATISTICAL_AGGREGATE
onLimit=truncate: disabled
```

- **constant-false WHERE の EXPLAIN**（execute.ts:8499 で完全入力表示前に return する経路）: records API を使用しないため完全入力契約の表示は**免除**（既存構造のまま・仕様として明記）。

## 6. 予約語

新規予約語 5 語: `STDDEV_POP` / `STDDEV_SAMP` / `VAR_POP` / `VAR_SAMP` / `MEDIAN`。

- 同名フィールドコードはバッククォートで回避（B19 前例の注記を言語リファレンスへ）。
- CHANGELOG で新規予約語を告知（B19 で確立した前例）。

## 7. 同期箇所（実装チェックリスト）

- `src/types/ast.ts`（`AggregateFunc` union へ 5 関数）
- lexer / parser（予約語・`PARSER_AGGREGATE_FUNCTION_TOKEN_MAP`・**`*` 拒否 2 箇所**＝parser.ts:1818/2170 の共通 helper 化・frozen 定数 export）
- `process.ts` evalAggregate（Welford / MEDIAN・§4.1 数値化ガード・§4.3 空文字規約・数値 DISTINCT）
- 完全入力: `completeInputReasons` walker（§4.4）＋ execute.ts:2294-2299 のエラーメッセージ理由別化
- 型メタ 5 経路（§4.5）
- **合成集計名 regex**（selectToKintone.ts:767 `isAggregateSyntheticName`＝6 関数固定列挙→5 関数追加。漏れると HAVING の `MEDIAN(金額)` を物理フィールドとして取得しにいく・codex 指摘）
- **CHECK 内の集計拒否 regex**（dmlCustomCheck.ts:41 の固定列挙→5 関数追加。CHECK に統計集計を書いた際に既存と同じ明示エラーへ）
- EXPLAIN（§5）
- 言語リファレンス §集計関数表（無印非対応・DISTINCT 単位差・空文字規約・HAVING 制約）＋算術精度注記＋予約語注記
- **B55 MCP instructions 全量関数カタログ**（aggregate 6→11・語数 guard 240–280 再実測・「明示形のみ・無印なし」の一文）
- catalog⇔parser⇔fixture 三者 drift guard（`functionCatalog.test.ts`・fixtures）
- `ksql_docs` embed
- mcp-smoke / pack-smoke の instructions 代表語 assertion へ新関数追加（stale bundle 検出）
- `CHANGELOG.md`（新規予約語告知）・`release/README.txt`・版数一式（package.json / package-lock 先頭 2 / prod/manifest.json / release/VERSION.txt＝リリース手順 memo どおり）
- プラグイン `desktop.js` 再ビルド（prod / plugin 両方）＋ 4 面 smoke

## 8. 受入条件

1. **正しさ**: GROUP BY あり/なし × 5 関数で外部計算と全件照合一致（§4.2 の複合誤差基準）。**大オフセット×微小分散**のデータ（Welford 採用理由の実証）・同一値大量入力・偶数/奇数件 MEDIAN を含む。実機データで確認。
2. **未定義値**: §4.3 の表どおり（0 件の 1 行返却・`_SAMP` 1 件=空文字・`_POP`/`MEDIAN` 1 件=定義値）。
3. **入力ガード**: 非数値・±Infinity 混入で ArgumentError（関数名・値つき）。空文字セルのみ→0 件扱い。
4. **構文**: 式引数・`DISTINCT`・`DISTINCT`×式。**SELECT / HAVING 両方**で 5 関数×`*` が ParseError。`... OVER (...)` が ParseError。
5. **DISTINCT 単位**: `"1"` と `"01"` が同値（数値単位）になることを temp/CTE 経由で固定。
6. **HAVING**: SELECT に同じ集計がある場合の直接参照と alias 参照の両方。SELECT にない HAVING 直接参照の現行挙動を固定（新関数で挙動が変わらないこと）。
7. **truncate**: `maxRecords` 以内は truncate 指定でも成功・超過時のみ `FetchAllLimitError`（理由=STATISTICAL_AGGREGATE の文言）。**集計算術式（`STDDEV_POP(x)+1`）・関数内集計（`FORMAT(STDDEV_POP(x),…)`）でも検出**されること。4 面（Node/CLI/MCP/plugin）で同一挙動。
8. **型メタ**: temp/CTE 経由の再集計・ORDER BY が数値比較。`SET @v = (SELECT VAR_POP(...))` が数値変数になり後段で数値利用できる。
9. **EXPLAIN**: §5 の表示。constant-false WHERE では免除。
10. **非回帰**: 既存 6 集計（NaN 伝播・文字列 DISTINCT・truncate 挙動を含めて不変）・全テスト green・B55 drift guard / 語数 guard green。
11. **予約語**: バッククォートで同名フィールド参照可。

## 9. 解決済み論点（2026-07-22・ユーザー承認）

- **R2-Q1: §4.3「未定義統計量=空文字」を採用（確定）**。根拠=§10 前例調査＝主要 4 RDB すべてが空集合・`_SAMP` 1 件で NULL を返す（クエリは落とさない）。kSQL に NULL 出力はなく空文字が NULL 相当。R1 の 0 案は Oracle 無印 `STDDEV` だけの歴史的例外挙動（PostgreSQL は同挙動を 2003 年に誤りとして NULL へ修正）。
- **R2-Q2: §4.1「非数値・非有限は ArgumentError」を採用（確定）**。根拠=§10 前例調査＝PostgreSQL/Oracle/SQL Server の 3/4 がエラー。MySQL のみ 0 へ黙変換（warning）で、これは「静かに誤った統計値」を生む側＝kSQL の fail-closed 原則に反する。

## 10. 前例調査（主要 RDB の実挙動・2026-07-22・Web 裏取り済）

### 10.1 空集合・1 件の返り値

| | 0 件（空集合） | `_SAMP` 系 1 件 | 無印 1 件 |
|---|---|---|---|
| MySQL | NULL（公式マニュアルが 7 関数すべてで明記） | NULL（2 件未満は NULL） | NULL（無印 STD/STDDEV/VARIANCE=**母集団**の方言） |
| PostgreSQL | NULL | NULL（「入力 1 行なら NULL」を明文化） | NULL（無印=**標本**の別名） |
| Oracle | NULL | NULL（`STDDEV_SAMP`） | **0**（無印 `STDDEV` のみ。公式が「`_SAMP` との違いは 1 行で 0 を返すこと」と明記＝歴史的例外） |
| SQL Server | NULL | NULL（`STDEV`=標本） | —（無印なし・STDEV/STDEVP の 2 本立て） |

→ 「定義できない統計量は NULL・クエリは落とさない」が業界標準。kSQL の空文字（kintone 空セル）は NULL と同型。

### 10.2 非数値入力

| | 挙動 |
|---|---|
| MySQL | 暗黙 cast で計算続行（非数値文字列→0・warning のみ）＝唯一の寛容派 |
| PostgreSQL | エラー（型システムが text への適用を拒否・cast 不能値は invalid input syntax） |
| Oracle | 実行時エラー（ORA-01722 invalid number） |
| SQL Server | エラー（STDEV 等は数値型引数のみ） |

### 10.3 その他の裏付け

- **無印を追加しない判断（§2.2）**: MySQL=母集団 vs PostgreSQL/Oracle=標本と、現役 RDB 間で無印の意味が実際に割れている。
- **MEDIAN**: ネイティブ集計を持つのは Oracle のみ（空集合→NULL）。他は `PERCENTILE_CONT` 代替＝kSQL の「MEDIAN 採用・PERCENTILE_CONT 見送り」は Oracle 前例＋構文コスト回避の構成。
- 出典: MySQL 8.4 Reference Manual（aggregate-functions）・Oracle Database SQL Reference（STDDEV）・ORACLE-BASE・PostgreSQL メーリングリスト（2003 年の stddev 1 行=0 修正）。
