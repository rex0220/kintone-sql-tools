# 課題: kintone 検索打ち切り（10 万件）警告 `X-Cybozu-Warning` の検出（P0）

- 作成日: 2026-07-15
- ステータス: **仕様案 R2（実装着手可）。FROM なし実体化バグ（[ksql_fromless_select_materialize_bug.md](ksql_fromless_select_materialize_bug.md)）と同一 minor バージョンで対応（ユーザー指示）**
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

## 1. スコープ

1. **`KintoneGetResponse` に警告情報を追加**（例: `warnings?: string[]` または `searchAborted?: boolean`）。既存呼び出しは後方互換（省略時 = 警告なし）。
2. **Node**: `requestJson` / `getRecords` で `response.headers.get("X-Cybozu-Warning")` を読み、打ち切り警告を検出して `KintoneGetResponse` に載せる。
3. **プラグイン検出可否（要判断）**: `kintone.api()` はヘッダー非露出。検出するには **`kintone.api.url()` + raw `fetch`（`X-Requested-With` / セッション認証）** へ切り替える必要がある。選択肢:
   - (a) plugin も raw fetch 化してヘッダー検出（実装量中・全 GET 経路に波及）。
   - (b) plugin は当面**未検出**とし、ドキュメントで「プラグインでは検索打ち切りを検出できない」と明記（Node/CLI/MCP のみ検出）。
   - 推奨: まず (b) で Node/CLI/MCP を先行、(a) は必要に応じ後続。
4. **`fetchAll` → SELECT への伝播**: ページングを束ねる `fetchAll` で警告を集約し、SELECT 結果の `warnings` に「検索が 10 万件で打ち切られ、結果が欠落した可能性があります」を追加。EXPLAIN でも注記可。
5. **DML 連携**: 親レコード DML の対象解決 `resolveDmlTargetIds` が打ち切り警告を受けたら**エラー化**（サイレントな一部更新/削除を防ぐ）。→ これが KLIKE 親 DML 解禁の前提。

## 2. 受入
- Node/CLI/MCP: `like` 等で 10 万件打ち切りが起きたとき、SELECT が**警告付き**で返る（結果非保証を明示）。打ち切りなしでは警告なし（既存不変）。
- `resolveDmlTargetIds` が打ち切り警告時に**エラー**（対象確定不能）。
- プラグイン: (b) 採用時はドキュメントで非検出を明記／(a) 採用時は Node と同等。
- 既存の SELECT/DML/バッチ・テストが後方互換（`KintoneGetResponse` 拡張はオプショナル）。
- 10 万件の実測が困難なら、ヘッダー注入のモック/スタブで検出経路を検証（実データ再現は未検証と明記）。

## 3. 位置づけ（KLIKE との関係）
- **KLIKE v1**: SIMPLE SELECT 限定・全 DML 拒否・「完全結果非保証」を文書化 → 本課題**未完成でも安全にリリース可**。
- **本課題完成後**: SELECT 警告を強化 → その後 **KLIKE 親レコード DML 解禁を別仕様で再レビュー**（サブテーブル DML は JS 評価のため恒久非対応）。

## 4. 進め方
1. 本課題を記録（済）。KLIKE v1 実装・リリースはブロックしない。
2. 検出基盤実装（Node/CLI/MCP 先行・plugin は (b) or (a) を判断）→ `fetchAll`/SELECT 警告伝播 → `resolveDmlTargetIds` エラー化。
3. 完成後、KLIKE 親 DML 解禁を別仕様で検討。
