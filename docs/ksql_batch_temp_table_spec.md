# kSQL バッチ実行・一時テーブル 仕様書

- 作成日: 2026-07-09
- 更新履歴:
  - 2026-07-09 R1: INSERT_SELECT を同一 `ksql_mutate` バッチ内完結に修正 / `ksql_explain` のフェーズ境界明記 / タイムアウト時の状態値を3値に固定 / `#t@dev` を LexError に変更
  - 2026-07-09 R2: `results` の対象を「結果セットを返す read-only 文」に拡張定義 / 単文 CREATE・DROP TEMP TABLE を ArgumentError で拒否
  - 2026-07-09 R3: リリース方針決定(フェーズ1・2 を v1.4.0 で一括リリース)/ `--console` を後方互換方式に変更
  - 2026-07-09 R4: `--console` の判定アルゴリズムを5段判定として確定(`CREATE TEMP TABLE` 開始のバッチ構築モードを追加)
  - 2026-07-09 R5: バッチ構築モードの終端を空行から明示メタコマンド `:run` に変更(SQL 整形用空行との衝突回避、既存 `:clear` / `:buffer` 体系との整合)
  - 2026-07-09 R6: バッチ構築モードの判定を「先頭コメント除外 + CREATE_TEMP_TABLE 文包含」の2条件に強化 / メタコマンドはバッファ非空でも解釈すると明記
  - 2026-07-09 R7: `#` レキサ実装を専用読み取り分岐に変更(`isIdentStart` 拡張だと `#` が識別子途中にも許容されるため)
  - 2026-07-09 R8: エイリアス位置(明示 AS・暗黙とも)の `#` 識別子を拒否と明記(暗黙 alias が `APP#x` を受理してしまう抜け道を封鎖)
  - 2026-07-09 R9: alias 拒否の対象に列 alias(`SELECT ... AS #x`)を含むと明確化
  - 2026-07-09 R10(S1 実装後): §8.2 の継続可能判定を `LexError.unterminated` フラグ + `ParseError` の EOF トークン基準に変更(位置ベースを廃止、実装計画 R10 と同期)
  - 2026-07-09 R11(S2 実装後): §4.3 に単文入力での一時テーブル参照の拒否を明記(単文 = 1文のバッチとして未定義参照と同じ扱い)
  - 2026-07-09 R14(S3 実装後): §4.3 の再定義エラーを「生存中の同名のみ」と明確化(DROP 後の再 CREATE は許容、個数上限は同時数)
  - 2026-07-09 R15(S3 実装後): 空入力(空文字列・`;` のみ)を `ArgumentError: SQL is empty.` として拒否(§9 に追加)
  - 2026-07-09 R18(S5 実装後): `ksql_validate` のバッチ対応を実装(§7.1)。外部から見える変更: ①バッチ入力が ParseError ではなくサマリ + `statements[]` の正常応答になる、②単文入力にも `statements[]`(要素1)が付く、③単文の CREATE/DROP TEMP TABLE は validate 段階で ArgumentError、④`appIds` が文字列走査から AST ベース(文ごと)に変わり文字列リテラル内の誤検出がなくなる。`ksql_query` / `ksql_mutate` へのバッチ入力は S6 / フェーズ2 対応まで `ArgumentError: batch SQL ... not supported ... yet.` で明示的に拒否
  - 2026-07-09 R19(S6 実装後): `ksql_query` の read-only バッチ受理を実装(§6.2・§7.2)。`maxTotalRecords` 超過時の挙動を ArgumentError と確定(§6.2 に追記)。バッチでは `timeout` を合計タイムアウトとして扱う(§5.7。HTTP クライアントの per-request タイムアウトにも同値が渡る)。DML 混在バッチは `ArgumentError: batch contains DML statements. Use ksql_mutate.`
  - 2026-07-09 R20(S7 実装後): CLI 実装(`-f` 複文・`--continue-on-error`・console)。§8.2 の「完結単文の `;` なし即実行」を撤回し **`;` ゲートを維持**(R3〜R4 の前提「現行 console は改行=実行」が誤りで、現行は従来から `;` 終端実行のため。撤回により複数行入力の途中実行という退行を回避)。判定順を6段に再構成(メタ → バッチ構築 → `;` まで蓄積 → 完結実行 → 継続可能失敗 → 即エラー)。`:run` エラー時はバッファ保持、`@profile` 構文は判定用パース前に正規化
  - 2026-07-09 R21(S8): 公開ドキュメントへ反映(言語リファレンス §25 / MCP server spec 7.2.1・7.5.1 / ksql_mcp_changes 11.5 / console spec)。フェーズ1 実装完了
  - 2026-07-09 R27(M3 実装後): バッチ EXPLAIN を実装(§7.4)。`ksql_explain` のバッチ入力は全文プランの配列(`statements[]` の `plan: string[]`)を返し、CLI の `--dry-run` もバッチ対応。一時テーブル参照文は既存プラン生成に通さず「FULL_SCAN(一時テーブル参照)/ 実体化前のため行数不明 / プッシュダウンなし」を明示(既存 `resolveSelectMode` が cteName 参照を SIMPLE と誤表示するため)
  - 2026-07-09 R26(M4 実装後): 一時テーブル経由の `INSERT_SELECT` を解禁(§7.3 の実装)。ソース判定は「SELECT 側に APP 参照がなく一時テーブル参照が1つ以上」(`tempOnlySource`)。実体化済み行数は confirm("INSERT") 経由で `dmlMaxRows` / `dmlTotalMaxRows` の対象になる(§7.3 の集計対象に明記)。§9 に APP 混在ソースのエラーメッセージを追加
  - 2026-07-09 R24(M1 実装後): `ksql_mutate` の DML バッチ受理を実装(§7.3)。静的ガード(INSERT_SELECT 拒否・WHERE なし・文ごと insertValuesCount)は validate-all-first で実行前に適用。`dmlTotalMaxRows` の集計対象(INSERT 静的 + UPDATE/DELETE 実行時、UPSERT 対象外)と混在バッチの取得上限・影響件数の文ごと展開を §7.3 に明記
