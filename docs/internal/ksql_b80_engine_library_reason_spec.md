# B80 — engine ライブラリの静的検証 reason 保持仕様 R1

- 作成日: 2026-07-27
- ステータス: ✅ **リリース済み（v3.27.0・2026-07-27）**。Step 1〜5 完了。11 条件を回帰固定し、4面 parity の「同じ拒否には同じ reason」を確立。
- 対象: B80（B79 と同一リリース）
- 関連: [B80 起票](ksql_b80_engine_library_reason_flattening_issue.md) /
  [B73 評価](ksql_b73_error_structured_i18n_evaluation.md) /
  [B76 Phase A 仕様 §17](ksql_b76_join_pushdown_phase_a_spec.md#17-2026-07-274面-parity-条件の緩和engine-ライブラリの-reason-平坦化) /
  [B66 Phase1 仕様](ksql_b66_engine_library_phase1_spec.md)

## 1. 結論

B80 は、engine ライブラリの parse 境界で **既知の静的検証エラーの reason を
トップレベル `KsqlEngineError.message` に保持する**互換修正とする。

現行 `parseSqlStatement()` の経路を静的監査し、現行コードへ SQL を直接入力して確認した結果、
`LexError` / `ParseError` 以外に SQL から到達する明示的な検証エラー型は
**`KlikeValidationError` だけ**である。KLIKE は「一例」ではなく、現時点の
`parseSqlStatement()` 後段に接続された唯一の非 `PARSE_ERROR` 検証である。

修正後の公開形は次とする。

```ts
KsqlEngineError {
  name: "KsqlEngineError",
  code: "PARSE_ERROR",                 // 現行を維持
  message: originalKlikeError.message, // 具体 reason を復元
  cause: originalKlikeError            // 現行を維持
}
```

- `code`、外側 class、reject 方式、`cause` identity は変更しない。
- `message` だけを、汎用文言 `SQL statement could not be parsed` から
  元の `KlikeValidationError.message` へ変える。
- `KlikeValidationError` だけを class identity で allowlist する。
  `name === "ArgumentError"` や全 `EXECUTION_ERROR` を通す広い条件は禁止する。
- 未知の非 parser error は現行どおり汎用 `PARSE_ERROR` に閉じ込める。
- B80 では `details`、`messageKey`、`params`、`lang` を追加しない。それらは B73 に残す。

判定は **非破壊の bug fix** である。B66 は `message` 完全一致を semver 契約から除外し、
error code の付け替えを minor で禁止しているため、`code` 維持・message 診断改善は
既存契約内で行える。移行作業は不要だが、利用者可視の診断変更として CHANGELOG へ記載する。

## 2. 目的と不変条件

### 2.1 目的

構文解析に成功した後の意味的拒否を「parse できなかった」と誤表示せず、
plugin / CLI / MCP / engine ライブラリの配布4面で同じ拒否 reason を観測可能にする。

### 2.2 不変条件

1. 同じ SQL、同じ静的検証による拒否では、4面の envelope や error class が異なっても
   **原因生成箇所の `Error.message` と同じ reason 文字列**を観測できる。
2. engine ライブラリの既存 `KsqlEngineError.code` は付け替えない。
3. `KsqlEngineError.cause` は元の error object と同一 identity を維持する。
4. allowlist 外の error は内部詳細をトップレベルへ露出せず、現行の汎用 message を維持する。
5. 拒否は records / Cursor / metadata API の前に起き、API call 数は 0 のままとする。
6. 判定は「plan があるか」等の間接条件ではなく、
   **実際に投げられた error の class identity** に直接結び付ける。
7. 新しい後段 validator を `parseSqlStatement()` へ接続する場合、
   engine 境界での公開可否を明示し、allowlist・負例・4面 parity test を同時追加する。
   黙って汎用化または黙って公開される状態を作らない。

## 3. スコープ

### 3.1 対象

- `src/engine-library/statementGuard.ts` の `parseSingleStatement()`。
- `src/engine-library/errors.ts` の既存正規化契約の回帰固定。
- `runQuery()` と `explainQuery()` の parse 前置 guard。
- `KlikeValidationError` から到達する全 SQL 拒否 reason。
- B76 §17.2 の配布面 parity 緩和の撤回。
- engine-library unit、4配布面 parity、CLI/MCP/plugin/engine 回帰。

### 3.2 対象外

- `KlikeValidationError` 自体の公開 export。
- `KsqlEngineError.code` の新設・変更。
- `details?`、reason code、position、token、field、path の新規構造化。
- `messageKey`、翻訳カタログ、`lang` option。
- parser / lexer / AST / KLIKE 意味論の変更。
- planner / executor で発生する実行時 error の分類変更。
- read-only allowlist、readonly client、検索打ち切り契約の変更。
- B76 JOIN 述語押し下げロジックの変更。

## 4. 現行経路の網羅監査

### 4.1 `parseSqlStatement()` の全段

`src/core/sql.ts` の単文 API は次の3段だけである。

1. `new Lexer(sql).tokenize()`
2. `new Parser(tokens, capabilities).parse()`
3. `validateKlikeStatement(stmt)`

明示的に投げられる型は次のとおり。

| 段 | 型 | `normalizeEngineError` の分類 | 現行 engine-library |
|---|---|---|---|
| lexer | `LexError` | `PARSE_ERROR` | 元 message と `cause` を保持 |
| parser と parser 内静的制約 | `ParseError` | `PARSE_ERROR` | 元 message（位置・トークンを含む）と `cause` を保持 |
| AST 後 KLIKE 静的検証 | `KlikeValidationError` (`name = "ArgumentError"`) | 通常なら `EXECUTION_ERROR` | `parseSingleStatement()` が汎用 `PARSE_ERROR` へ再置換 |
| 予期しない例外 | 任意 | 通常は `EXECUTION_ERROR` 等 | 汎用 `PARSE_ERROR` へ再置換 |

`src/core/groupingValidation.ts` 等の他 validator は `parseSqlStatement()` から呼ばれない。
parser 内の GROUPING、相対日付、IMPORT、VALIDATE、DML 句順等の静的制約は
`ParseError` を投げるため、今回の平坦化対象ではない。

`validateKlikePushdownPlan()` も `KlikeValidationError` を投げるが、これは runtime plan
検査であり `parseSqlStatement()` の呼び出し先ではないため B80 の対象外である。

### 4.2 実測方法

2026-07-27 に次を実行した。

- 現行 TypeScript の `parseSqlStatement()` と `guardRunQuerySql()` を同一プロセスで
  bundle し、候補 SQL を直接入力して `name` / `code` / `message` /
  `cause.name` / `cause.message` を比較。
- focused Jest:
  `klikeValidation.test.ts`、`statementGuard.test.ts`、`errorMapping.test.ts`、
  `b76JoinPushdownStep5.test.ts`。
- 結果: **4 suites、82 tests、全 PASS**。

プローブでは、到達する全 `KlikeValidationError` が次の形になった。

```text
parseSqlStatement:
  name=ArgumentError
  message=ArgumentError: <具体 reason>

guardRunQuerySql:
  name=KsqlEngineError
  code=PARSE_ERROR
  message=SQL statement could not be parsed
  cause.name=ArgumentError
  cause.message=ArgumentError: <具体 reason>
```

したがって、元 reason は object graph から消去されてはいない。
**公開 error のトップレベル message から隠れ、通常の表示経路では失われる**のが正確な事象である。

## 5. 影響を受けるエラー一覧

### 5.1 SQL から到達し、現行で平坦化されるもの

下表はすべて 2026-07-27 の現行コードで `parseSqlStatement()` が
`KlikeValidationError` を投げ、engine guard が汎用 message へ置換することを確認した。
修正後はいずれも `code = "PARSE_ERROR"` と元 `cause` を維持し、
`message` を表の reason へ戻す。

| 検証名 / 代表条件 | エラー型 | 現状ライブラリでの見え方 | 修正後 |
|---|---|---|---|
| FULL_SCAN KLIKE を安全に押し下げられない（OR / NOT、非 inline CTE、LEFT / RIGHT JOIN、subtable 等） | `KlikeValidationError` | `PARSE_ERROR: SQL statement could not be parsed` | `PARSE_ERROR: ArgumentError: FULL_SCAN の KLIKE / NOT KLIKE は、物理テーブルに対する AND リーフとして…` |
| subtable UPDATE の WHERE に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE はサブテーブル UPDATE の WHERE では使用できません` |
| 通常親 UPDATE の許可 WHERE 外に KLIKE（例: CHECK） | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は通常親 UPDATE の WHERE、または APPLY 複数親 UPDATE の安全な親 WHERE だけで…` |
| subtable DELETE の WHERE に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE はサブテーブル DELETE の WHERE では使用できません` |
| 通常親 DELETE の許可 WHERE 外に KLIKE（実測: nested SELECT） | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は通常親 DELETE の WHERE だけで使用できます` |
| INSERT / INSERT SELECT 内に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は INSERT / INSERT SELECT では使用できません` |
| UPSERT / UPSERT SELECT 内に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は UPSERT / UPSERT SELECT では使用できません` |
| subtable REORDER の WHERE に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE はサブテーブル REORDER の WHERE では使用できません` |
| VALIDATE の WHERE / CHECK に KLIKE | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は VALIDATE の WHERE / CHECK で使用できません` |
| KLIKE 検索語に `%` | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE の検索語に % は使用できません。SQL ワイルドカード検索には LIKE を…` |
| SELECT の WHERE 外に KLIKE（実測: projection CASE / HAVING） | 同上 | 同上 | `PARSE_ERROR: ArgumentError: KLIKE / NOT KLIKE は SELECT の WHERE 句でのみ使用できます` |

表は **11条件**である。起票例の FULL_SCAN 拒否を含め、
SQL から到達した利用者可視 reason を条件別に数えた値である。

### 5.2 平坦化されない対照例

| 検証 | 実測エラー型 | 現行 engine-library | 判定 |
|---|---|---|---|
| KLIKE 右辺が数値 | `ParseError` | `PARSE_ERROR`、位置・トークン付き元 message | 対象外。parser が後段 validator より先に拒否 |
| JOIN ON に KLIKE | `ParseError` | `PARSE_ERROR`、位置・トークン付き元 message | 対象外。JOIN ON の単一等値制約で先に拒否 |
| lexer 不正 token | `LexError` | `PARSE_ERROR`、元 message | 対象外 |
| 空文・複文・余剰 token | `KsqlEngineError` / `ParseError` | 既存具体 message | 対象外 |

`validateKlikeStatement()` には右辺型を再検査する防御分岐があるが、現在の SQL parser は
文字列またはバッチ変数以外を `ParseError` で先に拒否する。これは AST を直接渡す経路への
backstop であり、現行 `parseSqlStatement()` の平坦化対象数へ加えない。

### 5.3 利用者から見て失われる情報

平坦化対象の `KlikeValidationError` 自体は position、token、field name、reason code、
`details` を持たず、具体情報は `message` にだけある。したがって現行の損失は次である。

- トップレベルの具体 reason 全文。
- トップレベル表示上の `ArgumentError` 識別。
- 通常の `String(error)`、CLI 的ログ、UI の `error.message` 表示から見た原因。

一方、次は失われていない。

- 外側 `code = "PARSE_ERROR"`。
- 元 `KlikeValidationError` object。`KsqlEngineError.cause` として保持される。
- 元 error の `name`、message、stack、class identity。`cause` を明示的に辿れば取得可能。

位置・token・field・reason code を B80 が「復元」する根拠はない。
B72 の教訓に従い、元 error に存在しない情報を B80 の制約として追加しない。

## 6. 汎用化していた理由

### 6.1 B66 文書

B66 Phase1 仕様・実装計画が要求したのは次である。

- 内部 error class を re-export せず `KsqlEngineError` へ正規化する。
- malformed SQL は `PARSE_ERROR`、parse 可能な非 read 文は
  `READ_ONLY_VIOLATION` と区別する。
- 全 error code と `cause` を保持する。
- `message` 完全一致はテストせず semver 契約にしない。
- 未知 statement branch は read-only 境界で default deny する。

「非 `PARSE_ERROR` の後段 validator message を隠す」「内部エラー漏洩を防ぐため
`SQL statement could not be parsed` に置換する」という要件・脅威モデル・allowlist は
B66 の評価、仕様、実装計画から確認できなかった。

### 6.2 B66 導入コミット

B66 Step 3 commit
[`0e2f2372`](https://github.com/rex0220/kintone-sql-tools/commit/0e2f2372ac44f2d3af8a5e80b6481fce6dc033c6)
で現行 catch が追加された。commit message と patch は、空文・複文・parse 不能を
`PARSE_ERROR` に揃えること、parse 後の read-only 再帰 allowlist、未知 AST の
default deny を説明している。

しかし、非 parser validator の情報を隠す意図、`KlikeValidationError` の存在を考慮した記録、
漏洩防止の試験はない。Step 2 の旧 top-level guard は `parseSqlStatement()` を直接呼び、
この再置換を持っていなかった。

### 6.3 判定

**汎用化の目的は確定不能であり「不明」**とする。

観測証拠は「単文 parse の失敗を `PARSE_ERROR` に揃える簡略化」を示唆するが、
作者の意図として断定しない。内部漏洩防止だったと仮定しても現行は元 error を
`cause` に保持するため完全な秘匿境界ではなく、広い catch と単一汎用 message だけでは
公開可否の仕様になっていない。

したがって B80 は安全側として、公開が妥当と根拠を示せる
`KlikeValidationError` だけを allowlist する。未知 error の既定動作は変更しない。

## 7. `normalizeEngineError` の契約

### 7.1 保持するもの

| 入力 | 外側 code | message | cause |
|---|---|---|---|
| 既存 `KsqlEngineError` | 既存値 | 既存値 | 既存値。object を二重 wrap せずそのまま返す |
| `LexError` / `ParseError` | `PARSE_ERROR` | 元 error.message | 元 error object |
| `SearchAbortedError` | `SEARCH_ABORTED` | 元 error.message | 元 error object |
| `FetchAllLimitError` | `FETCH_LIMIT_EXCEEDED` | 元 error.message | 元 error object |
| `ClientOperationError` | `CLIENT_ERROR` | wrapper message | wrapper の `cause`（transport error） |
| status / response.status / string code を持つ shape | `CLIENT_ERROR` | shape の message または文字列化 | 元 object |
| その他 | `EXECUTION_ERROR` | 元 message または文字列化 | 元 value |

`errorMessage()` は `Error.message`、object の string `message`、`String(error)` の順で
トップレベル message を作る。

### 7.2 捨てる、または外側へ写像しないもの

- 元 error の `name` と class は外側では `KsqlEngineError` に統一される。
- 元 stack は外側 stack にコピーされない。ただし通常は `cause` から辿れる。
- status、kintone code、token、field、path 等の任意 property は
  `KsqlEngineError` の直下へ構造化コピーされない。
- `ClientOperationError` 自体は cause chain に残さず、その内側 transport error を
  直接 `KsqlEngineError.cause` にする。
- 非 `Error` value は class identity や構造を外側へ反映しない。

### 7.3 `parseSingleStatement()` の追加変換

現行の問題は `normalizeEngineError()` 自体が reason を消すことではない。
`KlikeValidationError` を一度 `EXECUTION_ERROR` と評価した後、
`parseSingleStatement()` がその normalized object を捨て、元 error を cause とする
新しい汎用 `PARSE_ERROR` を作る点にある。

B80 は `normalizeEngineError()` の全体分類を広げない。
parse 境界の専用 allowlist で元 message を採用する。

## 8. 修正設計と互換性

### 8.1 allowlist

概念上の分岐は次とする。関数名は実装時に調整してよいが、条件の意味を変えてはならない。

```ts
try {
  return parseSqlStatement(sql, { import: true });
} catch (error) {
  if (error instanceof KlikeValidationError) {
    throw parseError(error.message, error);
  }
  const normalized = normalizeEngineError(error);
  if (normalized.code === "PARSE_ERROR") throw normalized;
  throw parseError("SQL statement could not be parsed", error);
}
```

順序は class allowlist を先にする。`normalizeEngineError()` 後は
`KlikeValidationError` が `EXECUTION_ERROR` へ抽象化され、class identity を直接判定できないためである。

禁止する案:

- `normalized.code === "EXECUTION_ERROR"` をすべて元 message で通す。
- `error.name === "ArgumentError"`、message prefix、正規表現だけで通す。
- `cause` があること、plan の有無、SQL に `KLIKE` が含まれることを判定条件にする。
- `KlikeValidationError` の message を engine-library 側で再生成・複製する。

### 8.2 非破壊 / 破壊的判定

| 契約要素 | 現行 | B80 後 | 判定 |
|---|---|---|---|
| reject / throw | reject | reject | 不変 |
| 外側 class / name | `KsqlEngineError` | 同じ | 不変 |
| `code` | `PARSE_ERROR` | 同じ | 不変 |
| `cause` identity | 元 `KlikeValidationError` | 同じ | 不変 |
| `message` | 汎用・誤導的 | 元の具体 reason | 利用者可視の診断改善 |
| API call | 0 | 0 | 不変 |

B66 §6.2 は `message` 完全一致を契約にせず、§6.3 は error code の付け替えを禁止する。
よって B80 は既存 `code === "PARSE_ERROR"` 分岐を壊さない。

汎用 message の完全一致に依存した consumer は表示差を受けるが、その依存は B66 の
保証外である。major 変更や移行手順は不要と判定する。CHANGELOG には次の骨子を載せる。

> engine ライブラリの KLIKE 静的検証エラーは `code = "PARSE_ERROR"` を維持したまま、
> `message` が汎用文言から具体的な `ArgumentError` reason へ変わる。
> 分岐には `code` を使用し、message は表示・診断用途として扱う。

### 8.3 `code` の意味上の不一致

KLIKE の AST 後検証は構文エラーではないため、理想的な分類名として
`PARSE_ERROR` は正確でない。しかし `VALIDATION_ERROR` の追加または
`EXECUTION_ERROR` への付け替えは、B66 の error union と既存 consumer の分岐を変える
破壊的変更である。

B80 は「同一性を保つ」課題であり分類体系の再設計ではないため、
code の意味上の負債を受け入れる。将来 code を正す場合は B73 または別課題で
新 code、exhaustive consumer、major / migration を設計する。

## 9. 4面 parity

### 9.1 置ける不変条件

**置ける。** plugin / CLI / MCP は共通 `parseSqlStatement()` / `execute()` 経路から
`KlikeValidationError.message` を観測し、engine ライブラリだけが前置 guard で
トップレベル message を置換している。B80 の allowlist 修正でこの差は除去できる。

ただし各面の全シリアライズ文字列は同一ではない。

- plugin: Error の文字列表現または UI 表示。
- CLI: stderr または JSON error envelope。
- MCP: tool error payload。
- engine ライブラリ: `KsqlEngineError` reject。

したがって parity の比較対象を **原因生成箇所の reason、すなわち
`KlikeValidationError.message` と同一の文字列**に固定する。
prefix、JSON、stack、code の面固有 envelope 完全一致は要求しない。

### 9.2 B76 §17 の撤回

B80 実装と同じ merge で `b76JoinPushdownStep5.test.ts` の
「engine は拒否だけ」「汎用 message を含み reason を含まない」という期待を削除し、
engine を含む配布4面すべてで KLIKE OR 拒否 reason を要求する。

B76 §17.2 の緩和も同じ merge で撤回し、§17.3 を B80 解決済みの記録へ更新する。
「実行面4面」（CLI / MCP / Firefox / Chrome）と「配布面4面」
（plugin / CLI / MCP / engine）の用語区別は維持する。

### 9.3 構造的な限界

現在の `KlikeValidationError` に reason code や構造化 params がないため、
B80 だけで「message 文言が変わっても機械的に同じ reason」と判定することはできない。
B80 の parity は現行 message の一致 / 包含で固定する。
安定した reason code による parity は B73 の構造化後に置き換える。

## 10. B73 との境界

### 10.1 B80 が完了する範囲

- 元 error と `cause` の object identity を維持する。
- 元の具体 message を engine ライブラリのトップレベルまで伝える。
- 4面で同じ拒否 reason を利用者が観測できるようにする。
- 既知 validator の公開可否を allowlist で明示する。

### 10.2 B73 に残す範囲

- `KsqlEngineError.details?` と具体 schema。
- reason code、position、token、field、function、path 等の構造化。
- `messageKey` / params と翻訳カタログ。
- `lang` option と ja / en / zh 切替。
- error code taxonomy の再評価。
- message 文字列ではなく構造化 reason での parity。

### 10.3 B80 が B73 に与える影響

B80 は B73 を楽にする。

- B73 は engine 面だけ失われる reason を特別復元せず、共通の元 error から構造化できる。
- `cause` identity が固定されるため、段階導入時に既存 KLIKE error から details を抽出できる。
- allowlist が validator 境界を明示し、構造化対象の入口になる。

B80 は B73 の schema、key、言語を決めないため、不必要に制約しない。
唯一の制約は、B73 が既存 `code` / `message` / `cause` を無言で変更せず、
optional な構造化 property を純加法で始めることである。

順序は **B80 → B73** とする。B73 を B80 より先に merge しない。

## 11. 実装 Step

| Step | 内容 | 同一 merge 条件 | 見積もり |
|---|---|---|---:|
| 1. 境界 unit を先に追加 | 現行の KLIKE reason 平坦化を再現し、`code` / message / `cause` / API 0 を固定。未知 `Error` は汎用 message のままという漏洩防止負例も追加 | Step 2 と同一 merge 必須。失敗 test だけを独立 merge しない | 0.4〜0.6 人日 |
| 2. class allowlist 実装 | `statementGuard.ts` が `KlikeValidationError` だけ元 message を採用。`normalizeEngineError` の一般分類は変更しない | Step 1、3 と同一 merge 必須 | 0.3〜0.5 人日 |
| 3. B76 配布面 parity 復元 | `b76JoinPushdownStep5.test.ts` の緩和期待を撤回。run / explain の代表 KLIKE 拒否と records API 0 を engine を含む4面で固定 | Step 1、2 と同一 merge 必須 | 0.4〜0.7 人日 |
| 4. 網羅・回帰 test | §5.1 の11条件を table-driven test。LexError / ParseError、read-only、未知 error、error mapping、CLI/MCP/plugin を回帰 | production change と同一 PR。分割 commit 可だが merge は同時 | 0.5〜0.8 人日 |
| 5. docs / release 同期 | B76 §17、B80 起票、B73 追記、tracker、CHANGELOG、必要な公開 engine guide を同期 | Step 2 と同一 release merge 必須 | 0.4〜0.6 人日 |
| 6. release gate | focused → full test、build 5面、engine bundle/declaration/pack/docs smoke、CLI/MCP smoke、Firefox/Chrome の該当拒否 smoke | B79 と同一リリース。生成配布物は version / source と同一 merge | 0.5〜0.8 人日 |

### 11.1 同一 merge が必須の最小集合

次は分離すると一時的に契約・test・文書のいずれかが嘘になるため、必ず同一 merge とする。

1. `statementGuard.ts` の allowlist。
2. engine-library 境界 unit。
3. B76 Step 5 の配布4面 parity expectation。
4. B76 §17 の緩和撤回。

tracker / CHANGELOG / B80・B73 文書も同一 release merge に含める。
release artifact を追跡する運用では、最終 source state から再生成した成果物を同一 merge に含める。

## 12. 受入条件

### 12.1 engine-library

1. §5.1 の11条件すべてで `runQuery()` が `KsqlEngineError` を reject する。
2. `code === "PARSE_ERROR"` を維持する。
3. `message === originalKlikeValidationError.message` とする。
4. `cause` は元 `KlikeValidationError` と同一 object である。
5. `cause.name === "ArgumentError"` を維持する。
6. records / Cursor / metadata API は全て 0 call。
7. `explainQuery()` でも到達可能な代表条件について同じ契約を満たす。

### 12.2 allowlist と漏洩防止

8. 任意の未知 `Error("secret sentinel")` は class allowlist に入らず、
   トップレベル message は `SQL statement could not be parsed` のまま。
9. `name = "ArgumentError"` だけを偽装した別 class も allowlist に入らない。
10. `LexError` / `ParseError` は従来どおり位置・token を含む元 message と cause を保持。
11. `normalizeEngineError()` の6 code mapping と二重 wrap なしを回帰固定。

未知 error の test seam が必要なら、parse 関数差し替え等の広い production hook を足さず、
parse 境界の error 変換を小さな pure internal helper として抽出して直接 test する。

### 12.3 配布4面 parity

12. 同一 KLIKE OR 拒否 SQLで plugin / CLI / MCP / engine 全てが API 0 で拒否する。
13. 4面すべての利用者可視 error に同一 `KlikeValidationError.message` が含まれる。
14. engine だけ汎用 message を期待する既存 test は存在しない。
15. B76 §17.2 の緩和を撤回した文書と test が一致する。
16. Firefox / Chrome plugin の同一 SQL は reason と API 0 が一致する。

### 12.4 非回帰

17. malformed SQL、空文、複文、余剰 token の `PARSE_ERROR` は不変。
18. parse 可能な非 read 文の `READ_ONLY_VIOLATION` は不変。
19. `SEARCH_ABORTED` / `FETCH_LIMIT_EXCEEDED` / `CLIENT_ERROR` /
    `EXECUTION_ERROR` の mapping と cause は不変。
20. valid KLIKE、SELECT / WITH / UNION / SHOW APPS / DESCRIBE、EXPLAIN の結果は不変。
21. parser snapshot は B80 を理由に変更しない。
22. full test、build 5面、engine bundle / declaration / pack / docs smoke、
    CLI / MCP smoke が全て PASS。

## 13. 過去の教訓の反映

### 13.1 B72

元 `KlikeValidationError` に存在しない position、token、field、reason code を
B80 の必須情報にしない。構造化は根拠と schema を設計する B73 に残す。

### 13.2 B71

parity / API 0 fixture の client mock は、実際に要求された `fields` だけを返す。
全 APP 共通の過剰 field catalog や、テストを偶然通す不要 field を持たせない。

### 13.3 B75

新 validator の公開可否を黙って無視しない。parse 後 validator を追加する変更には、
allowlist に追加して4面 reason parity を保証するか、非公開のままにする根拠と
汎用化 test を同時に要求する。

### 13.4 B76

判定は `KlikeValidationError` が実際に投げられたという意味的事実へ直接結び付ける。
plan の存在、SQL 文字列に `KLIKE` が含まれること、normalized code 等の
間接 proxy で公開可否を決めない。

## 14. 見積もり

合計 **2.5〜4.0 人日**。

| 区分 | 見積もり |
|---|---:|
| 境界実装・unit | 0.7〜1.1 人日 |
| 11条件網羅・4面 parity | 0.9〜1.5 人日 |
| docs / tracker / CHANGELOG 同期 | 0.4〜0.6 人日 |
| full / build / pack / browser release gate | 0.5〜0.8 人日 |

B79 と同一リリースの版数・成果物更新工数は共有できるため二重計上しない。
B73 の構造化・多言語化工数は含まない。

## 15. 判断に迷った点

1. **B66 catch の作者意図**:
   漏洩防止を明記した一次資料がなく、簡略化とも防御とも断定できない。
   仕様では「不明」とし、未知 error を従来どおり隠す allowlist 案を採用した。
2. **KLIKE 後段検証を `PARSE_ERROR` に残すか**:
   意味的には不正確だが、code 変更は B66 の semver 契約を破る。
   B80 では非破壊性を優先し、message だけを直す。
3. **B80 で `details` を足すか**:
   optional property は純加法にできるが、schema・reason code・i18n との境界を
   B80 で先取りすると B73 を拘束する。追加しない。
4. **「全検証エラー」の数え方**:
   ソース上の backstop と SQL から到達する error を分けた。
   平坦化対象は実測到達した11条件・1 class とし、parser が先に拒否する右辺型、
   runtime の `validateKlikePushdownPlan()` は対象外とした。
5. **4面での「同じ」の定義**:
   envelope 完全一致は構造的に不可能なので、原因生成箇所の message を parity 対象にした。
   機械安定した reason code parity は B73 に残した。

上記はいずれも実現不可能な矛盾ではない。R1 は実装着手前の Claude レビューへ進められる。

---

## Claude レビュー（2026-07-27・R1 承認）

**結論: R1 を承認する。実装へ進んでよい。**

### A. 網羅性の独立検証

**§5.1 の一覧は網羅的である。** `src/core/sql.ts` を確認したところ、
`parseSqlStatement()` が呼ぶ後段検証は **`validateKlikeStatement()` のみ**だった。

```
src/core/sql.ts:4  import { validateKlikeStatement } from "./klikeValidation";
src/core/sql.ts:9    validateKlikeStatement(stmt);
src/core/sql.ts:17   statements.forEach(validateKlikeStatement);
```

したがって `PARSE_ERROR` 以外の例外源は `KlikeValidationError` に限られ、
**class identity による allowlist で過不足がない**。

**§5.2 の対照表が特に良い。** 「平坦化されない」ものを、なぜ平坦化されないか
（parser が後段 validator より先に拒否する）とともに示しており、
**allowlist が狭すぎないことの根拠**になっている。

`validateKlikeStatement()` の右辺型再検査を「AST を直接渡す経路への backstop であり
現行の平坦化対象数に加えない」と切り分けた判断も妥当である。

### B. 意識的なトレードオフ＝`code` は `PARSE_ERROR` のまま

engine ライブラリの `code` は5種（`PARSE_ERROR` / `READ_ONLY_VIOLATION` / … / `EXECUTION_ERROR`）で、
KLIKE の配置制約は**意味的には parse error ではない**。R1 はこれを承知のうえで
`code` を維持し、`message` だけを正確にする**非破壊の bug fix** として設計している。

**この判断を支持する。** 理由:

- **利用者の実害は message にある。**「SQL statement could not be parsed」を見て
  構文エラーを探すのが問題であり、`code` の粒度が原因ではない。
- `code === "PARSE_ERROR"` で分岐している利用者コードを壊さない。
- **`code` の正確性は B73 の `details?` / reason code で補える。**
  粗い `code` ＋ 構造化 `details` という設計は、`code` を細分化するより拡張性が高い。

ただし **B73 着手時に「`code` を意味的に正確にするか」を明示的に判断すること**。
その時点では破壊的変更の是非として扱う必要がある。本 spec の判断は
「**B80 の範囲では変えない**」であって「永久に変えない」ではない。

### C. B76 §17 の緩和撤回について

**実装・parity テストと同一 merge で撤回する**という設計を支持する。
緩和を残したまま実装だけ入れると、「4面で同じ reason」が実際には満たされているのに
テストが要求しない状態が生まれ、次の変更で静かに壊れる。

### D. 実装時の追加確認事項

1. **`cause` の identity を壊さないこと。** §7 のとおり `cause` は現在も保持されている。
   allowlist を通す際に再ラップして identity を失わせないこと。
2. **allowlist は class identity で判定すること**（`name === "ArgumentError"` のような
   文字列一致にしない）。`KlikeValidationError` は `name` を `"ArgumentError"` に
   上書きしているため、name ベースだと将来の別クラスを誤って通す。
3. **B76 の教訓**: 「plan の存在」のような間接的条件で判定しない。
   ここでは class identity という直接的な条件なので問題ないが、実装時に
   「エラーが `parseSqlStatement()` 由来かどうか」といった間接条件へ流れないこと。
4. **11条件すべてを回帰テストで固定すること**（§5.1 の表）。1件でも漏れると、
   将来の変更で静かに平坦化へ戻りうる。

### E. 見積もり

6 Step / 2.5〜4.0 人日を妥当と判断する。B79 と同一リリースのため、
版数・成果物更新を二重計上していない点も正しい。
