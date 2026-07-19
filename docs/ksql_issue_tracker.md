# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-19
- 現在の最新リリース: **v3.5.0**（既存レコード制約チェック B41＋バッチ変数の参照拡張 B3/B10-B・tag/GitHub Release 公開済み・**npm publish 待ち（ユーザー）**）。前版 v3.4.0（B37/B38・latest 3.4.0）。
- 次回リリース計画: 未定。**後続候補**＝B39 CSV 取込 IMPORT 文（要 R2）・B40 プロパティグラフ（大規模・要 R2）。**棚上げ**＝B4/B5/B6/B7。
- 目的: 課題・改善案・Issue の**進捗 / 効果 / リリースバージョン**を1か所で俯瞰する。個別の詳細は各文書へリンク。

## 運用ルール

- **本書は一覧（インデックス）**。仕様・診断・受入条件などの本文は各文書に置く。
- 各文書の先頭 `- ステータス:` 行が正（single source of truth）。本書はそれを集約する。
- **複数の課題にまたがる意味論は「横断仕様」を正とし、個別文書はそれを参照する**（事実を書き写さない）。現在: [文字列の扱い](internal/ksql_string_semantics.md)。実測で覆ったら**まず横断仕様を直し**、個別文書はそれに従う。
- 状態が変わったら **本書・各文書のステータス行・`CHANGELOG.md`・auto-memory** を揃えて更新する。
- リリース時は「§2 リリース済み履歴」に版数・効果を1行追記し、「§1 バックログ」から該当行を落とす。

## 凡例（状態区分）

| 記号 | 意味 |
|---|---|
| ✅ | リリース済み |
| 🚧 | 実装済み・リリース/実機確認待ち |
| 📋 | 仕様確定・実装待ち |
| 📝 | ドラフト / 評価 / 提案（仕様前 or 判断待ち） |
| ⏸ | 保留（対象外化の判断済み） |
| 🐞 | 残課題（未着手のバグ） |

効果の種別: **正しさ**（結果の整合・バグ修正） / **性能**（API 消費・速度） / **機能**（新機能） / **安全性**（誤操作・データ破損防止）

---

## 1. バックログ（未リリース・要対応）