- ステータス: フェーズ1 実装完了(S1〜S8。実機検証は未実施、リリースはフェーズ2 完了後に v1.4.0 一括)
- 対象バージョン: v1.4.0(フェーズ1・2 を同時リリース。フェーズは実装・マージの順序であり、リリース単位ではない)
- 前提資料: [multi-statement-temp-table-evaluation.md](multi-statement-temp-table-evaluation.md)(採否評価・コード調査)

---

## 1. 概要とスコープ

kSQL に以下を追加する。

1. **バッチ実行**: 1回のツール呼び出し / CLI 実行で、`;` 区切りの複数 SQL 文を**順次**実行する
2. **一時テーブル**: バッチ内で `CREATE TEMP TABLE #name AS SELECT ...` により中間結果をサーバー内に実体化し、後続文から参照する

### 対象外(本仕様では扱わない)

| 項目 | 理由 |
|---|---|
| 文レベルの並列実行 | レート制御基盤が未整備。基盤整備後に別仕様として再評価(評価ドキュメント §3) |
| トランザクション | kintone API の制約により非対応(既存の制限事項を踏襲) |
| セッション / プロセススコープの一時テーブル | MCP のステートレス設計を維持するため。一時テーブルの寿命はバッチ内のみ |
| 一時テーブルへの DML(`INSERT INTO #t` 等) | フェーズ1では非対応(エラー)。需要が確認できたら再検討 |
| `SELECT ... INTO #t` 構文 | `CREATE TEMP TABLE ... AS SELECT` に一本化 |

### フェーズ分割

フェーズは実装・レビューの順序を示す。**リリースはフェーズ2 完了後に v1.4.0 として一括**で行う(フェーズ1 単独ではリリースしない)。

- **フェーズ1**: read-only バッチ(SELECT / EXPLAIN / SHOW / DESCRIBE + 一時テーブル)。`ksql_query` と CLI で受理。`EXPLAIN` **文**をバッチに含めることは可能だが、`ksql_explain` **ツール**の複文入力対応はフェーズ2(§7.4)
- **フェーズ2**: DML を含むバッチ。`ksql_mutate` で受理。バッチ EXPLAIN、一時テーブル経由の `INSERT_SELECT` 解禁

---

## 2. 用語

| 用語 | 定義 |
|---|---|
| バッチ | 1回の呼び出しで渡された、`;` 区切りの2文以上の SQL 文列。1文のみの入力は「単文」であり従来動作を維持する |
| 一時テーブル | `CREATE TEMP TABLE` でバッチ内に実体化された行データ。名前は `#` 接頭辞で識別する |
| read-only バッチ | DML(INSERT / UPDATE / DELETE / UPSERT 等)を1文も含まないバッチ。一時テーブルの CREATE / DROP は read-only 扱い |
| DML バッチ | DML を1文以上含むバッチ |

