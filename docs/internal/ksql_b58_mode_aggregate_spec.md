# B58 仕様 — MODE 集約関数（最頻値・カテゴリデータ対応）

- ステータス: ✅ **v3.13.0 リリース済み（2026-07-22・release PR #210・tag/GitHub Release 公開・npm publish 待ち）。実装済み・CLI 実機 PASS・リリース待ち（2026-07-22・codex 実装→Claude コードレビュー承認・全 2,784 テスト green・mcp:smoke/pack-smoke ok・[実機証跡](evidence/b58_mode_aggregate_smoke.md)＝実データでタイ決定性含む全 10 ケース PASS）**。仕様 R2（codex レビュー P1×4/P2×4/P3×3 反映済）
- 起票: [B58 issue](ksql_b58_mode_aggregate_issue.md)（前例調査済＝MySQL/SQL Server なし・PG `mode() WITHIN GROUP`・Oracle `STATS_MODE`・分析系は素の `MODE(x)`・ANSI 標準外・タイは各 RDB とも不定）
- 種別: 改善（集計関数の拡充）／SemVer: **minor**（純追加・既存挙動不変）
- 関連: **B56**（統計集約＝完全入力契約・空文字規約・カタログ同期を再利用）／B55（MCP 全量関数カタログ同期）
- R1→R2 の主な変更: タイ規則の total-order 化（canonical 同値は raw 二次比較）・型メタ変更箇所を 5＋2 経路へ拡充（R1 の `SET @var`「追加不要」は実装と逆＝誤りを訂正）・resolver 収集条件（collectAggregateRef）追加・R1-Q1/Q2 確定・instructions 文言修正・チェックリスト 4 群化

## 1. 目的

kintone のカテゴリデータ（ドロップダウン・ラジオ・STATUS・テキスト）の最頻値を 1 文で取得可能にする。B56 の統計 5 関数（数値限定）を文字列側で補完する。

## 2. スコープ

- 追加する関数: **`MODE(引数)`** の 1 つ。素の集計構文（Snowflake/Databricks 型）。`WITHIN GROUP` は導入しない（B56 で `PERCENTILE_CONT` を見送ったのと同じ理由）。`STATS_MODE` 等の別名なし。
- ウィンドウ形は非対応（未消費トークンの ParseError）。

## 3. 構文

```sql
SELECT 部署, MODE(ステータス) AS 最頻ステータス FROM APP100 GROUP BY 部署
SELECT MODE(担当者名) AS 最頻担当 FROM APP100 WHERE 受注日 >= '2026-01-01'
```

- SELECT の引数は既存集計と同じ `parseArithAddSub` 経由（フィールド・算術式）。**HAVING の直接集計参照は現行どおり identifier のみ**（parser.ts:2199）。**厳密に 1 引数**。
- **`MODE(*)` は ParseError**: `aggregateAcceptsWildcard` の allow-list（COUNT/SUM/AVG/MAX/MIN＝parser.ts:188）へ **MODE を追加しない**だけで、SELECT（parser.ts:1842）/HAVING（parser.ts:2194）の両経路が拒否になる（codex 裏取り済）。
- **`MODE(DISTINCT x)` は ParseError**: 全値の頻度が 1 になり常にタイ→タイ規則の最小値＝実質 `MIN` となる無意味な指定のため fail-closed。SELECT（parser.ts:1835）/HAVING（parser.ts:2187）の両経路で **DISTINCT token を捕捉して**エラー位置に渡す（consume 後の後続解析まで待つと `this.prev()` がずれるため）。
- HAVING: B56 と同じ制約（同じ集計が SELECT 列にも存在する場合に限り直接参照可）。
- 使用可能位置: SELECT 列・HAVING（上記制約下）・（alias 経由で）ORDER BY。WHERE 内は不可。

## 4. 意味論

### 4.1 頻度カウント（文字列単位・数値変換なし）

- 値の収集は既存集計と同一経路。**単純フィールド参照は空文字（未選択セル）をスキップ**（`COUNT(field)`/`GROUP_CONCAT` と同じ。MIN/MAX の空セル保持分岐に MODE を加えない限り自動で成立＝process.ts:329）。算術式引数は数値評価（NaN スキップ・process.ts:338）。
- 頻度は**文字列の完全一致単位**（`"1"` と `"01"` は別カウント）。B56 の `numericValues` ArgumentError ガードは**通らない**（MODE を statistical 判定へ加えず、`nums` 生成前に return する実装とする）。
- 対象フィールド型の制限なし・複数値型は既存集計と同じ扱い。

