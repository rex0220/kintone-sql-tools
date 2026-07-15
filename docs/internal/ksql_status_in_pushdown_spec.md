# 仕様案: STATUS（ワークフロー状態）の `IN` 押し下げ（述語分割 第2段・フェーズ2b）

- 作成日: 2026-07-15
- ステータス: **仕様案 R1（実機ゲート済・codex レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 位置づけ: 選択系 IN 押し下げ（[ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)）の**フェーズ2b**。フェーズ2a（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT・v2.6.0）で対象外とした **STATUS** を、プロセス管理設定 API による状態検証付きで押し下げる。
- 関連コード: `src/core/optimization/wherePredicatePushdown.ts`（`isSelectionInComparison` / `SELECTION_IN_FIELD_TYPES`）、`src/execute.ts`（`loadTypedPushdownMeta` / `getFieldOptionSetMapByApp` / `KintoneClient`:70 / EXPLAIN）、`src/cli/nodeKintoneClient.ts`・`src/ui/kintoneClient.ts`（クライアント実装）

## 0. 実機ゲート結果（APP4221・プロセス管理有効化して確認）

状態: 未処理(1,5,6) / 完了(2,8) / 保留(3) / 処理中(4,7)。

| クエリ | 結果 | 判定 |
|---|---|---|
| `ステータス IN ('処理中')` SIMPLE | 4,7 | 有効時は動作（GAIA_ST02 は**無効時のみ**） |
| **`ステータス IN ('存在しない状態')` SIMPLE** | **`GAIA_IQ10`「項目に存在しません」** | 有効時の非実在値は DROP_DOWN と同じ検証エラー → **状態値の実在検証が必須** |
| `ステータス IN ('処理中') AND $id LIKE '%'` FULL_SCAN | 4,7 | STATUS はスカラー状態名・SIMPLE==FULL_SCAN |
| `ステータス IN ('処理中','完了')` FULL_SCAN | 2,4,7,8 | 混在 OK |
| `ステータス NOT IN ('処理中')` SIMPLE / FULL_SCAN | 1,2,3,5,6,8 | NOT IN OK |
| `ステータス IN ('')` SIMPLE | 0（GAIA なし） | 有効時は空状態なし・`''` 非押下で JS→0 と一致 |

→ **確定事項**:
- **有効時の非実在状態値は `GAIA_IQ10`**（フィールド選択肢と同じ検証）。**無効時は `GAIA_ST02`**（プロセス管理無効）。どちらも押し下げると FULL_SCAN の「0 件」がエラーに化ける。
- よって押し下げには「**プロセス管理が有効**」かつ「**全 IN 値が実在状態**」の 2 条件が必要。
- STATUS はスカラー状態名で JS 評価と一致（フェーズ1 の型別評価でスカラー扱い・追加の評価修正は不要）。

## 1. 状態一覧の入手先（form fields では不足 → status.json）