---

## 3. 設計原則

本プロダクトの安全設計3本柱を複文でも維持する。

1. **ツール分離**: read-only バッチは `ksql_query`、DML バッチは `ksql_mutate` のみが受理する。**新ツールは追加しない**(設計判断 D1)
2. **validate-all-first**: 実行前に全文をパース・分類し、1文でも不正ならバッチ全体を拒否する
3. **多層 DML ガード**: `dmlMaxRows` 等のガードを「文ごと + バッチ合計」の2段で適用する(フェーズ2)

> **設計判断 D1(ksql_batch を新設しない理由)**: read-only / DML のツール境界こそが安全設計の核であり、バッチ専用ツールを作ると境界の説明が二重になる。また MCP クライアント(LLM)にとってツール数の増加は誤選択リスクになる。

---

## 4. 構文仕様

### 4.1 複文

- 文と文の区切りは `;`(セミコロン)。最終文の `;` は任意(現行の単文動作と同じ)
- 空文(`;;` や末尾の余分な `;`)は無視する
- 文字列リテラル・コメント内の `;` は区切りとして扱わない(レキサがトークン化済みのため自然に満たされる)
- バッチ内の文数上限: **20文**(超過は `ParseError`)

### 4.2 一時テーブル識別子

- `#` + 識別子(`#high_customers`、`#集計結果` など)。`#` は一時テーブル名の**先頭のみ**で有効
- レキサは `#` を識別子の**先頭文字としてのみ**受理する(**現行レキサは `#` を読めないため変更が必要**)。実装は `isIdentStart` への追加ではなく専用の読み取り分岐とする — `isIdentStart` に足すと識別子の継続文字判定(`src/lexer/lexer.ts:291-293`)にも波及し、`APP#x` や `#a#b` が1つの識別子になってしまうため。`#` 単独や `#1`(直後が識別子先頭文字でない)は `LexError`
- テーブル参照位置(FROM / JOIN / CREATE / DROP)以外での `#` 識別子は `ParseError`。**エイリアス位置も不可** — テーブル alias(明示 `AS #x`・暗黙 `FROM APP100 #x`)と**列 alias**(`SELECT 顧客名 AS #x`)の両方で拒否する。これにより `APP#x` がレキサで `APP` + `#x` に分割された結果「`APP` の alias `#x`」として受理される抜け道と、列 alias 経由で `#` 名が結果セットに漏れる経路の両方を塞ぐ
- 大文字小文字の扱いは既存の CTE 名解決と同一規則
- `@profile` は付与不可。`APP@profile` の正規化は `APP<数字>` トークンのみを対象とするため(`src/node/appProfiles.ts:83`)、`#t@dev` は正規化を素通りしてレキサに到達する。レキサで `#` 識別子直後の `@` を**明示メッセージ付きの `LexError`** として拒否する(§9)

### 4.3 CREATE TEMP TABLE / DROP TEMP TABLE

```sql
CREATE TEMP TABLE #name AS
SELECT ...;          -- SELECT は WITH(CTE)・UNION を含む任意の SELECT 文

DROP TEMP TABLE #name;
```

- `CREATE TEMP TABLE`: `AS` 以降の SELECT を即時実行し、結果を一時テーブルとして実体化する
- 同名の再定義は**エラー**(`OR REPLACE` は非対応。需要が出てから検討)。エラーになるのは**生存中の同名**のみで、`DROP TEMP TABLE` で破棄した後の同名再 CREATE は許容する(個数上限 §5.6 も「同時」数で数え、DROP で枠が空く)
- `DROP TEMP TABLE`: 実体化済みの一時テーブルを破棄する。未定義名の DROP はエラー。バッチ終了時に全一時テーブルは自動破棄されるため、`DROP` は主にメモリの早期解放用
- 文タイプ(statementType)は `CREATE_TEMP_TABLE` / `DROP_TEMP_TABLE`。両者とも **read-only 扱い**(kintone に書き込まないため)
- 単文(バッチでない入力)としての `CREATE TEMP TABLE` / `DROP TEMP TABLE` は、作成直後に破棄されて無意味なため **`ArgumentError` として拒否**する(§9)。これにより単文入力の結果ペイロードは既存の文タイプのみとなり、後方互換(§6.1)と衝突しない
- 同様に、単文入力での**一時テーブル参照**(`SELECT ... FROM #t` 等。JOIN・サブクエリ・WITH 内・`INSERT_SELECT` のソースを含む)は、参照先が存在し得ないため `ParseError: temp table #t is not defined in this batch.` として拒否する(単文 = 1文のバッチであり、未定義参照の静的検証と同じ扱い)

