# 課題+仕様: FULL_SCAN `IN` / `NOT IN` の型メタ付き複数値・ユーザーコード評価（述語分割 第2段・フェーズ1）

- 作成日: 2026-07-15
- ステータス: **課題+仕様案 R2（codex レビュー反映・実装着手可）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版
  - 2026-07-15 R2: codex レビュー反映（[High] サブテーブル子定義は現行 `getFields` が取得しない＝`TABLE.fields` を再帰展開・CLI/UI 両クライアント修正・`_p.X` は親型・サブテーブル DML 経路も型メタ取得／[High] raw Map でなく**衝突時 `undefined` を返す型解決契約 `FieldTypeResolver(FieldRef)`**・JOIN 同名/非修飾/CTE/集計 alias/関数結果の規則を明記／[Medium] `IN (SELECT ...)`（SUBQUERY_IN_LIST）も共通の型付き membership へ通す／[Medium] 型メタ取得の走査対象を実際に JS 評価される全述語（WHERE/HAVING/CASE WHEN/サブテーブル DML）へ揃える／[Low] malformed の定義を「形不一致・code 欠落」まで拡張）。
- SemVer: **バグ修正（挙動変更・後方互換方向）→ minor 相当**（実装後に確定）
- 位置づけ: 選択系 `IN` 押し下げ（[ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)）の**フェーズ1（正しさ・押し下げと独立）**。フェーズ2（押し下げ＋実在検証）の**前提**。
- 関連コード: `src/engine/evalWhere.ts`（`evalOp` の IN 判定）、`src/engine/process.ts`（`flatten`・[:59](../../src/engine/process.ts#L59)）、`src/execute.ts`（`getFieldTypeMap` / FULL_SCAN の型メタ配線）

## 0. 課題（実機で確認済み）

FULL_SCAN で**複数値/オブジェクト型フィールドの `IN` / `NOT IN` が誤結果**になる。`flatten`（[process.ts:59-64](../../src/engine/process.ts#L59)）が配列/オブジェクト値を **JSON 文字列**にするため、JS の `IN` が要素と一致しない。

| 実機（MCP・APP4149・`主担当`＝USER_SELECT） | 結果 |
|---|---|
| `主担当 IN ('rex0220')` SIMPLE（kintone） | **20 件**（一致） |
| `主担当 IN ('rex0220') AND $id LIKE '%'` FULL_SCAN（JS） | **0 件**（`[{"code":"rex0220",...}]` ∉ `{"rex0220"}`） |

同じ SQL が実行モードで異なる結果を返す（②空セル −∞ と同種のモード乖離）。CHECK_BOX/MULTI_SELECT/USER/組織/グループ選択が該当。

## 1. 設計方針（型メタ付き評価＝ナイーブ JSON parse は不可）

**`flatten` 後の文字列だけでは型を判別できない**（例: `SINGLE_LINE_TEXT` に文字どおり `["A"]` が保存されている場合、JSON parse で配列と誤認すると文字列一致→要素一致に意味が変わり**別の回帰**を生む）。→ **フィールド型メタを JS 評価（`evalWhere`）まで渡し、型ごとに評価規則を切り替える**。

### 1.1 型ごとの `IN` / `NOT IN` 評価規則
| フィールド型 | 値の形（flatten 後） | `IN` の判定 |
|---|---|---|
| `DROP_DOWN` / `RADIO_BUTTON` / `STATUS` / `RECORD_NUMBER` / テキスト・数値等 | スカラー文字列 | 従来どおり `row[field] ∈ {v...}`（**変更なし**） |
| `CHECK_BOX` / `MULTI_SELECT` | 文字列配列 `["A","B"]` | 配列要素のいずれかが `{v...}` に含まれる |
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | オブジェクト配列 `[{code,name},...]` | いずれかの要素の **`code`** が `{v...}` に含まれる |
| `CREATOR` / `MODIFIER` | 単一オブジェクト `{code,name}` | その **`code`** が `{v...}` に含まれる |
| **型不明・上記以外** | — | **従来の文字列比較を維持**（回帰なし） |

- **`NOT IN`** は各型で `IN` の否定（配列/オブジェクトも「いずれの要素も含まれない」）。
- **ユーザー系は表示名でなく `code` で比較**（`name` は照合に使わない）。

### 1.2 型メタの入手（[High-1]・サブテーブル子定義の再帰展開が必須）
- 現行 `getFields`（[nodeKintoneClient.ts:234](../../src/cli/nodeKintoneClient.ts#L234) / [ui/kintoneClient.ts:130](../../src/ui/kintoneClient.ts#L130)）は `Object.values(res.properties).map(...)` で**フォーム直下のみ**を収集し、**`SUBTABLE`/`TABLE` 配下の `fields` を再帰していない**。よってサブテーブル子フィールドの型が取れない。
- **修正**: フォームフィールド応答の **`TABLE.fields` を再帰的に `KintoneFieldInfo[]` へ展開**する。**CLI/UI 両クライアントを同時に修正**（`getFieldTypeMap`([execute.ts:1953](../../src/execute.ts#L1953)) は展開後の一覧をそのまま Map 化）。
  - サブテーブル子フィールドは**子のフィールドコード**で型解決。
  - **`_p.X`（親項目参照）は親フィールド `X` の型**を使う。
- **取得の限定**: §1.4 の走査対象（WHERE/HAVING/CASE/サブテーブル DML）に `IN`/`NOT IN` を含む FULL_SCAN のときだけ当該アプリの型メタを取得（無関係クエリに API を足さない・フィールド検証で既取得ならキャッシュ再利用）。**UPDATE/DELETE/REORDER のサブテーブル経路**（[execute.ts:2506/2572/2779](../../src/execute.ts#L2506) は現状 `evalWhere` 直呼びで型メタなし）でも取得して渡す。

### 1.3 型解決契約（[High-2]・raw Map でなく resolver）
`flatten` は**修飾キー（`alias.field`）と非修飾キー（`field`）を併記**し、JOIN では非修飾キーが後段テーブルで上書きされ得る。生の `Map` を渡すと JOIN 同名フィールド・非修飾参照・HAVING の集計 alias を安全に扱えない。→ **`FieldTypeResolver(field: FieldRef): string | undefined`** を `evalWhere` に渡す契約にする。規則:

- **型別評価は IN 左辺が直接の `FIELD` のときだけ**適用（`FUNC_FIELD`/`ARITH_FIELD`/`CASE_FIELD` の**最終結果には元フィールド型を流用しない**。CASE 内部の条件は §1.4 で別途型付き評価）。
- **`alias.field`** は該当 alias の物理テーブルから解決。
- **JOIN なしの非修飾 field** はメインテーブルから解決。
- **JOIN ありの非修飾 field** は、型が**一意に決定できるときだけ**解決。**同名衝突時は `undefined`**（＝従来の文字列比較）。
- **CTE・一時テーブル**は型来歴がないため `undefined`（従来比較）。
- **HAVING の集計名・SELECT alias には物理フィールド型を適用しない**（物理 CHECK_BOX と同名の集計 alias を配列と誤評価する事故を防ぐ）。

### 1.4 型メタ取得・型付き評価の走査対象（[Medium-4]・全 JS 評価述語に揃える）
型メタの取得候補と、型付き `IN` 評価の適用は、**実際に JS 評価される全述語**に揃える:
- WHERE
- HAVING
- **SELECT / WHERE 右辺等の `CASE WHEN` 条件**（`evalCaseWhen → evalWhere`。[process.ts:648](../../src/engine/process.ts#L648) / [evalWhere.ts:200](../../src/engine/evalWhere.ts#L200)）
- **サブテーブル UPDATE / DELETE / REORDER の WHERE**
- 必要なら DML 代入式内の `CASE`

### 1.5 `IN (SELECT ...)` も同じ型付き membership へ（[Medium-3]）
`evalWhere` はリテラル IN（`IN_LIST`）とサブクエリ IN（`SUBQUERY_IN_LIST`）が別分岐（[evalWhere.ts:102](../../src/engine/evalWhere.ts#L102)）。`USER_SELECT IN (SELECT code ...)` も現状は JSON 全体と値集合を比較して同じ不具合。→ **`IN_LIST` と `SUBQUERY_IN_LIST` の両方を、解決済み `Set<string>` を受け取る共通の型付き membership 関数へ通す**（サブクエリは実行済みの値集合を渡すだけなので同時対応が自然）。

### 1.6 頑健性（[Low-5]・形不一致もフォールバック）
配列/オブジェクト型の評価で、次はいずれも**例外にせず従来の文字列比較へフォールバック**する:
- `JSON.parse` に失敗。
- parse 成功だが**型契約と形が不一致**（CHECK_BOX なのに `"A"` や `{...}`、USER_SELECT なのに `["A"]` 等）。
- OBJECT_ARRAY の要素に**文字列 `code` が無い**。
- **空配列 `[]` は正常値**として `IN` は **false**、`NOT IN` は **true**（フォールバックしない）。
- **型メタ空・不明**: 従来の文字列比較を維持。**変数を含む IN** は `resolveVariableRefs` でリテラル置換後、同じ評価。

## 2. 受入テスト観点（必須・修正前 fail → 修正後 pass）
- **複数値の一致**: `CHECK_BOX IN ('A')` が要素 A を含む行に一致。`USER_SELECT IN ('rex0220')` が `code` 一致で一致（実機の 20 vs 0 を解消）。
- **[回帰防止] テキストの誤配列化なし**: `SINGLE_LINE_TEXT` の値が文字列 `["A"]` でも**配列扱いしない**（`IN ('["A"]')` で一致、`IN ('A')` で不一致＝従来の文字列比較）。
- **空配列**: 空の CHECK_BOX に対し `IN ('A')` は false、`NOT IN ('A')` は true。
- **ユーザー系は code**: `USER_SELECT IN ('開発太郎')`（表示名）は不一致、`IN ('rex0220')`（code）は一致。
- **CREATOR/MODIFIER**: 単一オブジェクトの `code` で一致。
- **[High-2] 型解決の衝突**: JOIN で**物理 CHECK_BOX と同名の集計 alias / 非修飾同名**があるとき、集計 alias・衝突非修飾は**従来比較**（配列誤評価しない）。`alias.field` は該当テーブル型で評価。CTE/一時テーブル由来は従来比較。
- **[Medium-4] CASE WHEN**: `SELECT CASE WHEN CHECK_BOX IN ('A') THEN ... END ...` の条件が要素比較で評価される。
- **[Medium-3] サブクエリ IN**: `USER_SELECT IN (SELECT code FROM ...)` が `code` 一致で評価される（JSON 全体比較でない）。
- **JOIN**: 修飾フィールドごとに正しい型で評価（片側 CHECK_BOX・片側テキスト等）。
- **サブテーブル仮想行**: サブテーブルの CHECK_BOX/MULTI_SELECT が要素比較（**子定義の再帰展開で型解決**）。`_p.X` は親型。**サブテーブル UPDATE/DELETE/REORDER** の WHERE でも型付き評価（対象件数・確認件数が正しく変わる）。
- **[Low-5] 形不一致フォールバック**: 型契約と形が違う値（CHECK_BOX なのに `"A"`/`{...}`、USER なのに `["A"]`、`code` 欠落）は例外にせず従来の文字列比較。
- **型メタ空/不明**: 従来の文字列比較を維持（挙動不変）。
- **変数**: `WHERE k IN (@a, @b)` がリテラル置換後に同じ評価。
- **NOT IN**: 各型で `IN` の否定（空配列は `NOT IN`=true）。
- **型メタ取得の限定**: `IN`/`NOT IN` を含まない FULL_SCAN で追加の getFields を発生させない。含む場合も候補のあるアプリのみ・キャッシュ再利用。
- **実機**: `主担当 IN ('rex0220')` が SIMPLE == FULL_SCAN（20 == 20）。CHECK_BOX/MULTI_SELECT のあるアプリで同様に一致。

## 3. 実装メモ（Codex 向け）
- **クライアント層（[High-1]）**: `nodeKintoneClient.getFields` / `ui/kintoneClient.getFields` を、`TABLE.fields` を**再帰展開**して `KintoneFieldInfo[]` を返すよう修正（両方同時）。子は子コードで、`_p.X` は親型。
- **型解決契約（[High-2]）**: raw Map でなく `FieldTypeResolver(field: FieldRef): string | undefined` を `evalWhere` に渡す。§1.3 の規則（直接 FIELD のみ・alias→物理テーブル・JOIN 非修飾は一意時のみ・衝突/CTE/集計 alias/関数結果は `undefined`）。
- **IN 判定（`evalOp` の `IN`/`NOT IN`）を型付き membership に統一（[Medium-3]）**: `IN_LIST` と `SUBQUERY_IN_LIST`（解決済み `Set<string>`）を共通関数へ。型 → 規則は §1.1（`SCALAR / STRING_ARRAY / OBJECT_ARRAY(code) / SINGLE_OBJECT(code) / UNKNOWN→従来`）。配列/オブジェクトは `JSON.parse`＋**形不一致/parse 失敗/code 欠落はフォールバック**（§1.6）。空配列は正常値。
- **配線（[Medium-4]）**: `evalWhere` を呼ぶ全経路（`runFullScan` の WHERE、`applyHaving`、`evalCaseWhen`、サブテーブル UPDATE/DELETE/REORDER 選定 [execute.ts:2506/2572/2779](../../src/execute.ts#L2506)）に resolver を渡す。型メタ取得候補の走査も同じ述語集合。
- FULL_SCAN で `IN`/`NOT IN` を含むアプリだけ型メタ取得（`getFieldTypeMap`・キャッシュ再利用）。JOIN・サブテーブルはテーブル/子別。
- SIMPLE モードは kintone が評価するため**変更不要**（本課題は FULL_SCAN の JS 評価のみ）。
- プラグイン: FULL_SCAN エンジンをバンドルするため **`npm run build`（plugin 含む）** で `desktop.js` 再生成。UI クライアント修正も含む。
- ドキュメント: 言語リファレンスの `IN` 節に「複数値/ユーザー系は要素/code 比較（FULL_SCAN）」を明記。

## 4. 位置づけ・次
- **フェーズ1（本課題）を独立コミットで完成・実機確認**してから、フェーズ2（型メタ付き押し下げ＋実在検証）へ。
- フェーズ2の親仕様は [ksql_selection_in_pushdown_spec.md](ksql_selection_in_pushdown_spec.md)（本課題完了後に押し下げ詳細を整理）。
