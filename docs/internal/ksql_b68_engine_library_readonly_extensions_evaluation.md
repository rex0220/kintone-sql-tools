# B68 — kSQL read-only ライブラリの read-only 機能拡張（VALIDATE・一時テーブルバッチ）評価

- 起票日: 2026-07-24
- ステータス: **📝【A: 評価】起票**（仕様前・優先度未確定）
- 種別: 改善（B66 ライブラリの機能拡張）
- 効果種別: 機能
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B68
- 関連: [B66 ライブラリ Phase1 仕様](ksql_b66_engine_library_phase1_spec.md)（§1.2 で対象外化）／[利用ガイド](../ksql_engine_library.md)／B41（VALIDATE）／B12/B14（一時テーブル・batch）

## 1. 提案

v3.19.0 で公開した read-only エンジン・ライブラリ（B66）は、`runQuery()` が **単文の `SELECT` / `WITH` / `UNION` / `SHOW APPS` / `DESCRIBE`** だけを受理する。次の2つは **read-only でありながら現状使えない**ため、ライブラリの read-only 拡張として起票する。

1. **`VALIDATE` 文**（既存レコードの制約監査・B41）
2. **一時テーブルを使うバッチ処理**（複数文・`#temp` 実体化・`@変数` の read-only サブセット）

## 2. 現状（実コードで確認）

`src/engine-library/statementGuard.ts` の allowlist は `SELECT` / `SHOW_APPS` / `DESCRIBE` / `WITH` / `UNION` のみ許可し、それ以外は `READ_ONLY_VIOLATION`。したがって `VALIDATE`、`CREATE TEMP TABLE`、`INSERT INTO #temp SELECT …`、`SET @x=…`、複文（バッチ）は**すべて拒否**される。

**除外は安全性でなくスコープ最小化**（B66 §1.2＝「ダッシュボード向け最小契約に含めない」）。VALIDATE も一時テーブル materialize も **kintone への書き込みを行わない read-only 操作**であり、read-only の安全境界（二重強制）とは矛盾しない。

## 3. それぞれの固有価値と論点

### 3.1 VALIDATE 文

- **価値**: ライブラリ利用側（ダッシュボード・外部ツール）が、既存レコードの**データ品質監査**を1文で実行できる。組み込み検証＋`CHECK` で `$id`/`$err_field`/`$err_code`/`$err_message`/`$err_value` の5列を得る。書き込みは0。
- **read-only 適合**: VALIDATE は書き込み API を呼ばない（B41）。取得後に `evalWhere` で再評価するが、read-only client で完結する。
- **論点**:
  - **API 形状**: `runQuery()` の allowlist に `VALIDATE` を足して同じ `QueryResult`（5列）で返すか、専用 `runValidate()` を設けるか。VALIDATE の結果は SELECT と列語彙が固定的なので、専用 DTO or 汎用 QueryResult 流用の判断。
  - **allowlist 拡張**: statementGuard に `VALIDATE` を追加（read-only 分岐）。B67 の backstop 同様、書き込み経路を持たないことを二重強制で担保。
  - **検索打ち切り**: 母集団取得は他と同様、打ち切り時は `SEARCH_ABORTED` hard error。
- **規模感**: 小〜中（allowlist＋結果 DTO＋受入）。

### 3.2 一時テーブルを使うバッチ処理（read-only サブセット）

