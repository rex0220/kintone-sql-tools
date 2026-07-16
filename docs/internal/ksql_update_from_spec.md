# 仕様案: `UPDATE … FROM`（SET 値に他テーブルのフィールド参照／アプリ間転記）

- 作成日: 2026-07-16
- 親ロードマップ: [ksql_batch_processing_roadmap.md](ksql_batch_processing_roadmap.md)（Phase 2）
- 後続依存先: [ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md)（B12-A は非依存。B12-B の `#err` 書き戻しには v1.1 業務キー結合が必要）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B11
- ステータス: **v1（`$id` 結合）は R4 実装済み・v2.12.0。v1.1（業務キー結合）は R7 仕様確定・実装着手可・B12-B 前提。**
- 更新履歴:
  - 2026-07-16 R7: R6レビュー反映。kintoneの文字列（1行）`=` / `in` が先頭64文字で判定される制約に対し、取得後の全文字完全一致逆引きで過剰取得行を除外する契約と `maxRecords` 消費、65文字キーの受入テストを追加。`in` チャンクは既存UPSERT照合へ準拠
  - 2026-07-16 R6: v1.1 業務キー結合の codex レビュー反映。通常実行と `VALIDATE ONLY` の照合共通化、ターゲット重複時の全件取得と全チャンク合計 `maxRecords`、文字列/NUMBER の厳密なキー正規化、target/source の許可型・列検証を §12 に固定
  - 2026-07-16 R1: 初版（ソース temp/CTE 限定）
  - 2026-07-16 R2: **ソースに実アプリを追加**（ユーザー判断・案X）。結合・複数マッチ・per-record PUT は共通で、ソース取得だけ分岐。app ソースは maxRecords 準拠・上限超過は fail-closed
  - 2026-07-16 R4: codex 再レビュー反映（コードで裏取り）。**High＝`tempName` を `cteName` へ戻す**（`collectRefs`（batch.ts:125）は `cteName`（先頭 #）と `appId` を汎用走査で拾うため、`tempName` だと `tempTablesReferenced`/`dependsOn`/静的検証/ストア注入が全て抜ける）。R2 の `cteName`＋`appId` が正しく R3 の改名が誤り。バッチ解析の受入・テストを明記。軽微＝目的文/AST コメント/ロードマップ例の `APP<n>` 化
  - 2026-07-16 R5: B12 R3レビュー反映。B12 の `#err` はUPSERT入力列だけを保持し差分アプリ `$id` を持たないため、看板ユースケースは非 `$id` 結合を必要とする。v1.1 業務キー結合を §12 に追加し、リリース順を B12-A → B11 v1.1 → B12-B と確定
  - 2026-07-16 R3: codex レビュー反映（コードで裏取り）。**High①CTE を v1 スコープ外**（`WithStatement.query` は SELECT|UNION のみ・`WITH … UPDATE` 不可のため。v1 ソース = **#temp ＋ APP\<n\>**）②**MCP 読み取り上限**＝UPDATE_FROM を SELECT-based DML 扱いにして `maxRecords` で読む（既存は plain UPDATE に `dmlMaxRows+1` を渡す）・`containsSelectBasedDml`/`resolveMutateRuntimeMaxRecords`/案内文/単文・バッチ MCP テストを実装範囲に追加③**対象取得を 50 件チャンク**化（`$id IN` 単発は件数増に耐えない。既存 `UPSERT_IN_CHUNK_SIZE=50` に倣う）。Medium④WHERE 分解の論理形を限定（結合式はトップレベル AND 連鎖の原子・ソース alias は結合式のみ・OR/NOT 配下の結合式は ParseError）⑤ソース値の正規化・列欠落・型変換を確定⑥ソースキー扱いを §7 で確定。Low⑦例を `APP<n>` へ修正
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: 後方互換の構文追加（`FROM` 句なしの既存 `UPDATE` は不変）→ minor

---

## 1. 目的とスコープ

`UPDATE` の `SET` 値に**他テーブル（一時テーブル `#temp` ／実アプリ `APP<n>`）のフィールド**を参照できるようにし、**アプリ間・テーブル間の転記**を1文で行う。主用途は B12 のエラー行 `#err` を差分アプリへ書き戻すユースケースだが、単体でも「別テーブルの値で更新する」頻出ニーズに応える。

### スコープ（v1）

