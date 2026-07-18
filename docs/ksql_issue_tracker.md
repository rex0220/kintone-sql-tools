# kSQL 課題・改善案・Issue 一括管理

- 最終更新: 2026-07-18
- 現在の最新リリース: **v3.0.0**（B26 / B27 / B30 / B31 / B32＝型付き比較と ORDER BY 計画の major・npm publish 済み・latest 3.0.0）
- 次回リリース計画: **v3.1.0 = B33 単独**（2026-07-18 決定。実装済み・残 = Chromium/Firefox plugin smoke）。以降の目安: **v3.2.0 = B34＋B22**（受入確定済みの正しさバグ）・**v3.3.0 = B9＋B29**（numberPrecision 領域ペア・仕様作成から）
- 実装計画: [B33 KORDER Cursor 実装計画](internal/ksql_korder_cursor_implementation_plan.md)（v3.0.0 の計画は [こちら](internal/ksql_v3_order_by_implementation_plan.md)）
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

進捗が動くのはここ。優先度は「正しさ/安全性 > 機能 > 性能改善の上積み」で暫定。

| # | 課題 / 改善案 | 種別 | 状態 | 効果 | 優先 | 文書 |
|---|---|---|---|---|---|---|
| B21 | **`UPDATE SET` が文字列関数を直接受け付けない** | **バグ**（一貫性） | 📝 **R4 同期**。**同じ式が `CASE WHEN` の中では書けるのに直接書くと `ParseError`**。単純 UPDATE は `buildUpdateRecord` が row を持たないため、parser 追加だけでは直らない。assignment に限定して参照フィールド収集・row 評価・VALIDATE/ON ERROR SKIP を通し、関数の意味型（string/numeric）を値の見た目で再判定しない。親 DML WHERE は対象外 | **正しさ** | 中 | [issue](internal/ksql_update_set_string_func_issue.md) |
| B22 | **切り出し・桁揃え関数がサロゲートペアを分割する** | **バグ** | 📝 **R4 同期**。`LEFT`/`RIGHT`/`SUBSTRING`/`LPAD`/`RPAD` が孤立サロゲートを返す。対策は**コードユニット予算内の最大安全部分列**。入力18種・全境界の13,905ケースと、最大性を含む性質テストを受入条件とする。一般の文字単位・kintone実測は横断仕様 §§2–3を正とする | **正しさ** | 中 | [issue](internal/ksql_surrogate_pair_split_issue.md) |
| B23 | `LENGTH_CHAR`（コードポイント単位の文字数）を追加 | 改善 | 📝 **R4 同期**。コードポイント計数を別名で追加し、戻り意味型は numeric。`LENGTH - LENGTH_CHAR` は有効なサロゲートペア数。`LENGTH`・kintone計数の事実は横断仕様 §2を参照 | 機能 | 中 | [spec](internal/ksql_length_char_spec.md) |
| B24 | `TRANSLATE(x, from, to)`（1 対 1 の文字写像）を追加 | 改善 | 📝 **R4 同期**。実需の40字表ではコードユニット実装が25字を誤変換するため、コードポイント列で1対1写像する。長さ不一致はエラー、重複は先頭優先、戻り意味型は string。一般則は横断仕様 原則3–4を参照 | 機能 | 中 | [spec](internal/ksql_translate_spec.md) |
| B28 | **DML の単項符号（負数・正数リテラル）の受理範囲が経路ごとに違う** | **バグ**（一貫性） | 📝 課題R1。INSERT/UPSERT VALUESは`-5`/`+5`を拒否、UPDATE SETは`-5`のみ受理。親・サブテーブル・SELECT-based DMLを横断し、VALUESには符号付き数値だけを追加する。一時テーブル対象DMLは元から非対応なので解禁しない | **正しさ** | 低 | [issue](internal/ksql_dml_unary_sign_issue.md) |
| B29 | **kintoneの数値精度・丸め設定とDML/Tier-0を整合させる** | **バグ / 言語意味論** | 📝 **課題R2: 優先度を中へ降格（2026-07-17）**。根拠=実書込みは kintone の fail-fast（CB_VA01）が部分成功・データ破壊を防いでおり、**偽合格が起きるのは VALIDATE ONLY / ON ERROR SKIP の事前検証経路に限られる**＋既定 `digits` を超える運用は B9 降格と同じ頻度根拠で稀。`numberPrecision`（最大30桁・小数10桁・HALF_EVEN/UP/DOWN）はB9の比較順ではなく、入力・算術結果の検証/量子化を所有する。B9とは別実装・別受入条件（**B9 再昇格トリガー②＝B29 実装着手の関係は不変**） | **正しさ** | 中 | [issue](internal/ksql_number_precision_semantics_issue.md) |
| B33 | **`KORDER BY` 大規模窓のCursor API対応** | 改善 | 🚧 **実装中（2026-07-18）・v3.1.0 の主役候補**。`KORDER_CURSOR` planner/executor、必須`openCursor`契約、Node/plugin adapter、retryなしRequestGate、host lease・Create直列化・cleanup再確認・quarantine、batch timeout cleanup、CLI/env/profile/MCP/plugin設定、EXPLAIN/metrics/文書を実装済み。レビュー指摘P2×2/P3×1に加え、実機smoke指摘のMCP `ksql_explain.maxRecords`とCLI通常EXPLAINのconcurrency表示を修正。**順序release blockerはAPP730・618,525件で10,001件/21ページ・同値群境界・ASC/DESC・LIMIT/OFFSETをraw Cursor APIと照合し7/7完全一致で解消**（[evidence](internal/evidence/b33_cli_mcp_smoke.md)）。通常ORDER/FULL_SCAN/JOIN/DMLは現行方式を維持する。5分Create timeoutは再現不能のため専用応答判定を推測せず、応答喪失はquarantineする。**残release blocker**＝plugin離脱cleanup/warning・二重DELETE reject形状のChromium/Firefox実機確認 | **機能・性能** | 中 | [spec](internal/ksql_cursor_api_fetch_spec.md) / [plan](internal/ksql_korder_cursor_implementation_plan.md) |
| B34 | **DML が存在しない／サブテーブル内のフィールドを対象にしても黙って成功する** | **バグ**（説明不能な成功） | 📝 課題R2・実機確認済み（2026-07-17・APP4221）。kintone はトップレベル未知フィールドを黙って無視するため、通常 INSERT/UPDATE は不存在フィールド・サブテーブル子とも `insertedCount`/`updatedCount` を返して**何も書かない**（タイポも同経路で握り潰される）。VALIDATE ONLY は不存在のみ拒否し `inSubtable` を見ず素通し（execute.ts:3493）。対策＝共有「書き込み可能トップレベルフィールド検査」を DML 形式（INSERT VALUES/SELECT・UPDATE 通常/算術/CASE/FROM・UPSERT）× 修飾（なし/VALIDATE ONLY/ON ERROR SKIP）へ横断適用。**検査はソース SELECT・更新対象取得・confirm・POST/PUT より前**（現行 INSERT…SELECT はソース実行→confirm→フィールド取得の順＝execute.ts:3999/4015/4022）。サブテーブル DML は現行対応の INSERT VALUES/UPDATE/DELETE/REORDER を非回帰。SemVer=minor | **正しさ** | 中 | [issue](internal/ksql_dml_writable_field_check_issue.md) |
| B20 | 正規表現関数（`REGEXP_LIKE`/`REGEXP_REPLACE`/`REGEXP_SUBSTR`） | 改善 | ⛔ **現方式では出荷しない**（横断仕様 §7 制限 1）。**安全部分集合 R-1/R-2 では ReDoS を塞げない**＝量化グループも後方参照も無い `^a?×n a×n b$`（入力 `a×2n`）が指数時間（実測 n=26 で 470ms）。**任意の曖昧 NFA を構文規則で検出することはできない**。加えて **native `RegExp` の解釈はホスト依存**で 4 面同一にできない。**再開条件**＝①Node/ブラウザ共通の**非バックトラックエンジン**（WASM 等）を版ごと固定 or ②**正規表現でない限定パターン言語**を別設計。**CLI/MCP 限定は 4 面一貫性を捨てるため既定案にしない** | 機能 | 低 | [spec](internal/ksql_regexp_function_spec.md) |
| B3 | バッチ変数：配列展開 `IN (@list)`（1 変数＝複数値） | 改善 | 📝 提案（**仕様なし**＝1a 仕様 §2.2/§6 で対象外・配列型の導入が要る。R4 の `IN (@a, @b)` スカラー並べは **v2.1.0 で出荷済み**） | 機能 | 低 | [1a spec §6](internal/ksql_batch_variables_phase1a_spec.md) |
| B4 | 保存クエリのパラメータ化 `:name` | 改善 | 📝 評価確定・実装計画待ち | 機能 | 中 | [eval](internal/ksql_saved_query_params_evaluation.md) / [draft](internal/ksql_saved_query_params_spec.md) |
| B5 | KLIKE 親レコード DML 解禁 | 改善 | 📝 改善案（検索打ち切り検出が前提・v2.10.0 で整備済） | 機能 | 中 | [v1 spec](internal/ksql_klike_native_search_spec.md) |
| B6 | KLIKE 外部結合 非 nullable 側の押し下げ解禁 | 改善 | 📝 改善案 | 性能 | 低 | [v2 spec](internal/ksql_klike_pushdown_v2_spec.md) |
| B7 | プラグインでの検索打ち切り検出（raw fetch 経路） | 改善 | 📝 改善案（プラグインは header 不可） | 安全性 | 低 | [issue](internal/ksql_search_abort_warning_issue.md) |
| B9 | **最大30桁の厳密10進比較** | **バグ / 言語意味論** | 🔗 **R5: 優先度を頻度根拠で中へ降格**（能力の事実=digits最大30桁は不変・R4の撤回ではない）。衝突は2^53=9.0e15（16桁）超のみで現実の金額・数量は届かず、`Number()`丸めは単調のため**順序逆転はなく偽の同値だけ**（衝突域の`WHERE =`誤マッチ・MIN/MAX代表値）。`$id`/`RECORD_NUMBER`はv3.0.0で厳密化済み。追加スコープ=算術由来`"1e+21"`の科学記法正規化。**再昇格トリガー=①16桁超実データでの誤動作報告②B29実装着手**（同領域・同時が安価）。制限はv3移行ガイド・横断仕様§7に明記済み。`decimalPlaces`/`roundingMode`の量子化はB29へ分離 | 正しさ | 中 | [issue](internal/ksql_exact_decimal_compare_issue.md) |
| B10 | バッチ変数 後続：`NULL` 代入 / SELECT 列での `@var` 参照 | 改善 | 📝 提案（後続フェーズ） | 機能 | 低 | [1a spec](internal/ksql_batch_variables_phase1a_spec.md) |