- **価値**: 複雑な**多段の読み取り**をライブラリで表現できる。派生テーブル非対応の kSQL で、`#temp` に SELECT 結果を実体化 → 後段で JOIN/集計、を**複数文で**組める（CTE インライン展開より大きい materialize・文をまたいだ再利用）。
- **read-only 適合の切り出し**: バッチ全体でなく、**書き込みを含まない read-only バッチ**に限定する。許可＝`SET @var`（スカラー/サブクエリ・read）、`CREATE TEMP TABLE … AS SELECT`／`INSERT INTO #temp SELECT`（materialize は read＋メモリ）、`SELECT`/`WITH`/`UNION`。拒否＝実アプリへの INSERT/UPDATE/UPSERT/DELETE/APPLY/IMPORT/REORDER、`#temp` への書き込みでも最終的に実アプリへ反映する形。
- **論点**:
  - **API 形状**: 単文 `runQuery()` を超える。**`runBatch()` 相当の複数文 API**＋バッチ結果（最終 SELECT の結果 or 文ごとの結果配列）が要る。
  - **一時テーブルのライフサイクル**: エンジンの temp table はメモリ実体化（`tempTableMaxRows` guard）。ライブラリ session 内で materialize→参照→破棄を read-only で回す。
  - **文ごとの read-only 強制**: バッチの各文を statementGuard で個別検査し、read-only サブセット外は fail-closed。`#temp` への「書き込み」は許容するが、それが実 kintone mutation に化けない保証（temp は client メモリ）。
  - **変数**: `@var` の read サブセット（B12/B14）。DECLARE 外部注入をライブラリ API で受けるか。
- **規模感**: 中〜大（新 batch API＋temp lifecycle＋文別強制＋変数）。

## 4. B66 Phase2（DML）との関係

B66 の Phase2 は **`runMutation()`（DML 書き込み）**。B68 の2項目は**書き込みを伴わない read-only 拡張**であり、DML Phase2 とは**直交**する。実装順序も独立に選べる（read-only 拡張を先行できる）。

## 5. 段階案

- **Phase A（VALIDATE・先行推奨）**: allowlist に `VALIDATE` 追加＋結果 DTO。単文・小〜中規模。既存 `runQuery` 拡張か `runValidate` 新設かを R1 で確定。
- **Phase B（read-only 一時テーブルバッチ）**: `runBatch()` 相当の複数文 read-only API＋temp lifecycle＋文別 read-only 強制＋変数。中〜大。

## 6. 論点・要判断

1. **実需**: ライブラリ利用側（ダッシュボード等）で VALIDATE 監査・多段 read が具体的に要るか。
2. **API 形状**: `runQuery` 拡張 vs 目的別 `runValidate`/`runBatch`。read-only の型隔離・安全境界を保つ形。
3. **read-only バッチの境界定義**: 「temp への書き込みは許すが実 kintone mutation は不可」を statementGuard でどう厳密化するか（B66 の二重強制思想を multi-statement へ拡張）。
4. **バージョン**: 純加法 minor（既存 API 不変・新 API 追加）で出せるか。
5. **B66 Phase2（DML）との実装順**: read-only 拡張（B68）を先に出すか、DML と合わせるか。

## 7. 次アクション

1. 実需確認（VALIDATE 監査／多段 read のライブラリ利用計画）。
2. 方向確定なら **Phase A（VALIDATE）から Phase1 仕様 R1**（allowlist 拡張・結果 DTO・二重強制の維持・面）。
3. Phase B（read-only バッチ）は API 形状（`runBatch`）と temp lifecycle・文別強制の設計を別途 R1。

---

## 【2026-07-27】案の評価: ライブラリの許可構文を「MCP の READ 系と同じ」にする

オーナー提案。**許可範囲の基準を自前の列挙ではなく MCP READ 面に置く**という案。

### 1. 実コード確認＝現状は「能力表が2つ」

| 面 | 判定方法 |
|---|---|
| **MCP `ksql_query`** | `validation.isReadOnly` ＝ **`isReadOnlyStatement()`（`src/core/dmlGuard.ts`）**。文ごとに `analyzeBatch`（`src/core/batch.ts`）が分類し、バッチは `isReadOnlyBatch` |
| **ライブラリ** | **手書きの allowlist** `assertReadStatement()`（`src/engine-library/statementGuard.ts`）。`SELECT` / `WITH` / `UNION` / `SHOW_APPS` / `DESCRIBE` のみ、かつ `parseSingleStatement` で**単文限定** |

