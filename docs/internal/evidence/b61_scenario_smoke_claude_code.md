# B61 AI 行動検証シナリオセット — 手動実施記録（Claude Code 面・5 ラウンド・30 シナリオ）

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

いずれも validate によるセルフリカバリで最終形に到達。実測イベントとしての記録であり、**変数の使用可能位置の正確な境界（実装調査による全数確定）は B62 の §1 を正とする**＝instructions/`ksql_docs` の注記強化候補として B62 へ集約。

## 第 3 ラウンド（2026-07-22・バッチ/WITH/CHECK 3 シナリオ）: 2 PASS・**1 意味論 FAIL（初の実質失敗）**

| # | シナリオ | 結果 | 判定 |
|---|---|---|---|
| R3-1 | 一時テーブル＋ASSERT ゲート | `CREATE TEMP TABLE #agg AS …; ASSERT (SELECT COUNT(*) FROM #agg) >= 1; SELECT …`（「ASSERT 不成立は continueOnError でも必ず停止」の細部仕様まで正確） | PASS |
| R3-2 | 複数 CTE＋CTE 間結合 | `WITH per_dd AS (…), overall AS (…) SELECT … FROM per_dd d INNER JOIN overall o ON d.k = o.k`（**B51 修正経路**・「JOIN は等値 1 個のみ」を**定数キー `1 AS k`** で回避するクロス結合の応用） | PASS |
| R3-3 | UPDATE＋CHECK 業務ルール（引き上げ後 10 万超を隔離） | `CHECK WHEN 金額 > 100000 …`＝**更新前値で判定する別物**（正= `金額 * 1.1 > 100000`）。構文は正しく `ksql_validate` ok:true | **構文 PASS・意味論 FAIL** |

### R3-3 の分析（B61 初の実質失敗・最重要の発見）

- 言語リファレンス §17.3 の正: 「`UPDATE` は**更新前の既存値**（書き込む新値を検査したいときは SET 式を書く: `SET 数量 = 数量 - 出庫数` に対し `WHEN 数量 - 出庫数 < 0`）」（:2155）
- モデルは §16 の「`VALIDATE ONLY`/`ON ERROR SKIP` は SET 右辺の関数を評価した**後**の値を検証」（＝**組み込み制約検証**の記述）を **CHECK に誤適用**し、「CHECK は post-image 評価」と自信を持って逆の説明をした
- **構文 guard（ksql_validate ok:true）ではこの層は捕まらない**＝「カタログが正しい≠AI が正しく読める≠**AI が意味論まで正しく使える**」の三層目を実証。行動検証（B61）でしか検出できない失敗クラス

### 改善候補（R3-3 起点・観測 #3）

「**組み込み検証は post 値・CHECK は更新前値**」という非対称が §16/§17.3 に分かれて記載され混同しやすい。対策候補: ①言語リファレンス §16 の当該文へ「CHECK の参照値は §17.3（UPDATE は更新前値）」の相互参照を追記②`ksql_mutate` description か instructions 共通注記へ「UPDATE の CHECK is pre-update values; test new values by repeating the SET expression」の 1 文（+15 語程度）を追加。

## 第 4 ラウンド（2026-07-22・変数×5 文型／CHECK×4 文型の組合せ 8 シナリオ）: 8/8 PASS

| # | シナリオ | 核心結果 | 判定 |
|---|---|---|---|
| V1 | 配列変数×SELECT | `SET @targets = ['d1','d2']; … WHERE ドロップダウン IN @targets`（**カッコ無し IN @list**＝B3 の方言形） | PASS |
| V2 | スカラー変数×UPDATE | `SET @maxAmount = (SELECT MAX…); UPDATE … SET 金額 = @maxAmount WHERE 金額 IS NULL`（**`@max金額` が ParseError→ASCII 名へ自己修正**＝変数名規約の可視性・観測 #4） | PASS |
| V3 | 時刻変数×UPSERT | `VALUES` に @変数不可→`UPSERT SELECT` に UNION 直結不可→**temp 実体化＋`@start AS 日時`（定数列）へ 2 段自己回復**。「時刻を 1 回だけ評価して固定」（R4 レシピ）引用（VALUES @var 不可＝観測 #5・変数配置ファミリー） | PASS |
| V5 | 変数×DELETE | **MEDIAN は数値専用→`DATEDIFF` 日数化→`MEDIAN`→`FLOOR`→`DATE_ADD` 復元**の迂回を自力構成。件数変数→確認 SELECT→ASSERT→DELETE の 5 文 | PASS |
| C1 | CHECK×UPDATE（在庫引当） | `CHECK WHEN 数値MIN - 3 < 0`（**SET 式を CHECK に再掲**）＋「**更新前の既存値を参照（§17.3）**」の正しい説明・空セル 0→−3 隔離の edge まで。**R3-3 と合わせ n=2 で 1 FAIL/1 PASS**＝文書の実例に一致する場面では正答・表現が変わると §16 と混同 → 相互参照注記の価値を裏付け | PASS |
| C2 | CHECK×INSERT | temp→`INSERT … SELECT … CHECK WHEN 金額 < 1 THEN '…' \|\| 金額 ON ERROR SKIP INTO #err`→`#err` 確認の正配置（今回スキーマ未確認のまま列名を仮定＝自己申告あり・describe 未使用＝**スキーマ確認行動の揺れ**・観測 #6） | PASS |
| C3 | CHECK×UPSERT | `ON DUPLICATE (タイトル)`→`CHECK`→`ON ERROR SKIP` の正しい句順・境界値（=100 万は正常）の判定も正確 | PASS |
| C4 | CHECK×DELETE（**負性**） | **「CHECK/VALIDATE ONLY/ON ERROR SKIP は DELETE 不可」を根拠つきで正答**し、保護条件の WHERE 直接埋め込み＋ASSERT 二重ゲート＋監査スナップショット＋**非アトミック整合 ASSERT**＋空セル 0 扱い防御（`金額 IS NOT NULL`）。自書きの恒真検査を無意味と気づき除去 | PASS |

