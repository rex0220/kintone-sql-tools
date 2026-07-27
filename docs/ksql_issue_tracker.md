# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-27
- 現在の最新リリース: **v3.28.0（2026-07-27・npm latest 3.28.0）＝B76 Phase B・JOIN の server-only 関数 第5許可形＝リリース完全完了**。**純加法**（一部の KLIKE 混在形で拒否理由コードのみ変化）。詳細は [リリース履歴](ksql_release_history.md)。
- 次回リリース計画: **未定**。**B76 Phase B は v3.28.0 でリリース完了**（2026-07-27）。これで**オーナー決定の着手順序 ①Phase A →②B79+B80 →③Phase B がすべて完了**し、**Pro への完了報告の保留条件が解除**された（次のアクションは報告）。残りは **B73**（**B80 が前提を満たしたので着手しやすくなった**）/**B61**/**B53**（18〜29 人日・実需待ち）/**B54**/**B63**/**B68**。
- **Pro への完了報告は送付済み**（2026-07-27）。**次は Pro の返答待ち**＝特に **B73 の要件3点**（位置＋トークンで足りるか／多言語化の対象範囲／対象言語 ja-en-zh）。返答が来たら **B73 の仕様化に着手**し、来ない場合は B61 以降の優先度で進める。以下は送付時の記録。保留条件だった **B79＋B80（v3.27.0）と B76 Phase B（v3.28.0）が両方リリース済み**のため解除。送付版を [Pro 報告](internal/ksql_pro_report_draft.md) に用意済み（v3.23.0〜v3.28.0・4 NG ケース全解消・**D10 の書き換え提案は実機 EXPLAIN で裏取り済み**〔`DATE_FORMAT(...)=DATE_FORMAT(CURRENT_DATE(),...)` は全件取得／`= THIS_MONTH()` は `pushdown applied` かつ residual なし〕）。**送付前の最終確認3点**＝①エンジン取り込み版数を Pro の運用に合わせる ②D10 の実フィールド名を実物に合わせる ③B73 の問い合わせに期限を切るかはオーナー判断。ドラフトは [Pro 報告ドラフト](internal/ksql_pro_report_draft.md) に保存済み（v3.23.0〜v3.25.0 時点の本文＋送付前の更新項目＋受容した risk を記載）。**受容した risk＝v3.25.0 の破壊的変更が Pro のテンプレートを既に壊している可能性**（`^3` に自動更新で届いているため報告前に顕在化しうる。移行案内は3箇所に記載済み）。
- **着手順序・リリース単位（2026-07-27 オーナー決定）＝① B76 Phase A リリース → ② B79 ＋ B80 を1リリース → ③ B76 Phase B**。**②をまとめる理由**＝どちらも「**失敗時の挙動を正直にする**」課題で機能追加ではない〔B79＝外部結合＋打ち切りで**誤った値**を返し警告文も「欠落」としか言わない／B80＝検証エラーを「SQL statement could not be parsed」と偽る〕＝**どちらも利用者に嘘をついているのを止める変更**で CHANGELOG も一つのメッセージで書ける。各 1〜2 人日と小さく、**リリース準備1回あたりのコスト**（版数同期・ビルド・成果物配置・4点同期・実機確認）を考えると別々に出すのは非効率。**②は破壊的変更を含む**ため v3.25.0 と同様に移行案内を3箇所（CHANGELOG・言語リファレンス・`release/README.txt`）へ。**③を分ける理由**＝**機能追加**（第5許可形）で **5〜8 人日**と規模が違い、**Phase A のリリースと実地検証が前提**。Phase A は取得挙動を大きく変えるため、使われた結果を見てから積み上げる（B67 が Phase1→Phase2 A→B72→B75 と段階を踏んで正解だった前例と同じ）。3つ全部を1リリースにすると 7〜12 人日の長いサイクルになり **silent wrong result である B79 の修正が数週間遅れる**ため避ける。**依存関係**＝B79 は B76 Phase B の前提**ではない**（Phase B も INNER JOIN 限定で範囲が重ならない）が、仕様 §0.3.6-10 の「SearchAborted 時の母集合完全性」は Phase B が相対日付リーフを residual から除去する以上の論点なので、**B79 を先に片付ければ「決着済み」として扱える**。**実需確認待ちの B54/B63/B68、実需待ちで棚上げの B53（18〜29 人日）、継続運用の B61 は据え置き**。**③着手前に Pro の返答を見て B76 Phase B と B73 の優先度を再評価する**。
- 目的: 課題・改善案・Issue の**進捗 / 効果 / リリースバージョン**を1か所で俯瞰する。個別の詳細は各文書へリンク。

## 運用ルール

- **本書は一覧（インデックス）**。仕様・診断・受入条件などの本文は各文書に置く。
- 各文書の先頭 `- ステータス:` 行が正（single source of truth）。本書はそれを集約する。
- **複数の課題にまたがる意味論は「横断仕様」を正とし、個別文書はそれを参照する**（事実を書き写さない）。現在: [文字列の扱い](internal/ksql_string_semantics.md)。実測で覆ったら**まず横断仕様を直し**、個別文書はそれに従う。
- 状態が変わったら **本書・各文書のステータス行・`CHANGELOG.md`・auto-memory** を揃えて更新する。
- リリース時は [`ksql_release_history.md`](ksql_release_history.md) へ版数・効果を1行追記し、「§1 バックログ」から該当行を落とす（本書 §2 の直近5版も更新する）。

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

進捗が動くのはここ。優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」で暫定。**2026-07-26 に kSQL Dashboard Pro からの報告で B71〜B74 を起票**し、**B71 は v3.23.0**・**B72 は v3.24.0** でリリース済み、B74（相対日付 docs 是正）も対応済み。**同日の Pro 追加検証（実エンジン v3.24.0）で B75・B76 を起票**＝B72 で単一表の集計クエリは解消したが、**CTE 本体を挟むと再び拒否**（B75・guard の保守的既定であり機構は既存）、**JOIN では日付述語自体が押し下げ対象外のため拒否が正しい**（B76・押し下げ拡張が先）。**次点は B75**。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B61 | AI 行動検証シナリオセットの運用化（B60 継続） | 改善 | 📝 **評価・継続運用**。機械 guard は「カタログが正しい」まで、「AI が正しく読めるか」は行動検証でしか分からない非対称への対策（文型×依頼のシナリオ台帳）。**残＝スクリプト半自動化・Desktop 面・失敗観測→台帳追加ループの運用化**（小粒・継続タスク） | 機能 | 中 | [B61 issue](internal/ksql_b61_ai_behavior_scenario_set_issue.md) |
| B53 | `WITH RECURSIVE` / `CYCLE` 句（再帰 CTE） | 改善 | 📝 **方向確定（2026-07-23）＝B40 と二者択一で B53 採用**（BOM 多段展開が B53 Phase1 で完結・B40 は可変長 Phase2 が別途必要）。SQL:1999 `WITH RECURSIVE`＋SQL:2016 `CYCLE`。単一再帰 CTE＋必須境界＋CYCLE 最小形・戦略 B（アプリ1回実体化＋メモリ反復）。**仕様 R2・Claude レビュー済＝実装着手可能水準で凍結・実需待ちで棚上げ**（R1→codex→レビュー→R2 で指摘4件反映済み・§13・§5.3 規模目安あり）。**実装着手は BOM/循環の具体ユースケース確認後**（見積り 18〜29 人日の大型投資・B40 と同じく資産化） | 機能 | 中 | [B53 spec R2](internal/ksql_b53_recursive_cte_cycle_phase1_spec.md) / [eval](internal/ksql_b53_recursive_cte_cycle_evaluation.md) |
| B54 | User API（ユーザー・組織・グループ情報）対応 | 改善 | 📝 **評価**。cybozu.com 共通 [User API](https://cybozu.dev/ja/common/docs/user-api/)（`/v1/`・users/orgs/groups）を `__USERS__`/`__ORGS__`/`__GROUPS__` の read-only 仮想テーブルで SELECT/JOIN 可能に。組織階層（`parentCode`）は B53 と相乗。論点＝別ベースパス `/v1/`・権限・ページング・結合キー（code）。**次＝実需確認・権限/面の実機確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B54 eval](internal/ksql_b54_user_api_directory_evaluation.md) |
| B63 | プラグイン面での SQL 構文・関数の説明表示 | 改善 | 📝 **評価・方向判断**。プラグインの SQL 入力画面から構文骨格・関数・方言差をその場参照（B55/B60 の人手書き面版）。既存の機械同期済みカタログ（B60 骨格＋B55 関数＋言語リファレンス）を再利用し二重管理しない。論点＝表示範囲/供給方式/UI 形態。**次＝実需・UI 方針確認→方向確定なら Phase1 仕様 R1** | 機能 | 中 | [B63 eval](internal/ksql_b63_plugin_syntax_help_evaluation.md) |
| B68 | kSQL read-only ライブラリの read-only 機能拡張（VALIDATE・一時テーブルバッチ） | 改善 | 📝 **評価**（2026-07-24 起票）。B66 ライブラリ（v3.19.0）の `runQuery` は単文 SELECT/WITH/UNION/SHOW APPS/DESCRIBE のみで、**read-only なのに使えない**2機能を課題化＝①`VALIDATE`（既存レコード監査・書込み0・B41）②一時テーブルを使うバッチ処理（複文・#temp 実体化・@var の read-only サブセット）。現状 statementGuard の allowlist 外で `READ_ONLY_VIOLATION`（実コード確認）＝**除外は安全性でなくスコープ最小化**（B66 §1.2）。B66 Phase2（runMutation=DML）とは**直交**（書込みなし）で独立先行可。段階＝Phase A VALIDATE〔allowlist 追加＋結果 DTO・小〜中〕→Phase B read-only 一時テーブルバッチ〔runBatch 相当の複文 API＋temp lifecycle＋文別 read-only 強制・中〜大〕。論点＝API 形状（runQuery 拡張 vs runValidate/runBatch）・read-only バッチ境界（temp 書込みは可だが実 kintone mutation 不可を statementGuard で厳密化）。**次＝実需確認→方向確定なら Phase A から Phase1 仕様 R1** **【2026-07-27 オーナー提案の評価】＝許可構文を MCP の READ 系と同じ基準にする案**。実コード確認で**現状は能力表が2つ**と判明〔MCP は `isReadOnlyStatement()`（`src/core/dmlGuard.ts`・**kintone に書くかという意味的判定**）＋`analyzeBatch`／**ライブラリだけ手書き allowlist**（`assertReadStatement`・単文限定）〕＝**B76 の「押し下げ能力表が2つ」と同型**で片方に文型を足すともう片方が置き去りになる。**差分＝VALIDATE / DML VALIDATE ONLY / CREATE-DROP TEMP TABLE / SET-DECLARE / ASSERT / 複文バッチ**で、**B68 の2機能はこの部分集合**＝本案は B68 を包含し原理から説明できる。**ただし guard 差し替えだけでは終わらない**＝本体は **API 形状**（`runQuery` は単一 `QueryResult`・バッチは複数結果セット・DML VALIDATE ONLY は行でなく診断。ただし公開型は既に `type` 判別共用体なので拡張自体は素直）。**「MCP と完全に同一」は危険**＝MCP 側も分類器だけで判定しておらず **APPLY は別の場所で拒否**（VALIDATE ONLY 経由だと `writesKintone=false` で分類器を通ってしまう）・**IMPORT は enableImport で別途ゲート**・**temp table は既定 10,000 行×16 表を利用者アプリのプロセス内で実体化**・**VALIDATE は全件読むため onLimit=truncate が error へ強制**。**結論＝基準としては採用推奨だが「MCP READ を出発点に面の事情で明示的に絞る」形にする**。**Phase A**（判定を dmlGuard へ寄せ単文 VALIDATE と DML VALIDATE ONLY を解禁・APPLY は追加ゲート・IMPORT 既定 off）だけでも**能力表2つは解消**／**Phase B**（複文バッチ・新 API・上限契約）。**searchAborted の hard error は構文の許可範囲とは別の軸なので維持**。**実需確認は引き続き必要**（Pro への報告の返信で確認するのが自然）。 **【2026-07-27 実需確定・オーナー提示】**＝①**ダッシュボードで `VALIDATE` のチェック結果を KPI／グラフ表示** ②**一時テーブルで複雑な複数アプリ JOIN をシンプルに管理**。**「実需確認待ち」ではなくなった**。実機（v3.28.0 CLI・実 kintone）で用途ごとに確認＝**①は Phase A でほぼ足りる**〔`VALIDATE APPn` 単体の戻り値が**`validateStats: { errorRecords, errorCount }` という集計済み統計を持つ＝そのまま KPI**。内訳グラフも診断行が返るので呼び出し側 JS で集計可。SQL で `GROUP BY` したい場合だけ Phase B〕。**②は B76 の制約と噛み合う**〔**JOIN の入力が一時テーブルだと server-only 関数は使えない**。実測: ①作成時に相対日付→`#cur` 参照 ✅／②作成時に相対日付→**`#cur` を JOIN 入力**（WHERE に関数なし）✅／③`#cur` を JOIN 入力にして**WHERE 側で相対日付** ❌ `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`。→**「早く絞ってから結合する」が正解**で性能面でも望ましいが、**知らないと ③ を書いて拒否される**ため**Phase B の受入条件に「この使い分けを公開 docs へ明記」を含める**〕。**優先度＝Phase A の費用対効果が高い**（用途1をほぼ満たし、かつ§1 の能力表二重管理も解消）。**残る未確認＝ライブラリ面での需要か否か**（プラグイン／MCP は既に両機能を持つため、Pro が engine library を使うかが Phase 分けの判断材料）。 | 機能 | 中 | [B68 eval](internal/ksql_b68_engine_library_readonly_extensions_evaluation.md) |
| B73 | エンジンエラーの構造化情報公開 / 多言語対応 | 改善 | 📝 **評価・起票（優先 中）**（2026-07-26・Pro 報告2）。`KsqlEngineError` は `code`（6種の粗い分類）＋`message`（文字列）＋`cause` のみで、**位置・トークン・関数名・path は message 文字列に埋め込まれているだけ**。実測でメッセージは**日英混在**（PARSE_ERROR 系＝日本語／EXECUTION_ERROR・ArgumentError 系＝英語。Pro の「日本語のみ」は不正確）。Pro は UI 日英中対応のため en/zh ユーザーに日本語が出る。要望＝①構造化情報（messageKey/params）公開 ②`lang` 切替。内部の全エラー生成箇所（文字列 throw 主体）に触るため中〜大規模＋message 部分一致テストが広範に存在。**段階案＝Phase A（小）: 既存 reason code・位置・トークンを `details?` として非破壊公開 → Phase B: messageKey カタログ → Phase C: lang 切替**。Pro も「Phase 1 では記録のみで急ぎでない」。次＝実需確認（位置・トークンで足りるか）→Phase A 先行推奨 | 機能 | 中 | [B73 eval](internal/ksql_b73_error_structured_i18n_evaluation.md) |
| B81 | MCP instructions の語数予算が構造的に枯渇 | 改善 | ✅ **実装済み（未リリース）**（2026-07-27）。**語数予算を散文とカタログ列挙で分けて計上**するようにした（案 D）。実測 **total 548 = catalog 258 + prose 290**。起票時に「散文は P1〜P3 の 116 語」と見積もったのは誤りで、**P4/P5 の説明文も散文**のため実際は 290 語だった。閾値は **prose ≤ 320 / catalog ≤ 420 / total ≤ 700**、**exact 固定 `toEqual({total,catalog,prose})` は維持**（意図しない増減を fail-loud に）。`src/mcp/instructionsBudget.ts` を新設し、**カタログ由来の語数は文面ではなく元データ**（`KSQL_FUNCTION_CATALOG` / `STATEMENT_SYNTAX_CATALOG` / CHECKS / CONTROL）**から数える**。**破壊テストで肝心の性質を確認**＝関数を5個足すと catalog 258→263・**prose は 290 のまま**（旧ルールでは total 553 で上限 550 を突破していた）＝**機能追加が散文の予算を食わなくなった**。**【重要】上限値に外部根拠は無い（§7・実装後の調査）**＝MCP 仕様は instructions を "Optional instructions for the client" と書くだけで**サイズ規定なし**、SDK も `z.string().optional()` で**長さ制約なし**、**B60 の 500 も根拠が記録されていない**。実コストは毎セッション**約 1,000 トークン**（上限まで使っても増分 300〜400）で**無視できる水準**。**測る単位も目的に合っていない**〔文脈コストが関心事ならトークンで測るべき／指示追従の劣化が関心事なら 550 語に閾値がある根拠はない〕。→ **guard の位置づけを「予算」から「変化の検知」へ**＝**exact 固定を本体**とし（B62 502→525・B67 529→541・B76 552 の単調増加を実際に捕捉してきた実績がある）、**上限は「超えたら妥当性を再検討するトリガー」**として扱う（超過時に機械的に圧縮せず上限自体の妥当性を問う）。**トークン計測への置換は実需が出てから**（数字を作り直しても根拠の無さは変わらないため先回りしない）。 | 改善 | 中 | [B81 issue](internal/ksql_b81_mcp_instructions_word_budget_issue.md) |
| B82 | リリース時に公開文書の未リリース表記を検出 | 改善 | ✅ **実装済み（未リリース）**（2026-07-27）。**B70 §7 の残作業**。v3.25.0 で**リリース済みの B75/B77/B78 が言語リファレンスでは「Unreleased の破壊的変更」のまま出荷**された（2箇所）。version-sync-guard は**版数の一致**を見るもので**語の残存は守備範囲外**だった。**同種の事故は再発**〔v3.28.0 でも `release/README.txt` と `CHANGELOG.md` に「次回リリースの B76 Phase B で」という前方参照が残り、リリース作業中に人手で発見・修正。**「次回リリース」はそのリリースが出た瞬間に誤りになる**〕。**実装＝`version-sync-guard.mjs` に `--release` モード**〔対象 `docs/ksql_language_reference.md` / `release/README.txt`、検出語 `Unreleased`/`未リリース`/`次回リリース`、**`CHANGELOG.md` は開発中に見出しを持つのが正常なので対象外**、失敗時はファイル名・行番号・該当行を出力〕。**`npm test` は従来どおり**（未リリース機能の記述は正常なので開発を妨げない）、**`prepack` からのみ有効**。v3.25.0 と同じ取り残しを再現して**リリースモード exit 1 / 通常モード exit 0** を実測。**残る限界＝語の一致で見るため別の言い回しは捕まらない**ので、公開文書は版に依存しない表現で書く運用が本質。 | 改善 | 中 | [B82 issue](internal/ksql_b82_release_stale_marker_guard_issue.md) |
| B83 | MCP instructions の VALIDATE 診断列数が実態と違う | 改善 | 📝 **評価・起票（優先 中／docs 不正確）**（2026-07-27・B68 の実需確認中に発見）。MCP instructions が `VALIDATE` の診断列を **`fixed five diagnostic columns`** と書いているが、**実際は 9 列**（`$id` `$err_field` `$err_code` `$err_message` `$err_value` `$err_subtable` `$err_subrow` `$err_subrow_id` `$err_count`）。`VALIDATE APPn` 単体の戻り値・`INTO #err` の一時テーブルとも 9 列で実測。**推定原因＝前半5列が当初の形で、サブテーブル診断の4列が追加された際に instructions が追随しなかった**。**影響＝instructions は AI にとっての正**なので、**存在する列を隠している**状態（B62 が捏造を防ぐ目的で完全性を明示したことの裏返し）。**docs が実態と違う問題は本プロジェクトで反復**（B74 相対日付／B80 エラー理由／B76 Phase B の JOIN 制約）。**対応＝`five`→`nine` なら 0.1 人日・語数予算への影響なし**（B81・どちらも1語）。**再発防止＝数を手書きしていること自体が原因**なので「数を書かない」か「実データから生成」（B60 が statement templates と function catalog で採っている方式）のどちらか。**同種 drift が他に無いかの確認も要**（instructions ／ `ksql_docs` ／ 言語リファレンス ／ 実装の4者整合）。 | 改善 | 中 | [B83 issue](internal/ksql_b83_mcp_validate_columns_docs_issue.md) |

---

## 2. リリース済み履歴（版数・効果）

**全 61 版の履歴は [`ksql_release_history.md`](ksql_release_history.md) へ分割した**（2026-07-27）。
本書が 102KB まで肥大し、進行中の課題を見るのに履歴を毎回読む状態だったため。

直近5版のみ再掲する。**経緯・撤回した案・失敗の記録は履歴側にある。**

| バージョン | 内容 |
|---|---|
| **v3.28.0** | B76 Phase B — JOIN で server-only 15 関数（第5-W / 第5-L） |
| **v3.27.0** | B79 外部結合の検索打ち切りを fail-closed ／ B80 engine ライブラリの reason 保持 |
| **v3.26.0** | B76 Phase A — JOIN 述語の APP 別 prefilter ／ B70 版数同期ガード |
| **v3.25.0** | B75 CTE 本体の相対日付 ／ B77 kintone 関数の fail-closed 統一 ／ B78 LOGINUSER |
| **v3.24.0** | B72 相対日付を集計クエリでも（第3許可形 FULL_SCAN_EXACT） |

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
