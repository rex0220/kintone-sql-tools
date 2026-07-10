# kSQL バッチ強化 第1弾 仕様・実装計画

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R3(実装後レビュー反映): C1 の「env 解決をゲート生成部に集約」を変更 — `src/api/requestGate.ts` に `node/config`(fs 依存)を import させない。env 解決は `resolveRequestGateOptions()`(node/config.ts)として Node 層に置き、呼び出し側 2 箇所で適用(§4.3。優先順 env > CLI > config > 既定は不変)。あわせて `RequestGate` constructor で backoff 値を clamp(profile JSON 経由の無検証値対策)
  - 2026-07-10 R2: 再レビュー反映。プラグイン UI の「自動対応」を訂正 — `renderResult()` は `ExecuteResult` の網羅 switch のため `case "ASSERT"` の追加が必須(§2.5)/ §5 実装ステップ表 B1 の抽出先を `src/output/batchEnvelope.ts` に修正(§3.3 との不整合解消)
  - 2026-07-10 R1: レビュー反映。単文 ASSERT の出力ルートを明示 — MCP `ksql_query` の非 SELECT 拒否ガードと CLI の mutation 出力分岐に `AssertResult` 専用経路が必要(§2.3・§2.5)/ バッチ成功時の ASSERT は「result を持たない no-result 文」と規定 — 現行の `result.type !== "SELECT"` → mutation summary 経路への流入を防止(§2.3・§2.5)/ エンベロープ抽出先を `src/output/` に変更 — `core` → `execute.ts` の値 import 循環を回避(§3.3)/ サブクエリ 2 行打ち切りを非集計限定に条件化(§2.3)/ `KSQL_RETRY=0` と `envInt()` の `n <= 0` 無効扱いの衝突に対応 — `envNonNegativeInt` 追加を計画に明記(§4.3)
- ステータス: 実装完了(A1〜A4 / B1〜B3 / C1〜C3。v1.10.0 リリース待ち — 残: プラグイン実機確認)
- 対象バージョン: v1.10.0(3機能を一括リリース)
- 前提資料: [ksql_batch_enhancement_proposals.md](ksql_batch_enhancement_proposals.md)(採否評価)/ [ksql_batch_temp_table_spec.md](ksql_batch_temp_table_spec.md)(バッチ基盤仕様)

---

## 1. 概要とスコープ

提案書の推奨第1弾として、以下の3機能を実装する。3機能は相互に独立しており、実装・レビューは並行可能。リリースは v1.10.0 として一括。

| 機能 | 種別 | 提案書 |
|---|---|---|
| A. ASSERT 文 | 新規構文 | §2.1 |
| B. CLI バッチ JSON 出力 | 既存エンベロープの流用 | §3.2 |
| C. requestGate 設定公開 | 既存基盤の公開 + 仕様明文化 | §3.1 |

### 対象外(第2弾以降)

パラメータバインド / 保存クエリのバッチ対応 / bulkRequest / Undo ログ / Webhook 通知。

---

## 2. 機能A: ASSERT 文

### 2.1 構文

```sql
ASSERT <式> <比較演算子> <式>;
ASSERT <式> BETWEEN <式> AND <式>;
```

- 比較演算子: `=` `<>` `<` `<=` `>` `>=` および `BETWEEN`
- 式に許すもの: リテラル、算術式、**スカラーサブクエリ**(`(SELECT ...)`)。サブクエリは APP・一時テーブルとも参照可
- 初期版で**許さない**もの: `AND` / `OR` による複合条件(複数の ASSERT 文に分けて書く)、裸の値のみ(`ASSERT 1` は `ParseError`)、フィールド参照(FROM コンテキストが無いため)

```sql
-- 典型例: DML 前の件数ガード
CREATE TEMP TABLE #targets AS
SELECT $id FROM APP100 WHERE 売上 > 1000000;

ASSERT (SELECT COUNT(*) FROM #targets) BETWEEN 1 AND 500;

UPDATE APP100 SET 状態 = '対象' WHERE $id IN (SELECT $id FROM #targets);
```