### 4.2 タイ（同数）の決定的規則＝total order

最大頻度の値が複数ある場合:

1. **canonical 比較（v3 型付き比較・`compareCanonicalValues` 再利用）で最小の値**。
2. **canonical 比較が 0 かつ raw 文字列が異なる場合は、raw 文字列のコードポイント順を二次比較**に使う（数値型メタでは `"1"` と `"01"` が exact-decimal 同値＝cmp 0 になる（scalarCompare.ts:46）ため、二次比較なしでは取得順依存になる・codex 指摘）。

- 比較 semantics の既定（R1-Q2 確定）: **型メタ不明の FIELD_REF はコードポイント順・算術式は number semantics**（MIN/MAX の現行既定＝process.ts:373 と同一）。
- 結果は**レコード取得順に依存しない**ことを受入条件で固定（`"1"`/`"01"` 同頻度＋入力順シャッフルを含む）。

### 4.3 未定義値＝空文字

- 0 件（空集合・全値が空セル）→ **空文字 `""`**（B56 §4.3 規約踏襲・GROUP BY なし 1 行返却時も同じ）。
- 1 件 → その値。

### 4.4 完全入力契約（B56 と同一機構・reason 共用）

**`MODE` を `STATISTICAL_AGGREGATES` 集合と FIELD regex（dmlGuard.ts）へ追加**する。reason は `STATISTICAL_AGGREGATE` を共用し、仕様上「**統計集約＝分散・標準偏差・中央値・最頻値**」と定義する（独立 reason は型 union/EXPLAIN/テストの分岐が増える割に利用者価値が小さい・「統計集約の正しい結果には…」の文言は MODE にも自然）。

- truncate→error 強制・上限到達時 `FetchAllLimitError`・再帰 walker・EXPLAIN 3 行表示はすべて既存集合への追加のみで乗る（codex 裏取り済）。
- **MCP instructions の文言修正が必須**: 現行の「Statistical aggregates use explicit POP/SAMP names only」は MODE を統計集約に含めると誤読される→「**Variance and standard-deviation aggregates use explicit POP/SAMP names; unqualified STDDEV and VARIANCE are unsupported.**」へ差し替え（index.ts:82）。

### 4.5 型メタ（引数の型を透過＝5＋2 経路）

`MODE` は入力値の 1 つをそのまま返すため、FIELD_REF 引数は **source semantics 継承**・算術式引数は **number**。R1 の「materialized 分岐だけ＋SET @var は追加不要」は**不足・誤り**（codex 指摘で確定）。変更箇所:

| # | 経路 | 対応 |
|---|---|---|
| 1 | source meta のロード判定 `selectNeedsSourceColumnMeta`（execute.ts:3028・現在 MIN/MAX のみ） | MODE FIELD_REF を追加 |
| 2 | materialized 出力メタの source 継承（execute.ts:3120） | MIN/MAX 分岐へ MODE 追加 |
| 3 | HAVING alias semantics（execute.ts:2152・未対応だと「GROUP_CONCAT 以外＝number」に落ち **MODE(テキスト列) が number 誤分類**） | MIN/MAX 分岐へ MODE 追加 |
| 4 | ORDER BY alias semantics（execute.ts:4222・同上） | MIN/MAX 分岐へ MODE 追加 |
| 5 | **`SET @var = (SELECT MODE(...))` の型判定（execute.ts:1462）**: allow-list 外は `Number(value)` を試さず必ず文字列変数になる（execute.ts:1468-1471）ため「追加不要」は不成立。関数名 allow-list 追加でも入力型を判別できない | **MODE FIELD_REF の source meta に基づき numeric を決定**・source meta 不能時は安全側 string・算術式は number |
| +1 | resolver 用フィールド収集 `collectAggregateRef`（execute.ts:2743・MIN/MAX 固定） | MODE FIELD_REF を追加（これがないと §4.2 の semantics 解決が動かない） |
| +2 | `evalAggregate` の comparison 解決（process.ts:367・MIN/MAX 固定） | MODE FIELD_REF を追加・`AggregateSortKindResolver` 関連コメントの「MIN/MAX」表記を更新 |

- `deriveOutputOrderSemantics`（process.ts:1170）の number 固定リストへは**追加しない**（MIN/MAX 同様・外部から渡される型メタで補われる＝codex 裏取り済）。

## 5. 実行計画・EXPLAIN

- `MODE` を含む SELECT は集計として **FULL_SCAN**。押し下げなし。EXPLAIN は B56 の完全入力 3 行表示に乗る。

## 6. 予約語