---

## 5. 実行セマンティクス

### 5.1 スコープと寿命

- 一時テーブルの寿命は**バッチ内のみ**。呼び出し終了(正常・異常とも)で必ず破棄される
- サーバー・プロセス・セッションをまたぐ共有は行わない(ステートレス設計の維持)

### 5.2 validate-all-first

実行前にバッチ全文に対して以下を検証し、1件でも違反があれば**1文も実行せず**バッチ全体を拒否する。

1. 全文のパース成功
2. ツール境界: `ksql_query` は read-only 文のみ / DML を含む場合は `ksql_mutate` を要求(フェーズ2まで DML バッチ自体を拒否)
3. 一時テーブルの静的解決: 参照される `#name` が先行文で CREATE されていること、同名の再 CREATE がないこと、CREATE 前の参照・DROP 後の参照がないこと
4. 文数上限(20文)以内であること

### 5.3 実行順序と失敗セマンティクス

- 文は記述順に**直列**実行する
- **fail-fast(既定)**: 実行時エラーが発生した文で停止し、以降の文は `skipped` とする
- **continueOnError(opt-in、read-only バッチのみ)**: エラー文を記録して次の文へ進む。ただし**失敗した `CREATE TEMP TABLE` に依存する後続文は実行せず `skipped`** とする(依存スキップ)。依存関係は 5.2 の静的解決結果を用いる
- 文ごとの状態は `success` / `error` / `skipped` の3値で報告する(§6)
- トランザクションは無いため、フェーズ2の DML バッチでは**途中失敗時に前半の DML だけ反映された状態が起こり得る**。これを結果エンベロープで文ごとに明示する(ロールバック風の実装は行わない)

### 5.4 一時テーブルの参照

- 一時テーブルを FROM / JOIN に含む文は、CTE 参照と同じ機構(`ProcessRow[]` の FULL_SCAN 注入、`src/execute.ts:828-861,917`)で実行する
- **REST API への WHERE プッシュダウンは構造的に発生しない**(参照は常にインメモリ FULL_SCAN)。kintone クエリ最適化が効くという期待を持たせないよう、EXPLAIN にも FULL_SCAN である旨を表示する
- CTE と一時テーブルは同一文内で混在可能。名前解決の優先順位: CTE 名は `#` を持たないため衝突しない

### 5.5 列型の導出

一時テーブルの列型は実体化元 SELECT の結果から導出する。用途は検証・`EXPLAIN` 表示・ORDER BY / 比較演算の意味づけであり、プッシュダウンには使わない。

| 元の列 | 導出型 |
|---|---|
| フィールド参照 | 元フィールドの型 |
| 集計関数(COUNT / SUM / AVG 等) | NUMBER |
| 演算列・関数列 | 演算結果の型(既存の式型付け規則に従う) |
| 全行 NULL の列 | SINGLE_LINE_TEXT(文字列)として扱う |

### 5.6 上限

| 項目 | 上限 | 超過時 |
|---|---|---|
| バッチ内の文数 | 20 | validate で拒否 |
| 一時テーブル個数(バッチ内同時) | 16 | validate で拒否 |
| 一時テーブル1個の行数 | 10,000(`fetchAll` の既定上限と同値) | 実行時エラー。**`onLimit: truncate` は一時テーブルの実体化には適用しない**(暗黙の欠損が後続文の結果を静かに歪めるため、常に error) |

### 5.7 タイムアウト

- `timeout` はバッチ**合計**に適用する
- 到達時はその時点で実行中の文を中断する。文ごとの状態は §5.3 の3値を維持し、4つ目の状態は導入しない: 中断された文は `error`(`error.code: "TimeoutError"`)、未実行の文は `skipped`(`skippedReason: "timeout"`)とする

---

## 6. 結果仕様(エンベロープ)

