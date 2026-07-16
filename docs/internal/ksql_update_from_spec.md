# 仕様案: `UPDATE … FROM`（SET 値に他テーブルのフィールド参照／アプリ間転記）

- 作成日: 2026-07-16
- 親ロードマップ: [ksql_batch_processing_roadmap.md](ksql_batch_processing_roadmap.md)（Phase 2）
- 後続依存先: [ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md)（B12・`#err` の書き戻しに本機能が必要）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B11
- ステータス: **仕様案 R1（codex レビュー前）。採用・未実装。現行コードとのギャップ精査を反映**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: 後方互換の構文追加（`FROM` 句なしの既存 `UPDATE` は不変）→ minor

---

## 1. 目的とスコープ

`UPDATE` の `SET` 値に**他テーブル（一時テーブル/CTE）のフィールド**を参照できるようにし、**アプリ間・テーブル間の転記**を1文で行う。主用途は B12 のエラー行 `#err` を差分アプリへ書き戻すユースケースだが、単体でも「別テーブルの値で更新する」頻出ニーズに応える。

### スコープ（v1・最小）

1. **ソースは一時テーブル/CTE 限定**（`FROM #src` / `FROM cte`）。実アプリソース（`FROM APP200`）は将来拡張。
2. **結合はターゲット `$id` とソースの単一等値**：`WHERE <target>.$id = <alias>.<key>`（ちょうど 1 つ必須）。
3. **複数マッチ＝実行前エラー固定**（ソースに同一キーが複数 → `ArgumentError`。決定性維持）。
4. **親レコード UPDATE 限定**（`subtableCode` なし。サブテーブル `UPDATE … FROM` は対象外）。
5. `SET` 値は **ソースの修飾フィールド参照**（`alias.field`）／**リテラル**／**ターゲット自身の算術**（既存 `金額 = 金額 * 1.1`）を混在可。

### スコープ外（将来拡張・本 v1 では非対応）

- 実アプリソース `FROM APP200`（追加取得・件数上限・結合順の別論点）。
- `$id` 以外の結合キー（`target.顧客コード = src.code` 等）や複数等値・不等値結合。
- サブテーブル `UPDATE … FROM`。
- `DELETE … FROM` / `UPSERT … FROM`（本 v1 は UPDATE のみ）。

---

## 2. 現状（コード裏取り済み）

