# B69 Phase1 — engine ライブラリ `QueryColumn` 列メタ公開 仕様

- 作成日: 2026-07-25
- ステータス: **🚧 実装済み・PR/リリース待ち**（2026-07-25・ブランチ `feat/b69-query-column-metadata`・commit e4ef98b）。仕様 R2 完全確定（codex クロスレビュー反映・Claude 実コード裏取り・オーナー判断済）→ §11.8 To-Do を codex 実装→Claude 実コードレビュー→全ゲート green（全 npm test 4,250＋CLI 26・snapshot 22 不変・build 全面・engine guard 群〔docs-smoke/declaration-smoke 5値20型/bundle-guard〕）。内部実行意味論・内部メタ semantics.source は不変。次＝PR→merge→次 minor リリース。以下は仕様本文。R1（Claude 起草）→ Claude 自己検証＋実エンジンプローブ（§10・真のブロッカー＝execute() 結果コピーで列メタ WeakMap が外れる、を特定・実メタ値確定・R1 の過剰設計2点是正）→ **codex クロスレビュー（§11・§10 が見落とした P1 を4件検出）を Claude が全数裏取り**→ **CTE/temp provenance＝opaque（オーナー決定 §11.3）**。未決なし。実装は WIP ブランチ `feat/b69-query-column-metadata` を起点に §11.8 To-Do で（実装は codex・レビューは Claude・git は Claude）。§2〜§9 は R1 本文（§10/§11 が上書き・訂正する）。
- 正: [B69 評価](ksql_b69_query_column_metadata_evaluation.md)／起草ブリーフ [HANDOFF-column-meta-v3.22.md](HANDOFF-column-meta-v3.22.md)
- 前提: B66 engine ライブラリ（[spec](ksql_b66_engine_library_phase1_spec.md)／[利用ガイド](../ksql_engine_library.md)）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B69

## 1. スコープ（Phase1）

B66 engine ライブラリ `runQuery()` の結果 `QueryColumn` に、列メタを**後方互換の追加**として公開する。対象は read-only SELECT / WITH / UNION（B66 `runQuery` が受理する範囲）。engine 本体には opt-in の列メタ capture 経路を追加する。

### 1.1 対象外

- 変数バインド（`:VAR`）／`AbortSignal`（B69 スコープ外・eval §6）。
- `runMutation` 等の書き込み系（B66 Phase2 と直交）。
- サブテーブル行・関連レコード内フィールドの列メタ細分化（Phase2 検討）。
- Pro プロジェクトへの tgz vendoring（Pro スコープ。本 B69 の DoD は engine 改修＋通常 npm publish まで）。

## 2. 公開契約（`QueryColumn`）

```ts
export interface QueryColumn {
  name: string;
  valueType: "string";        // 既存・維持
  fieldType?: string;         // 追加（optional）
  sortKind?: "number" | "string";  // 追加（optional）
  sourceApp?: number;         // 追加（optional）
}
```

- **後方互換**: 3 フィールドはすべて optional。既存 consumer は無影響。
- **型隔離（B66 契約の維持）**: 追加フィールドはすべて primitive（string / 文字列リテラル union / number）。engine 内部型（`ResolvedFieldSemantics`・`MaterializedColumnMeta` 等）は**公開面へ一切 re-export しない**。値は engine 内部メタから写した primitive だけを載せる。
- **意味**:
  - `fieldType`: 元 kintone フィールド型（`SINGLE_LINE_TEXT` / `NUMBER` / `DROP_DOWN` / `DATE` / `__ID__` 等）または式・集計の導出擬似型（`KSQL_NUMBER` / `KSQL_UNKNOWN` 等、engine が内部で用いる文字列をそのまま）。解決不能な列は `undefined`。
  - `sortKind`: 型別ソート比較器の種別。`"number"` / `"string"`。決定できない列は `undefined`（consumer は既定で文字列扱い）。
  - `sourceApp`: 単純フィールド参照列（`$id` 等システム列を含む）が一意な物理アプリへ解決できる場合の参照元 appId。式・集計・JOIN で曖昧な列・CTE/一時テーブル由来の列は `undefined`。