- STATUS フィールドは form fields（`/k/v1/app/form/fields.json`）で **`options` を返さない**ため、`KintoneFieldInfo.optionOrder` は空（`describe` でも状態は出ない）。フェーズ2a の `optionOrder` 経路では検証できない。
- **プロセス管理設定 API `/k/v1/app/status.json`**（[get-process-management](https://cybozu.dev/ja/kintone/docs/rest-api/apps/process-management/get-process-management/)）が `enable`（有効/無効）と `states`（状態名の集合）を返す。**これを状態検証の情報源にする**。
- `enable` を status.json から得るため、**`KintoneFieldInfo` への `enabled` 追加は不要**（親仕様 R4 の想定を簡素化）。STATUS 候補のあるアプリだけ status.json を取得し、`enable=false` なら非押下（無効アプリの status.json 取得は稀で許容）。

## 2. 設計（フェーズ2a 基盤を最大流用）

### 2.1 抽出器（`wherePredicatePushdown.ts`）
- **`SELECTION_IN_FIELD_TYPES` に `"STATUS"` を追加するだけ**。`isSelectionInComparison` は現状のまま「型 ∈ 選択系 ∧ 全 IN 値 ∈ `fieldOptions.get(field)`」で判定する。**STATUS の妥当値集合は `fieldOptions` に status.json 由来の状態集合として載せる**（下記 2.2）。空文字ガード（`value.value !== ""`）も共通で効く。
- 候補抽出（`isSelectionInCandidate`・構文）は型メタ非依存なので変更不要（STATUS も `FIELD IN/NOT_IN IN_LIST(全 STRING)` で候補化）。

### 2.2 メタ取得（`execute.ts` `loadTypedPushdownMeta`）
- STATUS 候補のあるアプリについて、**status.json を取得**（新クライアント境界 2.3）。`enable=true` のときだけ、`fieldOptionsByApp` の **STATUS フィールドコード → 状態名集合** を追加する（`enable=false` は追加しない＝`fieldOptions` に無い→非押下）。
- 既存の `getFieldOptionSetMapByApp`（optionOrder→キー集合）と**マージ**して一つの `fieldOptions` にする（4 型は optionOrder 由来、STATUS は status.json 由来）。
- 取得は **STATUS 候補のあるアプリだけ**・**APP/profile 別キャッシュ**（`getOptionOrderMapByApp` と同様のスコープ付きキャッシュ）。候補のないアプリでは status.json を呼ばない。
- 取得失敗（reject）は既存の型メタ同様に伝播（メタ空＝非押下と区別）。

### 2.3 新クライアント境界（`KintoneClient`）
- `KintoneClient`（[execute.ts:70](../../src/execute.ts#L70)）に **`getProcessStatuses(appId: number): Promise<{ enable: boolean; states: string[] }>`** を追加。`GET /k/v1/app/status.json` の `enable` と `states`（キー＝状態名）を返す。
- 実装/モックを配線: `nodeKintoneClient`（HTTP）・`ui/kintoneClient`（`api()`）・`mcp` `noOpClient`（`{enable:false,states:[]}`）・`cli` `createDryRunClient`（同）・`withRequestGate`（`runReadOnly`）・`wrapClientWithMetrics`（パススルー）・各テストモック。
- **read-only**（`runReadOnly`）。DML ではない。

### 2.4 EXPLAIN
- STATUS IN も `pushdown candidate`（実行時の型・実在確認待ち）行。EXPLAIN は API を呼ばない契約を維持（候補は構文のみ・実在/enable は実行時）。

## 3. 押し下げ可否（STATUS）
`ステータス IN (...)` / `NOT IN (...)` を押し下げる条件:
- 左辺が単純フィールド参照（対象テーブル）・右辺 `IN_LIST` の全要素が**空でない文字列リテラル**。
- 型メタで左辺型 = `STATUS`。
- status.json が **`enable=true`** かつ **全 IN 値が `states` に実在**。
- いずれか欠ければ**非押下**（無効・非実在・status.json 取得不可＝`fieldOptions` に載らない）。FULL_SCAN の JS が正しく評価する。

## 4. スコープと非対象
- **対象**: `STATUS` の `IN` / `NOT IN`（有効＋実在状態）。`evalWhere` の全 JS 評価経路（WHERE/HAVING/CASE WHEN/サブテーブル DML は STATUS 非該当だが経路は共通）。バッチ変数は解決後の文字列として扱う（フェーズ2a と同じ）。
- **非対象**: `STATUS_ASSIGNEE`（作業者・オブジェクト配列・ディレクトリ照合で USER 系と同じく押し下げ非対象）。`IN ('')`（空状態・`''` は非押下のまま JS 評価）。無効プロセス管理（非押下）。

## 5. 受入（フェーズ2b）
1. **有効＋実在状態の `IN`/`NOT IN` 押し下げ後 == 全件 JS 評価**（`ステータス IN ('処理中') AND … LIKE` → 4,7）。
2. **非実在状態を含む IN はリーフ非押下**（GAIA_IQ10 を出さず・LIKE 併記など JS 評価経路で・他リーフは押下）。
3. **プロセス管理無効アプリの STATUS IN は非押下**（GAIA_ST02 回避・FULL_SCAN が JS 評価）。
4. **status.json は STATUS 候補のあるアプリだけ・APP/profile 別に 1 回**（キャッシュ・候補なしアプリは呼ばない・reject 伝播）。
5. **混在 `IN ('処理中','完了')`・`NOT IN`**（== SIMPLE）。
6. **`IN ('')` は非押下**（空状態・`''` ガード）で JS→0。
7. **STATUS_ASSIGNEE（作業者）は押し下げない**（型対象外）。
8. EXPLAIN に STATUS IN が `pushdown candidate` として現れる（API 非呼び出し）。
9. フェーズ2a 非退行: 4 型（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT）の押し下げ・空セル IN('')・数値/$id 押し下げが不変。新クライアントメソッド追加で既存モックが壊れない。

## 6. 規模・注意
- 中規模: **新クライアント境界（status.json）＋ 7 実装/モック配線 ＋ APP/profile キャッシュ**。抽出器と実行側判定はフェーズ2a をほぼそのまま流用（`SELECTION_IN_FIELD_TYPES` に STATUS 追加・`fieldOptions` に status.json 由来集合をマージ）。
- SemVer: 後方互換の最適化 → **minor（v2.7.0 想定）**。
- プラグイン（`prod/js/desktop.js`）は FULL_SCAN/押下エンジンをバンドルするため要 `npm run build`。ただし status.json 取得はクライアント実装依存（プラグインの `ui/kintoneClient` にも `getProcessStatuses` 実装が要る）。

## 7. 進め方
- **本仕様を codex レビュー → 実装（独立コミット）→ 実装レビュー（コード裏取り）→ 実機（APP4221 有効/無効・実在/非実在で GAIA 回避と SIMPLE==FULL_SCAN・status.json 取得回数）→ v2.7.0 リリース**。