### 2.2 真値規則(提案書 §2.1 で確定済み)

- スカラーサブクエリは**必ず 1行1列**を要求する
  - 複数列は select list が明示的な場合 **validate 段階で静的に拒否**(`ParseError`)、`SELECT *` 等で静的判定できない場合は実行時 `AssertError`
  - 0行・複数行は実行時 `AssertError`(0行を暗黙 NULL 扱いにしない)
- 比較結果が false または NULL 相当なら `AssertError`(`0` / 空文字の truthy 判定のような暗黙変換は導入しない)
- 比較の型規則は既存の WHERE 句比較と同一

### 2.3 実行セマンティクス

| 項目 | 仕様 |
|---|---|
| 分類 | **read-only 扱い**(kintone に書き込まない)。`ksql_query` の read-only バッチ、`ksql_mutate` の DML バッチのいずれにも含められる |
| 単文入力 | **許可する**(設計判断 D2)。`CREATE TEMP TABLE` と異なり単独で意味を持つ(CLI ヘルスチェック用途: `ksql -e "ASSERT (SELECT COUNT(*) FROM APP1 WHERE 異常フラグ = '1') = 0"` → exit code で監視) |
| 実行結果型 | **`AssertResult`(`type: "ASSERT"`)を新設**する。既存コードは結果型を SELECT / mutation の2値で分岐しており(MCP `ksql_query` は非 SELECT を `ArgumentError` で拒否、CLI は非 SELECT を `buildMutationOutput()` / `affected=` に流す)、ASSERT はどちらにも属さないため**専用の出力分岐が必須**(§2.5) |
| 成功時 | 単文: MCP は `{ ok: true, type: "ASSERT" }` の専用 payload、CLI は「assertion ok」等の1行(json 時は同 payload)。バッチ: **`statements[]` に `result` を持たせない no-result 文**として扱う(`status: "success"` のみ)。現行のエンベロープ / CLI サマリは `result && result.type !== "SELECT"` を mutation summary に流すため、`result` を持たせないことでこの経路への流入を構造的に防ぐ |
| 失敗時 | その文が `error`(`AssertError`)となり停止 |
| continueOnError | **ASSERT 失敗は continueOnError を無視して常にバッチを停止する**(設計判断 D3)。ASSERT の目的は後続実行のゲートであり、続行を許すと存在意義が消える。以降の文は `skipped`(`skippedReason: "assertion"`) |
| サブクエリ実行 | 一時テーブル参照は既存の FULL_SCAN 注入経路(`executeQueryWithCte`)。APP 参照は通常の取得経路(WHERE プッシュダウン有効) |
| EXPLAIN | バッチ EXPLAIN(`buildBatchStatementPlan`)にサブクエリのプラン + 「ASSERT: 実行時に条件評価」を表示 |
| タイムアウト・上限 | バッチ合計 `timeout` の対象。サブクエリの「2 行で打ち切り」最適化は**非集計・非 GROUP BY のスカラー検証に限る**(`SELECT COUNT(*)` 等の集計は結果が 1 行でも計算には全対象行の取得が必要。この場合は通常の取得経路 + `maxRecords` 系の既存上限に従う) |

> **設計判断 D2(単文 ASSERT を許可する理由)**: 単文拒否は「単独で無意味な文」(`CREATE TEMP TABLE`)に限った例外である。ASSERT は単独でも exit code による監視・CI ゲートとして機能するため許可する。単文入力に新しい文タイプのペイロードが増えるが、既存文タイプの応答形は不変であり後方互換(バッチ仕様 §6.1)と衝突しない。

> **設計判断 D3(continueOnError より ASSERT 停止を優先)**: read-only バッチの continueOnError は「独立した複数照会の一括実行」用であり、ASSERT を含むバッチは定義上「前提条件付きの手順」である。両立させる意味がない。

### 2.4 エラー仕様