## 3. capture 機構（engine 側・opt-in）

- `ExecuteOptions.captureColumnMeta?: boolean`（既定 `false`）を追加。`true` のときだけ、SELECT / WITH / UNION の実行結果へ列メタを関連付ける。既定 false の従来動作・出力・API 消費は不変。
- 関連付けは既存の `materializedMetaBySelectResult`（`WeakMap<SelectResult, MaterializedColumnMetaMap>`）を流用し、`SelectResult` 形は拡張しない。取得アクセサ `getSelectColumnMeta(result): MaterializedColumnMetaMap | undefined` を export。
- 伝搬: `executeParsedStatement` の SELECT / UNION / WITH 分岐で `options.captureColumnMeta` を渡す。`executeUnion` は左右の子へ伝搬し、結果に `mergeUnionColumnMeta`（既存）を適用。
- ライブラリ側 `runQuery` は `execute(..., { ...executeOptions, captureColumnMeta: true })` とし、`getSelectColumnMeta(result)` から `toPublicColumn()` で公開列へマップする。

### 3.1 §3-1 解決（単純 SELECT で列メタが空）

`inferSelectColumnMeta` 冒頭の物理フィールド情報取得は `selectNeedsSourceColumnMeta(stmt)` ゲート（`FIELD`/`WILDCARD`/`CASE_COL`/`MIN`/`MAX`/`MODE` のときのみ取得）で最小化されている。これは**内部の実体化最適化**（型付き比較・append 互換が必要な列だけ取得）のためのゲートであり、ライブラリ capture では**全出力列に対してメタが要るため不十分**。

**解**: `inferSelectColumnMeta` に `forCapture: boolean`（既定 false）を渡し、`forCapture === true` のときは `selectNeedsSourceColumnMeta` を経由せず `physicalSelectTables(stmt)` の物理フィールド情報を無条件取得する。`getFieldsCached` は app/cacheContext 別キャッシュのため、集計のみの SELECT でも高々 1 回のメタ GET。records/mutation は発行しない。既定 false の実体化経路（CTE/一時テーブル）は従来どおりゲートを維持し取得を最小化する。

### 3.2 §3-2 解決（DATE_FORMAT 等の導出列で sortKind が undefined）

内部メタには2系統がある＝(a) top-level `sortKind` を持つ合成メタ（`syntheticColumnMeta`・`systemColumnMeta`）、(b) `sortKind` 未設定で `semantics.compareMode` だけを持つメタ（`unknownStringColumnMeta` 等）。draft の `toPublicColumn` は `meta.sortKind` のみを見るため、(b) の列（`DATE_FORMAT` 等の一部文字列関数）で `undefined` になる。

**解（公開マッピング規則）**:

```text
public.sortKind = meta.sortKind
                ?? (meta.semantics.compareMode が "number"|"string" ならそれ、"unsupported" は undefined)
```

`DATE_FORMAT`（NUMBER_RETURNING_STRING_FUNCTIONS 外）は文字列を返すため `compareMode: "string"` → 公開 `sortKind: "string"`。テスト期待値はこの engine 意味論へ合わせる。

### 3.3 §3-3 解決（`COUNT(*)` 等の集計列メタ）

集計・算術の合成メタは engine が付与する導出型・`compareMode` をそのまま写す（`COUNT` / `SUM` / `AVG` 等は数値 → `sortKind: "number"`、`fieldType` は engine の合成 semantics が持つ文字列をそのまま）。**テスト期待値は engine の実出力へ合わせる**（`KSQL_NUMBER` 等の固定文字列を仕様で新設せず、engine が現に返す値を公開値とする）。R2 で実値を確定して受入表に固定する。

### 3.4 公開マッピング規則（まとめ）

