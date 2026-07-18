# B36 `REGEXP_REPLACE` の `occurrence` 引数（先頭／N 番目だけ置換）仕様

- 作成日: 2026-07-18
- ステータス: **仕様 R1・実装対象（v3.3.0 同梱）**
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B36
- 前提: B20 正規表現関数（[spec](ksql_regexp_function_spec.md)）。B20 実機検証中に「先頭 1 件だけ置換したい」という実需から派生

## 1. 背景

現状 `REGEXP_REPLACE(x, pattern, replacement [, flags])` は `global` 固定で**全置換**のみ（`evalFunc.ts:220` が `compileRegexp(..., true)`）。先頭 1 件や N 番目だけを置換する手段がない。MySQL/Oracle は `REGEXP_REPLACE(..., pos, occurrence, ...)` の `occurrence`（0=全部・N=N 番目）を持つ。回避策 `^(.*?)PATTERN`＋`$1` はあるが、アンカーに依存し汎用でない。

## 2. 構文

```text
REGEXP_REPLACE(x, pattern, replacement [, flags [, occurrence]])
```

- arity 3〜5（現状 3〜4 を 5 まで拡張）。
- **`occurrence` は第 5 引数**。kSQL の第 4 引数は `flags` なので（MySQL/Oracle の `pos` とは位置が異なる）、`occurrence` を指定するときは `flags` を明示する（不要なら空文字 `''`）。
- `occurrence` は式・フィールドを取れる**実行時評価**（B20 の他引数と同型）。

## 3. 意味論

| occurrence | 動作 |
|---|---|
| 省略 または `0` | **全置換**（現状と同一＝後方互換） |
| `1` | 先頭の一致だけ置換 |
| `N`（≥1） | N 番目の一致だけ置換 |
| 一致数より大きい `N` | 置換なし（`x` をそのまま返す） |

- `occurrence` は**非負整数**でなければならない。正規表現に必要な文字列表現は `/^\d+$/`（先頭ゼロは許容）。負数・小数・非数値は **`ArgumentError`**（実行時。第 3 引数が式も取れるため parse 時検証にしない）。
- N 番目だけ置換する場合も、置換文字列の**後方参照（`$1` 等）は当該一致に対して展開**する。`$\`` と `$'` は B20 の `assertRegexpReplacement` で従来どおり拒否。
- **ゼロ幅一致**（例 `x*`）でも無限ループしないこと。全置換経路（`String.replace` の global）と同じ前進規則を用いる。
- フラグ（`i`/`m`/`s`・`u` 強制）は従来どおり。`occurrence` はフラグに影響しない。

## 4. 実装方針（evalFunc.ts）

```ts
case "REGEXP_REPLACE": {
  assertArity("REGEXP_REPLACE", args, 3, 5);
  assertRegexpReplacement(args[2]);
  const occurrence = parseOccurrence(args[4]); // 省略時 0
  const re = compileRegexp(args[1], args[3] ?? "", true); // global
  if (occurrence === 0) return args[0].replace(re, args[2]);
  return replaceNthMatch(args[0], re, args[2], occurrence);
}
```

- `parseOccurrence(arg?: string): number` — 省略（`undefined`）は 0。`/^\d+$/` 以外は `ArgumentError`。
- `replaceNthMatch(input, globalRe, replacement, n)` — global 正規表現で走査し、**n 番目の一致だけ** `replacement` を後方参照展開して置換、他はそのまま。実装は `String.replace` のコールバックで一致回数を数え、n 番目でのみ当該一致に置換テンプレートを適用する方式を推奨（`$$`/`$&`/`$1`..`$99`/`$<name>` を JS 標準どおり展開。`$\``/`$'` は事前に拒否済み）。ゼロ幅一致は global の lastIndex 前進に委ねる。

## 5. SemVer・文書

- **minor**（純加法・省略時は全置換で後方互換）。v3.3.0 同梱。
- 言語リファレンスの `REGEXP_REPLACE` に第 5 引数 `occurrence` を追記（0=全部・N=N 番目・省略=全部・kSQL の第 4 は flags のため MySQL/Oracle と引数位置が異なる旨）。
- CHANGELOG・README 配布ノート・台帳 B36 を更新。

## 6. 受入（テスト化）

- 省略 / `0` = 全置換（現状の非回帰）。
- `1` = 先頭のみ・`2` = 2 番目のみ・一致数超 `N` = 無変化。
- `flags` 併用（例 `'i'` で大小無視の 2 番目だけ）。
- 後方参照 `$1`・リテラル `$$`・`$&` が N 番目置換で正しく展開。
- ゼロ幅一致（`a*` 等）で無限ループしない・妥当な結果。
- `occurrence` に負数・小数・非数値・空文字 → `ArgumentError`。
- 実行時評価（フィールド/式を `occurrence` に渡す）。
- 全 SQL 経路（SELECT/WHERE/UPDATE SET 等）で動作。