`isReadOnlyStatement()` は「**kintone の mutation API を呼ぶか**」という意味的判定である。

```ts
writesKintone(stmt)      = isDmlType(stmt.type) && !stmt.validateOnly
isReadOnlyStatement(stmt) = !writesKintone(stmt) && (isReadOnlyType(...) || isDmlType(...))
```

**ライブラリだけが別の分類を持っている。**これは B76 で痛い目を見た「押し下げの能力表が単一表と JOIN で2つある」のと同型で、
**片方に文型を足したときにもう片方が置き去りになる**構造である。

### 2. 差分（MCP READ ⊃ ライブラリ）

| 文型 | MCP READ | ライブラリ |
|---|---|---|
| `SELECT` / `WITH` / `UNION` | ✅ | ✅ |
| `SHOW APPS` / `DESCRIBE` | ✅ | ✅（run のみ） |
| `EXPLAIN` | ✅ | ✅（別経路） |
| **`VALIDATE`（既存レコード監査）** | ✅ | ❌ |
| **DML `... VALIDATE ONLY`** | ✅ | ❌ |
| **`CREATE` / `DROP TEMP TABLE`** | ✅ | ❌ |
| **`SET` / `DECLARE` 変数** | ✅ | ❌ |
| **`ASSERT`** | ✅ | ❌ |
| **複文バッチ** | ✅ | ❌（単文限定） |

B68 が挙げた2機能（`VALIDATE`・一時テーブルバッチ）は、**この差分の部分集合**である。
つまり本案は B68 を包含し、かつ**なぜその2つなのかを原理から説明できる**。

### 3. 強い点

1. **判定が意味的になる。**「一覧に載っているか」ではなく「kintone に書くか」で決まる。
2. **新しい判定ロジックを作らない。**既存の共有 predicate をそのまま使う。
3. **将来の read-only 文型が自動的に両面へ揃う。**能力表の二重管理が消える。
4. **B68 Phase A / B を一つの基準の下に置ける。**

### 4. ただし「guard を差し替えるだけ」では終わらない

**本体のコストは API 形状である。**

- `runQuery` は単一の `QueryResult { type: "query"; rows; columns; rowCount; warnings; metrics }` を返す。
  **バッチは複数の結果セット**になるため、戻り値をそのまま流用できない。
- **DML `VALIDATE ONLY` は行ではなく診断**を返す。`rows` に載せる形ではない。
- ただし公開型は既に `type: "query" | "explain"` の**判別共用体**なので、
  `"batch"` / `"validate"` を足す拡張自体は素直である。

**guard の緩和は容易で、設計判断が要るのは戻り値の型と API の分け方**（`runQuery` 拡張か `runValidate` / `runBatch` 追加か）。

### 5. 基準をそのまま採ると広すぎる部分（面の事情で絞る）

「MCP と**完全に同一**」にするのは危険で、**MCP 側も分類器だけでは判定していない**。

| 項目 | 事情 |
|---|---|
| **`APPLY`** | MCP は分類器とは**別の場所**で `UnsupportedError: APPLY mutation is disabled in MCP` を投げている。`VALIDATE ONLY` 経由なら `writesKintone=false` になるため、**分類器だけでは通ってしまう**。ライブラリでも同等の追加ゲートが要る |
| **`IMPORT ... VALIDATE ONLY`** | 基準上は read-only だが inline source を要求する。MCP は `enableImport` で別途ゲート。**ライブラリは既定 off が妥当** |
| **一時テーブルのメモリ** | 既定 10,000 行 × 最大 16 表を実体化する。MCP はサーバープロセスだが、**ライブラリは利用者アプリのプロセス内**。上限を明示的な契約として公開する必要がある |
| **`VALIDATE` は全件読む** | complete-input policy により `onLimit=truncate` が `error` へ強制される。**利用者から見た挙動差**として説明が要る |