`toPublicColumn(name, meta)`:

```text
fieldType = meta.fieldType ?? meta.semantics.fieldType        （なければ undefined）
sortKind  = meta.sortKind ?? mapCompareMode(meta.semantics.compareMode)   （§3.2）
sourceApp = meta.semantics.source.appId                       （§4・capture 経路で付与された列のみ）
```

undefined のフィールドはオブジェクトに含めない（`...(x !== undefined ? {x} : {})`）。

## 4. `sourceApp` の付与範囲と §5 回帰リスクの解

`sourceApp` は `$id` 等システム列を含む「単純フィールド参照列」に付ける。物理フィールド参照は既に `materializedMetaFromFieldInfo(info, appId)` が `semantics.source` を設定する（既存挙動）。不足していたのは**システム列（`$id`/`_pid`/…）に source が無い**点で、draft は `systemColumnMetaWithSource` で補う。

**回帰リスク（eval §5）**: `fieldSemanticsEqual` は `source.appId` / `source.fieldCode` を同定に含む（`src/core/fieldSemantics.ts:75`）。`inferSelectColumnMeta` は **CTE/一時テーブルの実体化メタにも使われる**ため、システム列へ無条件に source を付与すると、**異なるアプリ由来の `$id` 列を同名一時テーブルへ append する互換判定が非一致になり回帰**する（例 `INSERT INTO #t SELECT $id FROM APP1; INSERT INTO #t SELECT $id FROM APP2`）。

**解**: システム列への source 付与を**ライブラリ capture 経路に限定**する。すなわち §3.1 の `forCapture` フラグを共用し、`inferSelectColumnMeta(..., forCapture)` が `true` のときだけ `systemColumnMetaWithSource` を用い、実体化（`forCapture=false`）では従来の `systemColumnMeta`（source なし）を維持する。これにより実体化メタの `fieldSemanticsEqual`（append 互換）は不変で、公開列だけが `sourceApp` を得る。

- 代替案（不採用）: `fieldSemanticsEqual` から source を除外する案は、source が同定の一部という既存契約を広く変えるため Phase1 では採らない（`mergeExpressionColumnMeta` は既に比較前に source を除去しており、局所的な非同定化の前例はあるが、全域変更は影響範囲が広い）。**要 codex 判断**。

## 5. UNION / WITH / JOIN

- **UNION**: 既存 `mergeUnionColumnMeta(left, right)` を用い、左右で列メタが一致する列のみメタを残す（不一致は公開フィールド undefined）。列名は左辺に位置対応。
- **WITH**: 最終 SELECT の列メタを capture（CTE 実体化メタは従来どおり内部利用）。単一 CTE inline 後の物理 SELECT も同様。
- **JOIN**: `inferSelectColumnMeta` の既存解決（`matches.length === 1` のときだけ確定）に従う。曖昧な非修飾列は `fieldType`/`sourceApp` とも undefined。

## 6. B66 公開面 drift guard の同期

engine 公開型の変更のため、B66 の公開面固定機構を同期する（**必須**）:

- `engine:declaration-smoke`（`.d.ts` の公開型検証）＝`QueryColumn` の新 3 フィールドを期待に反映。
- `engine:bundle-guard`（bundle baseline / forbidden シンボル）＝内部型が公開 bundle へ漏れないこと（追加は primitive のみ・型 re-export 0 を維持）。公開 value/type カウントの期待を更新。
- `engine:docs-examples-smoke` / pack-smoke＝`QueryColumn` メタを使う docs 例があれば追加し実行確認。
- `docs/ksql_engine_library.md` の公開 API 節へ列メタ（3 フィールド・opt-in でなく既定で付く点・undefined の意味・sourceApp の範囲）を追記。

## 7. 非回帰・受入（テスト化）

### 7.1 正例（capture）

