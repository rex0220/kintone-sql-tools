# B62 — AI 可視性の注記強化（B61 行動検証 22 シナリオの観測まとめ対応）

- 起票日: 2026-07-22
- ステータス: 📋 **対策案 R2 確定（2026-07-22・codex レビュー P1×10/P2×4/P3×3 反映・実装待ち）**
- 種別: 改善（ドキュメント/MCP 可視性・B60/B61 の後続）
- 効果種別: 機能（AI クライアントの SQL 組み立て精度・唯一の意味論 FAIL の再発防止）
- 関連: **B61**（観測の出所・[証跡](evidence/b61_scenario_smoke_claude_code.md)）／B60（instructions カタログ＝注記の置き場所）
- R1→R2: **R1 の「変数の使用可能位置」表自体が不正確**（そのまま載せると誤った言語仕様を教える装置になる＝B60 の R1 と同じ轍）。codex が parser/lexer 実装から**正確な境界を全数確定**（下記 §2-A-2 の文法カテゴリ表）。「算術オペランド不可」「SET 右辺不可」「VALUES 不可」はいずれも**条件付き**に限定・CHECK 評価行は文種別一覧へ・語数実測 16 語・§25 は既存表の改訂・受入はテーブル駆動代表ケースへ

## 1. 観測一覧（B61・4 ラウンド 22 シナリオ）

**観測イベントは全て実測。そこから導く言語境界は parser/lexer 実装調査（codex 裏取り）で補正済み。**

| # | 観測イベント（実測） | 実装上の正確な境界（裏取り済み） | 起点 | 深刻度 |
|---|---|---|---|---|
| 1 | `金額 >= @avg / 2` が ParseError | **変数から直接始まる一般算術式は、比較右辺・ASSERT・単独 SELECT 変数列（専用分岐が 1 トークンだけ消費する経路）で非対応**。B38 スカラー式（関数引数・`\|\|` 連結）の内部では変数は算術に参加できる | Q6 | 中（ParseError で自己回復可） |
| 2 | `SET @half = @avg / 2` が ParseError | **SET/DECLARE の外側スカラー式では他変数参照不可**。例外＝`SET @b = (SELECT ... WHERE x = @a)` の**スカラーサブクエリ内は先行変数可**（現リファレンス :2751 に記載あり）。DECLARE はサブクエリ自体不可 | Q6 | 中 |
| 3 | UPDATE の CHECK を post-image と誤解（§16 の組み込み検証記述を誤適用） | **CHECK の評価行は文種別**: INSERT/UPSERT VALUES=入力行・INSERT/UPSERT SELECT=ソース SELECT 出力行・**UPSERT は update 分岐でも入力ソース行**・**UPDATE=更新前スナップショット**・UPDATE FROM=ターゲット旧値＋source alias 新値・IMPORT UPDATE=インポート行（execute.ts:5081/5150/5214/9105） | R3-3/C1（n=2 で 1 FAIL/1 PASS） | **高（validate ok のまま意味がずれる・唯一の意味論 FAIL）** |
| 4 | `@max金額` が ParseError | 変数名の受理集合＝**`@[A-Za-z_][A-Za-z0-9_]{0,63}`**（先頭数字不可・最大 64 文字・大小文字は小文字へ正規化）。`@max金額` は `@max`＋`金額` に分割される | V2 | 低 |
| 5 | `VALUES` に @変数を書けず temp＋定数列へ迂回 | **INSERT/UPSERT/APPEND の VALUES では @x を「直接のセル値」として指定不可**（直接受理＝文字列/数値/符号付き数値/文字列配列/CASE・IF。CASE/IF 内部の条件・式には変数が入り得る） | V3 | 中 |
| 6 | スキーマ確認行動の揺れ（describe 使用/列名仮定が実行ごとに混在） | ツール不具合の証拠なし（単一クライアント・各 1 回）。instructions は既に DML 前の metadata 確認を要求済み | C2 | 中（運用側） |

補足（codex 調査で判明した「使える位置」の広さ）: WHERE 系文法は HAVING・CHECK WHEN・CASE/IF 条件・VALIDATE WHERE・APPLY PATCH/REMOVE WHERE に再利用され、**そのすべてで変数の右辺使用可**。ほか UPDATE SET 値（UPDATE FROM の SET 含む）・CHECK の THEN メッセージ（連結式可）・ASSERT オペランド・IMPORT SELECT 射影・スカラーサブクエリ内（先行変数）・`SELECT @x AS 別名`（AS 必須）。**不可**＝条件左辺・LIMIT/OFFSET・EXPECT ROWS・REJECT LIMIT・GROUP BY/ORDER BY・識別子位置・VALUES 直接要素・SET/DECLARE 外側式の他変数。