| 項目 | 現状 | 参照 |
|---|---|---|
| AST | `UpdateStatement = {appId, subtableCode?, assignments, where}`。**`FROM`/`JOIN` なし** | [ast.ts:586](../../src/types/ast.ts#L586) |
| SET 値 | `Assignment.value = SqlValue \| ArithExpr`。算術の葉 `FIELD_REF` は**更新対象レコード自身のフィールドのみ**。他テーブル参照不可 | [ast.ts:594](../../src/types/ast.ts#L594) |
| 実行 | `executeUpdate` は2経路＝算術（$id＋参照フィールド取得→レコードごとに計算→PUT）／通常（$id のみ→一律 PUT）。**対象アプリ単一の kintone クエリ**で JS 結合なし | [execute.ts:2449](../../src/execute.ts#L2449) |
| temp 参照 | `executeUpdate` は cteCache/tempTables を**受け取らない**。バッチガードが SELECT-based DML 以外の temp 参照を実行前拒否 | [execute.ts:516](../../src/execute.ts#L516) |
| 回帰テスト | `DML 文内の一時テーブル参照（UPDATE のサブクエリ等）は拒否（実行前）` | [executeBatch.test.ts:696](../../src/__tests__/executeBatch.test.ts#L696) |

**流用可能な既存機構**: 算術パスの `fetchRecordsForSharedPlan`（[execute.ts:2469](../../src/execute.ts#L2469)）＋ `updateToPutBatchesArith`（[execute.ts:2485](../../src/execute.ts#L2485)）は「対象行ごとに異なる値を計算して PUT」する土台で、`UPDATE … FROM` の per-record PUT はここに乗せられる。

---

## 3. 構文

```sql
UPDATE <app>
SET <col> = <alias>.<field> [, <col> = <literal | ターゲット算術> ...]
FROM #<src> [AS] <alias>
WHERE <app>.$id = <alias>.<key>
  [ AND <ターゲット側フィルタ> ] ;
```

- `FROM` 句は `SET` の後・`WHERE` の前（SQL 慣行）。
- `WHERE` は **ちょうど 1 つの結合等値 `<app>.$id = <alias>.<key>`** を含むこと（順序は `<alias>.<key> = <app>.$id` も可）。
- 残りの `WHERE` 条件（AND 結合）は**ターゲット側フィルタ**（対象アプリのフィールド条件）として扱う。ソース alias を参照する追加条件は v1 では非対応（結合等値のみ）。
- `FROM` 句を書かない `UPDATE` は従来どおり（後方互換）。

### 例（B12 の書き戻し）

```sql
UPDATE APP_差分
SET 処理ステータス = 'エラー', エラー内容 = e.$err_message
FROM #err e
WHERE APP_差分.$id = e.差分ID;
```

---

## 4. AST 拡張

```ts
export interface UpdateStatement {
  type: "UPDATE";
  appId: number;
  subtableCode?: string | null;
  assignments: Assignment[];
  where: WhereExpr;
  /** UPDATE … FROM のソース（一時テーブル/CTE のみ・v1）。null で従来 UPDATE */
  from?: UpdateFromSource | null;
}

export interface UpdateFromSource {
  cteName: string;      // #src / cte 名（既存 FROM の cteName と同形）
  alias: string;
  /** 結合等値のソース側キー列（WHERE から抽出した <alias>.<key> の key） */
  joinKeyField: string;
  /** WHERE から結合等値を除いたターゲット側フィルタ（null 可） */
  targetFilter: WhereExpr | null;
}

/** SET 値にソースの修飾フィールド参照を追加 */
export type AssignmentValue =
  | SqlValue
  | ArithExpr
  | { type: "SOURCE_FIELD"; alias: string; field: string };  // 新規
```

- `Assignment.value` を `AssignmentValue` へ拡張（`SOURCE_FIELD` を追加）。既存の `SqlValue | ArithExpr` は不変。
- **パーサーが `WHERE` を分解**して `from.joinKeyField`（結合等値のソース側）と `from.targetFilter`（残り）を確定させる（実行層に生の WHERE を渡さず、意味を AST で固定＝曖昧さを排除）。結合等値が 0 個/複数個、または `$id` 以外を左右に持つ場合は **ParseError**。

---

## 5. パーサー変更

1. `parseUpdate`（[parser.ts:222](../../src/parser/parser.ts#L222) 経由）で `SET` リスト解析後に **任意の `FROM <#src|cte> [AS] alias`** を解析。
2. `SET` 値パーサーに **`alias.field` 修飾参照**を追加（`FROM` 句がある UPDATE でのみ許可。alias はその `FROM` の alias に一致）。`FROM` なしで `alias.field` を書いたら ParseError（従来メッセージ「SET の値にはリテラル・算術式を指定してください」を踏襲）。
3. `WHERE` 解析後に **結合等値の抽出・検証**：
   - `<app>.$id = <alias>.<key>`（または左右反転）を**ちょうど 1 つ**要求。`$id` は非修飾 `$id` も許容（対象アプリは 1 つのため）。
   - 抽出した等値を `from.joinKeyField` に、残りを `from.targetFilter` に格納。
   - 0 個・複数個・`$id` 以外・ソース alias を含む非結合条件が v1 非対応形なら ParseError（明確なメッセージ）。
4. ソース alias 参照が `SET`／`targetFilter` に現れるが、v1 では **`targetFilter` にソース alias を含めない**（結合等値のみがソース参照）。含む場合 ParseError。

---

## 6. 実行（`executeUpdate` 拡張）

`stmt.from != null` のとき新経路。**cteCache/tempTables を結線**（現状未接続）。

```
1. ソース行を取得: table = cteCache.get(from.cteName)（MaterializedTable。行＋列）
2. targetId → sourceRow マップ構築:
     各ソース行の from.joinKeyField 値を targetId とする
     同一 targetId が2行以上 → ArgumentError（複数マッチ＝ソースキー重複・実行前・何も書かない）
     targetId が数値でない/空 → 当該行はスキップ or エラー（§7 で確定）
3. 対象取得: $id IN (targetIds) AND <from.targetFilter> を対象アプリへクエリ
     （resolveDmlTargetIds/fetchRecordsForSharedPlan 流用。SET/フィルタ参照フィールドも取得）
4. 実行前 confirm(matched件数, "UPDATE")
5. 対象行ごとに PUT レコード構築:
     SOURCE_FIELD → マップの sourceRow[field]
     リテラル/ターゲット算術 → 従来通り（対象行の値で評価）
   updateToPutBatchesArith 相当の per-record 経路で 100 件チャンク PUT
6. updatedCount = matched（targetFilter 適用後）件数
```

- **バッチガード緩和**（[execute.ts:516-522](../../src/execute.ts#L516)）: `UPDATE` かつ `from != null`（temp 参照）を許可対象に追加。従来の「UPDATE のサブクエリ temp 参照は拒否」は維持（`from` 経路とサブクエリ経路を区別）。
- `executeUpdate` のシグネチャに cteCache を追加し、[execute.ts:406](../../src/execute.ts#L406) の dispatch・バッチ経路（[executeBatchStatement](../../src/execute.ts#L619)）から注入。単文（バッチ外）の `UPDATE … FROM` は temp が存在しないため実質バッチ内限定（`#src` はバッチスコープ）。

---

## 7. 設計判断・確定事項

- **複数マッチ = 実行前エラー**（決定性。先勝ち不採用）。ソースキー重複で `ArgumentError`、書き込みゼロ。
- **結合キーは `$id` 単一等値**（v1）。`$id` は必ず一意のため、複数マッチ＝ソース重複に一元化できる。
- **ターゲット側フィルタ**は対象取得クエリに合流（`$id IN (...) AND filter`）。フィルタで外れた targetId は更新しない（`updatedCount` に含めない）。
- **WHERE を AST で分解**（生 WHERE を実行層に渡さない）。曖昧さ（複数等値・不等値混在）はパーサーで ParseError。
- **maxRecords / dmlMaxRows / confirm** は matched 件数で判定（既存 UPDATE と同一）。
- **未決（§9）**: 結合キー値が非数値/空/対象非存在のソース行の扱い。

---

## 8. 受入条件

- [ ] `UPDATE app SET c = e.f FROM #e WHERE app.$id = e.k` が、`#e` の各行のキー `k`（=対象 $id）の対象を `e.f` の値で更新する。
- [ ] `SET` にソース参照・リテラル・ターゲット算術を混在できる（`SET a = e.x, b = 'const', c = 金額 * 1.1`）。
- [ ] **複数マッチ**（`#e` に同一 `k` が2行）→ `ArgumentError`・**PUT 未実行**（書き込みゼロ）。
- [ ] **ターゲット側フィルタ**（`AND app.状態 = '有効'`）で外れた対象は更新されず `updatedCount` に含まれない。
- [ ] `#e` が 0 行 → `updatedCount = 0` の no-op・PUT 未実行。
- [ ] `FROM` 句なしの既存 `UPDATE`（一律・算術・スカラーサブクエリ）は**完全に不変**（回帰）。
- [ ] `FROM` にサブクエリ／実アプリ／`$id` 以外の結合キー／複数等値／ソース alias をフィルタに含む → **ParseError**（v1 非対応の明確なメッセージ）。
- [ ] `confirm`／`dmlMaxRows` は matched 件数で発火（超過で PUT 未実行）。
- [ ] サブテーブル `UPDATE … FROM` は ParseError（対象外）。
- [ ] B12 書き戻し例（`SET エラー内容 = e.$err_message FROM #err WHERE APP_差分.$id = e.差分ID`）が動作。

## 9. テスト計画（修正前 fail → 修正後 pass）

### パーサー
- `UPDATE app SET c = e.f FROM #e WHERE app.$id = e.k` → `from` に cteName/alias/joinKeyField、targetFilter=null。
- ターゲットフィルタあり → targetFilter に格納・結合等値は除外。
- ParseError: 結合等値 0/複数、`$id` 以外の結合、`FROM APP200`、サブクエリ FROM、フィルタにソース alias、サブテーブル。
- `FROM` なしで `SET c = e.f` → ParseError。

### 実行（execute 経由・PUT モック）
- 基本転記（3 行）→ 各対象が対応ソース値で PUT・updatedCount=3。
- 複数マッチ → ArgumentError・PUT 未呼び出し。
- ターゲットフィルタで 1 行除外 → updatedCount 減・除外行は PUT されない。
- 0 行ソース → no-op・PUT 未呼び出し。
- 混在 SET（ソース参照＋リテラル＋ターゲット算術）→ 各値が正しく PUT。
- **回帰**: 既存 UPDATE（一律・算術・スカラーサブクエリ・サブテーブル）が不変。
- バッチ: `CREATE TEMP TABLE #e AS …; UPDATE app … FROM #e …` が動作（ガード緩和の確認）。

## 10. リスク・非対象

- **リスク（WHERE 分解の曖昧さ）**: 複数等値・不等値混在で結合キーを誤抽出しないよう、パーサーで厳密検証＋ParseError。実行層は分解済み AST のみ扱う。
- **リスク（temp ストア結線漏れ）**: `executeUpdate` の cteCache 追加を全 dispatch/バッチ経路へ。型変更をコンパイラに拾わせる。
- **非対象**: 実アプリソース・非 $id 結合・複数等値・サブテーブル・`DELETE/UPSERT … FROM`（将来拡張）。

## 11. 未決事項（codex / ユーザー判断）

1. **ソースキーの検証**: `joinKeyField` の値が非数値・空・対象アプリに存在しない `$id` のソース行の扱い（スキップ／エラー／`#err` 的に隔離）。推奨＝**非数値/空はソース不正として `ArgumentError`（実行前）**、存在しない $id は kintone クエリで自然に 0 マッチ（更新なし）。
2. **`$id` 以外の結合キー**（`target.顧客コード = src.code`）を v1.1 で足すか。B12 は $id 書き戻しで足りるため v1 は $id 限定を推奨。
