# 仕様案: STATUS（ワークフロー状態）の `IN` 押し下げ（述語分割 第2段・フェーズ2b）

- 作成日: 2026-07-15
- ステータス: **実装済み・v2.7.0 リリース済（STATUS の IN 押し下げ・status.json 検証）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版（実機ゲート済）。
  - 2026-07-15 R2: codex レビュー反映（コードで裏取り）。
    - **[High] 本番境界は 8 経路**（node HTTP・UI・metrics・requestGate・CLI dry-run・MCP no-op・**CLI ルーター**[index.ts:1898](../../src/cli/index.ts#L1898)・**runtime ルーター**[runtime.ts:357](../../src/node/runtime.ts#L357)）＋テストモック。`getProcessStatuses` は appId を取るため `getFields` 同様に**両ルーターで binding 解決してから対象クライアントへ**（漏らすと `LAPP_` 論理参照が誤 route）。`getApps` は非ルート（app 非依存）だが本 API はルート必須。
    - **[High] STATUS 候補判定は 2 段階**（型メタ取得後）。構文候補はフィールド型を持たないため、「候補アプリに STATUS フィールドがある」ではなく「**構文候補の直接フィールドに `fieldTypes.get(code)==="STATUS"` があるアプリだけ** status.json を呼ぶ」。JOIN は対象エイリアスごとに候補フィールドを分離。
    - **[Medium] 失敗契約を統一**（§2.2/§3 の矛盾解消）: **API reject は伝播**（`getFields` と同じ）／`enable=false`・`states` 空・STATUS 候補なし・値が状態に非在は**非押下**。キャッシュは `Map<cacheContext, Map<appId, Promise<...>>>`（同時実行含め 1 回）。`states` は未設定時 `null` になり得るため境界で空配列へ正規化。
    - **[Medium] 多言語状態名**: `status.json?app=...&lang=user` を使い、状態集合は `Object.values(states ?? {}).map(s => s.name)` から生成（実行ユーザーの表示言語で統一・CLI/plugin とも）。言語別名称テストを追加。
    - **[Low] `ExecuteMetrics` に `processStatusCalls` を追加**（新 API 消費の観測）。
    - 承認: `fieldOptions` への状態集合マージ／`KintoneFieldInfo.enabled` を追加しない簡素化。権限=status 取得はレコード閲覧または追加権限で可・**アプリ管理権限は不要**。
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

### 2.2 メタ取得（`execute.ts` `loadTypedPushdownMeta`）＝2 段階（[High]）
現行 `loadTypedPushdownMeta`（[execute.ts:1155 の後継](../../src/execute.ts#L1155)）は構文候補をアプリ単位で集めるが**フィールド型を持たない**。STATUS 判定は次の 2 段階にする:
1. 候補アプリの **`getFieldTypeMap` を取得**（既存フロー・4 型/数値の型確定にも使う）。
2. **構文候補の直接フィールド**を収集し（JOIN は対象エイリアスごとに分離）、その中に **`fieldTypes.get(code)==="STATUS"` があるアプリだけ** `getProcessStatuses` を呼ぶ。NUMBER 比較や DROP_DOWN IN しかないアプリでは **status.json を呼ばない**。
- `enable=true` のときだけ、`fieldOptionsByApp` の **STATUS フィールドコード → 状態名集合** を追加する（`enable=false`・`states` 空は追加しない＝`fieldOptions` に無い→非押下）。既存の `getFieldOptionSetMapByApp`（optionOrder→キー集合）と**マージ**して一つの `fieldOptions` にする（4 型は optionOrder 由来、STATUS は status.json 由来）。
- **失敗契約（[Medium]・§3 と統一）**: `getProcessStatuses` の **reject は伝播**（`getFields` と同じ）。`enable=false`・`states` 空・STATUS 候補なし・値が状態に非在は**非押下**（エラーにしない）。
- **キャッシュ**: `Map<cacheContext, Map<appId, Promise<...>>>`（`getOptionOrderMapByApp` と同スコープ・**Promise を保持して同時実行でも 1 回**）。候補のないアプリでは呼ばない。

### 2.3 新クライアント境界（`KintoneClient`）＝8 経路（[High]）
- `KintoneClient`（[execute.ts:70](../../src/execute.ts#L70)）に **`getProcessStatuses(appId: number): Promise<{ enable: boolean; states: string[] }>`** を追加。**`GET /k/v1/app/status.json?app=<id>&lang=user`** の `enable` と、状態集合を **`Object.values(states ?? {}).map(s => s.name)`**（[Medium]・多言語）で返す。`states` が `null`（未設定）なら空配列へ正規化（境界で）。
- 配線（**8 経路**＋テストモック）:
  1. `nodeKintoneClient`（HTTP・`lang=user`）
  2. `ui/kintoneClient`（`api()`・plugin も `lang=user`）
  3. **`cli` ルーター**（[index.ts:1898](../../src/cli/index.ts#L1898)）: `appBindingByMappedApp` で binding 解決 → `routed.getProcessStatuses(binding.appId)`（`getFields` と同型）
  4. **`node/runtime` ルーター**（[runtime.ts:357](../../src/node/runtime.ts#L357)）: `resolveRuntimeBinding` → `routed.getProcessStatuses(binding.appId)`
  5. `withRequestGate`（[requestGate.ts:164](../../src/api/requestGate.ts#L164)・`runReadOnly`）
  6. `wrapClientWithMetrics`（[execute.ts:273](../../src/execute.ts#L273)・`metrics.processStatusCalls += 1`）
  7. `mcp` `noOpClient`（[tools.ts:158](../../src/mcp/tools.ts#L158)・`{enable:false,states:[]}`）
  8. `cli` `createDryRunClient`（[index.ts:798](../../src/cli/index.ts#L798)・同）
  ＋ 各テストモック（`makeClient` 等）に `getProcessStatuses` を追加（既存モックが壊れないよう）。
- **read-only**（`runReadOnly`）。DML ではない。**アプリ管理権限は不要**（レコード閲覧または追加権限で可）。
- **`ExecuteMetrics` に `processStatusCalls` を追加**（[execute.ts:115](../../src/execute.ts#L115)・[Low]）。

### 2.4 EXPLAIN
- STATUS IN も `pushdown candidate`（実行時の型・実在確認待ち）行。EXPLAIN は API を呼ばない契約を維持（候補は構文のみ・実在/enable は実行時）。

## 3. 押し下げ可否（STATUS）
`ステータス IN (...)` / `NOT IN (...)` を押し下げる条件:
- 左辺が単純フィールド参照（対象テーブル）・右辺 `IN_LIST` の全要素が**空でない文字列リテラル**。
- 型メタで左辺型 = `STATUS`。
- status.json が **`enable=true`** かつ **全 IN 値が `states`（`lang=user` の `.name`）に実在**。
- いずれか欠ければ**非押下**（無効・非実在・STATUS 候補なし＝`fieldOptions` に載らない）。FULL_SCAN の JS が正しく評価する。**status.json の reject（ネットワーク/権限エラー）は非押下でなく伝播**（`getFields` reject と同じ・§2.2）。

## 4. スコープと非対象
- **対象**: `STATUS` の `IN` / `NOT IN`（有効＋実在状態）。`evalWhere` の全 JS 評価経路（WHERE/HAVING/CASE WHEN/サブテーブル DML は STATUS 非該当だが経路は共通）。バッチ変数は解決後の文字列として扱う（フェーズ2a と同じ）。
- **非対象**: `STATUS_ASSIGNEE`（作業者・オブジェクト配列・ディレクトリ照合で USER 系と同じく押し下げ非対象）。`IN ('')`（空状態・`''` は非押下のまま JS 評価）。無効プロセス管理（非押下）。

## 5. 受入（フェーズ2b）
1. **有効＋実在状態の `IN`/`NOT IN` 押し下げ後 == 全件 JS 評価**（`ステータス IN ('処理中') AND … LIKE` → 4,7）。
2. **非実在状態を含む IN はリーフ非押下**（GAIA_IQ10 を出さず・LIKE 併記など JS 評価経路で・他リーフは押下）。
3. **プロセス管理無効アプリの STATUS IN は非押下**（GAIA_ST02 回避・FULL_SCAN が JS 評価）。
4. **[High] status.json は「STATUS 候補フィールドのあるアプリ」だけ**呼ぶ。NUMBER 比較・DROP_DOWN IN しかないアプリでは**呼ばない**（型メタ取得後の 2 段階判定・`processStatusCalls` で検証）。JOIN は対象アプリごと。
5. **APP/profile 別に 1 回**（キャッシュ・同時実行でも 1 回＝Promise 保持）。
6. **[High] `LAPP_` 論理参照の STATUS IN**（CLI/runtime ルーター）で、物理 APP＋profile の status.json を呼ぶ（誤 route しない）。
7. **[Medium] status.json の reject は伝播**（非押下でなくエラー）。`enable=false` / `states` 空/未設定（`null`→[]） は非押下。
8. **[Medium] 多言語**: `lang=user` で実行ユーザーの表示状態名を用い、その言語の `IN` リテラルで押し下げ・検証が一致（言語別名称テスト）。
9. **混在 `IN ('処理中','完了')`・`NOT IN`**（== SIMPLE）。
10. **`IN ('')` は非押下**（空状態・`''` ガード）で JS→0。
11. **STATUS_ASSIGNEE（作業者）は押し下げない**（型対象外）。
12. EXPLAIN に STATUS IN が `pushdown candidate` として現れる（API 非呼び出し）。
13. フェーズ2a 非退行: 4 型（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT）の押し下げ・空セル IN('')・数値/$id 押し下げが不変。**新クライアントメソッド追加で 8 経路＋既存モックが壊れない**（型・実行とも）。

## 6. 規模・注意
- 中規模: **新クライアント境界（status.json）＋ 8 経路配線（両プロファイルルーター含む）＋ 各テストモック ＋ APP/profile キャッシュ ＋ 2 段階 STATUS 候補判定**。抽出器はフェーズ2a をほぼそのまま流用（`SELECTION_IN_FIELD_TYPES` に STATUS 追加・`fieldOptions` に status.json 由来集合をマージ・`isSelectionInComparison` 不変）。
- SemVer: 後方互換の最適化 → **minor（v2.7.0 想定）**。
- プラグイン（`prod/js/desktop.js`）は FULL_SCAN/押下エンジンをバンドルするため要 `npm run build`。ただし status.json 取得はクライアント実装依存（プラグインの `ui/kintoneClient` にも `getProcessStatuses` 実装が要る）。

## 7. 進め方
- **本仕様を codex レビュー → 実装（独立コミット）→ 実装レビュー（コード裏取り）→ 実機（APP4221 有効/無効・実在/非実在で GAIA 回避と SIMPLE==FULL_SCAN・status.json 取得回数）→ v2.7.0 リリース**。