---

## 2. リリース済み履歴（版数・効果）

新しい順。各機能の詳細は `CHANGELOG.md` と各文書を参照。

| バージョン | 内容 | 効果 | 文書 |
|---|---|---|---|
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
| **v2.4.0** | バッチ変数 Phase 1c：`DECLARE @x = 既定値` 外部パラメータ注入（MCP/CLI） | 機能 | [spec](ksql_batch_variables_phase1c_spec.md) |
| **v2.3.0** | バッチ変数 Phase 1b：`SET @x=(SELECT ...)` スカラーサブクエリ代入 | 機能 | [spec](ksql_batch_variables_phase1b_spec.md) |
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
| **v1.10.0** | バッチ拡張 第1弾（`ASSERT` / CLI バッチ JSON 出力 / `requestGate` 設定公開） | 機能 | [spec](ksql_batch_enhancement_phase1_spec.md) / [proposals](ksql_batch_enhancement_proposals.md) |
| ～v1.9.0 | 初期リリース群（順次バッチ＋一時テーブル v1.4.0 / プラグイン DML バッチ v1.9.0 / MCP INSERT・UPSERT … SELECT / `dmlMaxRows` ソース読み取り v1.8.0 ほか） | 機能 | [temp-table](ksql_batch_temp_table_spec.md) / [plugin-dml](internal/ksql_plugin_dml_batch_spec.md) / [dml-read-limit](internal/ksql_mcp_dml_source_read_limit_issue.md) |

