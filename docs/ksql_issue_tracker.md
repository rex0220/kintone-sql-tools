# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-08-01
- 現在の最新リリース: **v3.36.0**（2026-07-31・npm publish 済み）。→ [リリース履歴](ksql_release_history.md)
- 次回リリース計画: **未定（未リリースの変更なし）**。残る課題はいずれも優先 低 か実需待ち（§1）。クローズ済みは §3。
- 目的: 課題・改善案・Issue の**進捗 / 効果 / リリースバージョン**を1か所で俯瞰する。個別の詳細は各文書へリンク。

## 運用ルール

- **本書は一覧（インデックス）**。仕様・診断・受入条件などの本文は各文書に置く。
- 各文書の先頭 `- ステータス:` 行が正（single source of truth）。本書はそれを集約する。
- **複数の課題にまたがる意味論は「横断仕様」を正とし、個別文書はそれを参照する**（事実を書き写さない）。現在: [文字列の扱い](internal/ksql_string_semantics.md)。実測で覆ったら**まず横断仕様を直し**、個別文書はそれに従う。
- 状態が変わったら **本書・各文書のステータス行・`CHANGELOG.md`・auto-memory** を揃えて更新する。
- リリース時は [`ksql_release_history.md`](ksql_release_history.md) へ版数・効果を1行追記し、「§1 バックログ」から該当行を落とす（本書 §2 の直近5版も更新する）。
- **本書は前向きの文書。**「現在の最新リリース」「次回リリース計画」「§1 バックログ」に**リリース済みの経緯を書かない**。済んだ決定は履歴側へ移す（過去にヘッダ1行が 978 字まで肥大した）。

## 凡例（状態区分）

| 記号 | 意味 |
|---|---|
| ✅ | リリース済み |
| 🚧 | 実装済み・リリース/実機確認待ち |
| 📋 | 仕様確定・実装待ち |
| 📝 | ドラフト / 評価 / 提案（仕様前 or 判断待ち） |
| ⏸ | 保留（対象外化の判断済み） |
| ❌ | クローズ（実装しない。実需が出たら再起票） |
| 🐞 | 残課題（未着手のバグ） |

効果の種別: **正しさ**（結果の整合・バグ修正） / **性能**（API 消費・速度） / **機能**（新機能） / **安全性**（誤操作・データ破損防止）

---

## 1. バックログ（未リリース・要対応）

進捗が動くのはここ。**優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」**で暫定。**リリース済みの経緯は書かない**（版ごとの内容と決定理由は [リリース履歴](ksql_release_history.md)）。状態が変わった行はここから落とし、履歴へ1行追記する。

