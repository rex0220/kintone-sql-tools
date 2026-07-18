# 課題: B28 DML値における単項符号の受理不整合

- 作成日: 2026-07-17
- ステータス: **課題実装済み・実機確認済み（2026-07-18・[実機記録](evidence/b28_unary_sign_smoke.md)）・v3.2.0 リリース待ち**
- 種別: バグ（一貫性）
- 関連: [B15 `IN`リストの負数リテラル](ksql_in_list_negative_number_issue.md)

## 1. 症状

数値リテラルとして自然な `-5` が、`INSERT ... VALUES` と `UPSERT ... VALUES` ではパースできない。

```sql
INSERT INTO APP4221 (金額) VALUES (-5);
-- ParseError: INSERT の値には文字列・数値・配列リテラル・CASE WHEN が必要です
```

`'-5'`なら通るが、これは文字列を渡してkintone側の変換へ依存する回避であり、数値リテラル受理の代替契約にはしない。

## 2. 原因

`parseInsertRow`（`src/parser/parser.ts:2069`）は値を1トークンだけ読み、`STRING`または符号なし`NUMBER`だけを受理する。`-` / `+`は数値の一部でなく別トークンなので拒否される。

INSERTとUPSERTのVALUES形式は同じ`parseInsertRow`を共有するため、両方に同じ欠陥がある。親レコードとサブテーブルINSERTも同じ経路である。

一方、UPDATE SETは`parseAssignmentValue`から算術式パーサーへ進む。現状の算術一次式は単項`-`を受理するが単項`+`を受理しない。したがって「全DMLで単項符号が一律に使えない」のではなく、経路と符号による非対称である。

## 3. 現状マトリクス（実装前・2026-07-17 時点の記録。実装後は全経路で -5/+5 を受理）

| 経路 | `-5` | `+5` | 根拠 |
|---|---:|---:|---|
| 親 `INSERT ... VALUES` | ❌ | ❌ | `parseInsertRow` |
| サブテーブル `INSERT ... VALUES` | ❌ | ❌ | 同じ`parseInsertRow` |
| `UPSERT ... VALUES` | ❌ | ❌ | 同じ`parseInsertRow` |
| `UPDATE ... SET field = ...` | ✅ | ❌ | `parseArithPrimary`は単項`-`のみ |
| `INSERT/UPSERT ... SELECT` | SELECT式の文法に従う | SELECT式の文法に従う | VALUES経路ではない |
| 一時テーブルをソースにするSELECT-based DML | SELECT式の文法に従う | SELECT式の文法に従う | VALUES経路ではない |
| 一時テーブルを更新対象にするDML | 対象外 | 対象外 | kSQLは一時テーブルへのDML自体を禁止 |

> 「一時テーブルDMLもVALUESと同様に直す」という課題設定は誤り。一時テーブルは`CREATE TEMP TABLE ... AS SELECT`と`DROP`のみで、INSERT / UPSERT / UPDATE / DELETEの対象にはできない。確認対象は**一時テーブルをソースにするSELECT式**である。

## 4. 決定

- 数値リテラルを受理する位置では、単項`-`と単項`+`を対で受理する
- `-5` / `+5`は`NumberLiteral`へ正規化し、文字列`'-5'` / `'+5'`とは区別する
- VALUESに一般の算術式やフィールド参照を解禁しない。今回の拡張は**符号付き数値リテラルだけ**に限定する
- `--5`, `+-5`, `-+5`, `++5`はv1では拒否する。単項演算子の任意ネストへ広げない
- `-0`はNumberLiteralとして受理する。保存時の正規化とB9の数値同値契約は別問題
- B15へ戻さない。B15はINリスト、B28はDML値で消費先と回帰範囲が異なる

## 5. 実装対象

- `parseInsertRow`: `MINUS` / `PLUS`の直後に`NUMBER`を必須とし、符号付き`NumberLiteral`へする
- `parseArithPrimary`: 単項`+`も受理する。**対象範囲は実装時に確定（2026-07-18・仕様担当決定）: 数値リテラル直前のみ**（UPDATE SET の値文脈に限定するフラグ制御・`+field` や式全体へは広げない＝§4「符号付き数値リテラルだけに限定」と整合）。単項`-`の既存受理範囲は不変とし、符号のネスト（空白入り `- -5` 等）は明示 ParseError にする。なお空白なしの `--` は SQL 行コメントとして字句解析されるため、そもそもパーサへ届かない（実測）
- パーサーエラー位置は符号または直後の不正トークンを指す
- AST、DML変換、VALIDATE ONLY、ON ERROR SKIPは既存の`NumberLiteral`経路を再利用する

## 6. 受入条件

### 受理

- 親INSERT、サブテーブルINSERT、UPSERT VALUESで`-5`, `+5`, `-0`, `+0`, `-0.5`, `+0.5`
- UPDATE SETで同じ6値
- 複数行VALUESで正負が混在しても各行を正しく保持する
- VALIDATE ONLY / ON ERROR SKIPでも通常実行と同じASTになる
- EXPLAINと実行が同じパーサー結果を使う

### 拒否・非回帰

- 符号の直後が文字列、配列、CASE、変数、右括弧、EOF
- `--5`, `+-5`, `-+5`, `++5`
- VALUES内の`1 + 2`、フィールド参照、任意関数は従来どおり拒否
- `'-5'`は文字列のまま
- 一時テーブル対象DMLは従来どおり「非対応」であり、B28を理由に解禁しない
- INSERT SELECT / UPSERT SELECTの列式と一時テーブルソースについて、既存のSELECT文法を変えない

## 7. SemVer

受理範囲の追加で既存の成功SQLの意味を変えないため、単独ならpatch相当。ただしB26/B27と同梱する理由はない。
