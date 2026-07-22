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

## 第 2 ラウンド（2026-07-22・SELECT/JOIN・オプション組合せ 6 シナリオ）: 6/6 PASS

方言の逸脱ポイント（発明の罠）を突く読み取り系。構文は一切指定せず意図のみ依頼。

| # | シナリオ | 生成された核心構文 | 判定 |
|---|---|---|---|
| Q1 | JOIN＋集計＋整列 | `FROM APP4221 a INNER JOIN #cat c ON a.タイトル = c.タイトル GROUP BY … ORDER BY 金額合計 DESC`（**単一等値 JOIN**・修飾参照・alias 整列） | PASS |
| Q2 | グループごと最大 1 件（**派生テーブルの罠**） | `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY … ORDER BY 金額 DESC, $id ASC) AS rn …) SELECT * FROM ranked WHERE rn = 1`（**派生テーブルを書かず CTE**・**必須の `AS rn` あり**・「同一 SELECT 内 WHERE rn=1 不可のため CTE 分離」の理由・`$id` 決定的タイブレーク・completeInput/maxRecords 注意まで） | PASS |
| Q3 | 統計×日付軸 | `STDDEV_SAMP`/`MEDIAN`（**無印 STDDEV 不使用**）＋`YEAR/QUARTER` 関数 GROUP BY＋**`%G-W%v` を年跨ぎ週の理由（2025-12-29→2026 W01）つきで選択** | PASS |
| Q4 | kintone ネイティブ検索＋標準順 | `WHERE タイトル KLIKE 'ダミー' LIMIT 10`（SQL LIKE と別物の理解・**「KORDER BY は KLIKE と併用不可→ORDER BY を書かず SIMPLE で既定順保持」の深い制約判断**・サブテーブル内は KLIKE 不可の注意） | PASS |
| Q5 | サブテーブル一覧 | `FROM APP4221$テーブル WHERE _pid = 5 ORDER BY _idx`（仮想テーブル・`_pid`/`_idx`/`_rid`・`_p.` 親ショートカット言及） | PASS |
| Q6 | 変数＋CASE＋IN | `SET @avg = (SELECT AVG(金額) …); SET @half = (SELECT AVG(金額)/2 …); SELECT … CASE WHEN 金額 >= @avg … WHERE ドロップダウン IN ('d1','d2') ORDER BY 金額 DESC`（最終形は正しい） | PASS（摩擦 2 件・下記） |

### Q6 で観測した摩擦 2 件（構文発明ではなく方言制約の可視性）

1. CASE 内の `金額 >= @avg / 2` → **@変数は算術オペランドに置けず** ParseError → 自己修正
2. `SET @half = @avg / 2` → **SET 右辺は他変数を参照できず** ParseError → 自己修正

いずれも validate によるセルフリカバリで最終形に到達したが、**変数の使用可能位置（比較右辺・IN 要素・関数引数のみ／算術オペナンド不可・SET 右辺の変数参照不可）がカタログ/説明から読み取れない**＝instructions か `ksql_docs` 該当章の注記強化の改善候補として記録。

## 累計と限界（正直な記録）

- 累計 **11 シナリオ 11/11 PASS**（DML 系 5＋読み取り系 6）・構文発明ゼロ・カタログ表記の摩擦の新規検出なし（Q6 の 2 件はカタログでなく変数制約の可視性）。
- **各シナリオ 1 回・単一クライアント（Claude Code）・単一モデル**での結果。Desktop 面・複数回の安定性・弱いモデルでの成立は未確認。
- 判定は `ksql_validate` まで（実行はしていない）。
- B61 本体（スクリプト半自動化・失敗観測→台帳追加ループ・リリースゲート化）は未実装＝本記録は**シナリオ台帳の手動実施（2 ラウンド）**。
