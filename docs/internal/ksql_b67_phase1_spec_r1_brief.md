# B67 Phase1 仕様 R1 — codex 起草ブリーフ

- 作成日: 2026-07-24（Claude=仕様/観点）
- 目的: codex が **B67 Phase1 仕様 R1**（kintone REST クエリ関数＝相対日付の押し下げ対応）を起草するための scope と判断論点の枠組み。
- 出力先: `docs/internal/ksql_b67_rest_query_functions_phase1_spec.md`（R1 本体）
- 分担: **codex 起草 → Claude レビュー → R2**。git 操作は Claude 側。仕様は実装せず**文書のみ**。
- 方向: 評価（[B67 eval](ksql_b67_rest_query_functions_evaluation.md)）の**推奨 A＝押し下げネイティブ**を採用。
- 参照実コード: `src/types/ast.ts:596`（`KintoneFuncNode`＝TODAY/NOW/LOGINUSER）・`src/converter/whereToKintone.ts`（押し下げ serialize・TODAY/NOW/LOGINUSER 素通し）・`src/engine/evalWhere.ts:429 resolveKintoneFunc`・`src/lexer/tokens.ts`/`src/parser/parser.ts`（関数トークン）・B32 の WHERE 型×演算子能力表（`whereCapability`/EXACT_PUSHDOWN）・`src/core/optimization/korderPlanner.ts`。
- 公式: [kintone クエリの関数](https://cybozu.dev/ja/kintone/docs/overview/query/#function)（**引数文法・セマンティクスは公式を正として確認**）。

## スコープ（Phase1）

- **相対日付関数**を kSQL の WHERE で使えるようにし、**kintone クエリへ押し下げて kintone にサーバ評価させる**（A）。対象:
  - `YESTERDAY()` / `TOMORROW()`
  - `FROM_TODAY(n, DAYS|WEEKS|MONTHS|YEARS)`（n は負値可）
  - `THIS_WEEK([曜日])` / `LAST_WEEK([曜日])` / `NEXT_WEEK([曜日])`
  - `THIS_MONTH([1-31|LAST])` / `LAST_MONTH([...])` / `NEXT_MONTH([...])`
  - `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()`
- 既存 `TODAY()`/`NOW()`/`LOGINUSER()` は不変（回帰なし）。
- **対象外（Phase2）**: `PRIMARY_ORGANIZATION()`（B54 User API と相乗）・client 評価（FULL_SCAN 対応）。
- エンジンの SQL 意味論・既存挙動は純加法で不変。

## 必要セクション（B53/B66 Phase1 spec の構成を踏襲）

1. スコープ（対象/対象外） 2. 構文（関数文法・引数） 3. 意味論（サーバ評価・押し下げ） 4. 型・位置の制約 5. 押し下げと fail-closed 6. パーサ・予約語・AST 7. カタログ/docs 同期 8. 面（CLI/MCP/plugin） 9. 受入条件（テスト化） 10. Phase2 引き継ぎ 11. 工数見積り

## R1 で確定すべき判断論点（曖昧にしないこと）

1. **【最重要・正しさ】押し下げ専用＝押し下げ不可なら fail-closed**。これらの関数は**サーバ評価が本質**なので、比較が kintone クエリへ押し下げできる位置（B32 の `EXACT_PUSHDOWN` 相当）でのみ許可する。JOIN 後の残余評価・FULL_SCAN・派生等で関数付き比較が client 側に残る場合は、**client 評価にフォールバックせず取得前に fail-closed 拒否**（理由コード付き）。誤ったローカル評価でサーバと食い違う結果を出さない。B32 の WHERE 型×演算子能力表を関数対応へ拡張する。
2. **【型】日付系フィールド限定**。相対日付関数は DATE/DATETIME/作成日時/更新日時 との比較のみ。非日付フィールドとの比較は取得前拒否。型解決は既存の型付き比較（B26）経路を使う。
3. **【位置・演算子】WHERE 比較のオペランドに限定**。許可する比較演算子を確定（`<` `<=` `>` `>=` `=` `!=`）。`BETWEEN`/`IN` は kintone ネイティブに無いため、押し下げ時どう扱うか決める（分解して `>=`/`<=` にできるか、Phase1 は非対応か）。任意のスカラー式内・SELECT 出力・ORDER BY へは広げない（kintone クエリ関数の制約に合わせる）。
4. **【構文・予約語】引数文法とソフトキーワード**。`FROM_TODAY` の単位（DAYS/WEEKS/MONTHS/YEARS）、`THIS_WEEK` 等の曜日（SUNDAY..SATURDAY）、月の `LAST` を**ソフトキーワード優先**で扱い予約語増を最小化（既存フィールド名と衝突しうるためバッククォート退避）。`FROM_TODAY(n, ...)` の n（整数・負値可）の受理範囲。**引数文法は公式リファレンスを正として厳密化**。
5. **【serialize】whereToKintone での出力**。関数＋引数を kintone クエリ表現（例 `作成日時 < FROM_TODAY(5, DAYS)`）へ serialize。kSQL フィールド名→kintone フィールドコード・演算子・関数名/引数の正確な出力。既存 TODAY/NOW/LOGINUSER 素通しの隣に一般化して追加し、既存出力を byte 不変に保つ。
6. **【AST】`KintoneFuncNode` の一般化**。関数名 union の拡張＋引数フィールド（単位・曜日・日・数値）。既存 3 関数の AST を壊さない。
7. **【カタログ/docs】同期**。B55/B60 の contextual 関数カタログへ追加・catalog⇔parser⇔fixture の drift guard・instructions 語数 guard・言語リファレンス（日付/WHERE 章）へ反映。追加語が instructions 語数 guard に収まるか。
8. **【面】全面一致**。押し下げは engine の serialize なので Node/CLI/MCP/plugin で同一。LOGINUSER のような client 文脈差は A では無関係（kintone 評価）。

## 受入条件に必ず入れる例

- `WHERE 作成日時 < FROM_TODAY(5, DAYS)` が押し下げられ kintone クエリに `作成日時 < FROM_TODAY(5, DAYS)` が出る。
- `THIS_MONTH()` / `THIS_WEEK(MONDAY)` / `LAST_MONTH(LAST)` 等の代表が押し下げ serialize される。
- 非日付フィールドとの比較・押し下げ不可の文脈（JOIN 残余等）は**取得前 fail-closed**（理由コード）。
- 既存 `TODAY()`/`NOW()`/`LOGINUSER()` の出力・挙動が byte 不変（非回帰）。
- カタログ/instructions/言語リファレンスの drift guard・語数 guard が green。
- 全面（CLI/MCP/plugin）で同一の押し下げクエリ。

## 制約

- git 操作は Claude 側。仕様は実装せず文書のみ。
- 公開構文の意味論は発明せず**公式リファレンスを正**とする（曜日語・月末・単位・n の範囲）。
- エンジン本体の SQL 意味論は変えない（純加法・既存 3 関数不変）。
- 押し下げ不可時に client 評価へ流さない（Phase1 は A のみ）。
