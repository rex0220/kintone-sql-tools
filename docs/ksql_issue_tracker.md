# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-28
- 現在の最新リリース: **v3.29.0（2026-07-28・npm latest 3.29.0）＝B68 engine ライブラリの read-only 拡張／B81／B82＝リリース完全完了**。**純加法**（既存 API の型も挙動も不変）。**実機確認は Pro（engine library 利用）側が本来の受入**。版ごとの内容と決定理由は [リリース履歴](ksql_release_history.md)。
- 次回リリース計画: **未定**。着手可能な候補は **B83**（MCP カタログの drift）/ **B84**（押し下げ可否の公開）で、いずれも **docs が実装と drift している**類。**どちらも生成方式にすれば再発しない**ため、手書きで急がず設計を検討する。他は実需待ち（B53 / B54 / B63）・継続運用（B61）・保留（B73）。
- **Pro（ksql-dashboard-pro）**: v3.29.0 連絡 → **返信受領（2026-07-28）**。**確認依頼①②はどちらも当方の回答が正しく、①は Pro 側が「入れ替わったという見立ては誤りだった」と認めた**（回避策 `>= 5000000`→`> 4999999` も実機で有効・取得半減）。**新たに確認依頼③＝B85 として起票**（ライブラリの `VALIDATE` が制約を検証できず黙って 0 件）。**Pro は `VALIDATE` を「データ品質チェック」ペインとして採用検討中**（Pro 課題 K-33）だが、**現状は用途を選択肢の妥当性チェックに限定せざるを得ない**と回答＝**B85 が採否を左右する**。`runBatch` は Pro のペインが `runQuery` 1文実行のため当面不使用（Phase 2 で検討・急ぎではない）。**押し下げ表の自動生成は B84 でリリース待ち**。Pro は「落ち度ではなく、あると助かる性質」と回答。**B73 は `code` 維持の受入条件を了承済み**。
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
| 🐞 | 残課題（未着手のバグ） |

効果の種別: **正しさ**（結果の整合・バグ修正） / **性能**（API 消費・速度） / **機能**（新機能） / **安全性**（誤操作・データ破損防止）

---

## 1. バックログ（未リリース・要対応）