進捗が動くのはここ。優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」で暫定。**2 段構成＝上段 A: 設計探索済みの実装候補（B41/B39/B40・各 spec/eval＋codex レビュー＋工数見積り済み・要 R2/R3）、下段 B: 棚上げ・低優先の提案（B3〜B10）**。着手向き順は B41（最軽量・実需明確）> B39 > B40（大規模）。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B39 | IMPORT（外部 CSV を kSQL ソースにバインド・CLI v1） | 改善 | 📝 **【A: 実装候補】IMPORT 文 設計 R4・Claude レビュー承認・フラット CSV 実装着手可（2026-07-19）**＝`IMPORT INTO app (fields) FROM CSV <source> [SELECT 射影] [ON DUPLICATE key] [CHECK] [ON ERROR SKIP INTO #err]`。分担=codex 設計/Claude レビュー。R1→R4 の4回で確定＝共通 materializeDmlSource→MaterializedTable の3経路再編・射影後の意味型推論・IMPORT UPSERT 全経路の源内キー重複 preflight・同期 loader capability＋10 MiB・CSV 列名/構文/各面配線。**サブテーブル IMPORT は v1 非対応**（cli-kintone `*` 形式は v2・親 DML がサブテーブル子を書けない）。工数 17〜27 人日・minor。次段=実装（codex 実装/Claude レビュー）。**サブテーブル(テーブル)IMPORT は v1 非対応**（cli-kintone の `*` 複数行形式で可だが kSQL 親 INSERT/UPSERT がサブテーブル子を書けない＝前提機能が別途要・v2 は cli-kintone 形式基準・§10.4）。空 CSV=エラー・CLI 限定にしない（loader capability）。SemVer minor。bind 案（[bind spec](internal/ksql_csv_bind_import_spec.md)）は APP レス実行が重く後回し。R1 4 重大のうち②`analyzeBatch` external seed・④CSV 列は明示 string 型は**解消済**。**なお不足＝①単文/bind-only の APP レス実行（全ソース bound 時は no-op client）②実ストア seed（executeBatch の tempTables Map へ実 bind 表を注入）③read-only の全経路先行検査（単文 CREATE/DROP/INTO の generic エラーより前）④空 CSV スキーマ契約**＋公開 `BoundTable` 型・単文 SELECT の temp-aware ルート・CSV 破損 fail-closed。アーキ（CSV を temp 相当へ bind して既存 DML 再利用）は妥当。**難所＝APP レス実行経路**。→ **別案 IMPORT 文（[spec](internal/ksql_import_statement_spec.md)・設計 R1・codex レビュー済）を採用方向**＝CSV を temp 露出せず「INTO app へ書込む自己完結文」にし、**bind 固有の難所 3 つ（APP レス実行・temp seed・read-only）を確実に除去**（codex 確認）。ユーザー決定＝空 CSV(0 行)はエラー・CLI 限定にせず loader capability で面非依存（`FROM CSV <source>`・CLI=file/プラグイン=picker/MCP=inline）。残＝R2 で源 materializer 共通化・ON ERROR SKIP バッチ限定・CSV 射影の列スコープ検証。柔軟性（CSV↔アプリ JOIN）が要れば bind 案は v2。CLI `--bind-csv name=path`＋`--csv-encoding utf8\|sjis`＋`--csv-no-header` で CSV を一時テーブル `#<name>` 相当ソースにし、既存 `INSERT/UPSERT…SELECT`/`UPDATE…FROM`/`ON ERROR SKIP`/B37 `CHECK` を全再利用（検証・UPSERT・変換・不良行隔離付き取込）。要点＝`analyzeBatch` へバインド名を seed（未作成参照エラー回避・自己確認済み）・値は文字列供給・`TextDecoder` で SJIS/UTF-8 依存なし・read-only・`tempTableMaxRows` 流用。v2=MCP inline/プラグイン upload/JSON/複合型/EXPORT 構文化。[eval](internal/ksql_import_export_evaluation.md) 別。**EXPORT は非推奨**＝CLI `--format --output` で充足・面非対称で SQL 化の価値薄。**IMPORT は条件付き推奨**＝現状ローカル CSV/JSON を kSQL ソースにできない。純正 CSV 取込にない「検証・業務キー UPSERT・変換・不良行隔離（`ON ERROR SKIP`）・B37 チェック付きの賢い取込」が価値（B12/B37 と相乗）。設計＝SQL にファイルパスを入れず**名前付き外部ソースを面ごとに供給**（CLI=`--bind-csv name=path`／MCP=inline／プラグイン=upload）し一時テーブル相当で `FROM name` 参照＝既存 DML 機構を全再利用・SQL は面非依存。**CLI 先行 v1**（Shift_JIS/UTF-8 とも `TextDecoder` で依存なし・ヘッダ列名・値は文字列供給＋`CAST`/フィールド型委譲・複合型/添付は非対応）→ MCP/プラグインは v2。**実需確認済（2026-07-18）**＝CLI=バッチ（取込と役割一致）・欲しい 4 機能（検証/UPSERT/変換/隔離）は既存 DML 再利用で無料・SJIS/UTF-8 両方・実需は未検証だが npm ~4,500 DL の基盤あり。**提言=低コスト高適合の (A) 最小 v1 寄り／(B) 実需シグナルまで待つ**。判断待ち | 機能 | 中 | [eval](internal/ksql_import_export_evaluation.md) |
| B40 | グラフデータモデル（SQL/PGQ・プロパティグラフ／`MATCH`） | 改善 | 📝 **【A: 実装候補】Phase1 仕様 R1・codex レビュー済・要 R2（大規模 19〜31 人日 ≈ 2〜3× B37・探索的需要・2026-07-19）**。SQL:2023 の `CREATE PROPERTY GRAPH`＋`GRAPH_TABLE MATCH (a)-[t]->(b)`。ノード=アプリ・エッジ=2 外部キーのアプリ。**固有価値=可変長 `{m,n}`/到達可能性/循環検出**（現状 kSQL は再帰CTEなし・JOIN 単一等値・派生テーブルなしで**表現不能 or 極めて冗長**）。障害=kintone にグラフエンジンなし→**クライアント全件取得＋メモリ走査**（可変長は爆発リスク・境界と fail-closed 必須）・**実装最大級**（新 MATCH 副言語＋グラフ実行エンジン）・標準は新しい（Oracle 先行）。段階案=Phase1 固定長+循環検出（境界付き MVP）→Phase2 可変長/到達可能性。**実需確認済（2026-07-19）=規模 小(数千件以下)→性能リスクほぼ消滅・全面 engine 側→面配管不要＝2 大リスク緩和。用途 BOM/循環に関心だが具体需要は探索的。固定/可変 両方段階的**。Phase1 仕様 R1＋codex レビュー済（[spec](internal/ksql_property_graph_phase1_spec.md)）。**工数確定＝19〜31 人日 ≈ B37 単体の 2〜3 倍**（新 FROM ソース＋バッチスコープ定義＋型付き副言語＋パターン評価器）。技術的に実装可能・要 R2（FROM lowering・KEY/REFERENCES 契約・graph WHERE resolver・爆発は有界 fail-closed・EXPLAIN 実件数不可・LAPP プラグイン非対応の 10 点）。需要は探索的なので**大規模投資の是非が判断ポイント**。可変長(Phase2・BOM 本命)は別途 | 機能 | 中 | [eval](internal/ksql_property_graph_evaluation.md) |
| B41 | 既存レコードの制約チェック（組み込み制約＋カスタムチェックの読み取り監査） | 改善 | 🔍 **実装済み・Claude レビュー済・dev 実機 smoke pass（v3.5.0・2026-07-19）**。仕様 R1→R4 の4回 codex レビューを通し実装。[参考記事](https://qiita.com/rex0220/items/de02e64dc34f3362d1f8)。kintone のフォーム制約は過去データに効かない→既存レコードを**組み込み制約（必須/数値上下限/文字数/選択肢）＋カスタムチェック（B37 構文）で監査**し違反報告（`$id`/フィールド/コード/メッセージ/現在値・CLI は CSV）。**B37 の読み取り版**（書込み時 B37 ⇄ 既存監査 B41 で対）。**実現性高**＝`validateAndNormalizeDmlValue`（必須/min-max/length/choice を既に実装）・型解決・`CHECK`・fetch を既存流用、新規は「既存レコードへ検証適用＋出力」経路のみ＝**B37 より軽い見込み**・engine 側全面。設計案＝`VALIDATE <app> [(fields)] [WHERE] [CHECK …] [INTO #err]`（read-only）。**v1 仕様 R4・実装着手可**（[spec §13](internal/ksql_existing_record_validation_spec.md)・保守 v1）。R1→R4 の4回で codex レビューを通過し、核心（二系統・`{id,record,flat}`・read-only・`SelectResult`・raw fetch＋local 評価・NUMBER/onLimit）を確定。R3 review の P1×5 も §13 で解決＝`$err_value` 空値=`""`＋`normalizeRaw` export・修飾参照静的拒否・prefilter は `extractSafePushdownLeaves`＋local 再評価・サブクエリ専用静的拒否・#err は B12 validateOnly 分岐を範に固定5列＋列メタ・EXPLAIN 専用 plan builder。工数 4.5〜8.5 人日（計画上 6〜8.5 寄り）・SemVer minor。**実需明確**（ユーザー自作 Chrome 拡張）。次段＝実装（codex 実装／Claude レビュー） | 安全性・機能 | 中 | [eval](internal/ksql_existing_record_validation_evaluation.md) |
| B3 | バッチ変数：配列変数と `IN @list`（B10-B と統合） | 改善 | 🔍 **実装済み・Claude レビュー済・dev 実機 smoke pass**（2026-07-19）。統合仕様 R2 の STRING 配列 SET、`VARIABLE_IN_LIST`、非空 literal IN 展開、空配列 BOOLEAN 固定点簡約、更新系 root TRUE 拒否/root FALSE no-op、EXPLAIN・静的 kind 検査・回帰テストを実装。版数・artifact はリリース工程で同期 | 機能 | 低 | [統合仕様](internal/ksql_batch_variable_reference_extension_spec.md) |
| B4 | 保存クエリのパラメータ化 `:name` | 改善 | 📝 **【B: 棚上げ】価値評価の再検討が必要（2026-07-18 棚卸し）**。仕様（詳細 R2）は流用可能水準だが、**評価が `@var`（DECLARE 外部注入）実装前に書かれ重複を未検討**。B4 の中核価値「外部から動的値を安全注入」は `@var` が既に提供済み。残る固有価値は「カタログ永続化＋保存クエリでの利用」だけで、それも「保存クエリの単文制約を緩めて DECLARE+SELECT バッチ＋既存 @var」の軽量路線の方が安い。着手前に @var との差分で再評価（eval に追記済み） | 機能 | 中 | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
| B5 | KLIKE 親レコード DML 解禁 | 改善 | 📝 **【B: 棚上げ】改善案・専用仕様が要る（2026-07-18 棚卸し）**。前提の検索打ち切り検出は **Node/CLI/MCP のみ整備済**（プラグインは `kintone.api()` がヘッダー非露出＝B7 未解決で安全前提が崩れる）。実装には①DML result 型への `warnings` 追加②プラグイン面を対象外にするか（Node 系限定解禁）③サブテーブル DML 恒久非対応、を確定する専用仕様が必要（v1 spec §3.5 に面依存性を追記済み） | 機能 | 中 | [v1 spec](internal/ksql_klike_native_search_spec.md) |
| B6 | KLIKE 外部結合 非 nullable 側の押し下げ解禁 | 改善 | 📝 **【B: 棚上げ】改善案・棚上げ妥当（2026-07-18 棚卸し）**。INNER 限定は v3.2.0 でも有効（`klikePushdownPlan.ts:31`）。非 nullable 側判定は結合順・来歴付与を要する非自明な正しさ問題で、現状は将来メモ1行のみ。実需確認まで棚上げ・着手なら専用仕様から | 性能 | 低 | [v2 spec](internal/ksql_klike_pushdown_v2_spec.md) |
| B7 | プラグインでの検索打ち切り検出（raw fetch 経路） | 改善 | 📝 **【B: 棚上げ】改善案・B5 従属（2026-07-18 棚卸し）**。Node 系は実装済・プラグインのみ未検出（`ui/kintoneClient.ts` が `searchAborted` 未設定）。案a=`kintone.api.url()` で raw fetch 化しヘッダー取得だが実機確認未着手。B5 をプラグインまで解禁する段で必須化する従属課題。当面は案b（プラグイン非検出を明記）で許容・棚上げ妥当 | 安全性 | 低 | [issue](internal/ksql_search_abort_warning_issue.md) |
| B10 | バッチ変数 後続：`NULL` 代入 / SELECT 列 `@var`（Part B は B3 と統合） | 改善 | 🔍 **Part B 実装済み・レビュー済・実機 smoke pass／Part A クローズ**（2026-07-19）。`VARIABLE_COL`（AS 必須）を parser に追加し、解決時 STRING=`LITERAL_COL`、NUMBER=`ARITH_COL` へ変換して既存 rows/columns/meta を継承。CONCAT_OP 分岐後に配置して `@x||field` を維持。Part A（NULL）は既存の空文字方針でクローズ | 機能 | 低 | [統合仕様](internal/ksql_batch_variable_reference_extension_spec.md) |

---

## 2. リリース済み履歴（版数・効果）

新しい順。各機能の詳細は `CHANGELOG.md` と各文書を参照。

| バージョン | 内容 | 効果 | 文書 |
|---|---|---|---|
| **v3.5.0** | **既存レコード制約チェック＋バッチ変数の参照拡張（2026-07-19）**。**B41**=`VALIDATE <app> [(fields)] [WHERE] [CHECK …] [INTO #err]` の read-only 監査文（既存レコードを組み込み制約＋B37 CHECK で検査し `$id/$err_field/$err_code/$err_message/$err_value` の5列で返す・組み込み検証は生値で USER/組織/グループ/複数選択の空も必須違反検出・WHERE は KLIKE/サブクエリ/修飾参照を静的拒否・書込み API 0・単文 INTO 拒否・EXPLAIN 専用 plan で違反件数なし）／**B3**=`SET @l=['A','B']`＋カッコ無し `IN @l`/`NOT IN @l`（literal IN 展開・空配列は親aware固定点簡約で `in ()` 非送信・更新系恒真は実行前拒否）／**B10-B**=SELECT 定数列 `@x AS alias`（型保持）。仕様 R1→R4（B41）/R2（統合）の codex レビューを通し実装・npm test 1,955＋25 green・dev 実機 smoke（両フェーズ）pass。SemVer=minor | 安全性・機能 | [B41 spec](internal/ksql_existing_record_validation_spec.md) / [参照拡張 spec](internal/ksql_batch_variable_reference_extension_spec.md) / [計画](internal/ksql_v3_5_0_implementation_plan.md) |
| **v3.4.0** | **DML カスタムチェック＋文字列連結の 2 件（2026-07-18）**。**B37**=`CHECK WHEN <条件> THEN <メッセージ>` で INSERT/UPSERT/UPDATE に行レベル業務ルールを付与し該当行を `#err`(`ERR_CHECK`)＋カスタムメッセージで隔離（`ON ERROR SKIP`=隔離/`VALIDATE ONLY`=報告/素 DML=停止）。CHECK ブロック=グループ（ブロック内先勝ち・ブロック間独立）。参照=読み取り行（SELECT 出力行[先頭N列書込み・末尾CHECK専用]/挿入値/UPDATE 更新前値/UPDATE FROM は `APP<n>.列`=旧値・`<src>.列`=新値の修飾解決）。組み込み検証と独立・評価器例外は fail-closed・サブテーブル非対応・新ソフトキーワード（予約語増なし）／**B38**=文字列連結 `\|\|`（`CONCAT` 同義・NULL/空は空文字・左結合・加減算と同優先順位）＋関数引数の `@var` 受理（`CONCAT('x=',@v)`）＋再利用 `ScalarValueExpr`（既存 `ArithNode`・`FORMAT(SUM())` は非破壊）。`\|\|` は WHERE 比較オペランド未対応（`CONCAT` を使う）。全 1,943 テスト green・ブラウザ実機（B37/B38）パス。SemVer=minor | 機能・**正しさ** | [B37 spec](internal/ksql_custom_check_spec.md) / [B38 spec](internal/ksql_concat_operator_spec.md) |
| **v3.3.0** | **厳密10進比較・数値精度整合・正規表現の 4 件バンドル（2026-07-18）**。**B9**=最大30桁の厳密10進比較（16 有効桁超の NUMBER/CALC を binary64 で丸めず区別＝WHERE=・MIN/MAX・ORDER BY が正しくなる・数値リテラルは元字句保持で指数表記も受理。**実機検証中に発見した押し下げバグ＝指数リテラル `1e3` の生字句が kintone クエリへ漏れ CB_VA01 も修正**＝`numberLiteralText` を平文10進へ正規化）／**B29**=書き込み先アプリの `numberPrecision` から整数部の桁超過を書き込み前に検出（`ERR_NUMBER_INTEGER_DIGITS`・`ON ERROR SKIP` で行隔離）。**小数は kSQL で検証せず kintone の自動丸めに委ねる**（REST/CSV/編集画面と一貫＝案B。R1 の小数拒否・`quantizeDecimal` は撤回）／**B20**=正規表現関数 `REGEXP_LIKE`/`REGEXP_REPLACE`/`REGEXP_SUBSTR`（ECMAScript・`i`/`m`/`s`・`u` 常時有効・ユーザー責任・予約語3語）／**B36**=`REGEXP_REPLACE` 第5引数 `occurrence`（省略/0=全置換・1=先頭・N=N番目・後方参照は手書き展開）。全 1,912 テスト green・ブラウザ実機（B9/B20/B29/B36）パス。SemVer=minor（16桁超の比較のみ結果が正しく変わる） | **正しさ**・機能 | [migration](ksql_v3_3_migration_guide.md) / [B9 evidence](internal/evidence/b9_exact_decimal_semver_probe.md) / [B29 evidence](internal/evidence/b29_number_precision_smoke.md) / [B36 spec](internal/ksql_regexp_replace_occurrence_spec.md) |
| **v3.2.0** | **正しさ・関数の 7 件バンドル（2026-07-18）**。**B34**=DML 書き込み先フィールド検査（不存在/サブテーブル子/書込不可を文単位 ArgumentError・検査はソース SELECT/confirm/POST・PUT より前・VALIDATE ONLY の inSubtable 素通し解消）／**B22**=LEFT/RIGHT/SUBSTRING/LPAD/RPAD のサロゲートペア分割解消（コードユニット予算内の最大安全部分列・性質テスト 18 入力×全境界）／**B21**=UPDATE SET の文字列関数直接受理（行評価経路へ統合・LPAD 先頭ゼロ保持・ERR_LENGTH_MAX 捕捉・UPDATE FROM/サブテーブルは明示拒否）／**B23**=LENGTH_CHAR（コードポイント計数・LENGTH−LENGTH_CHAR=ペア数）／**B24**=TRANSLATE（コードポイント整列 1 対 1 写像・長さ不一致はエラー・レシピ R8 同梱）／**B28**=VALUES の符号付き数値リテラル受理（-- は行コメントの罠を文書化）／**B35**=message なしエラーの fallback 表示。全件 codex 実装→Claude レビュー→実機（evidence 6 点）。1,761 テスト green。SemVer=minor | **正しさ**・機能 | [台帳各行の issue/spec] / [evidence](internal/evidence/) |
| **v3.1.0** | **B33 `KORDER BY` 大規模窓の Cursor API 対応（2026-07-18）**。単発GETに収まらない窓（`LIMIT>500`/`OFFSET>10000`）を `KORDER_CURSOR` で kintone 固有順のまま実行（条件=走査件数 `OFFSET+LIMIT<=maxRecords`・超過は理由コード付き planning error・フォールバックなし）。必須 `openCursor` 契約・host 単位 lease（既定2最大5・新設定 `cursorMaxActive` 全面公開）・Create/Get 再試行なし・既解放=実測 `404`+`GAIA_CN01` のみ（plugin は status 非公開のため code 単独許可）・quarantine 10分+30秒・必要窓到達で早期 DELETE・plugin 離脱 best-effort cleanup・EXPLAIN `KORDER_CURSOR`/metrics・MCP `ksql_explain.maxRecords` 追加。**実機=raw Cursor API と 7/7 全件照合一致（618,525件・21ページ・500件境界同値群）＋Chromium/Firefox plugin smoke**（evidence 3点）。純加法 minor・挙動変更なし | 機能・性能 | [spec](internal/ksql_cursor_api_fetch_spec.md) / [plan](internal/ksql_korder_cursor_implementation_plan.md) / [migration](ksql_v3_1_migration_guide.md) |
| **v3.0.0** | **B26＋B27＋B30＋B31＋B32（型付き比較と ORDER BY 計画の major・2026-07-17）**。B26=4面共通の型付き canonical 比較（文字列・型不明はコードポイント順。`localeCompare`・Unicode 正規化・ペア単位の自動数値化を廃止。typed number は`空セル < -Infinity < 有限数 < +Infinity < "NaN" < その他非数値`の固定バンド・`#err` の検証失敗値をエラーにしない）／B27=schema-aware ORDER planner（REST top-N 初期 allowlist は `$id` のみ・query 全体の窓が同値な場合だけ押し下げ・STATUS は `states.*.index` 保持で定義順）／B30=部分候補の誤 top-N を fail-closed 化（`onLimit=truncate` でも local ORDER は完全入力必須）／B31=`KORDER BY`（kintone REST 固有順を明示する別構文・`$id`＋受理15型 allowlist・条件外は planning error でフォールバックしない）／B32=WHERE 型×演算子能力表（EXPLAIN ok→実行 `GAIA_IQ03` を解消。SELECT は FULL_SCAN 残余・DML は実行前拒否）。EXPLAIN は schema-aware 化・`KORDER` 予約語。SemVer=**major** | **正しさ**・機能・性能 | [migration](ksql_v3_migration_guide.md) / [semantics](internal/ksql_string_semantics.md) / [order draft](internal/ksql_local_order_by_draft.md) / [impl plan](internal/ksql_v3_order_by_implementation_plan.md) |
| **v2.17.0** | **B19 スカラー関数バンドル**。第1部＝`TRUNCATE`/`TRUNC`・`LEFT`/`RIGHT`・`INSTR`・`GREATEST`/`LEAST`・`LPAD`/`RPAD`・`LAST_DAY`（`RIGHT` は代替不能＝`SUBSTRING` は引数に算術式を書けず負数開始は全文を返す）。`GREATEST`/`LEAST` は `compareScalarValues` を畳み込まない（畳み込みは全順序でなく `2<10<1a<2` の循環）→空文字を先に確定・集合単位でモード判定・数値同値は元文字列で二次比較。第2部＝**既存欠陥の修正**: `DATE_ADD` の構文が文書と実装で食い違い（`INTERVAL` はトークン非存在＝**書いたら必ず ParseError**）・**不正な単位が黙って DAY 加算**（→実行時 `ArgumentError`）・`SUBSTRING` の負数開始が全文を返すことを文書化。8 語の新規予約語 | 機能・**正しさ** | [spec](internal/ksql_scalar_function_bundle_spec.md) |
| **v2.16.0** | **B17 順位系ウィンドウ関数**。`ROW_NUMBER()`/`RANK()`/`DENSE_RANK()` ＋ `OVER ([PARTITION BY …] [ORDER BY …]) AS alias`。**「各グループ最新1件をその行の全列とともに取得」を初めて可能に**（`MAX()` の結果を元行へ結合し直すには複合等値が要るが JOIN は単一等値のみ・派生テーブルも無いため従来は表現不可能）。CTE で1文。評価は HAVING 後・DISTINCT 前（SQL 標準）でウィンドウ列は FULL_SCAN 強制（CTE 誤インライン化＝`WHERE rn=1` の押し込みを防ぐ正しさの前提）。ウィンドウ内 `ORDER BY` はトップレベルと比較器・ソートメタを共有。`AS alias` 必須・`GROUP BY`/集計との同一 SELECT 併用は v1 非対応・予約語 | 機能 | [spec](internal/ksql_window_function_spec.md) |
| **v2.15.0** | **B14** 一時テーブル/CTE 列の型メタ伝播（temp 経由でもテキスト・日時の `MIN`/`MAX` が効く。`#err` の列は DML 対象アプリの定義から宣言・`$id` は RECORD_NUMBER 相当。推論は素通し/集約/算術/リテラルのみで「迷ったら載せない」）／**B16** 文字列集約 `GROUP_CONCAT([DISTINCT] 引数 [SEPARATOR '区切り'])`（暗黙の切り捨てなし・空値スキップ・`DISTINCT` 初出順・予約語・`GROUP_CONCAT(*)` は ParseError・**B14 とは独立**）／**B18** 事前検証がミリ秒付き ISO 日時（`NOW()` の形式）を誤って拒否し `ON ERROR SKIP` が正常行を誤隔離していた不具合を修正／バッチレシピ集に **R6「不良データを隔離して残りを流す」**新設・R2 に `VALIDATE ONLY` 追記・**実行できなかった B12 の例を修正** | 機能・正しさ・安全性 | [B14](internal/ksql_temp_column_type_meta_spec.md) / [B16](internal/ksql_group_concat_spec.md) / [B18](internal/ksql_validate_datetime_millisecond_issue.md) / [recipes](ksql_batch_recipes.md) |
| **v2.14.1** | B15 `IN`/`NOT IN` の負数リテラル受理。`= -1` / `BETWEEN` は受理するのに `IN (-1)` が `ParseError` になる非対称を解消（`parseInValues` が単項 `-`/`+` を受理）。`IN (+1)`≡`IN (1)`・`IN ('-1')` は文字列のまま・押し下げは `in (-1,1,"-1")`。受理範囲の拡大のみ（patch） | 正しさ | [issue](internal/ksql_in_list_negative_number_issue.md) |
| **v2.14.0** | B13 文字列・日時 `MIN`/`MAX`。実アプリのテキスト・選択・日時（正規化済み DATE/TIME/DATETIME・作成/更新日時）と文字列 CALC を UTF-16 辞書順で集約。NUMBER・数値 CALC は従来の数値比較を維持（回帰なし）。専用 `AggregateSortKindResolver`（sortKind 一次＋fieldType 補完）で型解決し `getFieldsCached` 共有。JOIN 修飾列・一意な非修飾列に対応。同名競合・非対応複合型・temp/CTE は従来の数値経路（フェーズ2で別途） | 正しさ | [spec](internal/ksql_string_min_max_aggregate_spec.md) |
| **v2.13.0** | B12 バンドル。B12-A `VALIDATE ONLY`（Tier 0 事前検証・書き込みゼロ・複数エラー収集・`INTO #err`）／B11.1 `UPDATE … FROM` 業務キー結合（`target.field = source.field` 単一等値・数値/文字列キー正規化・ターゲット重複全件更新・64 文字超は全文一致逆引き）／B12-B `ON ERROR SKIP INTO #err [REJECT LIMIT n]`（NG 行を隔離し合格行のみ書き込み・REJECT LIMIT 超過は書き込みゼロで診断返却） | 機能・安全性・正しさ | [validate](internal/ksql_validate_only_implementation_plan.md) / [update-from §12](internal/ksql_update_from_spec.md) / [on-error-skip](internal/ksql_on_error_skip_isolation_spec.md) |
| **v2.12.0** | B11 `UPDATE … FROM`（アプリ間・一時テーブル転記）。SET 値に他テーブル（`#temp`/実アプリ `APP<n>`）のフィールドを参照・`$id` 単一等値・複数マッチ/不正キー/列欠落/複合型/上限は PUT 前 fail-closed・50 件チャンク・MCP は `maxRecords` で読み取り | 機能 | [spec](internal/ksql_update_from_spec.md) / [roadmap](internal/ksql_batch_processing_roadmap.md) |
| **v2.11.0** | B1 CLI DML×`truncate` 暗黙部分書き込み防止（`error` 固定）／B2 空 `SELECT *` の列スキーマをパイプライン伝播（0 行 no-op 完走）／B8 `LIMIT>500` の安全な取得打ち切り（`ORDER BY` なし・KLIKE なし限定）＋`maxRecords` 意味論変更 | 安全性・正しさ・性能 | [B1](internal/ksql_cli_dml_on_limit_truncate_issue.md) / [B2](internal/ksql_empty_select_wildcard_pipeline_spec.md) / [B8](internal/ksql_limit_over_500_fetch_truncation_spec.md) |
| **v2.10.1** | SIMPLE SELECT の `LIMIT` > 500 が API エラーになる不具合を修正（案A ＝ `fetchAll` でページング） | 正しさ | [issue](internal/ksql_simple_select_limit_over_500_issue.md) |
| **v2.10.0** | 検索打ち切り（10 万件）検出＋`FROM` なし SELECT の実体化バグ修正。SELECT は警告 / DML・一時テーブル実体化は fail-closed | 正しさ・安全性 | [abort](internal/ksql_search_abort_warning_issue.md) / [fromless](internal/ksql_fromless_select_materialize_bug.md) |
| **v2.9.0** | KLIKE プレフィルタ押し下げ（v2）。FULL_SCAN でも KLIKE を安全 AND リーフとして kintone 押下・INNER JOIN 限定 | 性能 | [spec](internal/ksql_klike_pushdown_v2_spec.md) |
| **v2.8.0** | KLIKE / NOT_KLIKE（kintone ネイティブ `like` 素通し）。大規模キーワード検索の高速化 | 性能・機能 | [spec](internal/ksql_klike_native_search_spec.md) |
| **v2.7.0** | STATUS（ワークフロー状態）の IN 押し下げ（`status.json` 検証・型ベース判定） | 性能 | [spec](internal/ksql_status_in_pushdown_spec.md) |
| **v2.6.0** | 選択系 IN 押し下げ（4 型・optionOrder 実在検証）＋ `IN ('')` 空セル評価修正（案B） | 性能・正しさ | [pushdown](internal/ksql_selection_in_pushdown_spec.md) / [empty-in](internal/ksql_selection_empty_in_eval_issue.md) |
| **v2.5.0** | 型メタ付き `IN`/`NOT IN` 評価（複数値・ユーザーコード） | 正しさ | [spec](internal/ksql_fullscan_in_typed_eval_spec.md) |
| **v2.4.0** | バッチ変数 Phase 1c：`DECLARE @x = 既定値` 外部パラメータ注入（MCP/CLI） | 機能 | [spec](internal/ksql_batch_variables_phase1c_spec.md) |
| **v2.3.0** | バッチ変数 Phase 1b：`SET @x=(SELECT ...)` スカラーサブクエリ代入 | 機能 | [spec](internal/ksql_batch_variables_phase1b_spec.md) |
| **v2.2.0** | 述語押し下げの安全化と数値対応（案A ＝ `=`・strict `<`/`>`）＋空セル数値 −∞ 準拠 | 性能・正しさ | [numeric](internal/ksql_numeric_predicate_pushdown_spec.md) / [empty-num](internal/ksql_evalwhere_empty_cell_numeric_issue.md) |
| **v2.1.2** | 集計算術式（`SUM(a)-SUM(b) AS diff`）の alias 消失を修正 | 正しさ | [issue](internal/ksql_agg_arith_alias_dropped_issue.md) / [fix](internal/ksql_agg_arith_alias_dropped_fix_spec.md) |
| **v2.1.1** | 0 行 SELECT（明示列）の出力列欠落を修正。差分 0 件の空ソース INSERT/UPSERT が no-op 完走 | 正しさ | [issue](internal/ksql_empty_select_columns_issue.md) |
| **v2.1.0** | バッチ変数 Phase 1a：`SET @var`（スカラー式・時刻固定・DRY）＋ R4 の IN 要素対応（`WHERE k IN (@a, @b)`。チェックボックス等 `in` 必須フィールド向け） | 機能 | [spec](internal/ksql_batch_variables_phase1a_spec.md) |
| **v2.0.0** | 全 `LIKE` を JS 評価へ統一・kintone 押し下げ全廃（`isLike` 統一・親 DML fail-closed） | 正しさ・安全性 | [spec](internal/ksql_like_js_default_optin_pushdown_spec.md) |
| **v1.14.0** | WHERE 右辺フィールド比較 / LIKE モード不一致の 2 バグ修正 | 正しさ | [issue](internal/ksql_where_rhs_field_and_like_mode_divergence_issue.md) / [fix](internal/ksql_where_rhs_field_and_like_fix_spec.md) |
| **v1.13.0–.2** | 論理アプリ参照 `LAPP_<NAME>`（CLI/MCP・プラグイン非対応）。.1 CLI エラー復元・.2 単文 dry-run 露出修正 | 機能 | [spec](internal/ksql_logical_app_id_mapping_spec.md) / [plan](internal/ksql_logical_app_id_mapping_impl_plan.md) |
| **v1.12.1** | `extractAppIds` がコメント/文字列内 `APPxxxx` を誤ってトークン要求する不具合を修正 | 正しさ | [issue](internal/ksql_extract_app_ids_comment_string_issue.md) |
| **v1.12.0** | `GROUP BY` なし集計は 0 件でも 1 行返却（SQL 標準準拠） | 正しさ | [plan](internal/ksql_ungrouped_aggregate_empty_result_implementation_plan.md) / [spec](internal/ksql_ungrouped_aggregate_empty_result_spec.md) |
| **v1.11.0** | 一時テーブル実体化行数上限 `tempTableMaxRows` を可変化（env / profile / プラグイン UI） | 機能 | [spec](internal/ksql_temp_table_max_rows_option_spec.md) / [plan](internal/ksql_temp_table_max_rows_option_implementation_plan.md) |
| **v1.10.0** | バッチ拡張 第1弾（`ASSERT` / CLI バッチ JSON 出力 / `requestGate` 設定公開） | 機能 | [spec](internal/ksql_batch_enhancement_phase1_spec.md) / [proposals](internal/ksql_batch_enhancement_proposals.md) |
| ～v1.9.0 | 初期リリース群（順次バッチ＋一時テーブル v1.4.0 / プラグイン DML バッチ v1.9.0 / MCP INSERT・UPSERT … SELECT / `dmlMaxRows` ソース読み取り v1.8.0 ほか） | 機能 | [temp-table](internal/ksql_batch_temp_table_spec.md) / [plugin-dml](internal/ksql_plugin_dml_batch_spec.md) / [dml-read-limit](internal/ksql_mcp_dml_source_read_limit_issue.md) |

---

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| UPSERT 変更行スキップ `ONLY CHANGED` | ⏸ 保留 | 差分型では効果がリラン時の監査情報保護に限定・実装コスト重（既存値読み取り戦略/型別正規化/64 文字キー問題）。エラー行隔離（B12）の検証エンジンが先・需要立証後に再評価 | [spec](internal/ksql_only_changed_upsert_spec.md) |
| 実行ログ自動記録 / 更新前スナップショット退避 / チャンク実行・レジューム | ⏸ 保留 | ログは `@batch_id`＋現行 INSERT で運用可・スナップショットは `#before` レシピで代替・チャンクは適用限界の外（数十万件級は連携方式見直しが先）。バッチ強化 [roadmap](internal/ksql_batch_processing_roadmap.md) | [roadmap](internal/ksql_batch_processing_roadmap.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](internal/multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](internal/ksql_batch_temp_table_spec.md) |

---

## 関連文書

- **横断仕様（正・single source of truth）**
  - **文字列の扱い**（文字数の定義・サロゲートペア・比較順序・ホスト依存）: [`ksql_string_semantics.md`](internal/ksql_string_semantics.md) — **個別文書は事実を書き写さず本書を参照する**
- リリース履歴の一次情報: [`CHANGELOG.md`](../CHANGELOG.md)
- 主要 RDB（MySQL/Oracle/SQL Server）との機能比較・欠落機能の効果評価: [`ksql_sql_feature_comparison_evaluation.md`](internal/ksql_sql_feature_comparison_evaluation.md)
- 言語仕様: [`ksql_language_reference.md`](ksql_language_reference.md)
- バッチ実務レシピ: [`ksql_batch_recipes.md`](ksql_batch_recipes.md)
- リリース手順: auto-memory `release-procedure.md`