**リリース済みの 12 件は [課題台帳アーカイブ](ksql_issue_archive.md) へ移した**（2026-07-29）。
内容は削っていない。版ごとの決定理由は [リリース履歴](ksql_release_history.md) を参照。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B108 | インライン `EXPLAIN` 文が論理アプリの内部 mapped ID を表示する | 改善 | 📝 **調査完了（優先 低・修正 小〜中）**（2026-08-01・実測）。**B107 の回帰ではない**（ASCII 名でも同じ＝v1.13.x 以来の既存ギャップ）。**インライン `EXPLAIN` 文（`ksql -e`）は `app: APP900000000` と内部仮想 ID のまま**だが、**`--dry-run` は `LAPP_検証アプリ@dev` と正しく復元**される（実測）。**リファレンス §1「EXPLAIN と利用者向け診断は…内部 mapped ID は表示しない」との契約違反**。原因＝`restoreSqlDiagnosticValue` の配線が `--dry-run`（`cli/index.ts:2387`）と `buildBatchExplainPlans`（`:2238`）だけで、**通常実行の EXPLAIN 結果の経路に無い**。修正は同じ復元の配線だけに見える（要確認）。**未確認＝MCP の `ksql_explain` が復元されるか**（`tools.ts` は import 済みで配線済みの可能性が高い）。**優先 低**＝誤った結果ではなく診断表示の契約違反で、`--dry-run` という正しい代替がある。**ただし B107 で日本語論理名の利用者が増えると露出しやすい**。**【調査 2026-08-01】穴は「文として書いた EXPLAIN」に共通の 4 経路**＝CLI 単文・CLI バッチ・**MCP `ksql_query` 単文・同バッチ**（後者 2 つは dist-mcp＋一時 config で実測）。**専用経路（`--dry-run`・`ksql_explain`）は正しい**。**露出側を固定する既存テストは無く**、復元済みを固定するテストは複数（修正の方向と一致）。**設計注意 2 点**＝①EXPLAIN の実行結果は `result.type` が SELECT で返るため**文の型で復元対象を選ぶ**②restore は全体を文字列置換で歩くため**データ行へ掛けず EXPLAIN 計画出力に限定**（利用者データの偶然一致を書き換えないため）。**縫い目は 3 箇所・修正 小〜中**。 | 改善 | 低 | [B108](internal/ksql_b108_inline_explain_mapped_id_issue.md) |
| B107 | `LAPP_<NAME>` をブラウザ向け公開 API（`runQuery` / `runBatch`）でも解決する | 改善 | ✅ **実装済み（未リリース）**（2026-08-01・実機確認済み・[実装仕様](internal/ksql_b107_lapp_spec.md)）。依頼＝`logicalApps: Record<string, number>` の受け口。狙いは設定ファイルの環境非依存化。**【測定】解決機構は `src/node/appProfiles.ts` の前処理**＝**字句認識つきテキスト書き換え**（文字列・バッククォート・コメントを読み飛ばす）で core パーサは `LAPP_` を知らない。**Pro の懸念 3 点（文字列内誤置換・表示の食い違い・字句規則の二重管理）はエンジンの機構がすべて解決済み**＝依頼の筋は良い。診断は**併記**（`LAPP_ORDERS -> APP1234@prod`）・未定義名は**名前入り `ArgumentError`**。**【前提が覆った】論理名は ASCII 限定**（`[A-Z][A-Z0-9_]{0,63}`・大小無視）で、**依頼文の例 `LAPP_案件管理` は現行構文で PARSE_ERROR**（実測。`案` が名前開始文字でない）。**【Pro 回答 2026-08-01】日本語名を希望・破壊的変更を受け入れ**〔理由＝**論理名は「読み手全員が見る名前」**でバッチ変数（書いた本人だけの内部名）と役割が違う／設定 UI に「アプリ名をそのまま論理名に」ボタンを置く想定／**出荷 SQL 資産に `LAPP_`＋日本語のフィールド参照は無いことを機械的に確認済み**〕。→ **方向＝案 A＋B（受け口＋日本語構文拡張・全面同時）**。**設計判断の案は [B107 §7.1](internal/ksql_b107_lapp_engine_library_issue.md)**〔文字集合＝識別子の日本語 4 範囲＋ASCII（**半角 `$` は含めない**＝識別子集合に入っており流用するとサブテーブル区切り `LAPP_X$明細` を飲み込む）／**両側 NFC**（NFD 濁点 U+3099 が識別子範囲内にあり、正規化しないと「見た目同じなのに未定義」・実測）／**大小無視は `toUpperCase()` のまま＝ASCII＋全角英字のみ**（`ａ`→`Ａ` 実測）／64 UTF-16 ユニット上限維持／**4 重定義（スキャナ・config・MCP zod・リファレンス）の単一ソース化が前提条件**／**B86・B89 と同じ移行案内つき minor**〕。**【実装・実機確認済み】受入 1〜15 充足・全ゲート green**（204 suites / 5,100 tests・snapshot 22 不変）。**codex の停止 1 回**＝`config.test.ts` の `注文`（旧 ASCII 限定の決定記録）で、**「既存テストの書き換え＝決定を覆す合図」のルールが初めて本物の合図として働いた**（B107 はまさにその決定をオーナー Go・Pro 合意で覆す変更のため許可。`_ORDERS`・`ORDER-NOW`・65 units は不正のまま）。**【実機】**engine-library の `runQuery` が ASCII 名・日本語名・**NFD で書いた SQL** のいずれも APP4227 を解決（COUNT=3）／**未定義名・`@profile` は API 0 回で名前入りエラー**／`LAPP_` 無し SQL はオプション有無で同一／バッククォート退避はフィールドとして kintone 到達／CLI は日本語 config キーで解決し `--dry-run` 診断が `LAPP_検証アプリ@dev` と併記。**【検証中に確認した既存事項】**①同一物理 ID への複数論理名は拒否（v1.13 既存仕様）②**インライン `EXPLAIN` 文が mapped ID を復元しない既存ギャップ**（ASCII でも同じ）→ [B108](internal/ksql_b108_inline_explain_mapped_id_issue.md) として起票。 | 改善 | 中 | [B107](internal/ksql_b107_lapp_engine_library_issue.md) |
| B100 | 完全入力エラーの語順 — 対処が最後の 5 文目にあり、小さい表示領域で読めない | 改善 | 📝 **評価（優先 低）**（2026-07-29）＝[Pro の報告 v3.34.0 §3](../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの報告-v3340.md)。**Pro は「現状のままで結構です」と明記**しているが、**測ると射程が B98 より広かった**ため起票。**【実測】完全入力を理由に止まる 9 つの形すべてが 5 文で、対処は 5 文目**（`AGGREGATE` 137 字・対処 101 字目 〜 `OUTER_JOIN_NON_PRESERVED` 163 字・対処 127 字目）。**Pro のペインは高さ 3 行程度で先頭 1〜2 文しか見えず、その範囲に対処が入らない**。**内部識別子（`complete input reason: AGGREGATE` 等）の露出も 9 形すべて**で、**B98 で始まったものではない**。**B98 が最長なのは `OUTER_JOIN_NON_PRESERVED` が最長の識別子でアプリ番号も付くため**。文面は 3 箇所（`completeInputErrorPrefix`／`throwCompleteInputError`／`FetchAllLimitError` 本文）の連結で、**語順を変えると `message` の先頭が全形で変わる**。**案 A 語順入れ替え（④⑤①②③）／案 B 識別子だけ末尾（効果が小さい）／案 C 何もしない／案 D `FetchAllLimitError` へ `reasons`・`maxRecords`・`appIds` を任意プロパティで純加法追加（[B95](internal/ksql_b95_truncation_visibility_issue.md) と同じ形）**。**見立て＝案 D + 案 A が素直だが優先度は低い**〔誤った結果を返す問題ではない（止まるべきときに止まっている）／Pro は対応不要と明言／`FetchAllLimitError` という型で判定でき表示は利用者側で吸収できる〕。**次に開くとき必要なもの＝`message` の先頭を照合しているテスト・smoke の実数**（案 A の費用がこれで決まる）。（2026-07-29・Pro の報告から起票） | 改善 | 低 | [B100](internal/ksql_b100_failclosed_message_order_issue.md) |
| B61 | AI 行動検証シナリオセットの運用化（B60 継続） | 改善 | 📝 **評価・継続運用**。機械 guard は「カタログが正しい」まで、「AI が正しく読めるか」は行動検証でしか分からない非対称への対策（文型×依頼のシナリオ台帳）。**残＝スクリプト半自動化・Desktop 面・失敗観測→台帳追加ループの運用化**（小粒・継続タスク） | 機能 | 中 | [B61 issue](internal/ksql_b61_ai_behavior_scenario_set_issue.md) |
| B53 | `WITH RECURSIVE` / `CYCLE` 句（再帰 CTE） | 改善 | 📝 **方向確定（2026-07-23）＝B40 と二者択一で B53 採用**（BOM 多段展開が B53 Phase1 で完結・B40 は可変長 Phase2 が別途必要）。SQL:1999 `WITH RECURSIVE`＋SQL:2016 `CYCLE`。単一再帰 CTE＋必須境界＋CYCLE 最小形・戦略 B（アプリ1回実体化＋メモリ反復）。**仕様 R2・Claude レビュー済＝実装着手可能水準で凍結・実需待ちで棚上げ**（R1→codex→レビュー→R2 で指摘4件反映済み・§13・§5.3 規模目安あり）。**実装着手は BOM/循環の具体ユースケース確認後**（見積り 18〜29 人日の大型投資・B40 と同じく資産化） | 機能 | 中 | [B53 spec R2](internal/ksql_b53_recursive_cte_cycle_phase1_spec.md) / [eval](internal/ksql_b53_recursive_cte_cycle_evaluation.md) |
| B54 | User API（ユーザー・組織・グループ情報）対応 | 改善 | 📝 **評価**。cybozu.com 共通 [User API](https://cybozu.dev/ja/common/docs/user-api/)（`/v1/`・users/orgs/groups）を `__USERS__`/`__ORGS__`/`__GROUPS__` の read-only 仮想テーブルで SELECT/JOIN 可能に。組織階層（`parentCode`）は B53 と相乗。論点＝別ベースパス `/v1/`・権限・ページング・結合キー（code）。**次＝実需確認・権限/面の実機確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B54 eval](internal/ksql_b54_user_api_directory_evaluation.md) |
| B63 | プラグイン面での SQL 構文・関数の説明表示 | 改善 | 📝 **評価・方向判断**。プラグインの SQL 入力画面から構文骨格・関数・方言差をその場参照（B55/B60 の人手書き面版）。既存の機械同期済みカタログ（B60 骨格＋B55 関数＋言語リファレンス）を再利用し二重管理しない。論点＝表示範囲/供給方式/UI 形態。**次＝実需・UI 方針確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B63 eval](internal/ksql_b63_plugin_syntax_help_evaluation.md) |