- 物理フィールド列: `SELECT 会社名, 金額 FROM APP100` → 会社名 `fieldType: SINGLE_LINE_TEXT, sortKind: string`、金額 `fieldType: NUMBER, sortKind: number`、両者 `sourceApp: 100`。
- システム列: `SELECT $id FROM APP100` → `fieldType: __ID__, sortKind: number, sourceApp: 100`。
- 導出列: `DATE_FORMAT(...)` → `sortKind: string`（§3.2）。`LENGTH(x)` → `sortKind: number`。
- 集計: `COUNT(*)` → `sortKind: number`（`fieldType` は engine 実値・R2 で確定）。
- 式・JOIN 曖昧列 → `sourceApp` undefined。
- UNION で左右一致列のみメタ、不一致列は undefined。

### 7.2 非回帰（最重要）

- **`captureColumnMeta` 既定 false**の全経路で結果・列・API 消費・snapshot が不変（B66 `runQuery` の既存契約含む）。
- **実体化（CTE/一時テーブル）のメタ・`fieldSemanticsEqual` による temp append 互換が不変**（§4 の `forCapture` スコープにより、システム列 source は実体化メタに載らない）。異なるアプリの `$id` 同名 temp append テストを追加し、B69 前後で挙動が変わらないこと。
- 既存 `inferSelectColumnMeta`（CTE 列メタ）・MIN/MAX 型付き比較・B59 ORDER BY alias 等の非回帰。
- engine 本体は WHERE/実行意味論を変えない（capture は結果への付随情報のみ）。

### 7.3 公開面

- 全 npm test green・snapshot 不変・`npm run build` 全面・engine guard 群（bundle/declaration/docs-examples/pack）green。
- `runQuery` の型 export が primitive のみ（内部型 re-export 0）を declaration-smoke で固定。

## 8. 実装方針（R2 後の Step 目安）

WIP ブランチ `feat/b69-query-column-metadata` を起点に:

1. `ExecuteOptions.captureColumnMeta` ＋伝搬 ＋ `getSelectColumnMeta` ＋ `forCapture` 導入（§3.1/§4 の source スコープ化）。
2. 公開マッピング `toPublicColumn`（§3.4 の sortKind フォールバック）＋ `QueryColumn` 型。
3. §3.1–3.3 の意味論を engine 実値で確定し `columnMeta.test.ts` 4 件を green 化（テスト4 は定義済みフィールドへ修正）。
4. drift guard 同期（§6）＋ docs（`ksql_engine_library.md`）。
5. 全 gate → 次 minor で release（版数はリリース時確定・v3.22 と先出ししない）。

## 9. codex レビュー依頼観点

1. §4 の source スコープ化（`forCapture` 限定）で `fieldSemanticsEqual`／temp append 互換の回帰が本当に塞げているか。`materializedMetaFromFieldInfo` が既に付ける物理フィールド source は既存挙動として問題ないか（capture でない実体化でも物理フィールド source は既に載っている点の確認）。
2. §3.1 の無条件フェッチ（capture 時）が JOIN/複数物理ソース/LAPP 解決で正しく全出力列を解決するか。集計のみ SELECT の 1 メタ GET が許容範囲か。
3. §3.2 の `sortKind = meta.sortKind ?? compareMode` フォールバックで、既存の全メタ生成関数（synthetic/system/unknown/unsupported/aggregate/arith/case merge）を漏れなくカバーできるか。`compareMode: "unsupported"` → undefined の妥当性。
4. §2 の公開型が内部型を漏らさないこと（`fieldType`/`sourceApp` の値が engine 内部 enum でなく plain string/number であること）と declaration-smoke の期待。
5. `COUNT`/`SUM` 等・`DATE_FORMAT`・`$id` の実メタ値（R2 の受入表に固定するための実値）。
6. B66 の「engine 本体無改変（packaging のみ）」からの逸脱＝execute.ts 改変の妥当性と、フル gate で担保すべき非回帰の抜け。

## 10. R2 暫定（Claude 自己検証・実エンジンプローブ）