### 6.1 単文入力(後方互換)

入力が1文のみの場合、**現行のペイロードをそのまま返す**。既存クライアントへの影響はない。単文の `CREATE TEMP TABLE` / `DROP TEMP TABLE` は受理しない(§4.3)ため、単文入力に新しいペイロード形は発生しない。

### 6.2 バッチ入力

```jsonc
{
  "ok": true,                    // 全文 success のときのみ true
  "batch": true,
  "statementCount": 4,
  "statements": [
    { "index": 0, "type": "CREATE_TEMP_TABLE", "status": "success",
      "tempTable": "#high", "rowCount": 1200 },
    { "index": 1, "type": "SELECT", "status": "success", "resultIndex": 0 },
    { "index": 2, "type": "SELECT", "status": "error",
      "error": { "code": "FetchError", "message": "..." } },
    { "index": 3, "type": "SELECT", "status": "skipped",
      "skippedReason": "fail-fast" }
  ],
  "results": [                   // 結果セットを返す文の結果。statements[].resultIndex で対応付け
    { "columns": [...], "rows": [...], "rowCount": 42, "warnings": [] }
  ],
  "warnings": []
}
```

- `results` の対象は**結果セットを返す read-only 文**(SELECT / SHOW 系 / DESCRIBE / EXPLAIN — いずれも既存実装で `SelectResult` として返る)。ただし **`CREATE TEMP TABLE` の実体化結果(AS 句の SELECT)は含めない**(返すのは `tempTable` 名と `rowCount` のみ)。中間結果を LLM のコンテキストに載せないことが一時テーブルの主目的であるため
- `maxRecords` は `results` に入る各結果セットに**文ごと**に適用する(MCP 既定 500。EXPLAIN のプラン行にも一律適用されるが実質影響しない)。任意の `maxTotalRecords` でバッチ合計行数の上限も指定できる(既定なし。超過時は `ArgumentError: batch total rows (N) exceed maxTotalRecords (M).`)
- `skippedReason` は `"fail-fast"` / `"dependency: #name"`(依存スキップ)/ `"timeout"` のいずれか

---

## 7. MCP ツール仕様

### 7.1 ksql_validate

入力は現行どおり(`sql`, `profile`)。出力を拡張する。

- 単文入力: 現行のスカラー形(`statementType` 等)を維持し、加えて `statements` 配列(要素1)を返す
- バッチ入力: `statements` 配列 + バッチサマリを返す

```jsonc
{
  "ok": true,
  "batch": true,
  "statementCount": 3,
  "isReadOnlyBatch": true,
  "containsDml": false,
  "tempTables": ["#high"],
  "canRunWithQueryTool": true,
  "requiresMutationTool": false,
  "statements": [
    { "index": 0, "statementType": "CREATE_TEMP_TABLE", "isDml": false,
      "isReadOnly": true, "appIds": [100],
      "tempTablesCreated": ["#high"], "tempTablesReferenced": [] },
    ...
  ]
}
```

### 7.2 ksql_query(フェーズ1)

- read-only バッチを受理する。DML を1文でも含む場合は現行同様に拒否し、`ksql_mutate` を案内する
- 入力スキーマ追加: `continueOnError: z.boolean().optional()`(既定 false)、`maxTotalRecords: z.number().int().positive().optional()`
- `maxRecords` / `onLimit` の適用対象は「`results` として返却する結果セット」のみ。一時テーブルの実体化には適用しない(§5.6・§6.2)

### 7.3 ksql_mutate(フェーズ2)