---

## 2. リリース済み履歴（版数・効果）

**全 65 版の履歴は [`ksql_release_history.md`](ksql_release_history.md) へ分割した**（2026-07-27）。
本書が 102KB まで肥大し、進行中の課題を見るのに履歴を毎回読む状態だったため。

直近5版のみ再掲する。**経緯・撤回した案・失敗の記録は履歴側にある。**

| バージョン | 内容 |
|---|---|
| **v3.36.0** | B105 `UNION` の枝と定数列の `COUNT(*)` を単発 GET に／B103 行末の LF 固定／文書 3 件 |
| **v3.35.0** | B102 `PRIMARY_ORGANIZATION()` のサポート（DML は fail-closed・SELECT は kintone の挙動へ素通し） |
| **v3.34.1** | B101 MCP の `instructions` 1 行目に版数（常駐プロセスの版ずれ検証事故の再発防止） |
| **v3.34.0** | B98 外部結合の保持されない側の打ち切りを fail-closed 化／B99 MCP SDK v2 へ移行（**MCP のみ Node 20 必須**） |
| **v3.33.0** | B97 打ち切られた入力の集計を fail-closed 化／B96 `getRecords()` の応答契約 |

リリース時は**履歴側へ1行追記**し、本書 §1 から該当行を落とす。ここの直近5版も合わせて更新する。

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| UPSERT 変更行スキップ `ONLY CHANGED` | ⏸ 保留 | 差分型では効果がリラン時の監査情報保護に限定・実装コスト重（既存値読み取り戦略/型別正規化/64 文字キー問題）。エラー行隔離（B12）の検証エンジンが先・需要立証後に再評価 | [spec](internal/ksql_only_changed_upsert_spec.md) |
| 実行ログ自動記録 / 更新前スナップショット退避 / チャンク実行・レジューム | ⏸ 保留 | ログは `@batch_id`＋現行 INSERT で運用可・スナップショットは `#before` レシピで代替・チャンクは適用限界の外（数十万件級は連携方式見直しが先）。バッチ強化 [roadmap](internal/ksql_batch_processing_roadmap.md) | [roadmap](internal/ksql_batch_processing_roadmap.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](internal/multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](internal/ksql_batch_temp_table_spec.md) |
| B4 保存クエリのパラメータ化 `:name` | ❌ クローズ（実装しない・2026-07-29） | 中核価値「外部から動的値を安全注入」は `@var`（DECLARE 外部注入）が既に提供済みで、**Pro が実際に採用し「変数コントロールバーの課題はエンジンへの依頼が不要になった」と報告**（2026-07-29）。残る固有価値は「カタログ永続化＋保存クエリでの利用」だけで、それも「保存クエリの単文制約を緩めて DECLARE+SELECT バッチ＋既存 @var」の軽量路線の方が安い。仕様 R2 は流用可能な水準だが、**判断材料は出そろっており寝かせても情報は増えない**ため閉じる。実需が出たら再起票する。 | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
| B91 MCP のプラグイン互換モード（環境変数） | ❌ クローズ（Pro が取り下げ・2026-07-29） | **Pro が SQL 資産 83 本を機械的に監査し、該当 0 本**〔`IMPORT` 0／DML の `VALIDATE ONLY` 0／`EXPLAIN <DML>` 0／書き込む DML 0〕。**構造的に踏みにくい**＝5 形はすべて「書き込みを伴う作業の下準備」で、**ダッシュボードのペインは画面に表示するためのもの**（Pro 談）。データ品質ペインも**先頭 `VALIDATE APPn`**（両方が受理）で書けている。**決め手は「互換モードが純加法にならない」**＝MCP の `VALIDATE ONLY` を取り上げることになる。Pro は「純粋な絞り込みだと思っていたが、MCP の中核機能を削ることだった」と。**再提起の条件**＝AI が書いた SQL がペインで動かなかった実例が出たら。**そのときはモードではなく `ksql_validate` のフラグ**（Pro 談）。Pro は監査を機械的に回せる形にし、SQL 資産が増えたら定期的に測り直すとのこと。**【申し送り】案 D を実装する場合の穴**（Pro §2.1・要望ではなく参考）＝**`ksql_validate` を呼ばずに `ksql_query` を直接叩く経路が残る**。「渡し忘れ」が「呼び忘れ」に形を変えるだけなので、**同じフィールドを `ksql_query` / `ksql_explain` の応答にも載せる**必要がある。 | [B91 issue](internal/ksql_b91_mcp_plugin_compat_mode_issue.md) / [確認文](internal/ksql_pro_inquiry_b91_20260729.md) |
| B73 エンジンエラーの構造化情報公開 / 多言語対応 | ❌ クローズ（Pro が対応不要と回答・2026-07-29 オーナー判断） | **要望元の Pro が対応不要と回答**（2026-07-27）＝エンジンのメッセージを**翻訳せず `[CODE] メッセージ` でそのまま表示**する方針で、**日英混在は仕様として受容**。**位置・トークンも `messageKey`＋`params` も多言語化も不要**。**他所からの実需も出ていない**ため、**保留のまま置かずクローズする**。**【クローズしても残る契約】エラー `code` の値と意味を変えないこと**＝**Pro はエラー種別をメッセージ本文ではなく `code` で判定している**〔`PARSE_ERROR`／`READ_ONLY_VIOLATION`→構文エラー表示、`SEARCH_ABORTED`／`FETCH_LIMIT_EXCEEDED`→取得上限表示、`CLIENT_ERROR`／`EXECUTION_ERROR`→メッセージで細分化〕。**v3.27.0 の B80 で `code` を `PARSE_ERROR` のまま保った配慮が実際に有効だった**と Pro が明記しており、**B68 でも `code` 維持を受入条件に入れて実装済み**。**再起票する場合も、既存 `code` の値と意味は変えないこと。** | [eval](internal/ksql_b73_error_structured_i18n_evaluation.md) |
| B104 言語リファレンスの構文ブロックと文型テンプレートの乖離が検知されない | ❌ クローズ（何もしない・2026-07-30 オーナー判断） | **測った結果、検査が守る対象が小さかった**。**実在した乖離は SELECT 基本構文の `KORDER BY` 1 件だけ**（修正済み・commit `5b3b9c0`）で、**それも人が読んで見つかった**。**テンプレートの節キーワードをリファレンスへ機械照合すると 7 件が「無い」と出るが、すべて誤検知**〔`[JOIN句]` のような**意図的な略記**／`CHECK WHEN` 5 箇所・`ON DUPLICATE` 16 箇所・`APPLY` 11 箇所・`VALIDATE ONLY` 23 箇所は**専用節に存在**〕。**使える検査にするには略記の許可リストとリファレンス側マーカーの設計・保守が要る**。**[B84] の押し下げ表は「実装から導ける事実」なので生成が効いたが、構文の要約は「何を強調するか」の判断を含むため同じ手が効きにくい**。**再起票の条件＝2 件目の乖離の実例**。そのときは §4 の案 A（基本構文ブロックを指定して照合）の費用を払う根拠になる。 | [B104](internal/ksql_b104_syntax_block_drift_issue.md) |
| B106 テストスイートの監査（無駄・重複・意味のないテストの整理） | ❌ クローズ（整理しない・2026-07-31 オーナー判断） | **測った結果、消してよいものが実質ゼロ**。**【内訳】jest の 5,052 件のうち書かれた `test()` は 2,376 個**で、**差分約 2,600 件は `test.each` のパラメータ行の展開**（132 ファイル）＝**数字自体が実態より大きく見えている**。**【定番の無駄】`skip`/`only`/dead 0・同一ファイル内の同名重複 0・跨ぎ同名 4（層が違う別契約）**。**【規模】テスト 56,097 行 : 実装 47,963 行 = 1.17 倍・増加は 5 リリースで +64 記述・B 番号付き 66/201 ファイルは決定の記録**。**【実行時間】`npm test` 壁時計 約 50 秒＋e2e 19 秒。重い suite は①`evalFunc.surrogate`（総当たり性質検査・2 位の約 2 倍）②MCP 統合系（実サーバー接続）③エンジン統合系**で、**無駄に重いものは無い**（順位は 3 回の計測で安定・絶対値は計測汚染あり）。**【判断】整理で得るのは数字だけで、失うのは決定の記録**（この repo ではテストが仕様書を兼ねる）。**実行時間も削除では縮まず**、surrogate の分割は「網羅が常時走る」保証を失うので勧めない。**再起票の条件＝①`npm test` が数分に達したとき②本物の重複の実例が出たとき③mutation 監査に費用を払う判断をしたとき**。 | [B106](internal/ksql_b106_test_suite_audit_issue.md) |
| B40 グラフデータモデル（SQL/PGQ・プロパティグラフ／`MATCH`） | ⏸ 保留（B53 と二者択一で B53 採用・2026-07-23） | **B53（再帰 CTE）と同用途（到達可能性・循環検出・可変長経路）の別アプローチで、両方は過剰＝方向判断で B53 を採用**。決め手＝本命の BOM 多段展開が **B53 Phase1 で完結**するのに対し、B40 は **Phase1 が固定長のみで BOM 展開は可変長 Phase2 が別途必要**（19〜31 人日の Phase1 に上積み）・`CREATE PROPERTY GRAPH` 定義の前準備も要る。B40 が B53 を上回るのは「複数エッジ種別を跨ぐパターン照会・途中ノード条件付き経路検索」まで欲しいときだが、実需は探索的で未確認。**BOM 超のグラフ照会需要が具体化したら再評価**（Phase1 仕様 R1・codex レビュー済の資産は流用可） | [B40 eval](internal/ksql_property_graph_evaluation.md) / [Phase1 spec](internal/ksql_property_graph_phase1_spec.md) |
| B65-P2 B65 Phase2 残（#6 CTE/temp 実体化列・#3 式 grouping item・#7 window 併用・#4 GROUPING_ID） | ⏸ 保留（代替策あり・実需待ち・2026-07-23） | コア4件（#1 CUBE / #2 HAVING GROUPING / #5 SELECT DISTINCT / #8 static validate）は v3.18.0 で出荷済み。残4件は**新しい集計能力でなく書き方の直接性のみ**で、いずれも代替策がある＝**#4 は Phase1 の単一引数 `GROUPING()` を複数並べれば level 判別可・#7 の順位は「B65 body を CTE に materialize → 外側で既存 `RANK()`」の2段形で等価（累計 `SUM() OVER()` は B65 でなく window 側の別テーマ）・#3 は #6 の下位互換**。唯一純 kSQL で書けない**#6（正規化/計算済み列を集計軸に）も kintone 計算フィールド追加で迂回可**。実需が出るなら **#6 が起点**。着手前に @既存代替との差分で再評価 | [B65 Phase2 eval](internal/ksql_b65_phase2_evaluation.md) |
| B6 KLIKE 外部結合 非 nullable 側の押し下げ解禁 | ⏸ 却下（代替策あり・2026-07-21） | **回避策で用途を安全にカバーできるため却下**。外部結合の非 nullable 側で KLIKE を高速化したい場合は「**KLIKE で一時テーブル/CTE を作ってから JOIN**」で等価に実現できる（KLIKE は JOIN なしの単純 SELECT で押し下げ・実体化集合を LEFT JOIN・v3.11.0 の B51 修正で CTE 版も可・実データ確認済み）。専用実装（非 nullable 側判定に結合順/来歴解析が必要・誤ると P0 誤結果再導入）はリスクに見合わず、実需も未確認。詳細と回避策は v2 spec §2.6 | [v2 spec §2.6](internal/ksql_klike_pushdown_v2_spec.md) |

---

## 関連文書

- **横断仕様（正・single source of truth）**
  - **文字列の扱い**（文字数の定義・サロゲートペア・比較順序・ホスト依存）: [`ksql_string_semantics.md`](internal/ksql_string_semantics.md) — **個別文書は事実を書き写さず本書を参照する**
- **リリース済み履歴（全版・経緯つき）**: [`ksql_release_history.md`](ksql_release_history.md)
- リリース履歴の一次情報: [`CHANGELOG.md`](../CHANGELOG.md)
- 主要 RDB（MySQL/Oracle/SQL Server）との機能比較・欠落機能の効果評価: [`ksql_sql_feature_comparison_evaluation.md`](internal/ksql_sql_feature_comparison_evaluation.md)
- 言語仕様: [`ksql_language_reference.md`](ksql_language_reference.md)
- バッチ実務レシピ: [`ksql_batch_recipes.md`](ksql_batch_recipes.md)
- リリース手順: auto-memory `release-procedure.md`