### 6. 面ごとの差は「構文の許可範囲」とは別の軸

ライブラリは `searchAborted` を**全クエリ形で hard error** にしている（B79・意図的な厳格さ）。
これは**構文を揃えても維持する**。混同しないこと。

### 7. 結論

**基準としては採用を推奨する。**ただし「MCP と同一」ではなく、
**「MCP READ を出発点にし、面の事情で明示的に絞る」**という形にする。

段階案（B68 の Phase A / B を置き換える）:

| Phase | 内容 | 主なコスト |
|---|---|---|
| **A** | 判定を `dmlGuard` へ寄せ、**単文の `VALIDATE` と DML `VALIDATE ONLY`** を解禁。`APPLY` は追加ゲートで拒否、`IMPORT` は既定 off | 診断結果の戻り値型 |
| **B** | **複文バッチ**（temp table・`SET`/`DECLARE`・`ASSERT`）。新 API と temp lifecycle、文別 read-only 強制 | API 分割と上限契約 |

Phase A だけでも「能力表が2つ」は解消できる（allowlist を捨てて共有 predicate に寄せるため）。

**実需確認は引き続き必要。** Pro がライブラリ面を使っているか、`VALIDATE` / 複文バッチの需要があるかで
Phase A 先行か B まで行くかが変わる。Pro への報告の返信で確認するのが自然である。

---

## 【2026-07-27】実需が確定した（オーナー提示）

長く「実需確認待ち」だった本課題に、具体的な用途が示された。

1. **ダッシュボードで `VALIDATE` のチェック結果を KPI やグラフとして表示する**
2. **一時テーブルで、複雑になりやすい複数アプリの JOIN をシンプルに管理する**

これで B68 は「read-only なのに使えない機能がある」という原理的な指摘から、
**具体的な利用形を持つ課題**になった。以下、用途ごとに実機（v3.28.0 CLI・実 kintone）で確認した結果。

### 1. VALIDATE の KPI 表示は **Phase A でほぼ足りる**

`VALIDATE APPn` 単体の戻り値は、診断行に加えて**集計済みの統計**を持つ。

```json
{
  "columns": ["$id","$err_field","$err_code","$err_message","$err_value",
              "$err_subtable","$err_subrow","$err_subrow_id","$err_count"],
  "rows": [...], "rowCount": 0,
  "validateStats": { "errorRecords": 0, "errorCount": 0 }
}
```

- **`validateStats` がそのまま KPI になる**（エラーレコード数・エラー件数）。集計処理が要らない。
- 内訳グラフ（`$err_code` 別など）も、診断行が返るので**呼び出し側の JS で集計できる**。
- SQL 側で `GROUP BY` したい場合だけ Phase B（`VALIDATE ... INTO #err; SELECT ... GROUP BY`）が要る。

**したがって用途1は、安いほうの Phase A で大half が実現する。**
Phase B は「SQL で集計したい」という表現力の問題であり、実現可否の問題ではない。

### 2. 一時テーブルによる JOIN の分解は **B76 の制約と噛み合う**

**JOIN の入力が一時テーブルだと、server-only 関数（相対日付・`TODAY()` 等）は使えない**（B76 Phase B の対象外）。
用途2をそのまま実装すると、この制約に当たる可能性がある。実機で3形を確認した。

| 形 | 結果 |
|---|---|
| ① 作成時に相対日付 → `#cur` を素で参照 | ✅ 18 件 |
| ② 作成時に相対日付 → **`#cur` を JOIN 入力に**（WHERE に関数なし） | ✅ 18 件 |
| ③ `#cur` を JOIN 入力にして **WHERE 側で相対日付** | ❌ `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` |