新規予約語 1 語: `MODE`。一般的な英単語のため衝突リスク高＝バッククォート注記（B19 前例）＋CHANGELOG 告知。識別子解析は貪欲な前方一致をしないため `MODEL` 等は非影響（B19 実測）。

## 7. 同期箇所（実装チェックリスト・4 群）

**実装**
- `src/types/ast.ts`（`AggregateFunc` union）・lexer token・`PARSER_AGGREGATE_FUNCTION_TOKEN_MAP`・DISTINCT 拒否 2 箇所（token 捕捉）・frozen 定数
- `process.ts` evalAggregate（頻度 Map＋total-order タイ規則・`nums` 生成前 return・空文字規約）
- `dmlGuard.ts`（`STATISTICAL_AGGREGATES` 集合＋FIELD regex）
- 型メタ 5＋2 経路（§4.5 の表）
- `selectToKintone.ts` 合成集計名 regex・`dmlCustomCheck.ts` CHECK 拒否 regex

**テスト**（B56 実装コミット 3e02812 の範囲と同型）
- 契約テスト（statisticalAggregates.test.ts 相当＝一意最頻値・タイ 2 種・シャッフル決定性・空集合/全空セル/1 件・`*`/DISTINCT/OVER/2 引数 ParseError×SELECT/HAVING・完全入力再帰検出）
- lexer / parser / execute（truncate 文言）/ executeBatch（SET @var 数値列・テキスト列・算術式・型不明 temp の 4 種）/ explain / dmlCustomCheck の各契約テスト
- `functionCatalog.test.ts`（aggregate 11→12・drift guard）・`metadataTools.test.ts`（代表語・語数 240–280 実測再固定＝instructions 文言修正後に実測）

**docs / MCP**
- 言語リファレンス: 集計関数表＋統計集約節へ MODE 追記（タイ規則・**未選択（空セル）は候補に含めない**・未選択件数は `COUNT(*) - COUNT(field)` で確認・`MODE(COALESCE(field,'未選択'))` は算術式扱いで数値評価されるため不可＝カテゴリ化したい場合は CTE/temp で文字列列に実体化してから）・空集合表・予約語注記
- B55 カタログ: instructions（aggregate 12・§4.4 の文言差し替え）・docsResources・fixtures・`ksql_docs`・mcp-smoke / pack-smoke 代表語
- `CHANGELOG.md` 未リリース見出しへ追記（予約語告知）
- tracker / issue / spec ステータス行・実機 evidence

**リリース**（B56 と同一リリースに同梱想定）
- 版数一式（package.json / lock 先頭 2 / prod/manifest.json / release/VERSION.txt / README.txt）・`desktop.js` 再ビルド・4 面 smoke

## 8. 受入条件

1. **正しさ**: 一意最頻値・タイ（2 値/全値同数・数値型の `"1"`/`"01"` 同頻度含む）・**入力順シャッフルで結果不変**。実機データで外部集計（GROUP BY＋COUNT）と一致。
2. **タイ規則**: 数値型フィールド=数値順最小（同値は raw コードポイント）・テキスト=コードポイント最小・STATUS=定義順（optionOrder）・temp/CTE 型メタ経由でも同じ。
3. **未定義**: 空集合・全値空セル→空文字。1 件→その値。
4. **構文**: `MODE(*)` / `MODE(DISTINCT x)` が SELECT・HAVING 両方で ParseError（位置トークン正）。`OVER`・2 引数 ParseError。
5. **完全入力**: truncate 併用が上限到達時エラー（STATISTICAL_AGGREGATE 文言）・集計算術式/CTE 内でも検出・EXPLAIN 表示。
6. **型メタ**: `MODE(数値列)` が ORDER BY/HAVING alias で数値比較・`MODE(テキスト列)` が文字列比較（number 誤分類の非回帰）・`SET @v = (SELECT MODE(数値列))`=数値変数/テキスト列=文字列変数/型不明 temp=文字列変数（安全側）。
7. **非回帰**: 既存 11 集計・全テスト green・drift guard / 語数 guard green。
8. **予約語**: バッククォート参照可・`MODEL` 等非影響。

## 9. 解決済み論点

- **R1-Q1（DISTINCT）: ParseError を採用**（黙認は MODE の実質 MIN 化＝静かな誤結果・codex 推奨と一致）。
- **R1-Q2（比較の既定）: 型メタ不明の FIELD_REF はコードポイント順・算術式は number semantics・canonical 同値は raw コードポイント二次比較**（MIN/MAX の現行既定と整合・codex 推奨と一致）。