進捗が動くのはここ。**優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」**で暫定。**リリース済みの経緯は書かない**（版ごとの内容と決定理由は [リリース履歴](ksql_release_history.md)）。状態が変わった行はここから落とし、履歴へ1行追記する。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B61 | AI 行動検証シナリオセットの運用化（B60 継続） | 改善 | 📝 **評価・継続運用**。機械 guard は「カタログが正しい」まで、「AI が正しく読めるか」は行動検証でしか分からない非対称への対策（文型×依頼のシナリオ台帳）。**残＝スクリプト半自動化・Desktop 面・失敗観測→台帳追加ループの運用化**（小粒・継続タスク） | 機能 | 中 | [B61 issue](internal/ksql_b61_ai_behavior_scenario_set_issue.md) |
| B53 | `WITH RECURSIVE` / `CYCLE` 句（再帰 CTE） | 改善 | 📝 **方向確定（2026-07-23）＝B40 と二者択一で B53 採用**（BOM 多段展開が B53 Phase1 で完結・B40 は可変長 Phase2 が別途必要）。SQL:1999 `WITH RECURSIVE`＋SQL:2016 `CYCLE`。単一再帰 CTE＋必須境界＋CYCLE 最小形・戦略 B（アプリ1回実体化＋メモリ反復）。**仕様 R2・Claude レビュー済＝実装着手可能水準で凍結・実需待ちで棚上げ**（R1→codex→レビュー→R2 で指摘4件反映済み・§13・§5.3 規模目安あり）。**実装着手は BOM/循環の具体ユースケース確認後**（見積り 18〜29 人日の大型投資・B40 と同じく資産化） | 機能 | 中 | [B53 spec R2](internal/ksql_b53_recursive_cte_cycle_phase1_spec.md) / [eval](internal/ksql_b53_recursive_cte_cycle_evaluation.md) |
| B54 | User API（ユーザー・組織・グループ情報）対応 | 改善 | 📝 **評価**。cybozu.com 共通 [User API](https://cybozu.dev/ja/common/docs/user-api/)（`/v1/`・users/orgs/groups）を `__USERS__`/`__ORGS__`/`__GROUPS__` の read-only 仮想テーブルで SELECT/JOIN 可能に。組織階層（`parentCode`）は B53 と相乗。論点＝別ベースパス `/v1/`・権限・ページング・結合キー（code）。**次＝実需確認・権限/面の実機確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B54 eval](internal/ksql_b54_user_api_directory_evaluation.md) |
| B63 | プラグイン面での SQL 構文・関数の説明表示 | 改善 | 📝 **評価・方向判断**。プラグインの SQL 入力画面から構文骨格・関数・方言差をその場参照（B55/B60 の人手書き面版）。既存の機械同期済みカタログ（B60 骨格＋B55 関数＋言語リファレンス）を再利用し二重管理しない。論点＝表示範囲/供給方式/UI 形態。**次＝実需・UI 方針確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B63 eval](internal/ksql_b63_plugin_syntax_help_evaluation.md) |
| B68 | kSQL read-only ライブラリの read-only 機能拡張（VALIDATE・一時テーブルバッチ） | 改善 | ✅ **リリース済み（v3.29.0・2026-07-28）**（2026-07-27・Step 1〜5 完了）。**Pro のダッシュボードが engine library を使っており、生成 AI が MCP で作った SQL を library が実行するため、両面の許可構文の差は「AI が検証して通した SQL が本番で落ちる」事故になっていた**。**実装＝①判定を `isReadOnlyStatement()` へ一本化**（独自 allowlist を廃止）**②単文 `VALIDATE` を解禁**し `QueryResult.validateStats?` を公開（純加法・非破壊）**③`runBatch()` を新設**（文単位で read-only 強制・`results[]` は `QueryResult` 再利用）**④一時テーブル上限を公開契約化**（既定 10,000 行・同時 16 表・truncate 指定でも error・利用者アプリのプロセス内実体化）＋`variables`（`DECLARE` のみ・`SET` 注入は拒否）**⑤失敗時は throw**（案 A・オーナー決定）〔レビューで**失敗バッチが `ok:false` のまま部分結果を返す**ことを実測し、B79 の「部分結果が黙ってアプリロジックへ流れ込むほうが危険」と衝突すると判明。`ok` を削除し `statementIndex`/`statementType` だけをエラーに載せる〕**⑥parity をテストで固定**〔型レベル網羅・例外3件（`IMPORT`/`APPLY`/DML `VALIDATE ONLY`＝いずれも書き込み前提）・**面の固定**〕。**レビューで契約の穴を3件・codex が実装前に3回停止**〔16表は同時数／例外リストと非スコープの矛盾／受入条件の訂正漏れ〕。**parity は破壊テストで空回りしていないことを確認**（`runQuery` からのみ外す破壊で面固定テストだけが落ちる）。npm test 186 suites/4,813 green・docs/pack/declaration/bundle-guard/mcp:verify green・**B82 guard も green**。SemVer=**minor（純加法）**。 | 機能 | 中 | [B68 計画](internal/ksql_b68_engine_library_readonly_impl_plan.md) / [B68 eval](internal/ksql_b68_engine_library_readonly_extensions_evaluation.md) |
| B73 | エンジンエラーの構造化情報公開 / 多言語対応 | 改善 | ⏸ **保留（Pro 都合ではクローズ可・2026-07-27 Pro 返信）**。**Pro は対応不要と回答**＝エンジンのメッセージを**翻訳せず `[CODE] メッセージ` の形式でそのまま表示**する方針で、日英混在は仕様として受容。**位置・トークンも `messageKey`＋`params` も不要**、多言語化の要望も無し。**ただし1点だけ契約要求あり＝エラー `code` の値と意味を変えないこと**〔Pro はエラー種別を**メッセージ本文ではなく `code` で判定**している。`PARSE_ERROR`/`READ_ONLY_VIOLATION`→構文エラー表示、`SEARCH_ABORTED`/`FETCH_LIMIT_EXCEEDED`→取得上限表示、`CLIENT_ERROR`/`EXECUTION_ERROR`→メッセージで細分化〕。**v3.27.0 の B80 で `code` を `PARSE_ERROR` のまま保った配慮がまさにこの点で有効だった**と明記されている。→ **今後 B73 を実装する場合も既存 `code` の値と意味を変えない**こと。**B68 でも `code` 維持を受入条件に入れて実装済み**。実需が他所から出るまで着手しない。 | 機能 | 中 | [B73 eval](internal/ksql_b73_error_structured_i18n_evaluation.md) |
| B81 | MCP instructions の語数予算が構造的に枯渇 | 改善 | ✅ **リリース済み（v3.29.0・2026-07-28）**（2026-07-27）。**語数予算を散文とカタログ列挙で分けて計上**するようにした（案 D）。実測 **total 548 = catalog 258 + prose 290**。起票時に「散文は P1〜P3 の 116 語」と見積もったのは誤りで、**P4/P5 の説明文も散文**のため実際は 290 語だった。閾値は **prose ≤ 320 / catalog ≤ 420 / total ≤ 700**、**exact 固定 `toEqual({total,catalog,prose})` は維持**（意図しない増減を fail-loud に）。`src/mcp/instructionsBudget.ts` を新設し、**カタログ由来の語数は文面ではなく元データ**（`KSQL_FUNCTION_CATALOG` / `STATEMENT_SYNTAX_CATALOG` / CHECKS / CONTROL）**から数える**。**破壊テストで肝心の性質を確認**＝関数を5個足すと catalog 258→263・**prose は 290 のまま**（旧ルールでは total 553 で上限 550 を突破していた）＝**機能追加が散文の予算を食わなくなった**。**【重要】上限値に外部根拠は無い（§7・実装後の調査）**＝MCP 仕様は instructions を "Optional instructions for the client" と書くだけで**サイズ規定なし**、SDK も `z.string().optional()` で**長さ制約なし**、**B60 の 500 も根拠が記録されていない**。実コストは毎セッション**約 1,000 トークン**（上限まで使っても増分 300〜400）で**無視できる水準**。**測る単位も目的に合っていない**〔文脈コストが関心事ならトークンで測るべき／指示追従の劣化が関心事なら 550 語に閾値がある根拠はない〕。→ **guard の位置づけを「予算」から「変化の検知」へ**＝**exact 固定を本体**とし（B62 502→525・B67 529→541・B76 552 の単調増加を実際に捕捉してきた実績がある）、**上限は「超えたら妥当性を再検討するトリガー」**として扱う（超過時に機械的に圧縮せず上限自体の妥当性を問う）。**トークン計測への置換は実需が出てから**（数字を作り直しても根拠の無さは変わらないため先回りしない）。 | 改善 | 中 | [B81 issue](internal/ksql_b81_mcp_instructions_word_budget_issue.md) |
| B82 | リリース時に公開文書の未リリース表記を検出 | 改善 | ✅ **リリース済み（v3.29.0・2026-07-28）**（2026-07-27）。**B70 §7 の残作業**。v3.25.0 で**リリース済みの B75/B77/B78 が言語リファレンスでは「Unreleased の破壊的変更」のまま出荷**された（2箇所）。version-sync-guard は**版数の一致**を見るもので**語の残存は守備範囲外**だった。**同種の事故は再発**〔v3.28.0 でも `release/README.txt` と `CHANGELOG.md` に「次回リリースの B76 Phase B で」という前方参照が残り、リリース作業中に人手で発見・修正。**「次回リリース」はそのリリースが出た瞬間に誤りになる**〕。**実装＝`version-sync-guard.mjs` に `--release` モード**〔対象 `docs/ksql_language_reference.md` / `release/README.txt`、検出語 `Unreleased`/`未リリース`/`次回リリース`、**`CHANGELOG.md` は開発中に見出しを持つのが正常なので対象外**、失敗時はファイル名・行番号・該当行を出力〕。**`npm test` は従来どおり**（未リリース機能の記述は正常なので開発を妨げない）、**`prepack` からのみ有効**。v3.25.0 と同じ取り残しを再現して**リリースモード exit 1 / 通常モード exit 0** を実測。**残る限界＝語の一致で見るため別の言い回しは捕まらない**ので、公開文書は版に依存しない表現で書く運用が本質。 | 改善 | 中 | [B82 issue](internal/ksql_b82_release_stale_marker_guard_issue.md) |
| B83 | MCP instructions の VALIDATE 診断列数が実態と違う | 改善 | ✅ **実装済み（未リリース）**（2026-07-28）。**起票時の診断を訂正＝「5 は古い数値」ではなく「2形の取り違え」**〔`VALIDATE ... INTO #err` は **9 列**、**`VALIDATE ... SUMMARY INTO #err` は 5 列**で、`src/core/batch.ts` が `stmt.summary` で切り替える。**実機で両方確認**〕。**tool description が SUMMARY 形の列数を唯一の形のように書いていた**（カタログのテンプレートには `[SUMMARY]` があり例も SUMMARY を使うため、AI が既定形を書くと食い違う）。**言語リファレンスは元から正しかった**（「詳細出力は固定9列」）＝**ずれは MCP 面に限定**で、起票時に「docs が実装と drift」と一般化したのは過大だった。**対応＝数を消さず両方書く**（`nine columns, or five with SUMMARY`）。AI には具体的な数のほうが有用で、2形あると分かれば取り違えない。**`UPSERT_SELECT` のカタログ例も追加**し、B68 parity の「カタログ例の穴」を閉じた（`missingFromCatalog` の期待値を `["UPSERT_SELECT"]`→`[]` へ＝**カタログが全 AST 文型を網羅**するより強い不変条件になった。**穴を塞いだら追跡テストが落ちる**という正しい働きも確認）。該当文は instructions ではなく tool description にあり **B81 の語数予算に影響なし**。npm test 186 suites/4,813 green。 | 改善 | 中 | [B83 issue](internal/ksql_b83_mcp_validate_columns_docs_issue.md) |
| B84 | どの述語が押し下がるかが公開ドキュメントに無い | 改善 | ✅ **実装済み（未リリース）**（2026-07-28）。**Pro からの質問2件がどちらも「押し下がるかどうかが公開文書に無い」ことに起因**した。**①JOIN 内の数値が押し下がらない**＝実機で切り分けた結果**演算子の違い**で意図した仕様〔`案件No >= 5` は JOIN で全件取得／`> 5`・`= 5`・`$id <= 3000` は押し下がる。根拠は Phase A spec §5.2「**IEEE-754 境界のため inclusive は不可**」で非スコープとしても列挙済み。**Pro の「v3.25 以前と入れ替わった」は誤解**で、旧抽出器 `isNumericCandidate` を確認したところ**Phase A 以前から一般 NUMBER は厳密のみ**、`$id` だけが5演算子〕。**②選択系の `=` が押し下がらない**＝**kintone のクエリ文法が `in`/`not in` のみ**なので `=` は表現できず押し下げようがない（公式表で確認済み）。**Pro が明示的に「言語リファレンスに明記いただけると助かります」と依頼**。**原因＝結果は常に正しいので気づく契機が無く、遅いだけで動いてしまう**〔Pro 実測で取得件数 3.6 倍差〕。**Pro は自前でレシピ集に実測表を作った＝利用者に実測させている状態**で、エンジン側が正を出すべき情報。**対応＝言語リファレンスに押し下げの節を新設**（現状は相対日付・KLIKE・JOIN の各節に分散し横断的に読めない）。**手書きすると B74/B83 と同じ drift を起こすため、Phase A matrix と `classifyJoinPushdownLeaf` から生成する案を優先検討**（B60 が statement templates と function catalog で採っている方式）。手書き 0.5 人日／生成 1〜1.5 人日。公開挙動の変更なし。**B68 Step 5 で言語リファレンスに触れるので同時なら追加コスト小**。**【2026-07-28 設計確定】方針＝案 B（テストで直積を分類器へ流し公開文書の表と照合）**。**着手前に実証済み**＝`classifyJoinPushdownLeaf` へ **20 型 × 8 演算子 = 160 通り**を流して **34ms で表が生成**でき、**生成結果が実挙動と 5/5 一致**（実 kintone・v3.29.0。`superset`/`exact` は押し下がり `unsafe` は全件取得）＝**表は嘘にならない**ことを確認。**案 A（分類器をデータ表へリファクタ）は却下**＝本番ロジックに触る必要があり、押し下げの安全性は過去に何度も事故った領域（v2.0.0 の `LIKE` 全廃）で docs のために触る理由がない。**最大の注意点＝表が説明するのは「JOIN・field vs literal」の1軸だけ**〔単一表は WHERE 全体の直列化で**型を問わず通る**別機構／**`$id` は型ではなく名前で判定される別経路**で全比較演算子が可（probe では `RECORD_NUMBER` 型が全て unsafe になるため、**表に混ぜると逆の結論を読ませる**）／server-only 関数と KLIKE も別軸〕。**Pro が「単一表では押し下がるのに JOIN では」と混乱したのはこの2機構の差**なので、**表の前にどの軸の話かを明示**する。**公開文書は 2 値（押し下がる/押し下がらない）で書く**〔`exact`/`superset` は内部の安全性区分で、**元の WHERE を client で再評価するため結果は同じ**。3値のまま出すと「superset だと結果が違うのか」という疑問を生む〕。**やらないこと＝`>=`/`<=` の押し下げ拡張**（B76 Phase A で IEEE-754 境界のため不可と判断済み・**本課題は可視化であって拡張ではない**）。**【実装】型集合は TypeScript AST で分類器2ファイルを走査**して導出（grep より堅い方式を codex が採用）＝`KSQL_` 派生型と擬似型を除外して **25 型**。言語リファレンスに **§WHERE の REST 押し下げ**を新設し、**軸を先に明示**（alias 付き物理 APP だけの INNER JOIN・field vs literal の単一条件）した上で **2 値**の表を掲載。**`$id` と `RECORD_NUMBER` の違いを理由つきで明記**（`$id` は正準なレコード ID と証明できるが JOIN 中の `RECORD_NUMBER` は別アプリ由来かもしれない＝**書かないと表が逆の結論を読ませる**）。**破壊テストで両方向を確認**〔分類器へ新しい型を足す→落ちる（表に無い行を差分表示）／公開文書の表を1セル書き換える→落ちる〕＝**受入 #7 が実際に働く**ことを実測。**本番コードは無変更**（分類器に一切触れていない）。**実装前に codex が1回停止**＝仕様が「実装から導け」と要求しながら **probe が手書き 19 型**で自己矛盾していた（実装は `LINK`/`RICH_TEXT`/`FILE`/`STATUS_ASSIGNEE`/`CATEGORY` も扱う）→ 型集合の規則を §3.1 として確定。npm test 187 suites/4,814 green・docs-smoke・mcp:verify green。 | 改善 | 中 | [B84 計画](internal/ksql_b84_pushdown_visibility_spec.md) / [B84 issue](internal/ksql_b84_pushdown_visibility_docs_issue.md) |
| B85 | ライブラリの VALIDATE が制約を検証できず黙って 0 件を返す | 正しさ | 📝 **評価・起票（優先 高／silent under-report・v3.29.0 で出荷済み）**（2026-07-28・Pro 返信の確認依頼③）。**同じ `VALIDATE` 文が MCP は 10 行/errorCount 12、ライブラリは 0 行/0** という食い違い（選択肢違反だけは一致）。**利用者は「エラーなし」と読む**＝打ち切りを hard error にし押し下げ不能を取得前エラーにしてきた **fail-closed の思想と一貫しない**（Pro 指摘）。**原因は Pro の推測（`ReadonlyFieldInfo` に渡す口が無い＝契約上の限界）とは違った**＝**実測でパイプラインは制約を素通ししている**〔`getFields` が `minLength/required` を返せば **2 件検出**、返さなければ 0 件〕。**真因＝型が宣言していないこと**（`optionOrder` だけ宣言され `minLength/maxLength/minValue/maxValue/required` が無い）。**TypeScript は余剰プロパティを拒否するので、自前クライアントの利用者は渡そうとしても止められる**。**さらに `createReadonlyKintoneClient` は実行時には制約を返している**（`flattenFormFieldProperties` が `KintoneFieldInfo` を返し、型だけ狭められている）＝**同関数の利用者は既に完全な検証ができる**。Pro は自前クライアントの可能性が高く、**メタデータ取得量も増えない**（同じ fields.json を既に取得）。**対応＝案 A（型へ制約を宣言・純加法）＋案 B（検証できない制約があるとき警告）**。**案 A だけでは足りない**＝自前クライアントが渡さなければ依然として黙って 0 件になる。**hard error にしない判断**＝選択肢検証という正しく動く用途を壊すため警告が妥当だが、**警告を見落とすと「0 件＝問題なし」と読む**ので `validateStats` へ検証範囲を示す案も検討。**案 C（docs）＝内訳は `COUNT(*)` ではなく `SUM($err_count)`**（サブテーブル違反が1行に複数エラーとしてまとまるため実測 10 行 vs errorCount 12 で食い違う）。**Pro の質問への回答＝parity テストは受理可否の担保であって結果の一致は対象外**（本課題はその隙間を突いた形で、parity の定義を見直す契機）。**B78（黙って 0 件）・B79（黙って誤った値）と同系列**。0.85〜1.35 人日・SemVer=minor。 | 正しさ | 高 | [B85 issue](internal/ksql_b85_library_validate_constraints_issue.md) |

