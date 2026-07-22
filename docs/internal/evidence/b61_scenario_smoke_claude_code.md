# B61 AI 行動検証シナリオセット — 初回実施（Claude Code 面・5 シナリオ）

- 実施日: 2026-07-22
- 方法: B60 で確立した headless `claude -p`＋新ビルド（v3.14.0 `dist-mcp/ksql-mcp.js`）明示指定（`--mcp-config`/`--strict-mcp-config`）。シナリオごとに独立セッション・並列実行。許可ツール＝`ksql_validate`/`ksql_docs`/`ksql_describe_app` のみ（mutate なし・全 read-only）
- 判定: 期待構文要素の一発出現（発明・試行錯誤なし）＋`ksql_validate` ok

## 結果: 5/5 PASS

| # | シナリオ（依頼の趣旨） | 生成された核心構文 | 判定 |
|---|---|---|---|
| S1 | 重複キーは更新・新規は追加 | `UPSERT INTO APP4221 (…) VALUES … ON DUPLICATE (タイトル)`（**必須句を発明せず正配置**・重複キー複数一致はエラーという制約説明つき） | PASS |
| S2 | 一時テーブルの値で一括更新 | `UPDATE APP4221 SET 金額 = s.金額 FROM #src AS s WHERE APP4221.タイトル = s.タイトル`（**ソース別名・対象修飾の単一等値**・複数一致=全行更新/ソース重複=エラーの業務キー意味論も正確） | PASS |
| S3 | 本体＋サブテーブルを 1 文で更新（検証のみ） | `UPDATE … WHERE $id = 5 APPLY テーブル (PATCH SET 数値T1 = 0 ALL ROWS) VALIDATE ONLY`（**MCP は APPLY mutation fail-closed** の理解・`EXPECT ROWS`/revision ガード/post-image 修復まで言及） | PASS |
| S4 | CSV 取込（検証のみ） | `IMPORT INTO APP4221 (タイトル, 金額) FROM CSV customers BY NAME VALIDATE ONLY`（**`importSources` inline 供給・off-by-default**・`ksql_query`/`ksql_mutate` の使い分け・`ON ERROR SKIP` との排他まで正確） | PASS |
| S5 | 既存レコード監査→違反行を残す | `VALIDATE APP4221 INTO #err;` ＋ `$err_message` 集計＋詳細 SELECT の 3 文バッチ（**INTO はバッチ専用**の理解・read-only バッチ＝`ksql_query` 実行可・`requiresCompleteInput` の言及） | PASS |

## 所見

- **表記の摩擦は新たに検出されず**（B60 の括弧誤読のような自己修正イベントなし・全シナリオ一発）。
- 全シナリオで構文だけでなく**意味論・限界・実行時の導線**（必要ツール・上限・排他規則）まで正確＝カタログ（骨格）＋`ksql_docs`（詳細）の 2 段構えが機能。
- 判定は手動レビュー（出力全文は scratchpad の `b61_s1`〜`s5` に採取）。

## 限界（正直な記録）

- **各シナリオ 1 回・単一クライアント（Claude Code）・単一モデル**での結果。Desktop 面・複数回の安定性・弱いモデルでの成立は未確認。
- 判定は `ksql_validate` まで（実行はしていない）。
- B61 本体（スクリプト半自動化・失敗観測→台帳追加ループ・リリースゲート化）は未実装＝本記録は**シナリオ台帳の初回手動実施**。