codex 503 障害のため Claude が実コード＋WIP ブランチの実エンジンプローブで R1 を検証した（codex 復帰後にクロスレビュー）。**プローブ手法**＝WIP ブランチ `feat/b69-query-column-metadata` で `runQuery` をモック client 実行し公開列を出力。draft のままでは全列 bare だったため、真因（下記 P1-1）を一時パッチして revert し、実メタ値を採取。

### 10.1 真のブロッカー（P1-1・HANDOFF が見落とし）

**`execute()`（[execute.ts:723](../../src/execute.ts)）が結果をスプレッドコピー（`{ ...attachSearchAbortWarning(result, collector), metrics }`）して別オブジェクトを返すため、`executeSelect` が `materializedMetaBySelectResult`（元 `result` キー）に付けた列メタが、`runQuery` の `getSelectColumnMeta(返却オブジェクト)` から参照できず全列 bare になる。** capture 配線（`captureColumnMeta` パラメータ・`inferSelectColumnMeta`・メタ解決）自体は正しく、これだけが原因。

- **解**: `execute()` が返す最終オブジェクトへ列メタの WeakMap 関連付けを引き継ぐ（返却直前に `result.type==="SELECT"` の captured meta を最終オブジェクトへ再セット）。実測でこの 4 行パッチにより test1〜3 が正しい値を返した（下表）。
- HANDOFF §3 の仮説（①ゲート ②DATE_FORMAT sortKind ③COUNT メタ形）は**いずれも実挙動では非問題**で、全て P1-1 が原因の見かけだった。

### 10.2 R1 の是正（過剰設計 2 点）

- **§3.1（capture 時の無条件フェッチ）は不要**。既存 `selectNeedsSourceColumnMeta` は FIELD/WILDCARD/CASE_COL/MIN/MAX/MODE 列で true になり、単純フィールド参照列を漏れなく捕捉する。式のみの SELECT（`UPPER(x)` 等）は `sourceApp` を持たない設計なので physicalInfos 不要。よってゲート迂回は追加しない（R1 §3.1 を撤回）。
- **§3.2 のフォールバックは DATE_FORMAT には不要**。`DATE_FORMAT` はトップレベル `sortKind: "string"` を持つメタ（`fieldType: KSQL_STRING`）へ解決される（実測）。R1 が「undefined」と観測したのは P1-1 でメタ全欠落だったため。**`sortKind = meta.sortKind ?? compareMode` フォールバックは `unknownStringColumnMeta`（トップレベル sortKind 無し）等のエッジ列向けの防御に格下げ（P2）**。tested cases では不要。
- **§3.3（COUNT/SUM の値）は draft のままで正しい**。engine 改変不要。テスト期待値（`KSQL_NUMBER`/`number`）は実値と一致。

### 10.3 実メタ値（受入確定・実エンジンプローブ）

| 列（例） | fieldType | sortKind | sourceApp |
|---|---|---|---|
| `$id` | `__ID__` | `number` | あり（capture 経路） |
| DROP_DOWN フィールド | `DROP_DOWN` | `string` | あり |
| NUMBER フィールド | `NUMBER` | `number` | あり |
| `COUNT(*)` | `KSQL_NUMBER` | `number` | なし |
| `SUM(x)` / `AVG(x)` | `KSQL_NUMBER` | `number` | なし |
| `DATE_FORMAT(...)` | `KSQL_STRING` | `string` | なし |
| `LENGTH(x)` / `ROUND(x)` | `KSQL_NUMBER` | `number` | なし |

`columnMeta.test.ts` の期待値（test1〜3）はこの実値と一致するため、**P1-1 修正だけで test1〜3 は green**。test4 は未定義フィールド `顧客名` を SELECT した設計ミス（`validateSelectFieldCodes` が正しく拒否）＝定義済みフィールドへ修正。

### 10.4 §4 source スコープ化（P1-2・維持）