---

## 2. リリース済み履歴（版数・効果）

**全 62 版の履歴は [`ksql_release_history.md`](ksql_release_history.md) へ分割した**（2026-07-27）。
本書が 102KB まで肥大し、進行中の課題を見るのに履歴を毎回読む状態だったため。

直近5版のみ再掲する。**経緯・撤回した案・失敗の記録は履歴側にある。**

| バージョン | 内容 |
|---|---|
| **v3.29.0** | B68 engine ライブラリの read-only 拡張（`runBatch` / 単文 `VALIDATE` / parity 固定）／B81／B82 |
| **v3.28.0** | B76 Phase B — JOIN で server-only 15 関数（第5-W / 第5-L） |
| **v3.27.0** | B79 外部結合の検索打ち切りを fail-closed ／ B80 engine ライブラリの reason 保持 |
| **v3.26.0** | B76 Phase A — JOIN 述語の APP 別 prefilter ／ B70 版数同期ガード |
| **v3.25.0** | B75 CTE 本体の相対日付 ／ B77 kintone 関数の fail-closed 統一 ／ B78 LOGINUSER |

リリース時は**履歴側へ1行追記**し、本書 §1 から該当行を落とす。ここの直近5版も合わせて更新する。

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| UPSERT 変更行スキップ `ONLY CHANGED` | ⏸ 保留 | 差分型では効果がリラン時の監査情報保護に限定・実装コスト重（既存値読み取り戦略/型別正規化/64 文字キー問題）。エラー行隔離（B12）の検証エンジンが先・需要立証後に再評価 | [spec](internal/ksql_only_changed_upsert_spec.md) |
| 実行ログ自動記録 / 更新前スナップショット退避 / チャンク実行・レジューム | ⏸ 保留 | ログは `@batch_id`＋現行 INSERT で運用可・スナップショットは `#before` レシピで代替・チャンクは適用限界の外（数十万件級は連携方式見直しが先）。バッチ強化 [roadmap](internal/ksql_batch_processing_roadmap.md) | [roadmap](internal/ksql_batch_processing_roadmap.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](internal/multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](internal/ksql_batch_temp_table_spec.md) |
| B4 保存クエリのパラメータ化 `:name` | ⏸ 保留（候補外・2026-07-21） | 中核価値「外部から動的値を安全注入」は `@var`（DECLARE 外部注入）が既に提供済み。残る固有価値は「カタログ永続化＋保存クエリでの利用」だけで、それも「保存クエリの単文制約を緩めて DECLARE+SELECT バッチ＋既存 @var」の軽量路線の方が安い。仕様 R2 は流用可能水準だが実需未確認。着手前に @var との差分で再評価（実需が出たら候補へ戻す） | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
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