新しいエラー接頭辞 **`AssertError:`** を追加する(既存の「message 接頭辞をコードとして抽出する」規約に乗る)。

| 状況 | メッセージ例 |
|---|---|
| 条件不成立 | `AssertError: assertion failed: (SELECT COUNT(*) FROM #targets) BETWEEN 1 AND 500 (actual: 812).` |
| サブクエリ 0行 | `AssertError: scalar subquery returned no rows (expected 1 row).` |
| サブクエリ複数行 | `AssertError: scalar subquery returned 3 rows (expected 1 row).` |
| サブクエリ複数列(静的) | `ParseError: scalar subquery in ASSERT must return exactly 1 column.` |
| 複合条件・裸の値 | `ParseError`(構文エラーとして既存規約どおり) |

- CLI exit code: `AssertError` は **1**(初期版)。監視用途で専用コードの需要が確認できたら未使用の `4` 以降を割り当てる(§3.2 の exit code 方針と同じ判断)
- 失敗メッセージには実測値(`actual:`)を含め、LLM / CI ログが原因を読み取れるようにする

### 2.5 変更箇所(統合点)

| ファイル | 変更 |
|---|---|
| `src/lexer/tokens.ts` | キーワード `ASSERT` 追加(`BETWEEN` は既存) |
| `src/types/ast.ts` | `AssertStatement` ノード追加(`type: "ASSERT"`、左辺・演算子・右辺 or BETWEEN 3項) |
| `src/parser/parser.ts` | `ASSERT` 文のパース + 複数列サブクエリの静的拒否 |
| `src/core/dmlGuard.ts` | `isReadOnlyType` に `"ASSERT"` 追加 |
| `src/core/batch.ts` | 変更ほぼ不要(分類・一時テーブル参照収集は `getStatementType` / `collectRefs` が AST 走査で汎用に処理)。テストで確認のみ |
| `src/execute.ts` | `AssertResult` 型追加(`ExecuteResult` のユニオンに追加)、単文 switch に `case "ASSERT"`、`executeBatchStatement` に評価処理(**成功時は `result` を格納しない**)、`AssertError` 生成、continueOnError 無視の停止処理、`buildBatchStatementPlan` の ASSERT 分岐 |
| `src/mcp/tools.ts` | **要変更(過小評価注意)**: ①`ksql_query` 単文経路の非 SELECT 拒否ガード(`read-only query returned unexpected result type`)に `ASSERT` の許可分岐を追加し `toAssertPayload` を新設、②validate の `statements[]` は自動対応 |
| `src/cli/index.ts` | **要変更**: 単文実行の `result.type !== "SELECT"` 分岐は mutation 出力(`buildMutationOutput()` / stderr `affected=`)に流れるため、その手前に `ASSERT` 分岐を追加(成功1行 / json 時は専用 payload)。バッチサマリ行は no-result 文として既存機構で表示。`toExitCodeFromError` は変更なし(AssertError → 1) |
| `src/ui/renderResult.ts` | **要変更**: `renderResult()` の switch は `ExecuteResult` の網羅分岐であり、`AssertResult` 追加時に `case "ASSERT"` がないと単文 ASSERT の表示が `undefined` になる。成功表示(例: `renderSuccess("アサーション成立")`)を追加する |
| プラグイン UI(バッチ) | バッチ内 ASSERT は no-result 文のため既存表示(サマリ行 / エラーの `[N]` 表示)で自動対応。実機確認のみ |
| console(§8.2 判定) | 変更不要(ASSERT 単文は許可のため、バッチ構築モードの対象にしない) |

---

## 3. 機能B: CLI バッチ JSON 出力

### 3.1 現状と課題

CLI バッチ実行(`src/cli/index.ts` `writeBatchOutput`)は、SELECT 結果のみを stdout(結果間は空行区切り)、文ごとのサマリを stderr に出力する。`--format json` でも結果セットごとの JSON が連結されるだけで、**バッチ全体の成否・文ごとの状態を stdout から機械可読に得られない**。CI 用途の主要な欠落。

### 3.2 仕様

