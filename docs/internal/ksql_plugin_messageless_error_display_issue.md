# 課題: プラグインが message なしのネットワークエラーを「⚠」のみで表示する（B35）

- 作成日: 2026-07-18
- 位置づけ: B33 plugin smoke（DevTools request blocking で GET を遮断）中に発見。**B33 固有ではなく既存の表示品質問題**（`records.json` の遮断・オフライン・VPN 断でも同経路）。B33 の release blocker にはしない。
- ステータス: **実装済み・実機確認済み（2026-07-18・プラグイン実機で「⚠ネットワークエラー: kintone からの応答がありません（オフライン・通信遮断の可能性）」の表示をユーザー確認・v3.2.0 リリース待ち）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

## 現象（実機・2026-07-18・Chromium）

DevTools の Network request blocking で `cursor.json?id=`（GET のみ）を遮断して KORDER_CURSOR クエリを実行すると、プラグインの結果欄に **「⚠」だけが表示され、エラー文言が一切出ない**。利用者は何が起きたか（ネットワーク断・API 拒否・バグ）を判別できない。

なお同じ実行で cleanup は正しく動作した（blocked GET 直後に `DELETE cursor.json` = 200・受入条件 8 のとおり）。壊れているのは**表示だけ**である。

## 原因（コード確定）

ネットワーク層の失敗では `kintone.api()` の reject が kintone 正規エラー（`{code, id, message}`）ではなく **message を持たない値**になる。

1. `toDetailedApiError`（ui/kintoneClient.ts:44）は `typeof obj.message !== "string" || obj.message === ""` の場合に**素通しで元の値を返す**（詳細畳み込みの対象外）
2. `renderError`（ui/renderResult.ts:50）は Error でも kintone エラー形式でもない値を `String(err)` へ落とし、結果が空相当になって「⚠」のみが残る

## 対策案

- `toDetailedApiError` で message なしの reject を **fallback 文言付きの Error へ正規化**する（例: 「ネットワークエラー: kintone からの応答がありません（オフライン・通信遮断の可能性）」）。元の値は `cause` に保持する
- `renderError` 側にも最終防衛として「空文字列になった場合の汎用文言」を置く（二重防衛。どちらか一方でも表示は直る）
- CLI/MCP は nodeKintoneClient が fetch 例外を Error のまま伝えるため同現象は起きにくいが、受入時に横並びを確認する

## 受入条件（案）

- [ ] message なしオブジェクト・空文字列・undefined の reject で、プラグインに判別可能な文言が表示される
- [ ] kintone 正規エラー（code/message/errors あり）の表示は不変（非回帰）
- [ ] `String(err)` が `[object Object]` として露出しない
- [ ] SemVer=patch（表示のみの改善・意味論変更なし）
