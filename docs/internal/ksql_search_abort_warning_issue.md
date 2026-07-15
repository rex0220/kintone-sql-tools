# 課題: kintone 検索打ち切り（10 万件）警告 `X-Cybozu-Warning` の検出（P0）

- 作成日: 2026-07-15
- ステータス: **仕様 R3・実装済み（Codex モック/回帰テスト済み、実機レビュー待ち）。FROM なし実体化バグ（[ksql_fromless_select_materialize_bug.md](ksql_fromless_select_materialize_bug.md)）と同一 minor バージョンで対応（ユーザー指示）**
- 更新履歴: R2=独立起票・plugin (b) 方針。R3=codex レビュー反映（[P0-1] 単発 GET・合成境界の取りこぼし→実行単位コレクター／[P0-2] 算術 UPDATE 経路も fail-closed／[P1] 契約を `searchAborted?:boolean`＋`onSearchAborted` に確定・一時テーブル実体化はエラー・INSERT/UPSERT SELECT の扱い明記／[P2] plugin (b) を全文統一／受入テスト拡充）。実装=Node ヘッダー検出・実行文単位コレクター・読取後書込の fail-closed・plugin 非検出ドキュメントを反映。
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 位置づけ: **KLIKE（v2.8/v2.9 リリース済）の親 DML 解禁の必須ゲート**、かつ **SELECT の安全性強化**（現状 KLIKE は大規模アプリで 10 万件超の一致がサイレントに欠落する）。KLIKE v1/v2 はこの検出なしでもリリース済（SELECT は完全結果非保証を文書化・DML は全拒否で安全）。
- **plugin 方針（確定）**: `kintone.api()` はヘッダー非露出のため、**まず Node/CLI/MCP で検出**（`X-Cybozu-Warning`）、**plugin は当面「検索打ち切りを検出しない」と明記**（案b）。plugin の raw fetch 化（案a）は後続の別作業。
- 関連コード: `src/api/fetchAll.ts`（`KintoneGetResponse` / `fetchAll`）、`src/cli/nodeKintoneClient.ts`（`requestJson`・`getRecords`）、`src/ui/kintoneClient.ts`（`api()` / `getRecords`）、SELECT の警告伝播（`executeFullScanSelect` / SIMPLE 取得経路の `warnings`）

## 0. 課題

kintone REST の `like` / `not like` は、キーワード一致が **10 万件に達すると検索を打ち切り**、レスポンスヘッダー `X-Cybozu-Warning: Filter aborted because of too many search results` を返す（[公式](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/)）。しかし現状クライアントは**ヘッダーを読まず本文のみ**を扱うため、**結果がサイレントに欠落**する:

