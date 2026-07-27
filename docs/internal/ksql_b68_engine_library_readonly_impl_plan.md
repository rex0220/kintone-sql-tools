# B68 実装計画 — engine ライブラリの read-only 拡張（許可構文を MCP READ 基準へ統一）

- 作成: 2026-07-27
- ステータス: 📋 **仕様確定・実装待ち**。オーナー方針＝**Phase A と B を 1 リリースにまとめる**。
- 評価: [B68 評価](ksql_b68_engine_library_readonly_extensions_evaluation.md)
- 関連: [B66 ライブラリ](ksql_b66_engine_library_evaluation.md) / [B80 reason 保持](ksql_b80_engine_library_reason_spec.md) / [B76 Phase B](ksql_b76_join_pushdown_phase_b_spec.md) / [B79](ksql_b79_outer_join_search_abort_issue.md)

## 0. 前提（着手前に実証済み）

評価 §1〜§6 で確定済みの事実。**再調査不要。**

1. **実需（オーナー確認）** — ①ダッシュボードで `VALIDATE` 結果を KPI／グラフ表示 ②一時テーブルで
   複数アプリ JOIN をシンプルに管理。**ダッシュボードは engine library を使っている。**
2. **能力表が2つある** — MCP は `isReadOnlyStatement()`（`src/core/dmlGuard.ts`・意味的判定）、
   ライブラリだけ手書き allowlist（`assertReadStatement`・単文限定）。
3. **結果型** — 既存レコード `VALIDATE` は `SELECT` と**同じ `SelectResult`** ＋ 任意 `validateStats`。
   DML `VALIDATE ONLY` は**別型 `DmlValidationResult`**（追加フィールド 10 以上）。
4. **`BatchEnvelope`**（`src/output/batchEnvelope.ts`）が CLI / MCP 共通の batch 形として既にある。
5. **現状の拒否**（実測）— `VALIDATE` / `CREATE TEMP TABLE` / `ASSERT` は `READ_ONLY_VIOLATION`、
   複文は `PARSE_ERROR`。**そのメッセージが案内する「バッチ実行 API」が library に存在しない。**

## 0.1 【2026-07-27 オーナー補足】本課題の本質は「面をまたいだ契約の不一致」

利用の実態が示された。

1. **生成 AI が kSQL MCP を使って、ダッシュボードで使う SQL を作成する**
2. **ダッシュボードはその SQL を engine library で実行する**

つまり **SQL の作成面（MCP）と実行面（library）が別**である。

したがって許可構文の差は「library に機能が足りない」ではなく、
**AI が MCP で検証して通した SQL が、本番の library で落ちる**という事故になる。
**作成面で通ることが、実行面で通ることを保証していない。**

これは B76 で扱った「押し下げ能力表が2つ」と同型だが、**利用者から見た症状はより悪い**。
押し下げの差は性能差にとどまるが、こちらは**動くはずのものが動かない**。

### 0.1.1 したがって受入条件に「機械的な parity」を追加する

差を埋めるだけでは、**将来また開く**。文型を片面に足したときにもう片面が置き去りになる構造は
そのままだからである（§2.1 の一本化はこれを狙っている）。

**共通の SQL コーパスに対して、MCP が受理する read-only 文は library も受理することを
テストで固定する。**例外（`IMPORT` / `APPLY`）は**明示的な列挙**とし、
列挙にない差が生まれたらテストが落ちるようにする。

これにより「AI が MCP で書いた read-only SQL は library で必ず動く」が**契約として保証される**。

## 1. スコープ

### 1.1 対象

| 区分 | 内容 |
|---|---|
| **判定の統一** | ライブラリの手書き allowlist を捨て、**`isReadOnlyStatement()` へ寄せる** |
| **単文の解禁** | **既存レコード `VALIDATE`**（`runQuery` を純加法で拡張） |
| **複文の解禁** | **`runBatch()` を新設**。一時テーブル・`SET` / `DECLARE`・`ASSERT` |
| **追加ゲート** | `APPLY` を持つ文は拒否、`IMPORT` は既定 off |
| **公開面** | 型定義・README・言語リファレンス・移行案内 |