- DML バッチを受理する。`allowDml` / `confirmText` / `dmlMaxRows` は現行どおり必須
- `dmlMaxRows` は**文ごと**に適用。任意の `dmlTotalMaxRows` でバッチ合計影響行数の上限も指定できる(既定はガードなし = 文ごとガードのみ)
- DML バッチでは `continueOnError` は**指定不可**(常に fail-fast)。DML の続行判断を機械任せにしない
- `dmlTotalMaxRows` の集計対象は INSERT(VALUES 行数を静的に加算)、UPDATE / DELETE(実行時の対象件数を加算)、および**一時テーブル経由の `INSERT_SELECT`(実体化済み行数を書き込み前に実行時加算)**。**UPSERT の影響行数は対象外**(単文 `ksql_mutate` の挙動と同等。将来課題)
- DML バッチに read-only 文を混在させた場合、その取得上限も `dmlMaxRows + 1` になる(ksql_mutate は DML 用ツールであり、大きな SELECT は `ksql_query` を使う)
- DML の影響件数(insertedCount / updatedCount / deletedCount 等)は `statements[]` の各エントリに展開する。途中失敗時に「どこまで反映されたか」を文ごとに読み取れる
- 一時テーブル経由の `INSERT_SELECT` を解禁する: `INSERT INTO APPxxx SELECT ... FROM #t` は SELECT ソースが**一時テーブルのみ**の場合に受理する。一時テーブルはバッチスコープのため、**`CREATE TEMP TABLE` は同一の `ksql_mutate` バッチ内に含める必要がある**(呼び出しをまたぐ参照は不可)。書き込み前に実体化済み行数が確定するため、`dmlMaxRows` が実行時の確実なガードとして機能する。kintone アプリを直接ソースとする `INSERT_SELECT` は引き続き拒否
- 事前の件数確認(承認判断)は、同等の `CREATE TEMP TABLE` + `SELECT COUNT(*)` バッチを `ksql_query` で実行して行う(付録参照)。プレビューと本実行は別呼び出しであり一時テーブルは再実体化されるため、**両者の間でデータは変動し得る**。最終的な安全保証はプレビューではなく、実行時に確定行数へ適用される `dmlMaxRows` が担う

### 7.4 ksql_explain(フェーズ2でバッチ対応)

- **フェーズ1では `ksql_explain` は単文入力のみ**(現行どおり、複文入力はエラー)。フェーズ1でバッチのプランを見たい場合は `ksql_query` のバッチに `EXPLAIN` 文を含める
- フェーズ2でバッチ入力に対応し、全文のプランを配列で返す(dry-run 用途)
- 一時テーブル参照文のプランには「FULL_SCAN(インメモリ)」「実体化前のため行数不明」を明示する

---

## 8. CLI 仕様

### 8.1 `-f <file.sql>`(フェーズ1)

- ファイル内の複文をバッチとして実行する。出力は結果セットごとに区切って表示
- `--continue-on-error` フラグを追加(read-only バッチのみ有効)

### 8.2 `--console`(フェーズ1)

改行(Enter)ごとに次の順で判定する。**単文入力の操作感は従来(`;` 終端で実行)と完全互換**。

> 注記: R3〜R4 時点の本節は「現行 console は改行=実行」という誤った前提に基づき「完結した単文は `;` なしで即実行」としていたが、現行実装・§5.2 とも従来から **`;` 終端で実行**である(実装時に確認、R20)。`;` なし即実行にすると `SELECT * FROM APP100` の続きに WHERE を書く意図の複数行入力が途中実行される退行になるため、このルールは撤回し `;` ゲートを維持する。

1. **メタコマンド**: `:` で始まる行は**バッファ状態に関わらず**メタコマンドとして解釈する(SQL としてバッファに混入させない)
2. **バッチ構築モード**: ①**先頭の空白・コメントを除いた**先頭が `CREATE TEMP TABLE`(入力途中でも判定可能。コメント付き貼り付けを含む)、または②パース完結した入力に `CREATE / DROP TEMP TABLE` 文を含む場合、行末 `;` でも実行せず蓄積を続け、**メタコマンド `:run` でバッファ全体をバッチとして実行**する。単文の `CREATE TEMP TABLE` は §4.3 により拒否されるため即実行は常に誤りであり、これが複数文バッチを対話的に構築する経路となる。バッファ内の空行・`;` 行は保持する
3. **`;` 終端までの蓄積(従来互換)**: 行末が `;` でなければ継続行として蓄積する(従来の複数行入力と同一)
4. **`;` 終端・パース完結**: 1文なら従来どおり単文実行、2文以上ならバッチとして実行(例: `SELECT * FROM APP1; SELECT * FROM APP2;` を1行入力)
5. **`;` 終端・継続可能なパース失敗** → 蓄積を継続する。判定は2系統: `LexError` は `unterminated` フラグ(未終端の文字列・バッククォート・ブロックコメント)、`ParseError` はエラートークンが EOF を指すこと。これにより**文字列リテラル内の `;` で誤実行しない**(従来挙動より安全)
6. **`;` 終端・それ以外のパース失敗**(typo・括弧の閉じ忘れ等。例: `SELEC * FROM APP1;`) → 即エラー表示し、バッファを破棄する(入力を飲み込み続けない)

