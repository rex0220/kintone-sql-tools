# B60 Statement syntax catalog — 検証証跡（stdio 配線＋Claude Code AI 行動検証）

- 実施日: 2026-07-22
- 対象: 新ビルド `dist-mcp/ksql-mcp.js`（B60 実装後・`npm run build:mcp` 直後の成果物を明示指定＝stale server 回避）

## 1. 自動ゲート

- `npm test`: 115 suites / 2,815 ＋ subprocess 2 / 25 ＝ **2,840 green**（Claude 独立実行・codex 報告と一致）
- `build:mcp` → `mcp:smoke` / `mcp:pack-smoke`: ok（代表語 `Statement templates` / `ON ERROR SKIP INTO` 含む）
- `build:mcpb` → `mcpb-verify`: ok（**新設の launcher instructions 検証込み**＝MCPB 内 instructions の stale 検出が可能に）
- 契約テスト: family 全数（型レベル satisfies）・全 example パース受理＋expectedTypes・batch example は analyzeBatch・負例 5 種（単文 ON ERROR／単文 VALIDATE INTO×2／APPLY×CHECK／APPLY×ON ERROR）

## 2. stdio 配線検証

initialize 応答の instructions を直接取得: **502 語・5 段落**・`Statement templates:` 段落（CHECKS/CONTROL 共通記法→18 family 骨格→共通注記＋completeness 宣言）を確認。

## 3. Claude Code AI 行動検証（仕様 §6-8 の第 1 面・2 回実施）

方法: headless `claude -p` に新ビルド指定の `--mcp-config`（`--strict-mcp-config`）で「#source 一時テーブルから APP4221 へ、不正行を隔離して有効行だけ書き込む INSERT バッチを書き ksql_validate で検証」を依頼（mutate 禁止・`ksql_validate`/`ksql_docs`/`ksql_describe_app` のみ許可）。

**結果: PASS ×2**（B60 発端の「構文発明」は再現せず）:

- `ON ERROR SKIP INTO #err` を**一発で正しい位置**（ソース後・バッチ内）に配置し、`CREATE TEMP TABLE`＋後続 `SELECT * FROM #err` の**自己完結バッチ**として構成（INTO のバッチ専用制約どおり）
- `ksql_validate` ok:true（`isOnErrorSkip: true` を含む 3 文バッチ）
- `REJECT LIMIT n` の存在・`$err_message` 列・「実行時エラー（権限・競合）は fail-fast のまま」という正確な限界説明まで自発的に提示
- 許可待ち時点でも「`ksql_docs` で構文を確認してから書く」と宣言＝**行動規範（発明せず確認）が効いている**

### 3.1 検証で発見・修正した摩擦 1 件

1 回目にモデルが `CREATE TEMP TABLE ... AS ( ... )` と**括弧付き**で書いて ParseError→自己修正した。原因＝カタログ表記 `AS(SELECT...|WITH...)` のグルーピング括弧がリテラルに見える（WITH の括弧はリテラルなので非対称）。→ template を `AS SELECT...|AS WITH...` へ修正（502 語で exact 再固定）し、**2 回目は初回から括弧なしで正解**。

## 4. 残（リリース前・仕様 §6-8 の第 2 面）

- **Claude Desktop（ユーザー確認）**: 新ビルド `dist-mcpb/ksql-mcp.mcpb`（または `dist-mcp/ksql-mcp.js` 指定）で同じ依頼を実施し、`ON ERROR SKIP INTO #err` の一発組み立てを確認。**完了までリリース（版数確定・release アセット差し替え）はホールド**。
