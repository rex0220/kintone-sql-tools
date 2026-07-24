# B33 実機 smoke 記録: プラグイン（Chromium / Firefox）

- 実施日時: 2026-07-18
- 実施者: ユーザー（実機操作）＋Claude（記録・コード切り分け）
- 対象: [B33 実装計画](../ksql_korder_cursor_implementation_plan.md) Phase 4 Step 4-4 のプラグイン分（最後の release blocker）
- 環境: dev ドメイン・APP730（618,525 件）・`release/ksql-plugin-v3.1.0.zip`（署名 zip・内側 manifest 3.1.0）
- ブラウザ: Chromium 系で全項目実施、Firefox で再実施し**全項目同結果**（ユーザー報告）。⑤ の実測ログは Firefox（console の `debugger eval code` 表記）

## 結果

| # | 項目 | 結果 |
|---|---|---|
| ① | 通常完了（`KORDER BY 都道府県K ASC, $id ASC LIMIT 501`） | ✅ 501 件・warning なし・Network で `POST → GET×2 → DELETE(200)`＝必要窓到達の早期削除 |
| ② | 実行中キャンセル | **対象外**。プラグインに実行中キャンセル UI が存在しない（desktop.ts にあるのは DML 実行前確認のキャンセルのみ・AbortController 未使用）。中断手段はページ離脱＝③ |
| ③-a | レコード詳細への遷移（SPA 的） | ✅ **実行が継続し通常経路の DELETE まで完走**（カーソルは孤児化しない。離脱 cleanup に頼らず主保証の finally が効く） |
| ③-b | 真の unload（F5 リロード・Preserve log で観測） | ✅ **破棄直前に DELETE の送信を確認**＝pagehide/beforeunload の best-effort cleanup が機能 |
| ④-a | GET のみ遮断（blocking pattern `cursor.json?id=`） | ✅ **blocked GET 直後に finally 経路の `DELETE`=200**（受入条件 8「Get 失敗でも必ず解放」の実機実証）。エラー表示は「⚠」のみ＝文言ゼロ → **B33 固有でない既存の表示品質問題として B35 起票**（cleanup 文言による主エラー上書きは無し） |
| ④-b | 全遮断（`*cursor.json*`・DELETE も失敗） | ✅ cleanup 不明 → **quarantine** → permit 2 個消費後の実行が **30 秒待機 → `CursorCapacityError`**（host・上限・待機時間を表示・カーソル ID 非露出）＝受入条件 9 の実機実証。復旧はリロード（lease はページ内メモリ）・サーバー側カーソルは TTL 10 分で自動解放 |
| ⑤ | 二重 DELETE の reject 実形状（console・Firefox） | ✅ `reject: {"code":"GAIA_CN01","id":"djvAbduBWZFpPnuzQu0D","message":"指定したカーソルは存在しないか、既に有効期限が切れています。"}`・**`has status prop: false`** — `kintone.api` は HTTP status を公開しない。**plugin 専用判定 `isPluginAlreadyReleasedCursorError`（`code==="GAIA_CN01" && status===undefined 許可）が必須だったことの決定的裏付け**（共有側の厳格判定 404+code では plugin で永遠に不成立だった） |
| ⑥ | 設定 UI（Cursor 上限） | 部分実施: ④-b の `CursorCapacityError` に既定上限 2 が反映されることを間接確認。上限変更 → サマリ/EXPLAIN 追従の操作確認は未実施（低リスク: 同配線を CLI `--cursor-max-active` / MCP `cursorMaxActive` で実測済み・[b33_cli_mcp_smoke.md](b33_cli_mcp_smoke.md)） |
| ⑦ | EXPLAIN のプラグイン表示 | 未実施（低リスク: EXPLAIN はエンジン共有で CLI/MCP の実測済み・desktop.js への `KORDER_CURSOR` 収録はビルド検証で確認済み） |
| ⑧ | 負例（planning error） | ✅ `LIMIT 501`×`maxRecords=500` で `KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS(scanRows=501, maxRecords=500)` が UI に理由コード・対処案付きで表示（パネル保存値 500 の環境で自然発生・実効 maxRecords の自己申告により設定起因と即断可能）。通信ゼロの Network 明示確認は未実施（planning error は設計上 API 前・CLI で実測済み） |

## 副次的な発見

1. **kintone の一覧→レコード詳細遷移はページを破棄しない**（③-a）— 実行中のクエリは中断されず完走する。離脱 cleanup が必要になるのは F5・タブ閉じ・別サイト遷移のみ
2. **B35 起票**: message を持たないネットワーク層の reject が「⚠」のみ表示になる（既存挙動・[issue](../ksql_plugin_messageless_error_display_issue.md)）
3. DevTools の request blocking は URL パターンのみのため、GET だけを遮断するには `cursor.json?id=`（GET のみクエリ付き URL）を使う

## 判定

**B33 の release blocker はすべて解消。** 未実施 3 点（⑥の操作確認・⑦・⑧の通信ゼロ明示）は、エンジン共有＋CLI/MCP 実測＋ビルド検証で本質をカバー済みの低リスク項目として記録する。

## B67 相対日付の追加 browser harness

B67 Phase1 はB33の完了判定と混ぜず、同一buildのFirefox / Chromeで別途実施する。
SQL fixture、query byte、`evalWhere` 0回のconditional-breakpoint計測、API 0、
server結果の貼付欄は
[b67_relative_date_browser_smoke.md](b67_relative_date_browser_smoke.md) を使用する。
現状は **ユーザー実施待ち**であり、Node testやplugin build成功では代替しない。