1. **ソースは一時テーブル ＋ 実アプリ**（`FROM #src` / `FROM APP<n>[@profile]`）。**CTE（`WITH … UPDATE … FROM cte`）は v1 スコープ外**（High①・§スコープ外）。結合・複数マッチ・PUT は共通で、**ソース取得のみ分岐**（#temp＝バッチストア／app＝fetch・maxRecords 準拠）。
2. **結合はターゲット `$id` とソースの単一等値**：`WHERE <target>.$id = <alias>.<key>`（ちょうど 1 つ必須）。
3. **複数マッチ＝実行前エラー固定**（ソースに同一キーが複数 → `ArgumentError`。決定性維持。app ソースでも同様）。
4. **親レコード UPDATE 限定**（`subtableCode` なし。サブテーブル `UPDATE … FROM` は対象外）。
5. `SET` 値は **ソースの修飾フィールド参照**（`alias.field`）／**リテラル**／**ターゲット自身の算術**（既存 `金額 = 金額 * 1.1`）を混在可。

### スコープ外（将来拡張・本 v1 では非対応）

- **CTE ソース `WITH cte AS (…) UPDATE … FROM cte`**（High①）。現行 `WithStatement.query` は `SelectStatement | UnionStatement` のみ（[ast.ts:159](../../src/types/ast.ts#L159)）・`CteDefinition.query` も UPDATE を持てないため、`WITH … UPDATE` は parser/dispatch/cteCache を横断する別実装。**ソースの絞り込みが要る場合は先に `CREATE TEMP TABLE #src AS SELECT …` で #temp 化して渡す**運用（バッチ内で完結）。将来 `WithStatement.query` を UPDATE まで拡張する場合は別課題。
- `$id` 以外の結合キー（`target.顧客コード = src.code` 等）は **v1.1（§12）で追加予定**。複数等値・不等値結合は引き続き対象外。
- サブテーブル `UPDATE … FROM`。
- app ソースへの `WHERE` フィルタ（`FROM APP200 s WHERE s.区分 = 'X'` のような**ソース側絞り込み**）。v1 は結合等値のみ＝ソース全件を対象に結合（ソースの絞り込みは事前に #temp 化して渡す）。
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
UPDATE APP<t>
SET <col> = <alias>.<field> [, <col> = <literal | ターゲット算術> ...]
FROM ( #<src> | APP<n>[@profile] ) [AS] <alias>
WHERE APP<t>.$id = <alias>.<key>
  [ AND <ターゲット側フィルタ> ] ;
```

- `FROM` 句のソースは **一時テーブル `#src` ／実アプリ `APP<n>`**（CTE は v1 非対応）。
- `FROM` 句は `SET` の後・`WHERE` の前（SQL 慣行）。
- `WHERE` は **ちょうど 1 つの結合等値 `<app>.$id = <alias>.<key>`** を含むこと（順序は `<alias>.<key> = <app>.$id` も可）。
- 残りの `WHERE` 条件（AND 結合）は**ターゲット側フィルタ**（対象アプリのフィールド条件）として扱う。ソース alias を参照する追加条件は v1 では非対応（結合等値のみ）。
- `FROM` 句を書かない `UPDATE` は従来どおり（後方互換）。

### 例（B12 の書き戻し・差分アプリ = APP4220）

```sql
UPDATE APP4220
SET 処理ステータス = 'エラー', エラー内容 = e.$err_message
FROM #err e
WHERE APP4220.$id = e.差分ID;
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
  /** UPDATE … FROM のソース（v1 は #temp または実アプリ APP<n>）。null で従来 UPDATE */
  from?: UpdateFromSource | null;
}

export interface UpdateFromSource {
  /** 実アプリソースの APP 番号（#temp のときは 0）。既存 FROM の appId と同形 */
  appId: number;
  /** 一時テーブル名 #src（実アプリのときは null）。**プロパティ名は既存 FROM と
   *  同じ `cteName`**（先頭 `#`）にすること＝`collectRefs`（batch.ts:125）が
   *  汎用走査で temp 参照を自動検出し、tempTablesReferenced / dependsOn /
   *  未定義・DROP 後参照検証 / バッチ実行のストア注入が既存機構で働く。
   *  v1 では WITH-CTE 非対応のため値は常に #temp を指す（CTE 名は入らない） */
  cteName: string | null;
  alias: string;
  /** 結合等値のソース側キー列（WHERE から抽出した <alias>.<key> の key） */
  joinKeyField: string;
  /** WHERE から結合等値を除いたターゲット側フィルタ（null 可・target-only） */
  targetFilter: WhereExpr | null;
}
```

> **重要（codex R3 再レビュー・High）**: 一時テーブル参照の検出は [`collectRefs`](../../src/core/batch.ts#L118) が **`cteName` プロパティ（先頭 `#`）と `appId`** を AST 全走査で拾う汎用実装。`UpdateFromSource` も **`cteName` を使う**ことで、`UPDATE … FROM #e` の temp 参照・app ソースの `appId`（トークン要求）が**追加コードなしで自動配線**される（`tempName` 等の別名にすると `tempTablesReferenced`・`dependsOn`・静的検証・ストア注入が全て抜ける）。実行側のバッチガード緩和（§6）は別途必要。

```ts
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

1. `parseUpdate`（[parser.ts:222](../../src/parser/parser.ts#L222) 経由）で `SET` リスト解析後に **任意の `FROM <#src | APP<n>[@profile]> [AS] alias`** を解析（既存 `FROM` のテーブル参照パーサーを流用し appId/cteName を確定。**CTE 名は非対応**＝#temp または APP のみ）。
2. `SET` 値パーサーに **`alias.field` 修飾参照**を追加（`FROM` 句がある UPDATE でのみ許可。alias はその `FROM` の alias に一致）。`FROM` なしで `alias.field` を書いたら ParseError（従来メッセージ「SET の値にはリテラル・算術式を指定してください」を踏襲）。

### 5.1 WHERE 分解の論理形（Medium④・厳密規則）

`WHERE` から結合等値を安全に取り出すため、受理する論理形を限定する。`WHERE target.$id = s.key OR target.状態 = '有効'` のように結合式を単純除去すると意味が変わるため、**結合式はトップレベルの `AND` 連鎖に属する独立した原子条件**でなければならない。

- **結合等値**: `<target>.$id = <alias>.<key>`（左右反転可）を**トップレベル AND 連鎖の中にちょうど 1 つ**。`$id` は非修飾 `$id` も許容（対象アプリは 1 つ）。
- **ソース alias の出現は結合等値の中だけ**。他のどこ（他の AND リーフ・OR/NOT 配下・関数引数）に `alias.*` が現れたら **ParseError**。
- **結合等値が `OR` / `NOT` の配下**にある場合は **ParseError**（`WHERE a=b OR …`、`WHERE NOT (a=b)` 等）。
- **`targetFilter` = トップレベル AND 連鎖から結合等値を除いた残り**（target-only）。残りの中の**括弧内 `OR` は target-only なら許可**（`… AND (状態='A' OR 状態='B')`）。
- 結合等値が 0 個・複数個・`$id` 以外を左右に持つ・ソース alias が結合式外に出現 → **ParseError（明確なメッセージ）**。

境界値の parser テスト（§9）で `OR`/`NOT` 配下の結合式・複数結合等値・target-only 括弧 OR を固定する。

---

## 6. 実行（`executeUpdate` 拡張）

`stmt.from != null` のとき新経路。**cteCache/tempTables を結線**（現状未接続）。

```
1. ソース行を取得（出自で分岐）:
     #temp (from.cteName != null): tempTables/cteCache.get(from.cteName) の rows（実体化済み・上限 tempTableMaxRows）
     実アプリ (from.appId != 0):     from.appId を fetchAll で取得（joinKeyField + SET 参照列）
                                     ・maxRecords 準拠。上限超過は onLimit に依らず error（fail-closed・下記）
2. ソースキー正規化＋targetId → sourceRow マップ構築（§7 の規則）:
     各ソース行の from.joinKeyField を正規化: 空/非整数/0以下 → ArgumentError（PUT ゼロ）
                                              数値文字列 → 正の安全整数へ
     正規化後 targetId が2行以上で同一 → ArgumentError（複数マッチ＝ソースキー重複・実行前・何も書かない）
3. 対象取得（50 件チャンク・High③）:
     targetIds を 50 件（UPSERT_IN_CHUNK_SIZE）ずつに分割し、各チャンクへ
       $id in (chunk) AND <from.targetFilter> を発行（splitChunks 流用）
     全チャンクの取得後に matched を確定（存在しない $id は自然に 0 マッチ＝無視）
4. 実行前 confirm(matched件数, "UPDATE")
5. PUT データを全件構築・検証してから最初の PUT を送る（部分書き込み防止）:
     SOURCE_FIELD → 正規化後 sourceRow[field]（§6.1）。SET/フィルタ参照列が
                    ソースに存在しなければ ArgumentError（最初の PUT 前）
     リテラル/ターゲット算術 → 従来通り（対象行の値で評価）
     ターゲットフィールド型に応じた既存変換（dmlToKintone 相当）を通す。変換不能は全 PUT 前に失敗
   updateToPutBatchesArith 相当の per-record 経路で 100 件チャンク PUT
6. updatedCount = matched（targetFilter 適用後）件数
```

### 6.1 ソース値の正規化・列欠落・型変換（Medium⑤）

`SOURCE_FIELD → sourceRow[field]` は temp と app で値表現が異なるため、**共通表現へ正規化してから**ターゲット型変換を通す。

- **値表現の統一**: #temp は `ProcessRow`（プリミティブ文字列値）、app は `KintoneRecord`（`{ value: … }`）。ソース取得直後に**両者を `ProcessRow` 相当（`field → 文字列/配列`）へ正規化**する共通関数を1か所に置く（app は `flatten` 相当を流用）。以降の結合・SET 評価は正規化後の表現のみを扱う。
- **列欠落**: SET/フィルタが参照するソース列がソースに存在しない → **最初の PUT 前に `ArgumentError`**（サイレントな空値書き込みをしない）。
- **型変換**: ターゲットフィールド型に応じた**既存の DML 変換経路**（`dmlToKintone`）を通す。変換不能（数値フィールドへ非数値文字列等）は**全 PUT 構築時に検出し、最初の PUT 前に失敗**。
- **複合型の範囲（v1）**: `SOURCE_FIELD` はまず**スカラー系**（文字列/数値/日付/選択1個等）を対象。**配列・ユーザー/組織/グループ選択・添付ファイルは v1 非対応**（`ArgumentError`・将来拡張）。B12 の `#err`（`$err_message` 等はテキスト）はスカラーで足りる。

### 6.2 MCP の読み取り上限（High②）

現行 MCP は `INSERT_SELECT`/`UPSERT_SELECT` だけを SELECT-based DML 扱いにし、plain `UPDATE` には `dmlMaxRows + 1` を読み取り上限として渡す（[tools.ts:320,335](../../src/mcp/tools.ts#L320)）。**`UPDATE … FROM` はソース読み取り件数 ≠ 影響行数**（ソース 20 件・更新 1 件でも成立）なので、この上限では 11 件目で失敗する。

- **解析属性 `UPDATE_FROM` を導入**（statementType の細分 or `isUpdateFrom` フラグ）。`containsSelectBasedDml`（実質「ソース読み取りが影響行数と乖離する DML」）を **`UPDATE_FROM` も真**に拡張し、`resolveMutateRuntimeMaxRecords` が `undefined`（＝通常の `maxRecords` 解決）を返すようにする。
- **読み取り上限エラーの案内文**（[tools.ts:342](../../src/mcp/tools.ts#L342) 付近）に `UPDATE … FROM` 用の文脈を追加（「`dmlMaxRows` ではなく `maxRecords` を上げる／ソースを絞り込む」）。
- **MCP テスト**を単文・バッチ双方で追加（ソース > dmlMaxRows でも更新が成立・app ソース maxRecords 超過で fail-closed）。

### その他
- **app ソースの取得上限は fail-closed**: 複数マッチ検出には**全ソース行**が必要なため、app ソースが maxRecords を超えたら `onLimit=truncate` でも**打ち切らずエラー**（truncate すると重複キーを見逃し＝決定性喪失）。#temp は実体化時に上限確定済みで問題なし。巨大な app ソースは事前に #temp 化して渡す。
- **ソースのトークン/プロファイル**: app ソース `APP<n>[@profile]` は `extractAppIds` がトークンを解決（既存 FROM と同経路）。
- **バッチガード緩和**（[execute.ts:516-522](../../src/execute.ts#L516)）: `UPDATE` かつ `from.cteName != null`（#temp 参照）を許可対象に追加。`collectRefs` により `tempTablesReferenced` に `#src` が入る前提で、dependsOn（CREATE への依存）・未定義/DROP 後参照検証は既存経路で働く。従来の「UPDATE のサブクエリ temp 参照は拒否」は維持（`from` 経路とサブクエリ経路を区別）。app ソース `UPDATE … FROM APP<n>` は temp 非参照のためガード対象外（単文でも実行可）。
- `executeUpdate` のシグネチャに tempTables/cteCache を追加し、[execute.ts:406](../../src/execute.ts#L406) の dispatch・バッチ経路（[executeBatchStatement](../../src/execute.ts#L619)）から注入。#temp ソースはバッチスコープ、app ソースは単文でも可。

---

## 7. 設計判断・確定事項

- **複数マッチ = 実行前エラー**（決定性。先勝ち不採用）。ソースキー重複で `ArgumentError`、書き込みゼロ。#temp・app ソースとも同一規則。
- **結合キーは `$id` 単一等値**（v1）。`$id` は必ず一意のため、複数マッチ＝ソース重複に一元化できる。
- **ソースキーの扱い（Medium⑥・R3 で確定）**:
  - **空・非整数・0 以下** → `ArgumentError`（PUT ゼロ）。
  - **数値文字列** → 正の安全整数へ正規化。
  - **存在しない `$id`** → 0 マッチとして無視（更新なし）。
  - **正規化後に同一 ID となるキー**（例 `"1"` と `1`、`" 1"` 等） → 複数マッチエラー。
- **app ソースは取得上限で fail-closed**（§6）。全ソース行が揃わないと複数マッチを検出できないため、maxRecords 超過は truncate せずエラー。
- **対象取得は 50 件チャンク**（High③・§6）。`$id in (...)` 単発は件数増・クエリ長で破綻するため `UPSERT_IN_CHUNK_SIZE=50` に倣い分割。各チャンクに同じ `targetFilter` を適用し、全取得後に件数確定・confirm、全 PUT 構築・検証後に最初の PUT。
- **MCP 読み取り上限は `maxRecords`**（High②・§6.2）。`UPDATE_FROM` を SELECT-based DML 扱いにし `dmlMaxRows+1` を渡さない。
- **ターゲット側フィルタ**は各チャンクの取得クエリに合流（`$id in (chunk) AND filter`）。フィルタで外れた targetId は更新しない（`updatedCount` に含めない）。
- **WHERE を AST で分解**（生 WHERE を実行層に渡さない・§5.1 の厳密規則）。
- **dmlMaxRows / confirm** は matched 件数で判定（既存 UPDATE と同一）。ソース読み取りは別枠（`maxRecords`・§6.2）。

---

## 8. v1 受入条件（実装済み）

- [ ] **temp ソース**: `UPDATE app SET c = e.f FROM #e WHERE app.$id = e.k` が、`#e` の各行のキー `k`（=対象 $id）の対象を `e.f` の値で更新する。
- [ ] **app ソース**: `UPDATE app SET c = s.f FROM APP200 s WHERE app.$id = s.k` が、APP200 の各行のキー `k` の対象を `s.f` で更新する（アプリ間転記）。
- [ ] `SET` にソース参照・リテラル・ターゲット算術を混在できる（`SET a = e.x, b = 'const', c = 金額 * 1.1`）。
- [ ] **複数マッチ**（ソースに同一 `k` が2行・temp/app とも）→ `ArgumentError`・**PUT 未実行**（書き込みゼロ）。
- [ ] **app ソースの取得上限**: APP200 が maxRecords 超過 → `onLimit=truncate` でも**エラー**（fail-closed・PUT 未実行）。
- [ ] **ターゲット側フィルタ**（`AND app.状態 = '有効'`）で外れた対象は更新されず `updatedCount` に含まれない。
- [ ] ソース 0 行 → `updatedCount = 0` の no-op・PUT 未実行。
- [ ] `FROM` 句なしの既存 `UPDATE`（一律・算術・スカラーサブクエリ）は**完全に不変**（回帰）。
- [ ] `FROM` にサブクエリ／CTE 名／`$id` 以外の結合キー（v1時点）／複数等値／ソース alias をフィルタに含む／ソース側 WHERE／結合式が `OR`・`NOT` 配下 → **ParseError**（v1 非対応の明確なメッセージ）。
- [ ] **50 件超の対象**（例 targetIds 130 件）→ 3 チャンクに分割取得し全件更新（1 クエリに詰め込まない）。
- [ ] **ソースキー**: 空/非整数/0 以下 → `ArgumentError`（PUT ゼロ）。`"1"` と `1` の混在 → 複数マッチエラー。存在しない `$id` → 無視。
- [ ] **ソース列欠落**（SET 参照列がソースにない）→ 最初の PUT 前に `ArgumentError`。
- [ ] **配列/ユーザー/添付の SOURCE_FIELD** → v1 は `ArgumentError`。
- [ ] **MCP**: ソース件数 > `dmlMaxRows` でも `UPDATE … FROM` が成立（単文・バッチ）。読み取り上限は `maxRecords`。
- [ ] `confirm`／`dmlMaxRows` は matched 件数で発火（超過で PUT 未実行）。
- [ ] サブテーブル `UPDATE … FROM` は ParseError（対象外）。
- [ ] **バッチ解析**: `UPDATE … FROM #e` が `tempTablesReferenced=['#e']` を持ち、CREATE #e への `dependsOn`・未定義参照/DROP 後参照の静的エラーが働く（`cteName` 採用で `collectRefs` が自動検出）。
- [ ] `$id` を明示的に持つソースからの書き戻し例（`... WHERE APP4220.$id = e.差分ID`）が動作。B12標準 `#err` は差分IDを持たないため、看板ユースケースはv1.1 §12で受け入れる。

## 9. テスト計画（修正前 fail → 修正後 pass）

### パーサー
- temp: `UPDATE APP100 SET c = e.f FROM #e WHERE APP100.$id = e.k` → `from` に appId=0/cteName=`#e`/alias/joinKeyField、targetFilter=null。**analyzeBatch で `tempTablesReferenced=['#e']`・CREATE #e への dependsOn** が入る。
- app: `UPDATE APP100 SET c = s.f FROM APP200 s WHERE APP100.$id = s.k` → `from` に appId=200/cteName=null/alias/joinKeyField。**appId=200 が collectRefs で拾われトークン要求**。
- ターゲットフィルタあり → targetFilter に格納・結合等値は除外。target-only 括弧 OR（`AND (状態='A' OR 状態='B')`）は許可。
- **境界値（Medium④）**: `WHERE …$id=s.k OR …`（結合式が OR 配下）→ ParseError。`NOT (…$id=s.k)` → ParseError。結合等値 2 個 → ParseError。ソース alias が結合式外に出現 → ParseError。
- ParseError: 結合等値 0/複数、`$id` 以外の結合、サブクエリ FROM、CTE 名 FROM、フィルタにソース alias、ソース側 WHERE、サブテーブル、`FROM` なしの `SET c = e.f`。

### 実行（execute 経由・PUT モック）
- temp 基本転記（3 行）→ 各対象が対応ソース値で PUT・updatedCount=3。
- app 基本転記（`FROM APP200`・3 行）→ APP200 を read・結合・PUT・updatedCount=3。
- **50 件超**（targetIds 130 件）→ 3 チャンクの `$id in (...)` 取得・全件 PUT。
- 複数マッチ（#temp/app／`"1"`+`1` 正規化衝突）→ ArgumentError・PUT 未呼び出し。
- ソースキー 空/非整数/0 以下 → ArgumentError・PUT 未呼び出し。
- ソース列欠落 → ArgumentError（最初の PUT 前）。
- 配列/ユーザー/添付の SOURCE_FIELD → ArgumentError。
- app ソース maxRecords 超過（onLimit=truncate）→ エラー・PUT 未呼び出し。
- ターゲットフィルタで 1 行除外 → updatedCount 減・除外行は PUT されない。
- 0 行ソース → no-op・PUT 未呼び出し。
- 混在 SET（ソース参照＋リテラル＋ターゲット算術）→ 各値が正しく PUT。
- **回帰**: 既存 UPDATE（一律・算術・スカラーサブクエリ・サブテーブル）が不変。
- バッチ: `CREATE TEMP TABLE #e AS …; UPDATE APP100 … FROM #e …`（ガード緩和）／単文 `UPDATE APP100 … FROM APP200 …`（temp 非依存）。

### MCP（High②）
- 単文 `UPDATE … FROM APP200`：ソース 20 件・`dmlMaxRows=10`・更新 1 件 → 成立（読み取り上限は `maxRecords`）。
- バッチ内 `UPDATE … FROM`：同様に `dmlMaxRows+1` で切られない。
- app ソース maxRecords 超過 → fail-closed エラー・案内文に `UPDATE … FROM` 文脈。

## 10. リスク・非対象

- **リスク（WHERE 分解の曖昧さ）**: §5.1 の厳密規則（結合式はトップレベル AND 原子・ソース alias は結合式のみ・OR/NOT 配下は ParseError）で誤抽出を防止。実行層は分解済み AST のみ扱う。
- **リスク（ストア結線漏れ）**: `executeUpdate` の tempTables/cteCache 追加を全 dispatch/バッチ経路へ。型変更をコンパイラに拾わせる。
- **リスク（app ソースのサイレント欠落）**: maxRecords 超過で重複キー検出が不完全 → truncate せず **fail-closed でエラー**（§6）。巨大ソースは事前 #temp 化を案内。
- **リスク（MCP 読み取り上限）**: `UPDATE_FROM` を解析属性で識別し `dmlMaxRows+1` を渡さない（§6.2）。漏れると更新可能でも読み取りで失敗するため MCP テスト必須。
- **非対象**: CTE ソース・非 $id 結合・複数等値・サブテーブル・ソース側 WHERE 絞り込み・複合型 SOURCE_FIELD・`DELETE/UPSERT … FROM`（将来拡張）。

## 11. 未決事項（codex / ユーザー判断）

- **なし**（R5 で B12-B に必要な業務キー結合を v1.1 として採用）。CTE ソース、複数等値・不等値結合、複合型 SOURCE_FIELD は将来拡張として別課題化する。

## 12. v1.1：業務キー結合（B12-B リリースゲート）

### 12.1 構文と範囲

```sql
UPDATE APP4220
SET 処理ステータス = 'エラー', エラー内容 = e.エラー内容
FROM #err_summary e
WHERE APP4220.顧客コード = e.顧客コード;
```

- 結合は v1 と同じくトップレベル AND 内の**単一等値1個**。`target.<scalar-field> = source.<scalar-field>`（左右反転可）を追加する
- ターゲット結合キーは `$id`（v1互換）／`SINGLE_LINE_TEXT`／`NUMBER` のみ。フィールド不存在、サブテーブル子フィールド、`CALC`、ルックアップコピー先、配列・ユーザー等の複合型は対象外とし、ターゲット取得前に `ArgumentError`
- app source の結合キーも `SINGLE_LINE_TEXT`／`NUMBER`（`$id` を含む）のみ。フィールド不存在・非対応型はターゲット取得前に `ArgumentError`。#temp source は型メタを持たないため、全行の結合キーがスカラー文字列であることを実行時に検査する
- ソースキーはターゲット型へ正規化してから索引化する。同じ正規化キーを持つソース行が複数あれば、対象 PUT 前に複数マッチエラー
- ターゲット側に同じ業務キーの行が複数ある場合は、それぞれが同じ1ソース行へ対応するため全行を更新する。1件限定を求める場合は利用者がkintone側で「値の重複を禁止する」を設定する
- 空のソースキーは `ArgumentError` とし、黙って非一致にしない。対象側の空値は一致対象外。文字列キーの空判定は値が厳密に `""` の場合だけとし、空白だけの値は空とはみなさない
- target filter、confirm、`dmlMaxRows`、全PUT構築後に送信、app sourceのmaxRecords fail-closedはv1規則を維持する

#### 12.1.1 キー正規化（通常実行・VALIDATE ONLY 共通）

正規化は source 重複検査、ターゲット検索値、取得したターゲット行の source 逆引きで**同じ共通関数**を使う。JavaScript の `Number()` を索引キー生成に使わず、IEEE 754 の丸めで異なる業務キーを衝突させない。

- ターゲットが `SINGLE_LINE_TEXT`: source を文字列のまま使用する。trim・大文字小文字変換・Unicode正規化を行わず完全一致。したがって `"001"` と `"1"`、`" A "` と `"A"` は別キー
- ターゲットが `NUMBER`: 前後空白を除いた有限10進表記（符号、整数部、小数部）だけを受理し、指数表記・`NaN`・`Infinity` は拒否する。符号、先頭ゼロ、小数末尾ゼロを文字列演算で正規化し、`+1`／`01.0`／`1` は同一、`-0`／`0` は同一とする。安全整数を超える整数・高精度小数も文字列精度を保持する
- `$id`: v1どおり前後空白を除いた正の安全整数だけを受理する
- source の正規化後キーが重複した場合は、対応するターゲットが0件でも `ArgumentError`。すべての source key を検証し終えるまでターゲット取得を開始しない

### 12.2 AST・実行差分

- `UpdateFromSource` に `targetJoinField: string` を追加。v1の `$id` 結合も `targetJoinField="$id"` として同じ形へ寄せる
- parser の `isTargetIdRef()` 固定判定を、許可型を静的/実行前検証する target field 抽出へ拡張する
- **通常実行と `VALIDATE ONLY [INTO #err]` の両方**を対象とする。source取得、許可型・列検証、キー正規化、target取得、`target + source` の matched 生成を共通ヘルパーへ集約し、通常実行と検証候補生成で別実装を持たない
- 共通照合器はソースキー集合を確定・重複検査後、ターゲットを `<targetJoinField> in (...) AND <targetFilter>` でチャンク取得する。取得フィールドには `$id`、`targetJoinField`、SET のターゲット算術参照列を含め、取得行の正規化済み `targetJoinField` で source を逆引きし、`$id` をPUTキーに使う
- kintone の文字列（1行）`=` / `in` 比較は先頭64文字で判定される（[ONLY CHANGED spec §8](ksql_only_changed_upsert_spec.md#8-制限事項)）ため、64文字超のキーでは同じ先頭64文字を持つ行が過剰取得され得る。`in` の取得結果をそのまま matched とせず、取得した `targetJoinField` 全文を §12.1.1 の文字列規則で source 索引へ完全一致逆引きし、一致しない過剰取得行は除外する。完全一致行は必ず候補に含まれるため取りこぼしはなく、誤更新もしない
- 64文字制約による過剰取得行も読み取り済みレコードとして全チャンク合計 `maxRecords` を消費する。過剰取得を除外した matched 件数だけを `confirm`／`dmlMaxRows`／`updatedCount`／検証候補件数へ用いる
- `in` の生成は既存 `resolveUpsertTargets` の第1キー照合（`UPSERT_IN_CHUNK_SIZE=50`、`splitChunks`、`sqlQuote`）と同じクエリ長・エスケープ制約および50件上限へ準拠する
- ターゲット取得の1チャンクあたり `maxRecords` をキー数に固定しない。同じ業務キーを持つ複数ターゲットを全件取得し、**全チャンク合計**に実行時 `maxRecords` を適用する。上限超過は `onLimit` にかかわらず PUT 0回で fail-closed
- 全ターゲット取得と matched 生成の完了後に `confirm(matched件数, "UPDATE")` を呼び、`dmlMaxRows` を実際の更新対象行数へ適用する。その後、全PUTを構築・検証してから最初のPUTを送る
- `VALIDATE ONLY` も同じ matched 集合から候補を生成するため、通常実行と対象行・順序・照合エラーが一致する。`VALIDATE ONLY` は従来どおり PUT と confirm を呼ばない
- 型・書込可否等のフィールド情報はB12-Aで拡張した `KintoneFieldInfo` を共有する。`$id` 結合はターゲット業務キーメタ取得を追加せず、v1 のAPI回数を維持する

### 12.3 受入条件

- §12.1 のB12書き戻し例が動作する
- 文字列/数値キーの正常系、左右反転、target filterを受理する
- 文字列キーは完全一致（`001`≠`1`、前後空白を保持）。数値キーは `+1`／`01.0`／`1` と `-0`／`0` を同一視し、安全整数超過・高精度小数でも精度を失わない。指数表記・非有限値は PUT 0回でエラー
- source 1行に同じキーのtargetが2件以上ある場合、全targetを更新する。全チャンク合計 `maxRecords` 超過、または実対象件数の `dmlMaxRows` 超過は PUT 0回でエラー
- 65文字以上の文字列キーについて、先頭64文字が同じで全文が異なるtarget行をkintoneの `in` 結果へ含めても、その行はローカル完全一致で除外され更新されない。全文一致行は更新される。過剰取得行を含めた取得件数が `maxRecords` を超えた場合は PUT 0回でエラー
- 正規化後のソースキー重複（target 0件の場合を含む）、空キー、target/source列欠落、非対応型、複数結合、OR/NOT配下の結合は PUT 0 回でエラー
- 通常実行と `VALIDATE ONLY`／`VALIDATE ONLY INTO #err` で、業務キー照合後の対象集合と照合エラーが一致する。検証経路は PUT・confirm 0回
- `$id` 結合のv1テストとAPI回数に回帰がない
