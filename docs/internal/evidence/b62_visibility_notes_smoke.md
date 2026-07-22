# B62 AI 可視性の注記強化 — 効果実証（摩擦シナリオ before/after）

- 実施日: 2026-07-22
- 方法: B61 の摩擦シナリオ 4 件を**修正前と同一プロンプト**で再実行（headless `claude -p`＋B62 実装後の新ビルド `dist-mcp/ksql-mcp.js` 明示指定・read-only ツールのみ）
- 比較対象: [B61 証跡](b61_scenario_smoke_claude_code.md) の R3-3／Q6／V2／V3

## 結果: 意味論 FAIL 1→0・自己修正 計 5→1

| シナリオ | Before（B61） | After（B62 実装後） | 判定 |
|---|---|---|---|
| **R3-3** UPDATE＋CHECK（引き上げ後 10 万超を隔離） | **意味論 FAIL**＝`CHECK WHEN 金額 > 100000`（更新前値で別判定）＋「post-image 評価」と逆の説明 | **意味論 PASS**＝`CHECK WHEN 金額 * 1.1 > 100000`（SET 式の再掲）＋「CHECK は更新前値。`金額 > 100000` と書くと業務ルールと一致しない」と**前回の FAIL パターンを反例として説明**・空セル 0×1.1 ガード（`WHERE 金額 IS NOT NULL`）まで自発追加 | **FAIL→PASS** |
| **Q6** 変数＋CASE ランク付け | 自己修正 2 回（`@avg / 2` 算術・SET 右辺の変数参照） | **自己修正 0 回**＝最初から `SET @half = (SELECT AVG(金額)/2 …)` の正解形・「比較右辺での変数算術は制約がある」と制約を引用 | 2→0 |
| **V2** 変数×UPDATE（空を最大値で埋める） | 自己修正 1 回（`@max金額` ParseError） | **自己修正 0 回**＝最初から ASCII 名 `@max_amount`・MAX 側の `IS NOT NULL` 空セルガードも追加 | 1→0 |
| **V3** 時刻変数×UPSERT | 自己修正 2 回（VALUES @var → UPSERT SELECT UNION 直結） | **自己修正 1 回**＝`VALUES (@now)` を一度試して ParseError 後、即 temp＋`@now AS 日時` の正解形（UNION 直結の躓きは消滅・ParseError メッセージからの一発回復） | 2→1 |

## 所見

- 本丸の **#3（CHECK 参照値）は完全解消**。instructions の 16 語注記＋§16 相互参照が機能し、モデルは誤りパターンを反例として説明できるまでになった。
- 変数ファミリーは自己修正 5→1。残る 1 回（V3 の VALUES 試行）は「試す→ParseError→表の回避レシピどおり回復」という fail-closed 設計の想定内挙動（VALUES 制約は R01 として docs に記載済み・instructions は誘導のみの設計判断どおり）。
- 判定は各 1 回・単一クライアント/モデル（B61 と同条件）。

## 自動ゲート（同日）

- `npm test`: 116 suites / 2,833 ＋ subprocess 2 / 25 ＝ **2,858 green**（Claude 独立実行・codex 報告と一致）
- 変数配置の特性化テスト（受理 A01-A13／拒否 R01-R05）全 green・**R2 境界との食い違いなし**＝言語リファレンスの配置詳細表とテスト ID が一対一対応
- instructions 実測 **529 語**（5 段落維持・上限 550 内）・`build:mcp`→`mcp:smoke`/`pack-smoke`・`build:mcpb`→`mcpb-verify` すべて ok

## 残

- リリース（次版候補・MCP instructions 変更を含むため Desktop 反映には版数更新が必要）。Desktop 面での再確認はリリース時。