### 1.2 非スコープ（fail-closed 継続）

- **DML `... VALIDATE ONLY`** — 別型で規模が違い、read-only ダッシュボードの用途からも外れる。
  将来含めるなら `BatchResult.results[]` の判別共用体として扱う（§2.6）
- **書き込み DML**（`runMutation` は B66 Phase2 の別課題・**本計画と直交**）
- **`IMPORT`** の有効化
- `searchAborted` 契約の変更（§2.7）

## 2. 設計判断（確定済み・実装時に蒸し返さない）

### 2.1 判定は `isReadOnlyStatement()` に一本化する

ライブラリ独自の文型列挙を**残さない**。残すと B76 で苦しんだ「能力表が2つ」が再生する。

```ts
writesKintone(stmt)       = isDmlType(stmt.type) && !stmt.validateOnly
isReadOnlyStatement(stmt) = !writesKintone(stmt) && (isReadOnlyType(...) || isDmlType(...))
```

**ただし「MCP と完全に同一」にはしない。** MCP 側も分類器だけで判定しておらず、
面の事情による追加ゲート（§2.5）を明示的に持つ。

### 2.2 `runQuery` は純加法で拡張する

- **新しい関数を作らない。判別共用体にもしない。**
- `QueryResult` に**任意フィールド `validateStats?: { errorRecords; errorCount }`** を足す。
  `query.ts` の `SelectResult → QueryResult` の写しに1行足すだけ。
- **既存利用者に完全に非破壊**（返る型にフィールドが1つ増える／これまで例外だった SQL が通る）。

> `explainQuery` の前例から `runValidate()` を分ける案は**却下済み**。
> `EXPLAIN` は行ではなくプラン文字列を返すので事情が違う。VALIDATE は行を返すクエリである。

### 2.3 `runQuery` が受けるのは「単文かつ行を返す read-only 文」

`isReadOnlyStatement` が真でも、**`CREATE TEMP TABLE` 等は `QueryResult` を返せない**。
これらは `runBatch` へ誘導する。**エラーメッセージで誘導先を明示すること**（§2.8）。

| API | 受ける文 |
|---|---|
| `runQuery` | 単文の `SELECT` / `WITH` / `UNION` / `SHOW APPS` / `DESCRIBE` / **`VALIDATE`** |
| `explainQuery` | 従来どおり（変更なし） |
| **`runBatch`** | 複文。上記に加え `CREATE` / `DROP TEMP TABLE`・`SET` / `DECLARE`・`ASSERT` |

### 2.4 `runBatch()` の形

```ts
runBatch(sql: string, client: ReadonlyKintoneClient, options?: RunBatchOptions):
  Promise<BatchResult>

interface BatchResult {
  readonly type: "batch";
  readonly ok: boolean;
  readonly statementCount: number;
  readonly statements: readonly BatchStatementInfo[];  // index / type / status / tempTable? / rowCount?
  readonly results: readonly QueryResult[];            // ← QueryResult を再利用する
}
```

- **`results[]` は `QueryResult` を再利用**する。VALIDATE も同じ形なので新しい型が要らない。
- `BatchEnvelope`（CLI / MCP 共通）と**フィールド名を揃える**。揃えない理由がない。

### 2.5 追加ゲート（分類器だけでは足りない部分）

| 項目 | 扱い |
|---|---|
| **`APPLY`** | 拒否。`VALIDATE ONLY` 経由だと `writesKintone=false` になり**分類器を通ってしまう** |
| **`IMPORT`** | 既定 off。inline source を要求するため |

**`statementHasApplyBlocks()` は現在 `src/mcp/tools.ts` にある。**
ライブラリから `src/mcp/` を import してはならない（**bundle 汚染**＋`engine:bundle-guard` 違反、
さらに**三重管理**になる）。**`src/core/` へ移し、MCP と library が同じ実装を使う。**

