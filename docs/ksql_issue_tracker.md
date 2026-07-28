# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-29
- 現在の最新リリース: **v3.31.1**（2026-07-29・npm latest 3.31.1）。**v3.31.0 は当日に回帰が判明したため単独では使わない**（B92 で修正）。→ [リリース履歴](ksql_release_history.md)
- 次回リリース計画: **B93・B94 実装済み（未リリース）＝minor 相当**。**B94 は Pro が報告した「10,228 件が 10000 と表示される」症状の一部を既に解消する**（`COUNT(*)` に `maxRecords` を適用しないため）。着手候補は **B95 案 A**（0.5〜0.75 人日）。**B91** は M6 待ち。
- **Pro（ksql-dashboard-pro）**: v3.31.1 の検証完了（依頼①②とも動作・§4§5 該当なし・CI 199 件通過）。回帰報告は取り下げ → **B93** で伝え方を改善。**新たに依頼④（取得上限の構造化フラグ）を受領 → B95 として起票**。**急ぎではない**（Pro 側は `onLimitReached: "error"` で解決済み）。**次は M6 の受け入れテスト結果待ち**。依頼③（B91）は再評価待ち。
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
| B61 | AI 行動検証シナリオセットの運用化（B60 継続） | 改善 | 📝 **評価・継続運用**。機械 guard は「カタログが正しい」まで、「AI が正しく読めるか」は行動検証でしか分からない非対称への対策（文型×依頼のシナリオ台帳）。**残＝スクリプト半自動化・Desktop 面・失敗観測→台帳追加ループの運用化**（小粒・継続タスク） | 機能 | 中 | [B61 issue](internal/ksql_b61_ai_behavior_scenario_set_issue.md) |
| B53 | `WITH RECURSIVE` / `CYCLE` 句（再帰 CTE） | 改善 | 📝 **方向確定（2026-07-23）＝B40 と二者択一で B53 採用**（BOM 多段展開が B53 Phase1 で完結・B40 は可変長 Phase2 が別途必要）。SQL:1999 `WITH RECURSIVE`＋SQL:2016 `CYCLE`。単一再帰 CTE＋必須境界＋CYCLE 最小形・戦略 B（アプリ1回実体化＋メモリ反復）。**仕様 R2・Claude レビュー済＝実装着手可能水準で凍結・実需待ちで棚上げ**（R1→codex→レビュー→R2 で指摘4件反映済み・§13・§5.3 規模目安あり）。**実装着手は BOM/循環の具体ユースケース確認後**（見積り 18〜29 人日の大型投資・B40 と同じく資産化） | 機能 | 中 | [B53 spec R2](internal/ksql_b53_recursive_cte_cycle_phase1_spec.md) / [eval](internal/ksql_b53_recursive_cte_cycle_evaluation.md) |
| B54 | User API（ユーザー・組織・グループ情報）対応 | 改善 | 📝 **評価**。cybozu.com 共通 [User API](https://cybozu.dev/ja/common/docs/user-api/)（`/v1/`・users/orgs/groups）を `__USERS__`/`__ORGS__`/`__GROUPS__` の read-only 仮想テーブルで SELECT/JOIN 可能に。組織階層（`parentCode`）は B53 と相乗。論点＝別ベースパス `/v1/`・権限・ページング・結合キー（code）。**次＝実需確認・権限/面の実機確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B54 eval](internal/ksql_b54_user_api_directory_evaluation.md) |
| B63 | プラグイン面での SQL 構文・関数の説明表示 | 改善 | 📝 **評価・方向判断**。プラグインの SQL 入力画面から構文骨格・関数・方言差をその場参照（B55/B60 の人手書き面版）。既存の機械同期済みカタログ（B60 骨格＋B55 関数＋言語リファレンス）を再利用し二重管理しない。論点＝表示範囲/供給方式/UI 形態。**次＝実需・UI 方針確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B63 eval](internal/ksql_b63_plugin_syntax_help_evaluation.md) |
| B73 | エンジンエラーの構造化情報公開 / 多言語対応 | 改善 | ⏸ **保留（Pro 都合ではクローズ可・2026-07-27 Pro 返信）**。**Pro は対応不要と回答**＝エンジンのメッセージを**翻訳せず `[CODE] メッセージ` の形式でそのまま表示**する方針で、日英混在は仕様として受容。**位置・トークンも `messageKey`＋`params` も不要**、多言語化の要望も無し。**ただし1点だけ契約要求あり＝エラー `code` の値と意味を変えないこと**〔Pro はエラー種別を**メッセージ本文ではなく `code` で判定**している。`PARSE_ERROR`/`READ_ONLY_VIOLATION`→構文エラー表示、`SEARCH_ABORTED`/`FETCH_LIMIT_EXCEEDED`→取得上限表示、`CLIENT_ERROR`/`EXECUTION_ERROR`→メッセージで細分化〕。**v3.27.0 の B80 で `code` を `PARSE_ERROR` のまま保った配慮がまさにこの点で有効だった**と明記されている。→ **今後 B73 を実装する場合も既存 `code` の値と意味を変えない**こと。**B68 でも `code` 維持を受入条件に入れて実装済み**。実需が他所から出るまで着手しない。 | 機能 | 中 | [B73 eval](internal/ksql_b73_error_structured_i18n_evaluation.md) |
| B91 | MCP にプラグイン互換モードを追加する（環境変数） | 改善 | 📝 **評価・起票（優先 低／Pro 側に代替あり・B89 の後）**（2026-07-29・Pro 依頼③＝継続）。環境変数（例 `KSQL_PLUGIN_MODE=1`）で ksql_validate / ksql_explain / ksql_query に runQuery と同じ許可リストを適用してほしい。**ツール引数ではなく環境変数を希望する理由＝引数だと AI が渡し忘れる**（`.mcp.json` に探索用と互換モード用の2エントリを登録して併存できる）。**Pro が優先度を下げた**＝**設定画面の構文チェックが `explainQuery`（プラグインの guard 経路）を通すため、CLI/MCP 専用構文はペインを開いた時点で既に弾かれる**。本件が埋めるのは**「AI が MCP で書いた SQL が設定画面を開くまで誤りと分からない」時間差だけ**で、誤った結果が出る類ではない。**B89 が実現すると本件の価値も上がる**（バッチが検証できれば互換モードでも同じ判定が返せる・Pro 談）ため**先に B89**。**検討事項3点**＝①環境変数という形（面ごとの許可集合を環境変数で切り替える前例が無い。プロファイルは既にツール引数）②**Pro が欲しいのが `runQuery` 相当か `runBatch` 相当か**（`runQuery` は行を返す文に限られる。**Pro は `runBatch` を採用済み**なので後者の可能性が高い）③MCP の許可集合が2通りになると **B68 の parity テストの対象も2通り**になる保守コスト。**未見積もり＝B89 完了後に再評価**。 | 改善 | 低 | [B91 issue](internal/ksql_b91_mcp_plugin_compat_mode_issue.md) |
| B93 | 未知フィールド型のエラーがエンジンの不具合に見える | 改善 | ✅ **実装済み（未リリース）**（2026-07-29・Pro の報告 §1）。**Pro が v3.31.1 の回帰として報告してきた事象が、Pro 側の自前クライアントの誤りだった**〔`getFields` へ `{code:"$id", fieldType:"__ID__"}` という擬似フィールドを注入し、B88 の未知型 fail-closed に当たっていた〕。**Pro は自力で切り分けて取り下げたが、こちらの伝え方に2つ問題があった**。**①エラーがエンジンの不具合に見える**＝接頭辞 `InternalError:` と「policy is not defined」という文言。このコードベースで `InternalError:` は**到達しないはずの不変条件が破れた＝エンジンのバグ**に使う接頭辞であり、**client 由来の入力に使うのは誤用**。**結果として Pro は回帰として報告し、双方が調査に時間を使った**。**フィールドコードも出ていなかった**（型だけではどれを直すか分からない）。**②`getFields` の契約が片側しか書かれていなかった**＝ライブラリ文書には「渡すもの」（制約メタデータ・B85 で追記）はあるが「渡してはいけないもの」が無い。**Pro は同じ種類の誤りを2回**している（B85＝落とした／本件＝足した）。Pro 自身が「**足りない項目だけを直して、余計に足している項目を見ていなかった**」と書いている。**修正＝接頭辞を `ArgumentError:` へ変え、フィールドコードと期待する契約を文面に含める**。文書には「渡す」「渡さない」を**表で対にして**書いた。**`code` は `EXECUTION_ERROR` のまま**＝[B73](internal/ksql_b73_error_structured_i18n_evaluation.md) で Pro が「エラー種別を code で判定する／既存の code の値と意味を変えない」ことを受入条件にしているため。**MCP/CLI の code は接頭辞由来だが、この経路は nodeKintoneClient が実際の kintone 型しか返さないため発生しない**（BYO client でのみ到達）。**独立検証＝修正前 2 件 fail → 修正後 15 件 pass**（旧実装へ戻して空回りしていないことを確認）。npm test 193 suites/4,944 green・snapshot 22 不変・公開面不変。SemVer=**patch**（エラー文面と文書のみ・挙動は不変）。 | 改善 | 中 | [B93 issue](internal/ksql_b93_getfields_contract_error_issue.md) |
| B94 | `SELECT COUNT(*)` が全件取得している（totalCount で 1 リクエスト化） | 性能 | ✅ **実装済み（未リリース）**（2026-07-29・オーナー指摘）。**実機確認**＝`EXPLAIN SELECT COUNT(*) FROM APP4147` は **FULL_SCAN・kintone query:(全件取得)・fields:$id**。**フィールドは `$id` に絞られているがレコードは全件取得**しており、数値1つを得るために `ceil(N/500)` 回の往復が発生する（10万件なら 200 回以上）。**kintone REST は 1 リクエストで返せる**＝[get-records](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/) の `totalCount` パラメーターで「query に一致するレコードの件数」がレスポンスに返る（公式文書で確認）。**部品は既にある**〔①`KintoneGetParams.totalCount` は**型に存在するが常に false** ②`nodeKintoneClient.getRecords` は **totalCount を送っていない** ③**`openCursor` はカーソル作成のレスポンスで既に totalCount を受け取っている**（`createKintoneCursorHandle(Number(created.totalCount), ...)`）〕＝**カーソル経路は総件数を最初から知っているのに全件読んでいる**。**適用条件は5つ全部**＝`SELECT COUNT(*)` のみ／GROUP BY・HAVING・DISTINCT なし／JOIN なし／FROM が物理アプリ／**WHERE が完全に押し下がる**。**5 が最重要**＝ksql は LIKE を JS 評価に統一しており（v2.0.0）client 側で絞る場合がある。そのとき totalCount は**絞る前の件数**なので**使うと誤った件数を返す**。**`COUNT(列)` は対象外**（空セルを除外する意味であり totalCount のレコード件数とは違う）。**KLIKE 押し下げ時の検索打ち切り（10万件）にも注意**＝totalCount が打ち切り後の値になるため、既存のヘッダー検出で**従来どおり fail-closed**にする（黙って小さい件数を返さない）。**案 A（推奨）＝`getRecords` へ totalCount を送る**（`limit 1` と併用で1リクエスト）。ただし `ReadonlyGetRecordsResult` へ `totalCount?` を足すため**公開型が変わる**（B66 snapshot が動く）。**BYO クライアントが返さない場合は全件取得へ落とす**＝B85/B93 の教訓（BYO は契約から外れる）から、**推測で 0 や undefined を件数にしない**。**案 B＝カーソルを作って totalCount だけ読みすぐ閉じる**（BYO の変更不要・2 リクエスト・カーソル枠を1つ消費）＝**案 A が使えない BYO 向けのフォールバック**。**3 段階（A → B → 現状維持）とも正しい件数を返す**設計にする。**効果**＝1万件で 20 回以上 → 1 回、10万件で 200 回以上 → 1 回。**ダッシュボードの KPI タイル（総件数）は典型用途**でペインの数だけ全件取得が走っている可能性がある。**最大の注意点＝押し下げ完全性の判定を新規に書かず既存の判定を再利用する**。誤ると B78/B79/B86 と同じ silent wrong result になり、**件数は検算されにくい**（利用者は返ってきた数を信じる）。1.25〜2.0 人日・SemVer=**minor（純加法）**。**【2026-07-29 追記】判定は新規に書く必要が無い**＝エンジンは既に「WHERE が完全に押し下がるか」を計算し**計画にも出している**〔`WHERE 商談フェーズ = '受注'`（DROP_DOWN の = は kintone が in/not in しか受けない）→ **reason に WHERE_RESIDUAL・kintone query:(全件取得)**／`WHERE 売上 > 100` → **マーカー無し・kintone query: 売上 > 100**〕。**該当は [classifyWhereCapability](../src/core/optimization/whereCapability.ts#L128) の [PredicateCapability](../src/core/optimization/whereCapability.ts#L15)** で、**`EXACT_PUSHDOWN` のときだけ totalCount が使える**（`SUPERSET_PREFILTER` はサーバーが広く返し client で絞るので使えない）。**同じ判定で分岐している前例が2つある**（canonicalOrderPlanner の `WHERE_NOT_EXACT`／joinPredicatePushdown の `unsafe()`）ので基準を新規に作らずに済む。**【重要】判定は実行時に確定する**＝計画に `pushdown candidate:（実行時の型・実在確認待ち）` と出るとおり、押し下げ可否はフィールドの型と実在を実行時に確認して決まる。**totalCount を使う判断も押し下げ確定後に行う**こと。計画時の見込みで決めると、**実行時に候補が外れた場合に誤った件数を返す**。**【2026-07-29 仕様確定】もう1つ実測で判明＝現状は `maxRecords` を超えると失敗する**〔`SELECT COUNT(*) FROM APP4147` maxRecords=5 → `FetchAllLimitError`〕。**MCP の既定 maxRecords は 500 なので、500 件を超えるアプリの件数は今日 MCP から取得できない**。**本修正は性能改善であると同時にこの不能を解消する**＝totalCount はレコードを取得しないので取得件数の上限を適用する理由が無い。**挙動の変更**（従来エラーだった形が成功する）だが**失われる正しい結果は無い**（エラーは件数ではない）。CHANGELOG に明記する。**案 B（カーソルで totalCount だけ読む）は今回作らない**＝2 リクエスト＋カーソル枠を消費し、案 A のフォールバックとして割に合わない。**案 A が使えなければ現状維持**の2段階に留める。**【実装 2026-07-29】codex が実装前に2回停止＋実装差分のレビューで1件**。**①打ち切りの扱いを R1→R2→R3 と二転**〔R1「従来どおり fail-closed」（確認せずに書いた）→ R2「今日と同じ警告」（**通常 SELECT は警告という一般論だけ確認し、集計の例外を見落とした**）→ R3「fail-closed」〕。**R2 の誤りは実装差分で発覚**＝codex が R2 を忠実に実装した結果、**B72 の fail-closed テストを警告期待へ書き換えていた**。[B72 §7.2](internal/ksql_b72_relative_date_fullscan_exact_spec.md) は「**既存契約を local 集計へ適用すると部分集計を成功結果として返し得る**」として `SearchAbortedError` を選び「緩和しない」と明記していた。**codex の最初の提案（この経路は fail-closed）が正しく、Claude が却下したのが誤り**だった。→ **仕様へ一般則を追加**＝「**既存テストを書き換える必要が出たら、それは既存の決定を覆している合図。止めて報告する**」（**以後 codex 自身が判定できる形**）。**②やり直し時の片付け漏れ**＝`git checkout -- src/` は**未追跡ファイルを消さない**ため R2 のテストと CHANGELOG が残り、codex が新ルールを適用して停止（**ルールが機能した証拠だが、原因は Claude の後片付け**）。→ ルールに「**対象は main にコミット済みのテスト。前回試行の未コミット生成物は含まない**」を補足（**そうしないとやり直しのたびに縛られる**）。**③Claude の仕様漏れを codex が補完**＝`src/ui/kintoneClient.ts`（**プラグイン面の client**）も同じインターフェースを実装しており配線が必要だった（仕様は node と browser の2つしか挙げていなかった）。**漏れていればプラグインだけ最適化が効かない**状態だった。**実装＝`searchAborted` を `totalCount` の妥当性より先に判定して停止**し、不正値は `null` を返して従来経路へフォールバック。**EXPLAIN に `REST execution: single GET` / `record limit: maxRecords/onLimitReached not applied` / `search abort: fail-closed` を表示**＝何が起きるか計画から読める。**独立検証＝修正前 10/26 fail → 修正後 26/26 pass**（最初「0 total」＝型が無くコンパイル不能だったため、**型と client は残して execute.ts だけ戻す**やり方に変えた。**コンパイルエラーは挙動の検証にならない**）。**main の既存テストの書き換えはゼロ**（B72 の fail-closed テストも無変更で pass）。**ゲートは Claude が自分で測定**＝194 suites/4,970 green（B93 時点 193/4,944 から **+1 suite/+26 tests**）・snapshot 22 不変・**公開面は `totalCount?` 2 件の純加法のみ**（6 values/26 types/12 properties は不変）・engine docs/bundle-guard・mcp:verify・version:check すべて green。 | 性能 | 中 | [B94 仕様](internal/ksql_b94_count_star_totalcount_spec.md) / [B94 issue](internal/ksql_b94_count_star_totalcount_issue.md) |
| B95 | 取得上限の打ち切りが結果から分からず、集計が誤った数を返す | 正しさ | 📝 **評価・起票（優先 中）**（2026-07-29・Pro 依頼④）。**Pro の症状＝実件数 10,228 のアプリで `SELECT COUNT(*)` が 10000 を返し、KPI カードに誤った数字が大きく表示された**（警告は出るが数字自体が誤り）。`onLimitReached: "error"` へ切り替えて解決済みだが、**`"truncate"` のまま「集計だけエラー・明細は行＋警告」に分けたい**のに**結果から打ち切りを判別できない**。**Pro の観察はすべてコードで確認できた**〔①判定はアプリ単位（fetchAll が取得ごとに `allRecords.length > maxRecords`）②`fetchedRows` は合算（client wrapper で `+= res.records.length`）③判別手段が文言しかない（`onTruncate` は**警告文字列を組み立てるだけ**）〕。**アプリ ID はその場で手に入る**＝`onTruncate` の引数は max だけだが、呼び出し側は `table.appId` を持つ。**深い配管は不要**。**【より重い問題】集計が誤った数を黙って返す**＝**`COUNT(*)` は「完全な入力」の強制対象に入っていない**（`STATISTICAL_AGGREGATES` は STDDEV/VAR/MEDIAN/MODE のみ）。**B94 が直すのは一部だけ**で、BYO フォールバック・JOIN・GROUP BY 等・CTE/一時表・**`SUM`/`AVG` など COUNT 以外**では打ち切られた入力を数える経路が残る。**前例＝[B72 §7.2](internal/ksql_b72_relative_date_fullscan_exact_spec.md)** が「部分集計を成功結果として返し得る」として fail-closed を選んでいる。**ただし違いがある**＝検索打ち切りは kintone 側の都合だが、**`truncate` は利用者が明示的に選んだもの**。**ここが判断の分かれ目**。**案 A＝`metrics.limitReachedApps?: readonly number[]` を純加法で追加**（Pro の要望そのもの・`code` を変えないので B73 の制約に触れない・浅い実装）。**ただし誤った数が返ることは直らない**。**案 B＝打ち切られた入力の集計を fail-closed**（根本的だが**挙動の変更**で、`truncate` を選んだ利用者の集計が失敗するようになる）。**案 C（推奨）＝まず A を出し、B は別途判断**〔A は純加法で誰も困らず Pro は今日すぐ使える／B は契約変更で Pro 以外にも影響し単独評価すべき／**B94 が既に一部を解消**しているので残り範囲を測ってから決める〕。**未確認＝`SUM`/`AVG` が打ち切られた入力でどう振る舞うか**（案 B を評価するならまずそこを実測する）。案 A 0.5〜0.75 人日・SemVer=minor（純加法）／案 B 評価のみ 0.25 人日。**Pro は急いでいない**。 | 正しさ | 中 | [B95 issue](internal/ksql_b95_truncation_visibility_issue.md) |

---

## 2. リリース済み履歴（版数・効果）

**全 65 版の履歴は [`ksql_release_history.md`](ksql_release_history.md) へ分割した**（2026-07-27）。
本書が 102KB まで肥大し、進行中の課題を見るのに履歴を毎回読む状態だったため。

直近5版のみ再掲する。**経緯・撤回した案・失敗の記録は履歴側にある。**

| バージョン | 内容 |
|---|---|
| **v3.31.1** | B92 EXPLAIN が変数の算術を拒否する回帰の修正（v3.31.0 当日に実機確認で発覚） |
| **v3.31.0** | B89 explainQuery のバッチ対応／B90 変数の直接算術／B87 キャッシュ／B88 0 行 `SELECT *`（**回帰あり・v3.31.1 を使う**） |
| **v3.30.0** | B86 実体化ソースの不存在列を fail-closed 化（**破壊的**）／B85 VALIDATE の検証範囲開示／B84 押し下げ可否の公開／B83 |
| **v3.29.0** | B68 engine ライブラリの read-only 拡張（`runBatch` / 単文 `VALIDATE` / parity 固定）／B81／B82 |
| **v3.28.0** | B76 Phase B — JOIN で server-only 15 関数（第5-W / 第5-L） |

リリース時は**履歴側へ1行追記**し、本書 §1 から該当行を落とす。ここの直近5版も合わせて更新する。

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| UPSERT 変更行スキップ `ONLY CHANGED` | ⏸ 保留 | 差分型では効果がリラン時の監査情報保護に限定・実装コスト重（既存値読み取り戦略/型別正規化/64 文字キー問題）。エラー行隔離（B12）の検証エンジンが先・需要立証後に再評価 | [spec](internal/ksql_only_changed_upsert_spec.md) |
| 実行ログ自動記録 / 更新前スナップショット退避 / チャンク実行・レジューム | ⏸ 保留 | ログは `@batch_id`＋現行 INSERT で運用可・スナップショットは `#before` レシピで代替・チャンクは適用限界の外（数十万件級は連携方式見直しが先）。バッチ強化 [roadmap](internal/ksql_batch_processing_roadmap.md) | [roadmap](internal/ksql_batch_processing_roadmap.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](internal/multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](internal/ksql_batch_temp_table_spec.md) |
| B4 保存クエリのパラメータ化 `:name` | ❌ クローズ（実装しない・2026-07-29） | 中核価値「外部から動的値を安全注入」は `@var`（DECLARE 外部注入）が既に提供済みで、**Pro が実際に採用し「変数コントロールバーの課題はエンジンへの依頼が不要になった」と報告**（2026-07-29）。残る固有価値は「カタログ永続化＋保存クエリでの利用」だけで、それも「保存クエリの単文制約を緩めて DECLARE+SELECT バッチ＋既存 @var」の軽量路線の方が安い。仕様 R2 は流用可能な水準だが、**判断材料は出そろっており寝かせても情報は増えない**ため閉じる。実需が出たら再起票する。 | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
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