- バッチ入力 + `--format json` のとき、**MCP と同一のエンベロープ**(バッチ仕様 §6.2: `ok` / `batch` / `statementCount` / `statements[]` / `results[]` / `warnings`)を **stdout に単一 JSON ドキュメント**として出力する。`--pretty` 対応
- `--output <path>` 指定時も同じエンベロープをファイルへ書く
- **`table` / `csv` / `markdown` / `jsonl` は従来出力を維持**(エンベロープ化は `json` のみ。jsonl は「結果行のストリーム」という契約を維持する)
- 単文入力の `--format json` は従来どおり(互換不変)
- stderr のサマリ行は従来どおり出力(`--quiet` で抑止)。stdout のみパースする CI に影響しない
- **exit code は変更しない**: 0 = 全文 success / 1 = 実行時エラー(部分失敗含む)/ 2 = ArgumentError / 3 = AuthError(現行 `toExitCodeFromError` のまま)。部分失敗(`--continue-on-error` 時)の判別は exit code ではなく JSON の `ok: false` + `statements[]` で行う(提案書 §3.2 R2 の決定)

#### 互換性注記(破壊的変更)

バッチ + `--format json` の従来出力(SELECT 結果 JSON の空行区切り連結)は v1.4.0 導入の挙動だが、複数ドキュメント連結は元々機械可読でなく、利用実態も想定しにくい。**CHANGELOG に破壊的変更として明記した上で置き換える**。従来の「結果セットだけ欲しい」用途は `jq '.results[].rows'` で代替可能。

### 3.3 実装

| ステップ | 内容 |
|---|---|
| B1 | `src/mcp/tools.ts` のエンベロープ構築ロジック(`batch.statements.map(...)` で `resultIndex` / `results[]` を組む部分、現在は MCP 内の無名処理)を抽出し純関数化する。**配置は `src/output/batchEnvelope.ts`(新設の上位層)とする** — エンベロープは `BatchExecuteResult` / `ExecuteResult` に依存し、`execute.ts` は既に `core` を import しているため、`src/core` 配下に置くと値 import が混ざった時点で循環する(`import type` 限定で core 配置も可能だが、規約をレビューで守り続けるより層で防ぐ)。`maxTotalRecords` 超過チェックはコールバック or オプション引数とし、MCP 側だけが使う(CLI に同等オプションはない)。MCP の既存テストで回帰確認 |
| B2 | `writeBatchOutput` に `format === "json"` 分岐を追加し、共通ビルダーを呼ぶ。`--pretty` / `--output` 対応 |
| B3 | ヘルプ(`--format` の説明にバッチ時の挙動追記)/ CLI 仕様書 / CHANGELOG |

---

## 4. 機能C: requestGate 設定公開

### 4.1 現状(実装済みの基盤)

`src/api/requestGate.ts`(P0-1)が提供済み:

- **セマフォ**: プロセス内グローバルの同時リクエスト上限。既定 10(1〜50)。解決優先順は `KSQL_MAX_CONCURRENT` env > `profile.query.maxConcurrent`(config 公開済み)> 既定
- **GET 系リトライ**: 408/429/502/503/504 + ネットワーク一時エラー(fetch failed / AbortError)を指数バックオフ + ジッタで再試行。既定 3 回、初期 500ms、上限 8,000ms
- **書き込み系(POST/PUT/DELETE)はリトライしない**(応答喪失時の二重実行回避。セマフォのみ適用)

未公開なのは: ①CLI フラグ(`maxConcurrent` すら CLI からは指定不可)、②リトライ系パラメータ(`maxRetries` / `baseDelayMs` / `maxDelayMs` は config・env とも未公開)、③「書き込み非リトライ」方針の公開仕様化。

### 4.2 仕様

#### 設定の公開