## 第 5 ラウンド（2026-07-22・codex 提案の未カバー領域 8 シナリオ）: 8/8 PASS

シナリオ設計自体を codex に依頼（言語リファレンス・構文カタログ・既存 26 件を突合し、意味論リスク・負性能力・未カバー文型を優先して 8 件提案）。**提案の判定基準に 1 件誤りがあり実行前に補正**（N5 の「IS NOT NULL のみは FAIL」→ kSQL の IS NULL は空文字判定〔§IS NULL〕のため空セル除外として有効＝提案も裏取りが要る、という教訓）。

| # | シナリオ | 核心結果 | 判定 |
|---|---|---|---|
| N1 | REORDER | `REORDER APP4221$テーブル BY 数値T1 DESC WHERE _pid = 5` 期待形そのまま（`$id`/`_pid` 混同なし・VALIDATE ONLY 付加なし） | PASS |
| N2 | EXPLAIN の使い分け | `EXPLAIN SELECT … ORDER BY 金額 DESC LIMIT 10` 正配置＋**「ローカル整列かは実行しないと分からない」「validate はフィールド実在を確認しない」と分かる/分からないを正確に区別**（メタ認識） | PASS |
| N3 | UNION ALL | 重複保持の理由つきで `UNION ALL` を選択・列位置一致 | PASS |
| N4 | GROUP_CONCAT 決定的順序（負性） | 関数内 ORDER BY 非対応・「連結順=収集順」を正しく認識した上で、**temp 事前ソート（`CREATE TEMP TABLE #sorted AS SELECT … ORDER BY タイトル` → `GROUP_CONCAT(DISTINCT … SEPARATOR ' / ')`）で収集順を固定する正当な決定性手法**を提示（DISTINCT 初出順維持・選択肢定義順の注意も正確） | PASS（期待超え） |
| N5 | 空セル 0 意味論 | `WHERE 数値MIN IS NOT NULL` で行除外＋「未入力が『1』という偽の結果として混入」の正確な説明 | PASS |
| N6 | 相関 EXISTS（負性） | **相関サブクエリ非対応を正しく認識**し、`RANK() OVER (PARTITION BY …) … WHERE rk > 1`（意味論の等価性証明つき）と MAX 集約 CTE＋1:1 JOIN の**非相関再定式化 2 案**・重複の出る自己 JOIN は明示的に不採用 | PASS（期待超え） |
| N7 | IMPORT UPDATE | `IMPORT UPDATE INTO APP4221 (金額, 日付) FROM CSV updates BY NAME MATCH RECORD NUMBER SOURCE` （レコード番号は照合専用・列リスト外・INSERT 0 保証・R12 引用・inline CSV で validate） | PASS |
| N8 | VALIDATE SUMMARY | `VALIDATE APP4221 (タイトル, 数値MIN, テーブル(数値T1)) SUMMARY INTO #summary`＋「SUMMARY 5 列はレコード単位のまま」の理解に基づく GROUP BY 畳み込みの 2 文構成 | PASS（期待超え） |

## 累計と限界（正直な記録）

- 累計 **30 シナリオ・29 PASS＋1 意味論 FAIL（B62 で解消済み）**（DML 5＋読み取り 6＋バッチ/WITH/CHECK 3＋変数×文型/CHECK×文型 8＋codex 提案の未カバー領域 8）。構文発明はゼロのまま＝カタログ（B60）は機能。改善候補・観測は計 6 件: ①@変数は算術オペランド不可②SET 右辺の変数参照不可③CHECK 参照値の可視性（§16/§17.3・n=2 で 1 FAIL/1 PASS）④変数名は ASCII のみ⑤VALUES に @変数不可⑥スキーマ確認行動の揺れ（運用/プロンプト側）。①②④⑤は「変数の使用可能位置・規約」ファミリーに集約可能。
- **各シナリオ 1 回・単一クライアント（Claude Code）・単一モデル**での結果。Desktop 面・複数回の安定性・弱いモデルでの成立は未確認。
- 判定は `ksql_validate` まで（実行はしていない）。
- B61 本体（スクリプト半自動化・失敗観測→台帳追加ループ・リリースゲート化）は未実装＝本記録は**シナリオ台帳の手動実施（5 ラウンド）**。