## 2. 対策案 R2（codex レビュー反映済み）

優先原則: **#3（意味論 FAIL）を最優先・二重化**（instructions＋description）。変数ファミリーは ParseError で fail-closed 済みのため **§25 の正確化を主**とし、instructions は誘導のみ。

### 対策 A: 言語リファレンス

1. **§16（:1814 直後）へ相互参照**（文面は codex 修正案採用・「更新前値」と一般化しない）:
   > これは書き込み候補に対する組み込み制約検証です。`CHECK` の評価行は別で、通常 `UPDATE` は更新前の既存値を参照します。新値を検査する場合は SET 式を CHECK に再掲してください。INSERT/UPSERT/UPDATE FROM を含む文種別の評価行は §17.3 を参照してください。
2. **§25 の既存「参照できる位置」行（:2728 の表）を概要として保ち、直後に「スカラー変数の配置詳細」を追加**（新設ではなく改訂）。内容＝§1 の文法カテゴリ表（使える側の広さ・不可側の限定・SET サブクエリ例外・変数名 regex/64 文字/小文字正規化）＋回避レシピ:
   > 派生値は元の SET のスカラーサブクエリ内で同時に計算する（`SET @half = (SELECT AVG(金額)/2 FROM …)`）か、条件側を変形する（`金額 * 2 >= @avg`）。既存変数から別の SET 変数を直接導出することはできない。VALUES に値を入れたい場合は temp テーブル＋`@x AS 列`（AS 必須）で実体化する。

### 対策 B: MCP instructions（`STATEMENT_SYNTAX_COMMON_NOTES` へ追加・別段落にしない＝5 段落 exact 維持）

- #3 の 1 文（**実測 16 語**）: `UPDATE CHECK sees pre-update values; to test the new value, repeat the SET expression inside CHECK.`
- Variables 誘導（**実測 7 語**・採用）: `Variable names start with ASCII letter/_; see ksql_docs for placement rules.`
- 語数 exact を **502→525** へ再固定（上限 550 内）。

### 対策 C: `ksql_mutate` description へ #3 の短縮形

- 全文 exact/サイズ guard は非対象だが**部分文字列 guard（metadataTools unit・mcp-smoke キー）はある**＝新文のキー句を `toContain`/smoke key へ追加して二重化の退行を防止。

### 対策 D: 検証運用（#6・コード変更なし）

- B61 定型プロンプトへ「`ksql_describe_app` で対象スキーマを確認してから書く」を明記。複数回再現したら instructions 昇格を再検討。

### 同時に直す軽微修正（codex P3）

- B61 evidence: タイトルを「手動実施記録（4 ラウンド・22 シナリオ）」へ・末尾の「（2 ラウンド）」stale 修正・Q6 所見の「比較右辺・IN 要素・関数引数のみ」という過度な限定を実測事実＋本書 §1 への参照に差し替え。

### 受入条件（実装時）

1. **意味論の実証**: R3-3（「引き上げ後 n 超」表現）を再実行して意味論 PASS。Q6/V2/V3 再実行で自己修正回数減（0 が理想）。
2. **テーブル駆動の代表ケーステスト**（parser＋batch analyzer・全数自動照合は過剰工学として不採用）: 受理側=WHERE/HAVING/CHECK/CASE/KLIKE/IN・`IN @list`/SELECT 定数列/IMPORT SELECT/UPDATE SET/UPDATE FROM SET/ASSERT/SET スカラーサブクエリ内の先行変数。拒否側=VALUES 直接要素/LIMIT・OFFSET/条件左辺/外側 SET・DECLARE の他変数/`@max金額` 分割。
3. instructions 語数 exact（525）・段落数 5 維持・description キー句 guard・全テスト green・mcp-smoke/pack-smoke/mcpb-verify green。
4. 言語リファレンスの配置詳細表がテスト（受入 2）と一対一対応。

## 3. 解決済み論点

- R1-Q1: **現表は不一致＝文法カテゴリ表へ全面改訂**（codex の実装調査を正として §1 に反映済み）。
- R1-Q2: **Variables 誘導 7 語を採用**（先頭規則＋docs 誘導を含む文面）。
- R1-Q3: **テーブル駆動の代表ケース固定を採用**・parser ソース自動走査は過剰工学として不採用。