| 項目 | CLI | config(`profile.query`) | env | 既定 |
|---|---|---|---|---|
| 同時リクエスト上限 | `--max-concurrent <n>`(1〜50) | `maxConcurrent`(既存) | `KSQL_MAX_CONCURRENT`(既存) | 10 |
| GET リトライ回数 | `--retry <n>`(0〜10。0 で無効) | `retry` | `KSQL_RETRY` | 3 |
| バックオフ初期値 | `--retry-base-delay <ms>` | `retryBaseDelayMs` | — | 500 |
| バックオフ上限 | `--retry-max-delay <ms>` | `retryMaxDelayMs` | — | 8000 |

- 解決優先順は既存規約を維持: **env > CLI フラグ > config > 既定**(`KSQL_MAX_CONCURRENT` の「env 最優先」を変えない。CLI フラグは config と同じ limitHint 系に入り、CLI > config)
- ゲートは**プロセス内グローバル1個・初回解決値で固定**(既存挙動)。複数 profile 同時利用では最初に解決された値が使われる旨をヘルプに明記
- **MCP ツール入力には公開しない**(設計判断 D4): 設定は `ksql.config.json` の profile 経由のみ。LLM がリトライ回数や同時実行数を操作できるべきではない

> **設計判断 D4**: レート制御は運用者が決める環境設定であり、呼び出しごとに変える性質のものではない。ツールスキーマの肥大は誤選択リスクにもなる(バッチ仕様 D1 と同じ考え方)。

#### 仕様の明文化(ドキュメント追記)

- 「書き込み系はリトライしない(二重実行回避)。必要なら呼び出し側で冪等な再実行(UPSERT 等)を設計する」を CLI 仕様書・MCP サーバー仕様書・言語リファレンスの制限事項に追記
- リトライ対象ステータス(408/429/502/503/504)と GET 限定である旨を明記

### 4.3 実装

| ステップ | 内容 |
|---|---|
| C1 | `getGlobalRequestGate(limitHint?)` を `getGlobalRequestGate(options?: number \| Partial<RequestGateOptions>)` に拡張(数値渡しは後方互換)。env 解決(`KSQL_MAX_CONCURRENT` / `KSQL_RETRY`)は **`resolveRequestGateOptions()`(`node/config.ts`)として Node 層に置き、呼び出し側2箇所が解決済み options を渡す**(R3: `src/api` に fs 依存の `node/config` を import させない。`getGlobalRequestGate()` 自体は env を読まない)。**注意: `KSQL_RETRY=0`(リトライ無効)は既存 `envInt()` が `n <= 0` を無効値として捨てるため読めない** — `envNonNegativeInt()` を `node/config.ts` に追加し、`KSQL_RETRY` の解決に使う(`KSQL_MAX_CONCURRENT` は 1 以上のため既存 `envInt` のまま)。あわせて `RequestGate` constructor で backoff 値を clamp(R3: profile JSON 経由の無検証値対策) |
| C2 | `node/config.ts` の `query` に `retry` / `retryBaseDelayMs` / `retryMaxDelayMs` 追加。`cli/index.ts` にフラグ4件 + ヘルプ追記。`node/runtime.ts` / `cli/index.ts` の `getGlobalRequestGate` 呼び出し(計2箇所)に新オプションを配線 |
| C3 | ドキュメント明文化(§4.2)。README の CLI オプション表は HELP_SYNC で自動反映 |

---

## 5. 実装ステップと順序

```
Phase A(ASSERT)         A1 → A2 → A3 → A4
Phase B(CLI JSON 出力)  B1 → B2 → B3
Phase C(requestGate)    C1 → C2 → C3
```