---

## 3. 保留・対象外

| 項目 | 状態 | 理由 | 文書 |
|---|---|---|---|
| UPSERT 変更行スキップ `ONLY CHANGED` | ⏸ 保留 | 差分型では効果がリラン時の監査情報保護に限定・実装コスト重（既存値読み取り戦略/型別正規化/64 文字キー問題）。エラー行隔離（B12）の検証エンジンが先・需要立証後に再評価 | [spec](internal/ksql_only_changed_upsert_spec.md) |
| 実行ログ自動記録 / 更新前スナップショット退避 / チャンク実行・レジューム | ⏸ 保留 | ログは `@batch_id`＋現行 INSERT で運用可・スナップショットは `#before` レシピで代替・チャンクは適用限界の外（数十万件級は連携方式見直しが先）。バッチ強化 [roadmap](internal/ksql_batch_processing_roadmap.md) | [roadmap](internal/ksql_batch_processing_roadmap.md) |
| 複数 SQL の並列実行 | ⏸ 対象外 | 順次バッチのみ採用。並列は評価時に対象外化 | [eval](multi-statement-temp-table-evaluation.md) |
| `bulkRequest`（M5） | ⏸ 保留 | v1.4.0 では見送り。実機スパイクとセットで判断 | [temp-table](ksql_batch_temp_table_spec.md) |

---

## 関連文書

- **横断仕様（正・single source of truth）**
  - **文字列の扱い**（文字数の定義・サロゲートペア・比較順序・ホスト依存）: [`ksql_string_semantics.md`](internal/ksql_string_semantics.md) — **個別文書は事実を書き写さず本書を参照する**
- リリース履歴の一次情報: [`CHANGELOG.md`](../CHANGELOG.md)
- 主要 RDB（MySQL/Oracle/SQL Server）との機能比較・欠落機能の効果評価: [`ksql_sql_feature_comparison_evaluation.md`](internal/ksql_sql_feature_comparison_evaluation.md)
- 言語仕様: [`ksql_language_reference.md`](ksql_language_reference.md)
- バッチ実務レシピ: [`ksql_batch_recipes.md`](ksql_batch_recipes.md)
- リリース手順: auto-memory `release-procedure.md`