### 2.6 DML `VALIDATE ONLY` を将来足すときの置き場所

`BatchResult.results[]` を `QueryResult | DmlValidationResult` の判別共用体にする。
**今回は足さないが、型を将来拡張できる形にしておく**（`results` の要素型に名前を付けておく）。

### 2.7 `searchAborted` は現行契約を維持する

ライブラリは**全クエリ形で `SEARCH_ABORTED` の hard error**（B79・意図的な厳格さ）。
**構文の許可範囲とは別の軸**なので、複文・VALIDATE でも同じ扱いにする。
部分結果を返す方向へ寄せない。

### 2.8 「存在しない API を案内しない」

現在の複文拒否メッセージは「複文はバッチ実行 API を使用してください」と言うが、
**library にその API が無い**（CLI / MCP 向け共有メッセージ）。B80 と同種の面ごとの不整合。
本計画で `runBatch` が実在するようになるため、**メッセージが正しくなることを確認する**。
`runQuery` が `CREATE TEMP TABLE` 等を拒否するときも**同様に `runBatch` を案内する**。

## 3. 実装ステップ

**Phase A（Step 1）と Phase B（Step 2〜3）を 1 リリースに含める**（オーナー方針）。
ただし**ステップは分ける**。混ぜると失敗時の切り分けができない。

### Step 1 — 判定の統一 ＋ 単文 `VALIDATE`（Phase A・1〜1.5 人日）

- `statementGuard.ts` の手書き allowlist を `isReadOnlyStatement()` ベースへ置換
- `runQuery` は §2.3 の「行を返す単文」に限定。それ以外は `runBatch` を案内して拒否
- `QueryResult` に `validateStats?` を追加し、`query.ts` の写しを埋める
- `statementHasApplyBlocks()` を `src/core/` へ移設し、MCP 側の import を差し替え
- `IMPORT` 既定 off を明示

**同一 merge 必須**: guard 緩和と `validateStats?` の公開。
guard だけ先行させると **VALIDATE が通るのに統計が落ちる**中途半端な状態になる。

**gate**: 移設後も MCP 側の APPLY 拒否が従来どおり効くこと（回帰）。`engine:bundle-guard` green。

### Step 2 — `runBatch()` の API と型（Phase B・1.5〜2.5 人日）

- `runBatch` / `BatchResult` / `BatchStatementInfo` / `RunBatchOptions` を新設し公開
- 文ごとに `isReadOnlyStatement` ＋ 追加ゲートを適用（**バッチ全体ではなく文単位**）
- `BatchEnvelope` とフィールド名を揃える
- UMD / ESM / CJS の型定義とバンドルへ反映

**同一 merge 必須**: API 追加と**文別 read-only 強制**。
API だけ先行させると、書き込み文が混じったバッチを受け付ける窓口が開く。

### Step 3 — 一時テーブル lifecycle と上限契約（Phase B・1.5〜2.5 人日）

- 呼び出し単位のメモリ実体化。`tempTableMaxRows`（既定 10,000）・最大 16 表を
  **`RunBatchOptions` と型コメントで公開契約として明示**
- 超過は常に error（truncate しない＝下流が静かに欠けた入力を受け取らないため）
- `SET` / `DECLARE` / `ASSERT` の read-only サブセット
- **利用者アプリのプロセス内で実体化する**点を型コメントと docs に明記

**gate**: 上限超過・`ASSERT` 失敗・`SEARCH_ABORTED` が**バッチのどの位置でも**期待どおり止まること。

### Step 4 — limits・4面 parity（0.5〜1 人日）

- `VALIDATE` は complete-input policy により **`onLimit=truncate` が `error` へ強制**される。
  ライブラリ面でも同じであることをテストで固定