- 裏取り＝`materializedMetaFromFieldInfo`（[execute.ts](../../src/execute.ts)）は**物理フィールドに既に `semantics.source` を付与**（appId 指定時 `withFieldSemanticSource`）。よって B69 の新規 source は**システム列 `$id`/`_pid` 等のみ**が差分。`fieldSemanticsEqual`（[fieldSemantics.ts:75](../../src/core/fieldSemantics.ts)）は `source.appId`/`source.fieldCode` を同定に含む。
- draft は `inferSelectColumnMeta` 内で**無条件に** `systemColumnMetaWithSource` を用いるため、CTE/一時テーブル実体化メタにもシステム列 source が載り、**異なるアプリ由来 `$id` を同名 temp へ append する互換判定が回帰し得る**。
- **解（維持）**: システム列 source の付与を**ライブラリ capture 経路に限定**する（`inferSelectColumnMeta` に capture 識別フラグを渡し、`captureColumnMeta` 由来の top-level 呼び出しのときだけ `systemColumnMetaWithSource`、実体化は従来の `systemColumnMeta`）。`runQuery` は read-only 単文のみで temp append を発行しないため、capture 経路への source 付与は安全。
- **要追加テスト**: 異なるアプリの `$id` を同名一時テーブルへ append する回帰テスト（B69 前後で挙動不変）。full npm test で既存回帰の有無も確認する。

### 10.5 実装 To-Do（R2 確定分・codex クロスレビュー後に着手）

1. **P1-1**: `execute()` の返却オブジェクトへ列メタ WeakMap を引き継ぐ（唯一のブロッカー）。
2. **P1-2**: システム列 source を capture 経路限定（§10.4）＋ cross-app `$id` temp append 回帰テスト。
3. **P2**: `sortKind` の `compareMode` フォールバック（unknown 列の防御）。
4. `columnMeta.test.ts` test4 を定義済みフィールドへ修正・test1〜3 の期待値は実値どおり維持。
5. §6 の公開面 drift guard 同期（declaration-smoke/bundle-guard/docs-examples）＋ `ksql_engine_library.md` 追記。
6. 全 gate（全 npm test・snapshot・build・engine guard 群）→ 次 minor で release（版数はリリース時確定）。

### 10.6 codex クロスレビュー観点（復帰後）

- P1-1 の execute() 引き継ぎ実装の妥当性（batch/UNION/その他コピー経路の網羅）。
- §10.4 の source スコープ化で temp append 回帰が完全に塞げるか・cross-app `$id` の既存挙動確認。
- §10.3 の実メタ値が JOIN/LAPP/WILDCARD/PARENT_WILDCARD/CASE 列でも整合するか（本プローブは単一物理 APP のみ）。

## 11. codex クロスレビュー反映（R2 確定）

codex 復帰後にクロスレビューを実施し、Claude が全指摘を実コードで裏取りした。§10 の判定（10.1 blocker・10.2 R1 是正・10.3 実メタ値）は codex も CORRECT で確認。加えて **§10 が見落とした P1 を4件**検出（すべて裏取り済み）。以下を R2 の確定事項とする（§3.1/§3.4/§4/§5/§6 の該当箇所を上書き）。

### 11.1 P1 — source 付与は「専用フラグ」で行う（capture フラグ流用は不十分）

**裏取り**: 内部実体化も `captureColumnMeta=true` を渡す（`executeQueryWithCte(..., captureColumnMeta=false)` 定義だが、**DML source materialization が `executeQueryWithCte(projection, ..., true)` を渡す**＝[execute.ts:6516](../../src/execute.ts)。CTE body も伝搬）。よって §4/§10.4 の「`captureColumnMeta` フラグを共用して source をスコープ化」では**内部実体化にも system 列 source が載り回帰を塞げない**。

