# B202 `npm pack --json` を使う検証スクリプト 2 本が `prepack` の標準出力で壊れている

- 状態: 📝 **起票のみ（2026-10-28。v3.88.0 のリリース作業中に発見。直し方は決まっているが、リリースを止める問題ではない）**
- 種別: 課題（検証スクリプトが動かない。製品の動きには影響しない）
- 優先: 低（配布物そのものは `engine:pack-smoke` と `mcpb:verify` で確かめられている）
- 関連: B135（`mcp:smoke` の期待値が古くなっていた例。v3.49.0 以前でリリース済み＝[リリース履歴](../ksql_release_history.md)）

## 1. 現象

`npm run engine:docs-smoke` と `npm run mcp:pack-smoke` が、どちらも `npm pack --json` の出力を `JSON.parse` できずに落ちる。

```
SyntaxError: Unexpected token 'v', "[version-sy"... is not valid JSON
    at packFilename (scripts/engine-docs-examples-smoke.mjs:53)
[mcp-pack-smoke] Could not determine npm pack filename from output:
```

原因は `package.json` の **`prepack`** が `version:check:release` と 6 本のビルド・ガードを呼び、**それぞれが標準出力へ書く**こと。
`npm pack --json` の stdout は JSON だけである前提の実装なので、先頭に `[version-sync] …` が混ざって parse に失敗する。

- `prepack` は公開時（4f197cb）からあり、両スクリプトはそれ以前の前提で書かれている＝**今回の変更で壊れたのではない**（v3.88.0 の作業前から落ちる）。
- 落ちているのは **ファイル名の取得**だけで、`npm pack` 自体は成功している（`npm test` の対象外のスクリプト）。

## 2. 影響

- `engine:docs-smoke`（README / 言語リファレンスの engine 例を実際に tarball から import して動かす検証）と
  `mcp:pack-smoke`（MCP の配布面の検証）が**リリース前に回せない**。
- 代替で効いているもの: `engine:pack-smoke`（tarball の中身・ESM/CJS/types/runtime）・`engine:declaration-smoke`・
  `engine:bundle-guard`・`flow:bundle-guard`・`mcp:smoke`・`mcp:dual-era-smoke`・`mcpb:verify`。いずれも v3.88.0 で ok。

## 3. 案（未決定）

- **案 A**: 両スクリプトの `packFilename` を「stdout の**最後の JSON 配列**だけを拾う」ように直す（`output.slice(output.indexOf("["))` 相当）。最小。
- **案 B**: `npm pack --json --ignore-scripts` を使う（prepack を回さない）。ただし**ビルド済み成果物が前提**になるので、呼ぶ前に `npm run build` を要求する注記が要る。
- **案 C**: `npm pack` にファイル名を推測で付ける（`rex0220-kintone-sql-tools-<version>.tgz`）。版と scope に依存するが単純。

推奨は**案 A**（stdout の形に依存しない・prepack の検証はそのまま効く）。案 B は「配布物を作ってから確かめる」という smoke の目的を弱める。