- **§0.1.1 の parity テストを実装する**（共通コーパス・例外は明示列挙）
- plugin / CLI / MCP / library で**許可・拒否・reason が既存方針どおり**であることを確認
- **library だけが `SEARCH_ABORTED` hard error** という差は**維持**（§2.7）

### Step 5 — docs・smoke・release gate（0.5〜1 人日）

- 型定義コメント（公開 API の契約）
- README / 言語リファレンスに **library で使える構文**を明記
- **§2 の使い分けを必ず書く**（下記）
- `engine:docs-smoke` / `engine:pack-smoke` / `engine:bundle-guard` / `engine:declaration-smoke`
- CHANGELOG（**純加法**であること・非破壊であることを明記）

**docs に必ず含める使い分け**（評価 §2 で実測済み・知らないと拒否される）:

```sql
-- ✅ 一時テーブルを作る時点で絞る
CREATE TEMP TABLE #cur AS SELECT ... FROM APP100 WHERE 受注日 = THIS_MONTH();
SELECT ... FROM #cur a INNER JOIN APP200 t ON a.顧客No = t.顧客No;

-- ❌ 一時テーブルを JOIN 入力にしてから関数で絞る（B76 の対象外）
CREATE TEMP TABLE #cur AS SELECT ... FROM APP100;
SELECT ... FROM #cur a INNER JOIN APP200 t ON ... WHERE a.受注日 = THIS_MONTH();
```

## 4. 受入条件

| # | 条件 |
|---|---|
| 1 | ライブラリに**独自の文型列挙が残っていない**（`isReadOnlyStatement` へ一本化） |
| **1b** | **共通コーパスで「MCP が受理する read-only 文は library も受理する」が機械的に固定**されている。例外は `IMPORT` / `APPLY` の明示列挙のみで、**列挙にない差が生まれたらテストが落ちる**（§0.1.1） |
| 2 | 単文 `VALIDATE` が通り、`validateStats` が **`QueryResult` に載る** |
| 3 | 既存 `runQuery` / `explainQuery` 利用者に**型・挙動の破壊がない** |
| 4 | `runBatch` が複文・一時テーブル・`ASSERT` を実行し、`results[]` が `QueryResult` |
| 5 | **書き込み DML が単文・複文のどちらでも拒否**され、kintone の mutation API 呼び出しが 0 |
| 6 | **`APPLY` を持つ文が `VALIDATE ONLY` 経由でも拒否**される |
| 7 | `IMPORT` が既定で無効 |
| 8 | 一時テーブル上限の超過が error（truncate しない） |
| 9 | `VALIDATE` で `onLimit=truncate` が `error` へ強制される |
| 10 | `SEARCH_ABORTED` が全クエリ形で hard error（B79 契約の維持） |
| 11 | 拒否メッセージが**存在する API だけを案内**する |
| 12 | `statementHasApplyBlocks` の移設後も MCP 側が回帰していない |
| 13 | plugin / CLI / MCP / library の reason parity |
| 14 | 4形の配布 smoke と bundle guard が green |

## 5. リスクと禁止事項

| リスク | 対策 |
|---|---|
| **能力表が三重になる** | `statementHasApplyBlocks` を `src/core/` へ移す。ライブラリから `src/mcp/` を import しない |
| **bundle にサーバー専用コードが混入** | `engine:bundle-guard` を各 Step の gate に置く |
| **利用者アプリのメモリを圧迫** | 上限を公開契約として明示。超過は error |
| **`VALIDATE ONLY` 経由の APPLY すり抜け** | 分類器の後に追加ゲート（受入 #6 で固定） |
| **`searchAborted` を部分結果へ寄せてしまう** | §2.7。B79 で確定した面ごとの差であり、揃えない |
| **docs に使い分けを書き忘れる** | Step 5 の必須項目。知らないと ③ を書いて拒否される |

**禁止**: 既存 `runQuery` の戻り値型を判別共用体へ変更すること（非破壊性を失う）。
**禁止**: `runMutation`（B66 Phase2）に手を出すこと。直交する別課題である。