- `KintoneGetResponse`（[fetchAll.ts:27](../../src/api/fetchAll.ts#L27)）は `{ records }` のみ。
- Node の `requestJson`（[nodeKintoneClient.ts:36](../../src/cli/nodeKintoneClient.ts#L36)）は JSON 本文のみ返す（`fetch` の `response.headers` を捨てている）。
- プラグインの `api()`（[kintoneClient.ts:58](../../src/ui/kintoneClient.ts#L58)）は `kintone.api()` の**本文のみ**。`kintone.api()` は**レスポンスヘッダーを露出しない**。

> 本警告は KLIKE 専用ではなく、**kintone が検索を打ち切る任意のクエリ**（`like` 等）に共通。汎用の安全性改善。

## 1. スコープ（R3・全レコード取得経路を漏れなく）

### 1.1 内部契約（確定・[P1]）
- **`KintoneGetResponse` に `searchAborted?: boolean` を追加**（`warnings?: string[]` 案は不採用）。省略時=打ち切りなし（後方互換）。
  ```ts
  interface KintoneGetResponse { records: KintoneRecord[]; searchAborted?: boolean; }
  ```
- **`fetchAll` に `onSearchAborted?: () => void` コールバックを追加**（後方互換）。ページング内で打ち切りを検出したら 1 回以上呼ぶ。
- **責務分離**: Node クライアント側で `X-Cybozu-Warning: Filter aborted…` の既知メッセージを判定し、実行エンジンには**型付き boolean（`searchAborted`）だけ**を渡す（実行側は文字列を解釈しない）。
- **検出タイミング（重要）**: **先頭ページ・短い最終ページ・並列取得の全レスポンス**について、早期 return より**先に**検出する（1 レスポンスでも打ち切りなら aborted）。

### 1.2 検出（Node/CLI/MCP・plugin 非検出）
- **Node**: `requestJson`/`getRecords`（[nodeKintoneClient.ts:36](../../src/cli/nodeKintoneClient.ts#L36)）で `res.headers.get("X-Cybozu-Warning")` を読み、既知メッセージなら `KintoneGetResponse.searchAborted=true`。`fetch` の `Response` からヘッダー取得可能（確認済み）。`CB_IL02` リトライ後の最終レスポンスでも判定する。
- **plugin（[P2]・確定 (b)）**: `kintone.api()` はヘッダー非露出のため、**plugin は当面「検索打ち切りを検出しない」**（`searchAborted` を付けない）。ドキュメントに明記。raw fetch 化（`kintone.api.url()`）は**別課題**（後続）。→ §1 全体・本文とも (b) に統一。

### 1.3 伝播＝実行単位の集約コレクター（[P0-1]・**fetchAll だけでは不足**）
警告は「`fetchAll` → SELECT」だけでなく、**単発 GET を含む全レコード取得**で発生し得る。取りこぼす経路:
- **SIMPLE 単発 GET**: `useSingleGet`（[execute.ts:1055](../../src/execute.ts#L1055)・`LIMIT<=500` 等）は `client.getRecords()` を直接呼び `fetchAll` を通らない（例: `SELECT … KLIKE … LIMIT 100`）。
- **合成境界で子の警告が捨てられる**: UNION（[execute.ts:1542](../../src/execute.ts#L1542)）・CTE 実体化（[1580](../../src/execute.ts#L1580)）・CTE 文脈 UNION（[1620](../../src/execute.ts#L1620)）・WHERE/CASE/EXISTS 等のサブクエリ（[3248](../../src/execute.ts#L3248)）。

→ **設計（推奨・漏れに強い）**: **実行単位（execute/runSelectLike 呼び出し）に「打ち切りコレクター」を 1 つ持ち、単発 GET・fetchAll・サブクエリ・合成の全レコード取得がそこへ集約**する。SELECT 結果の `warnings` に「検索が 10 万件で打ち切られ、結果が欠落した可能性があります」を 1 回付す。EXPLAIN でも注記可。（代替: 各合成境界で子の warnings を確実にマージ。ただしコレクター方式の方が新経路追加に強い。）

### 1.4 DML は全「読取後書込」経路を fail-closed（[P0-2]・**resolveDmlTargetIds だけでは不足**）
打ち切りを検出したら、**確認コールバック・PUT/DELETE より前に fail-closed で停止**（サイレントな一部更新/削除を防ぐ）。対象経路:
- 親 `UPDATE` の**通常経路**（`resolveDmlTargetIds`）
- 親 `UPDATE` の**算術式経路**（`fetchRecordsForSharedPlan` 直接呼び・[execute.ts:2384](../../src/execute.ts#L2384)）
- 親 `DELETE`
- 将来解禁するその他の読取後書込経路（KLIKE 親 DML 等）

### 1.5 一時テーブル実体化はエラー（[P1]）
`CREATE TEMP TABLE AS SELECT` は SELECT 結果の行だけ保存し `result.warnings` を捨てる（[execute.ts:618](../../src/execute.ts#L618)）。打ち切り済み一時テーブルを後続が**完全な集合として使う**ため通常 SELECT より危険。→ **実体化時は警告でなくエラー**（既存 `onLimitReached:"error"` と同じ思想）。
- **`INSERT … SELECT` / `UPSERT … SELECT`**（SELECT 結果を書込に使う経路）は、**本バージョンで同様にエラー化するか将来課題にするかを実装時に明記**（推奨=書込前提の経路は実体化と同様にエラー化）。

## 2. 受入（R3）
- **SIMPLE 単発 GET**（`LIMIT<=500`）で打ち切り → SELECT が警告付き。
- **`fetchAll` の先頭・後続・並列ページ**いずれの打ち切りも検出（早期 return より先）。
- **UNION・CTE・サブクエリ**を含む合成 SELECT でも子の打ち切りが最終 `warnings` に伝播。
- **`CREATE TEMP TABLE AS SELECT`** は打ち切りで**エラー**（実体化しない）。
- **通常 UPDATE・算術 UPDATE・DELETE** は打ち切りで**書込前に停止**（fail-closed）。
- **Node の `CB_IL02` リトライ後レスポンス**でも検出。
- **plugin は警告情報なし**（`searchAborted` 付かない）で後方互換。
- **打ち切りなし**は従来どおり（警告なし・既存 SELECT/DML/バッチ・テスト不変）。
- 10 万件の実測が困難なため、**ヘッダー注入のモック/スタブ**で検出・伝播・停止を検証（実データ再現は未検証と明記）。

## 3. 位置づけ（KLIKE との関係）
- **KLIKE v1**: SIMPLE SELECT 限定・全 DML 拒否・「完全結果非保証」を文書化 → 本課題**未完成でも安全にリリース可**。
- **本課題完成後**: SELECT 警告を強化 → その後 **KLIKE 親レコード DML 解禁を別仕様で再レビュー**（サブテーブル DML は JS 評価のため恒久非対応）。

## 4. 進め方
1. 実装: `KintoneGetResponse.searchAborted` ＋ `fetchAll.onSearchAborted` 追加 → Node クライアントでヘッダー判定（plugin/dryRun/noOp は付けない）→ **実行単位コレクター**で単発 GET・fetchAll・サブクエリ・合成の取得を集約 → SELECT `warnings` 伝播 → **一時テーブル実体化・全 DML 読取後書込経路を fail-closed** → plugin 非検出をドキュメント明記。
2. 実機/モック: ヘッダー注入スタブで §2 受入を検証。
3. **FROM なし実体化バグと同一 minor バージョンでリリース**。
4. 後続（別課題）: plugin の raw fetch 化（案a）／KLIKE 親レコード DML 解禁（本課題完成が前提・サブテーブル DML は恒久非対応）。
