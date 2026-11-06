# B204 `ASSERT` / `EXIT SUCCESS IF` のメッセージを変数で受ける

- 状態: 🔧 **実装済み・未リリース（2026-11-06。v3.90.0 見込み）**。テスト 39 件（`src/parser/__tests__/b204AssertMessageVariable.test.ts` 13 件・`src/__tests__/b204AssertMessageVariable.test.ts` 15 件・`src/flow-library/__tests__/b204AssertMessageVariable.test.ts` 11 件）
- 種別: 機能（**構文の受け口だけ**。変数の解決・外部注入・端の守りは B203 までで既にある）
- 優先: 低〜中（急ぎではない。依頼元の Ver.1 は「1 言語のまま」で出せる）
- 版: minor（v3.90.0 想定）。**純加法**＝リテラルで書いた既存の SQL と、`message` しか見ない既存の読み手は不変
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261106-KJ7-ASSERTのメッセージに変数.md`（依頼 KJ-7）。回答は同じ場所の `kSQLエンジンからの回答-20261106-KJ7-ASSERTのメッセージに変数.md`
- 関連: [B203](ksql_b203_array_variable_injection_issue.md)（外部注入。本件はその仕組みをそのまま使う）

## 1. なぜ必要か

依頼元（kSQL アクション）は kintone のログインユーザーの言語（`ja` / `en` / `zh`）で画面の文字を出し分ける。
プラグイン自身の文言は 3 か国語を持つが、**設定した人が書いた文字**は 1 種類しか持てない。
`ASSERT` / `EXIT SUCCESS IF` のメッセージは**仕様上はっきり「利用者の画面に出す文字」**（依頼元の仕様 §13）なのに、
**リテラル固定なのでここだけ 1 言語のまま**取り残される。

変数で受けられれば、呼び出し側が**利用者の言語で解決した文**を `variables` で注入するだけで済む
（メッセージの表は設定側に持つ）。代替案（リテラルがメッセージのコードと完全一致したら表示時に差し替える）は
仕組みが見えにくいので避けたい、という依頼元の判断。

## 2. 今の状態（v3.89.0 で実測）

| 形 | 今の動き |
|---|---|
| `ASSERT … , @m_x;` | **parse エラー** `KSQL1202 ASSERT のメッセージには文字列リテラルが必要です`（`parseFlowMessage` がカンマの後に `STRING` を強制） |
| `EXIT SUCCESS IF … , @m_x;` | **parse エラー** `KSQL1202 EXIT SUCCESS IF のメッセージには文字列リテラルが必要です`（`parseExit` に直書き） |
| `ASSERT … = @n, 'ng';` | **通る**（条件側は `parseAssertOperand` が `VARIABLE` を受ける＝`AssertOperand` に `VariableRef` がある） |
| `ASSERT … , @m_x \|\| '!'` / `CONCAT('a','b')` / `123` | いずれも同じ `KSQL1202`（メッセージはリテラル 1 個だけの受け口） |
| `EXIT SUCCESS IF … ;`（メッセージ省略） | **parse エラー**（`EXIT SUCCESS IF には末尾のメッセージ文字列が必要です`）。型も `message: string` で必須 |
| `ASSERT … , '';`（空リテラル） | `AssertError` の文末に**空白が 1 つ残る**（`suffix = ' ' + ''`） |
| `ASSERT WARN … , '';` | `warning: ""`＝**既定の文に落ちない** |
| 変数の解決 | 文の AST を丸ごと歩く 1 か所（`src/execute.ts` の `resolveBatchVariableReferences`）で `VARIABLE` を値に差し替える |
| 配列 / 未宣言 / `RELATIVE_DATE` の変数 | `analyzeBatch` が使い方（`scalar` / `select-column` / `array-in-list`）と宣言を突き合わせて**実行前**に拒否（`src/core/batch.ts:322-353`） |
| EXPLAIN のスカラー変数 | `@名前` のプレースホルダーに解決する（`src/execute.ts` の DECLARE 計画）＝**注入値は計画に出ない** |

**前例**: `VALIDATE` / DML の `CHECK WHEN … THEN <メッセージ>` は最初から式（`CheckRule.message: ScalarValueExpr`＝
`VariableRef` / `ConcatExpr` / `CASE` を含む）。利用者向けメッセージに変数を入れるのはエンジンとして既にやっていることで、
`ASSERT` / `EXIT` のリテラル固定が例外だった。

## 3. 出すもの

1. **構文**: `ASSERT [WARN] <条件>, @名前;` / `ASSERT <式> BETWEEN <式> AND <式>, @名前;` / `EXIT SUCCESS IF <条件>, @名前;`。
   **受けるのは変数参照 1 つだけ**（連結・関数・数値リテラルは不可。式を書いたら専用の診断で止める）。
2. **AST**（案 (b)＝純加法）: `AssertStatement.messageVar` / `ExitStatement.messageVar`（`AssertMessageRef = VariableRef | StringLiteral | NumberLiteral`）。
   リテラルの形は従来どおり `message`。**`EXIT` は `message: string` が必須なので、変数の形では `message: ""` を入れる**
   （`message` しか見ない読み手には「固定の文は無い」と見え、既定の文に落ちる＝落ち方が安全側）。
   案 (a)（`message?: string | VariableRef`）を採らなかったのは、`EXIT` 側が型の破壊的変更になり、
   公開面（`dist-flow/types/ast.d.ts`）の既存の読み手（`typeof === "string"` で分岐）も壊れるため。
3. **実行時**: メッセージの文字を 1 か所（`assertMessageText`）で求める。**空文字は「省いた」のと同じに正規化**（リテラルの `''` も同じ規則）。
   未解決の `VARIABLE` が届いたら（単文実行）条件を読む前に `ParseError: unresolved batch variable @名前.`。
4. **EXPLAIN**: 計画には**変数の名前**（`, '@m_x'`）を出す。注入値は出さない。
5. **CLI / MCP も同時に使える**（スカラーの注入は `--var` と MCP の `variables` に既にあるので、公開面の線引きは不要）。
6. 文書: 言語リファレンス §25（変数が書ける位置・注入の節）と §27.2 / §27.3、README の `/flow`、MCP の文型カタログ。

### E-1 の決め（空文字）

依頼の希望は「空文字はメッセージを省いたのと同じ（エラーにしない）」。**リテラルにも同じ規則を効かせた**（規則を 1 つにするため）。
これで変わる既存の動きは 2 つだけ:

1. `ASSERT …, '';` のエラー文の**末尾の空白が消える**。
2. `ASSERT WARN …, '';` の `warning` が **`""` から既定の文（`assertion failed: …`）に変わる**。

`EXIT` は「省いた状態」が構文上存在しないので、結果の `message` は **`""`** のまま返す（呼び出し側が自分の既定の文に落とす）。
CLI は空のとき `終了条件成立: <条件>` と表示する（従来は空行になっていた。ついで直し）。

### 受けない / 禁じないもの

- **数値の変数**（`SET @n = (SELECT COUNT(*) …)`）は**通し、文字表現を使う**。用途は無いが、禁じるために実行時の検査を増やすほどではない。
- **as-of 関数**（`@NOW()`）も同じ受け口を通る（時刻の文字列がメッセージになる）。禁じない。
- **配列 / 未宣言 / `RELATIVE_DATE`** は `analyzeBatch` が**何も足さずに**拒否する（§2）。`/flow` では `createExecutionContext` が投げる。
- **長さの上限は設けない**（注入値にもメッセージにも検査を入れない。parse は 10 万字でも通る）。表示側で丸める。

## 4. 受入基準（依頼 KJ-7 §6）

1. `ASSERT <式> = <式>, @var;` が parse を通り、AST にメッセージの参照が入る。
2. `BETWEEN` の形も同じ。
3. `EXIT SUCCESS IF` も同じ。
4. 注入（`variables: { m_no_stock: "在庫が足りません" }`）の値が、不成立のときのメッセージに出る。
5. 空文字はメッセージを省いたのと同じ。
6. リテラルの形がこれまでどおり（退行なし）。
7. `warn` 付きの `ASSERT` でも同じ。

## 5. 実装（2026-11-06）

| 触った場所 | 内容 |
|---|---|
| `src/types/ast.ts` | `AssertMessageRef` を足し、`AssertStatement.messageVar` / `ExitStatement.messageVar`（どちらも optional）を追加 |
| `src/parser/parser.ts` | `parseFlowMessage` が `FlowMessage`（`{ message?, messageVar? }`）を返す形に。`parseFlowMessageBody`（リテラル or 変数 1 つ）を `ASSERT` と `EXIT` で共有し、`rejectFlowMessageExpression` で連結・算術が続く形を専用の診断で止める。診断の文言を「文字列リテラルまたは変数（@名前）が必要です」へ |
| `src/execute.ts` | `assertMessageText`（解決後の値・空文字の正規化・未解決の拒否）と `explainFlowMessageText`（計画には名前）を足し、`executeAssert` / `executeExit` / EXPLAIN の 2 行をそれに差し替え。`executeExit` の結果は `message ?? ""` |
| `src/ui/renderResult.ts` | CLI の `EXIT` 表示で、メッセージが空なら `終了条件成立: <条件>` |
| `src/mcp/statementSyntaxCatalog.ts` | Flow-ASSERT / Flow-EXIT の文型に `\| @messageVariable` を追記（instructions の語数予算 +4＝`metadataTools.test.ts` の実測値も更新） |
| `src/core/batch.ts` | **変更なし**（メッセージの位置の `VARIABLE` は `collectVariableRefs` が `scalar` の使い方として拾い、宣言との突き合わせがそのまま効く） |
| 文書 | 言語リファレンス §25・§27.2・§27.3、README の `/flow`、本ファイル、台帳 |

**実装して分かったこと**: 端の守り（E-2 配列・E-3 未宣言・`RELATIVE_DATE`）は**新しいコードを書かずに満たせた**。
変数の解決が AST を丸ごと歩く 1 か所で、使い方の収集（`collectVariableRefs`）も型を見ずにノードの `type` で拾うので、
**新しいキー（`messageVar`）を足しただけで解決と静的チェックの両方に乗った**。
`b65GroupByConsumerAllowlist.test.ts` の行番号ピン（`src/parser/parser.ts:894` → `897`）は、B203 と同じく付随して更新した。

## 6. 再現

work-link の `ksql-action-kj7-assert-message-probe.mjs`（v3.89.0 での実測＝依頼書 §3 の 5 件・式の拒否・
実行時のエラー文と `warning` と `EXIT` の結果・EXPLAIN の計画・空リテラルの扱い・長い文字列・端の動きがどこで止まるか）。
モックの client で kintone に接続しない。

## 7. 依頼元への申し送り（回答 §7）

- **依頼元の表示の経路（未解決の AST の `message`）には注入値が届かない**。変数の形では `messageVar.name`（小文字）を見て、
  自分のメッセージ表から引く（**(ア) に決定**。2026-11-06）。`StatementError` に解決後の文を足す案（B204-2）は**不要で閉じた**。
- 引くのは**メッセージ専用の辞書**にすること（業務のパラメーターと同じ辞書を引くと `ASSERT …, @cust` で業務の値が画面に出る）。
- エンジンのエラー文（`AssertError`）は**変数と無関係に条件の SQL 本文と `actual` の値を含む**ので、
  「エンジンのエラー文は画面に出さない」という依頼元の決めは今後も維持してもらう。