| ステップ | 内容 | 依存 |
|---|---|---|
| A1 | レキサ(`ASSERT` キーワード)+ AST + パーサ(複数列静的拒否含む)+ 単体テスト | — |
| A2 | 分類(`isReadOnlyType`)+ `ksql_validate` / バッチ静的解析での扱い + テスト(batch.test.ts に ASSERT ケース追加) | A1 |
| A3 | 実行(単文 / バッチ / continueOnError 停止 / `AssertError` / 1行1列の実行時検証)+ テスト | A2 |
| A4 | EXPLAIN 分岐 + プラグイン実機確認 + 公開ドキュメント(言語リファレンスに ASSERT 節、バッチ仕様 §9 エラー表に AssertError 追加) | A3 |
| B1 | エンベロープビルダーの抽出(`src/output/batchEnvelope.ts`。§3.3 の層の理由参照)+ MCP 回帰テスト | — |
| B2 | CLI `--format json` バッチ分岐 + テスト | B1 |
| B3 | ヘルプ / CLI 仕様書 / CHANGELOG(破壊的変更の明記) | B2 |
| C1 | `RequestGateOptions` の全項目を `getGlobalRequestGate` で受け付け + env 解決は `resolveRequestGateOptions()`(Node 層)に集約 + テスト | — |
| C2 | config スキーマ + CLI フラグ + 配線(2箇所) | C1 |
| C3 | 「書き込み非リトライ」方針の公開仕様化(3ドキュメント) | — |

- 3 Phase は独立(共有ファイルの競合は `cli/index.ts` のみ。マージ順は A → B → C を推奨)
- リリースは v1.10.0 一括。A のみ先行リリースも可能な構成だが、リリース単位を増やさない

---

## 6. テスト計画(概要)

| 対象 | 主なケース |
|---|---|
| ASSERT パース | 各比較演算子 / BETWEEN / スカラーサブクエリ / 複合条件の拒否 / 裸の値の拒否 / 複数列サブクエリの静的拒否 / `SELECT *` サブクエリは静的拒否しない |
| ASSERT 実行 | 成立 / 不成立(actual 値のメッセージ)/ 0行 / 複数行 / NULL 比較 / 一時テーブル参照 / APP 参照 / DML バッチ内で DML 直前のゲート動作 / continueOnError でも停止 + `skippedReason: "assertion"` / バッチ成功時に `result` を持たない(mutation summary に流入しない) |
| ASSERT 出力経路 | 単文 MCP: `ksql_query` の非 SELECT 拒否ガードを通らず `toAssertPayload` が返る / 単文 CLI: mutation 出力(`affected=`)に流れない(table / json 両形式)/ プラグイン: `renderResult()` が ASSERT 成功表示を返す(`undefined` にならない) |
| ASSERT validate | `statements[]` の `statementType: "ASSERT"` / `isReadOnly: true` / `tempTablesReferenced` の収集 |
| CLI JSON | バッチ + json でエンベロープ / 単文 + json は従来形 / jsonl・table は従来形 / `--pretty` / `--output` / 部分失敗時 `ok: false` + exit 1 / MCP との出力一致(スナップショット) |
| requestGate | env > CLI > config の優先順 / `--retry 0`・`KSQL_RETRY=0` で無効(`envNonNegativeInt` 経由)/ クランプ(1〜50 等)/ 既存2呼び出し箇所の回帰 |

---

## 7. 互換性

- 単文入力の既存文タイプの応答形は全ツール・CLI で不変。ASSERT は新規文タイプの追加であり既存応答に影響しない
- **破壊的変更は1点のみ**: バッチ + `--format json` の CLI 出力形(§3.2)。CHANGELOG 明記
- exit code の割り当ては不変(AssertError は 1)
- requestGate の既定値・既存の env / config 解決順は不変(公開が増えるだけ)

---

## 8. 公開ドキュメント反映(リリース時)

- 言語リファレンス: ASSERT 文の節を新設、制限事項に「複合条件は非対応」
- バッチ仕様(`ksql_batch_temp_table_spec.md`): §9 エラー表に `AssertError` / `skippedReason: "assertion"` を追記
- CLI / console 仕様: `--format json` のバッチ挙動、requestGate フラグ、書き込み非リトライ方針
- MCP サーバー仕様: ASSERT の扱い(read-only)、書き込み非リトライ方針
- README: 機能概要に ASSERT 追加、CLI オプション表(HELP_SYNC)
- 提案書(`ksql_batch_enhancement_proposals.md`): 第1弾のステータスを「実装中 → 完了」に更新