**確定解**: メタ「計算/格納」の `captureColumnMeta` とは**別の目的フラグ `includePublicSystemSource`**（既定 false）を `inferSelectColumnMeta` に導入し、**ライブラリ top-level（`runQuery` 由来の `execute()` 呼び出し）だけ true**にする。system 列 source（`systemColumnMetaWithSource`）はこのフラグ true のときだけ付与し、内部実体化（CTE/DML source）は従来の source なし `systemColumnMeta` を維持する。

### 11.2 P1 — `sourceApp` が CASE/MIN/MAX/MODE・算術等の式列へ漏れる

**裏取り**: `caseResultColumnMeta` の `FIELD`/`FIELD_REF` 分岐は `resolveField(field)`（物理フィールドは既に `semantics.source` 付き）をそのまま返す（[execute.ts:3311-3326](../../src/execute.ts)）。`mergeExpressionColumnMeta` は単一分岐/同一 source で source を保持。`inferAggregateArgMeta` 経由の MIN/MAX/MODE も引数フィールド meta を継承。よって `SELECT MIN(会社名)` / `SELECT CASE WHEN … THEN 会社名 END` が `sourceApp` を持ち、§2 の「式・集計列は undefined」契約に反する（`publicTypes.ts` の QueryColumn 契約）。§10 のプローブは COUNT/SUM（synthetic・source なし）しか見ておらず見落とした。

**確定解**: **公開 `sourceApp` は「直接の単純フィールド参照列」（＋ system 列）に限定**する。CASE/MIN/MAX/MODE/算術/スカラーサブクエリ等、式・集計でラップされた列は下地メタが field source を持っていても `sourceApp` を**出さない**。実装は「直接フィールド参照列である」ことを識別して source を出す（例: 出力列の AST 種別が FIELD/system のときのみ／または式・集計経路で source を除去）。受入に `SELECT MIN(会社名)`・`CASE … 会社名` → `sourceApp` undefined を追加。

### 11.3 P1 — CTE/temp の provenance 契約＝**opaque（オーナー決定 2026-07-25）**

**裏取り**: 物理フィールド source は CTE 実体化メタにも格納され（[execute.ts:3835 付近](../../src/execute.ts)）、最終 CTE フィールド解決はそれをそのまま返す。よって CTE 経由でも `sourceApp` が出得るが、§2 は「CTE/一時テーブル由来は undefined」。単一 CTE inline（最適化）では物理 SELECT 化されるため、**inline/materialize で `sourceApp` の有無が変わる最適化依存**が生じる。

**確定解（オーナー決定＝opaque）**: **CTE/temp/派生を跨いだ列は `sourceApp` を出さない（opaque）**。決定性優先で最適化依存を避けるため、**`WITH`/CTE/一時テーブルを含む文では、たとえ単一 CTE inline されても直接フィールド参照列に `sourceApp` を付けない**（inline/materialize で挙動不変）。§2 の文言もこの契約へ改訂する（「CTE/temp/派生を跨いだ列の sourceApp は undefined」）。`sourceApp` が出るのは **CTE を含まない単一物理アプリ文の直接フィールド参照列（＋ system 列）** のみ。受入に「CTE 経由の直参照列 → sourceApp undefined（inline/materialize とも）」を追加。

### 11.4 P1 — UNION の文言を実装へ合わせる

**裏取り**: `mergeUnionColumnMeta`（[execute.ts:3516-3527](../../src/execute.ts)）は不一致時に全フィールドを undefined にしない。**同型で source 違い→型を保持し source を除去／型非互換・片側のみ→`KSQL_UNKNOWN`**。§5/§7 の「不一致は公開フィールド undefined」は誤り。§5/§7 を実挙動へ改訂（UNION 列の fieldType は一致時のみ確定、非互換は `KSQL_UNKNOWN`、source は左右一致時のみ）。

### 11.5 P2 — unknown 列のフォールバックの契約