```sql
-- ✅ 推奨: 一時テーブルを作る時点で絞る（B75 が開けた形）
CREATE TEMP TABLE #cur AS SELECT 顧客No, 会社名 FROM APP4147 WHERE 対応日付 = LAST_YEAR();
SELECT ... FROM #cur a INNER JOIN APP4148 t ON a.顧客No = t.顧客No;

-- ❌ 拒否: 一時テーブルを JOIN 入力にしてから関数で絞る
CREATE TEMP TABLE #cur AS SELECT 顧客No, 対応日付 FROM APP4147;
SELECT ... FROM #cur a INNER JOIN APP4148 t ON ... WHERE a.対応日付 = LAST_YEAR();
```

**「早く絞ってから結合する」**という、性能面でも望ましい書き方が正解になる。
ただし**知らないと ③ を書いて拒否される**ため、Phase B を出すなら
**この使い分けを公開ドキュメントに明記すること**を受入条件に含める。

### 3. 優先度の見直し

実需が確定したため、**「実需確認待ち」ではなくなった**。

- **Phase A**（単文 `VALIDATE` / DML `VALIDATE ONLY`）＝用途1をほぼ満たし、
  かつ**能力表の二重管理（§1）を解消**する。**費用対効果が高い。**
- **Phase B**（複文バッチ・一時テーブル）＝用途2の本体。API 形状の設計が主コスト。
  ③ の使い分けを docs に含めること。

ただし**ライブラリ面での需要か、プラグイン／MCP 面での需要か**は未確認。
プラグインと MCP は既に両機能を持つため、**ライブラリ面（Pro が engine library を使うか）**で
必要かどうかが Phase 分けの判断材料になる。

### 4. ライブラリ面での需要が確定（2026-07-27）

**ダッシュボード（Pro）は engine library を使っている**とオーナーが確認。
§3 の「残る未確認」は解消し、**Phase A / B とも library 面の課題として確定**した。

現状の拒否を実測（`guardRunQuerySql`）:

| SQL | 結果 |
|---|---|
| `VALIDATE APP100` | `READ_ONLY_VIOLATION` |
| `UPDATE ... VALIDATE ONLY` | `READ_ONLY_VIOLATION` |
| `CREATE TEMP TABLE ...` | `READ_ONLY_VIOLATION` |
| `ASSERT ...` | `READ_ONLY_VIOLATION` |
| 複文バッチ | `PARSE_ERROR`「この API は単文のみ受け付けます（**複文はバッチ実行 API を使用してください**）」 |
| 単文 `SELECT` | ✅ |

> **副次的な発見**: 複文の拒否メッセージが「**バッチ実行 API を使用してください**」と案内するが、
> **library にはそのような API が存在しない**（CLI / MCP 向けの共有メッセージ）。
> B80（library だけ具体的な reason を返さない）と同種の、**面ごとの案内の不整合**である。
> Phase B で batch API を追加すれば解消するが、Phase A 止まりなら文言の手当てが要る。

### 5. Phase A の API 形状（要判断）

公開 API は現在 `runQuery`（`QueryResult`）と `explainQuery`（`ExplainResult`）に分かれており、
**種類ごとに関数を分け、結果に `type` 判別子を持たせる**設計になっている。

| 案 | 内容 | 評価 |
|---|---|---|
| **A-1（推奨）** | **`runValidate()` を追加**し `ValidateResult { type: "validate"; rows; columns; stats }` を返す | **`explainQuery` の前例に一致**。`runQuery` の戻り値型を変えないので既存利用者に影響しない |
| A-2 | `runQuery` を拡張し戻り値を判別共用体にする | 「SQL を1つ投げる」窓口が1つで済むが、**既存の `QueryResult` 前提コードが型エラーになり得る** |

**スコープ**: 用途1（KPI 表示）に必要なのは**既存レコード監査の `VALIDATE`** のみ。
DML `... VALIDATE ONLY`（この DML は妥当かの事前検証）は read-only ダッシュボードの用途から外れるため、
**Phase A では見送り可能**。含めるかは判断事項。