- 通常モードでの空行・`;` のみの入力は無視する
- `:run` は既存のメタコマンド体系(`:help` / `:clear` / `:buffer` / `:edit` 等)への追加。`:run` がエラー(空バッファ・パース未完)のときバッファは**保持**する(`:edit` / `:clear` で修正できるように)。入力途中の破棄は既存の `:clear` をそのまま使う
- `APP100@profile` 構文は判定用パースの前に正規化する(実行に渡す SQL は生のまま)

### 8.3 DML バッチの確認(フェーズ2)

- 確認プロンプトはバッチ全体で1回とし、含まれる**全 DML 文の一覧**(タイプ・対象アプリ・WHERE 有無)を表示して確認を取る
- `--yes` は現行どおり確認をスキップする

---

## 9. エラー仕様

既存の `ArgumentError:` / `ParseError` 等の規約に従う。主な追加エラー:

| 状況 | メッセージ例 |
|---|---|
| DML を含むバッチを ksql_query に渡した | `ArgumentError: batch contains DML statements. Use ksql_mutate.` |
| 未定義の一時テーブル参照 | `ParseError: temp table #t is not defined in this batch.` |
| 同名の再 CREATE | `ParseError: temp table #t is already defined.` |
| 一時テーブルへの DML | `ParseError: DML on temp table #t is not supported.` |
| `@profile` 付き一時テーブル名 | `LexError: @profile is not allowed on temp table #t.`(レキサで検出。§4.2) |
| 文数超過 | `ParseError: batch exceeds 20 statements.` |
| 単文の `CREATE TEMP TABLE` / `DROP TEMP TABLE` | `ArgumentError: CREATE TEMP TABLE requires a batch (temp tables are batch-scoped).` |
| APP をソースに含む `INSERT_SELECT`(バッチ内) | `ArgumentError: INSERT_SELECT in a batch must select from temp tables only. (statement N)` |
| 空入力(空文字列・`;` のみ) | `ArgumentError: SQL is empty.` |
| 一時テーブル行数超過 | `FetchAllLimitError`(既存を流用) |

---

## 10. 制限事項(利用者向けドキュメントに記載する内容)

- 一時テーブルの参照は常にインメモリ FULL_SCAN であり、kintone クエリの最適化(WHERE プッシュダウン)は効かない
- トランザクションは無い。DML バッチの途中失敗時、前半の DML は反映されたまま残る(結果の文ごとレポートで確認すること)
- 一時テーブルはバッチ終了で必ず破棄される。呼び出しをまたいで参照することはできない

---

## 11. 互換性

- 単文入力の挙動・ペイロードは全ツール・CLI で不変(§6.1)
- `ksql_validate` の既存フィールドは単文入力で維持
- 言語リファレンスの制限事項表に「一時テーブルのスコープ」「バッチの非トランザクション性」を追記する

---

## 付録: 利用例

```sql
-- 2段階 DML フロー(フェーズ2)。一時テーブルはバッチスコープのため
-- 呼び出しをまたいで参照できない。プレビューと本実行はそれぞれ独立した
-- バッチとして一時テーブルを再実体化する。

-- 呼び出し1: ksql_query(プレビュー。件数を確認して承認判断)
CREATE TEMP TABLE #targets AS
SELECT $id, 顧客名, 売上
FROM APP100
WHERE 売上 > 1000000;

SELECT COUNT(*) FROM #targets;

-- 呼び出し2: ksql_mutate(本実行。CREATE を同一バッチに含める)
-- プレビューとの間でデータは変動し得るが、実体化済み行数に対する
-- dmlMaxRows が実行時のガードとして機能する。
CREATE TEMP TABLE #targets AS
SELECT $id, 顧客名, 売上
FROM APP100
WHERE 売上 > 1000000;

INSERT INTO APP200 (顧客名, 売上)
SELECT 顧客名, 売上 FROM #targets;
```

```sql
-- 相関サブクエリの回避(フェーズ1)
CREATE TEMP TABLE #latest AS
SELECT 顧客ID, MAX(受注日) AS 最新受注日
FROM APP300
GROUP BY 顧客ID;

SELECT a.顧客名, t.最新受注日
FROM APP100 a
INNER JOIN #latest t ON a.顧客ID = t.顧客ID;
```
