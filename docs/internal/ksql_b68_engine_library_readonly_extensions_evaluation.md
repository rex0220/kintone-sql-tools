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