`unknownStringColumnMeta` は `fieldType: KSQL_UNKNOWN` を semantics 経由で持つ（top-level sortKind なし）。§3.2/§3.4 の `sortKind = meta.sortKind ?? compareMode` フォールバックを入れると unknown 列で `sortKind: "string"` も出る。§2 の「解決不能は undefined」と齟齬。**確定**: unknown 列は `fieldType: "KSQL_UNKNOWN" / sortKind: "string"` を**意図的な degraded 値**として公開する（consumer は既定文字列扱いで無害）。`unsupported` は `sortKind: undefined` を維持。§2 の「undefined」を「解決不能でも KSQL_UNKNOWN/string に degrade」へ明確化。

### 11.6 §6 の是正（guard script 名・変更ファイル）

- npm script 名は **`engine:docs-smoke`**（§6 の `engine:docs-examples-smoke` は**スクリプトファイル名**であって npm script 名ではない）。実行 script は `engine:bundle-guard` / `engine:declaration-smoke` / `engine:pack-smoke` / `engine:docs-smoke`（[package.json:39-42](../../package.json)）。
- 変更が要るファイル: **`scripts/fixtures/engine-consumer-types/index.ts`**（`QueryColumn` の 3 optional primitive を import・コンパイル検査）。docs 例に列メタを足すなら `scripts/engine-docs-examples-smoke.mjs` / `scripts/engine-pack-smoke.mjs` に runtime assert。`scripts/engine-public-exports.snapshot.json` は **export 名/数が変わらないため変更不要**。`engine-bundle-guard.mjs` は forbidden 入力/文字列検査で**期待変更不要**（rebuild で baseline サイズは自然変化）。`docs/ksql_engine_library.md:98-105` の公開列形を更新。

### 11.7 P1-1 の完全性（execute() 引き継ぎ）

§10.1 の fix は `execute()` の最終返却＋`attachSearchAbortWarning` を跨ぐ形にする（`runQuery` は単文のみで `executeBatch` に到達しないが、実装は batch を回帰させない位置に置く）。UNION/WITH/no-FROM も `executeSelect`/`executeQueryWithCte`/`executeUnion` が結果へメタを set した後、`execute()` の 1 箇所でコピー先へ引き継げば足りる（全コピー経路の合流点が `execute()` の return）。

### 11.8 R2 確定・実装 To-Do（codex クロスレビュー後）

1. **P1-1**: `execute()` 返却オブジェクトへ列メタ WeakMap を引き継ぐ（§11.7）。
2. **P1（§11.1）**: `includePublicSystemSource` 専用フラグを導入し、system 列 source をライブラリ top-level のみに付与。cross-app `$id` の実体化 source-free 回帰テスト（**`INSERT INTO #t` は runQuery 非対応のため、内部 materialization を叩く supported 経路でテスト**）。
3. **P1（§11.2）**: `sourceApp` を直接フィールド参照列＋system 列に限定（式・集計は undefined）。受入 `MIN(会社名)`/`CASE…会社名`。
4. **P1（§11.3）**: CTE/temp provenance＝**opaque 確定（オーナー決定）**。CTE を含む文は inline/materialize とも `sourceApp` を出さない→ §2 改訂＋inline/materialize 両方の受入テスト。
5. **P1（§11.4）**: UNION の §5/§7 文言を `mergeUnionColumnMeta` 実挙動へ改訂。
6. **P2（§11.5）**: unknown 列 degrade（KSQL_UNKNOWN/string）を契約化・`unsupported` は undefined。
7. `columnMeta.test.ts` test4 を定義済みフィールドへ・test1〜3 は実値どおり。JOIN 修飾/曖昧・WILDCARD/`_p.*`・CASE/MIN/MAX の受入追加。
8. §11.6 の guard 同期（`fixtures/engine-consumer-types` 等）＋ `ksql_engine_library.md`。
9. 全 gate → 次 minor で release。

**判定**: §10＋§11 で仕様は実装着手可能水準。ただし **§11.3（CTE provenance 契約）はオーナー判断が1点残**る。他は確定。