## 6. 見積とリリース

| Step | 内容 | 見積 |
|---|---|---:|
| 1 | 判定統一 ＋ 単文 `VALIDATE` | 1.0〜1.5 |
| 2 | `runBatch` API と型 | 1.5〜2.5 |
| 3 | 一時テーブル lifecycle・上限契約 | 1.5〜2.5 |
| 4 | limits・4面 parity | 0.5〜1.0 |
| 5 | docs・smoke・release gate | 0.5〜1.0 |

**合計 5.0〜8.5 人日**（1 リリース）。

**SemVer**: **minor**（純加法）。既存 API の型も挙動も変えず、
これまで例外だった SQL が通るようになるだけである。

**実機確認**: ダッシュボード（Pro）が engine library を使っているため、
**リリース後に Pro 側で用途①②が実際に書けるか**を確認するのが最終ゲートになる。

---

## 【Step 1 レビュー・2026-07-27】完了

### 実装の要点

- ライブラリの手書き allowlist を廃し、**`isReadOnlyStatement()`（意味的判定）へ一本化**
- 結果形の分類は **`isRowReturningReadOnlyStatement()` として `src/core/` に置いた**。
  read-only かどうかの判定とは**別の軸**（何を返せるか）なので分離してある
- `explainQuery` は **`isExplainableReadOnlyStatement()`** で従来契約を独立させた。
  `runQuery` の拡張が EXPLAIN の受理範囲を巻き添えにしない
- `statementHasApplyBlocks()` を **`src/core/applyGuard.ts` へ移設**し MCP と共有

### 独立検証（7 形すべて期待どおり）

| # | 形 | 結果 |
|---|---|---|
| Z1 | 単文 `VALIDATE` | ✅ 通り **`validateStats` が載る** |
| Z2 | 通常 `SELECT` | ✅ **`validateStats` が付かない** |
| Z3 | **`APPLY` ＋ `VALIDATE ONLY`** | ✅ **拒否・API 呼び出し 0** |
| Z4 | 書き込み DML 3 形 | ✅ 拒否・API 呼び出し 0 |
| Z5 | `CREATE TEMP TABLE` / `ASSERT` | ✅ 拒否・**`runBatch` を名指ししない** |
| Z6 | `SELECT` / `SHOW APPS` / `DESCRIBE` / `EXPLAIN` | ✅ 非破壊 |
| Z7 | `IMPORT` | ✅ 既定で拒否 |

**Z3 が本 Step の核心。**`VALIDATE ONLY` を付けると `writesKintone=false` になり
分類器を通ってしまうため、追加ゲートが無いと APPLY が素通りする。塞がっていることを実測した。

### bundle 汚染がないこと

`src/mcp/` を引き込んでいないことを、guard だけでなく**成果物の中身**でも確認した。

| 検索語 | 件数 |
|---|---:|
| `ksql_app_metadata` / `ksql_mutate` / `modelcontextprotocol` / `APPLY mutation is disabled in MCP` | **すべて 0** |

`engine-bundle-guard` は CJS / ESM / UMD とも `forbidden=0`。
MCP 側の `tools.test.ts` 117 件も green で、移設による回帰なし。

### 既知の一時状態（Step 2 で解消する）

`runQuery` が `CREATE TEMP TABLE` 等を拒否するメッセージは、
**まだ存在しない `runBatch` を名指ししていない**（「単文かつ行を返す read-only query のみ」）。
Step 2 で `runBatch` が実在した時点で案内を追加する。

**未解消のままリリースしないこと。**「存在しない API を案内する」不整合（§2.8）を
直すのが本課題の一部であり、誘導先を示さない拒否メッセージは中途半端である。

### ゲート

`npm test` 184 suites / 4,777 tests ＋ CLI 26 green、snapshot 22 不変、
`engine:bundle-guard` / `engine:declaration-smoke` green、版同期 v3.28.0 green。
