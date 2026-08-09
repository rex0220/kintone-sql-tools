# B53 Stage 1 レビュー指摘の修正依頼（codex・2 件）

[Stage 1 実装](ksql_b53_codex_impl_request.md)の Claude レビュー指摘。禁止事項は実装依頼 §0 のとおり。

## 指摘 1（要修正）: 列名リストが非再帰 CTE でも受理され、実行で黙って無視される

`parseWith()` は `parseOptionalCteColumnAliases()` を**全 CTE に無条件で**呼ぶ。
その結果、①`RECURSIVE` なしの通常 `WITH t (x) AS (...)`、②`WITH RECURSIVE` 内の
**自己参照しない sibling** に列名リストを書いても受理され、実行側は `columnAliases` を
消費しないため**黙って無視される**（宣言した列名で参照できない/挙動が仕様と無関係になる）。

仕様 R4 §1.1/§2 の列名リストは**再帰 CTE の定義のみ**が対象。修正＝
**`recursiveSpec` が付かない定義に `columnAliases` があれば ParseError**
（「CTE の列名リストは WITH RECURSIVE の再帰 CTE にだけ指定できます」級・fail-closed）。
判定は §2 のとおり定義単位（`WITH RECURSIVE` モードでも sibling は拒否）。

テスト追加: 通常 WITH の列名リスト拒否／RECURSIVE WITH の非再帰 sibling の列名リスト拒否／
再帰 CTE 本体の列名リストは引き続き受理（既存 44 テストの非回帰）。

## 指摘 2（要修正・軽微）: 禁止ノード検査に実在しない型名

`parser.ts:1426` の `containsRecursiveForbiddenNode()` が `"AGG_ARITH_COL"` を見ているが、
この型名は AST に存在しない。実在は **`"ARITH_AGG_COL"`**（SELECT 列・`src/types/ast.ts:1216`）と
`"AGG_ARITH"`（式ノード・`ast.ts:1208`）。現状は内包する `"AGG_REF"` で結果的に検出されるため
実害は確認されていないが、検査の意図と一致しない文字列を残さない。

修正＝`"AGG_ARITH_COL"` → 実在の `"ARITH_AGG_COL"`（`"AGG_ARITH"` も加えてよい）。
テスト追加: 再帰項に `SUM(a) - SUM(b)` を書いた負例 1 本（拒否文言は既存と同じ）。

## 報告

最終メッセージ＝修正報告のみ（変更ファイル・追加テスト・`npm test` 全体の結果）。
