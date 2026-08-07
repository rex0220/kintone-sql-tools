# B151 仕様作成依頼 R2（codex）——前提転換＝「そのまま押し下げ」

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。`npm test` は不要。
**自分の MEMORY.md は読まないこと。**

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.59.0）

**旧依頼（`ksql_b151_codex_spec_request_r1.md`・widening 正規化前提）は破棄済み。参照しないこと。**
その出力も破棄された（保存されていない）。**本依頼が正**で、出力する仕様が R1（初版の正本）になる。

## 0. 前提の転換（実測で確定。再導出せず、そのまま使うこと）

widening（`<= L` → `< L+1`）は**不要**になった。オーナーの指摘を実測で追った結果:

1. **現行のローカル数値比較は 10 進厳密**＝`src/core/scalarCompare.ts` の `numberKey` が
   `parseExactDecimal`（band 2）で比較する。binary64 ではない
2. **境界すれすれの実測（v3.59.0・APP4228）**＝格納値 `999999999999.9999`・
   リテラル `999999999999.99985`（binary64 では同値に丸まる組）で、
   **押し下げ経路・FULL_SCAN 強制経路（`OR ... LIKE` で残余化）・算術経由（`個数 + 0`）の
   3 経路すべてが同じ結果**。ローカルも 10 進で判定している
3. **空セルの実測**＝空の数値セルは **kintone・ローカルとも「最小値」扱いで両方向一致**
   （`個数 < 100` は両者とも空セル行を含む／`個数 >= -5` は両者とも除外）
4. **B76 Phase A の「IEEE-754 境界のため inclusive は不可」は、現行実装では前提が成立していない**
5. kintone の数値精度はアプリ設定 `numberPrecision`（既定 16 桁・小数 4・HALF_EVEN、
   最大 30 桁・小数 10）。格納時に丸められる（`0.1234567890123456789` → `0.1235` を実測）

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b151_join_inclusive_range_pushdown_issue.md` | **起票（§2.5〜2.6 に上記実測の全記録）** |
| `src/core/scalarCompare.ts` / `src/core/exactDecimal.ts` | 現行のローカル数値比較（10 進厳密） |
| `src/core/optimization/joinPredicatePushdown.ts` | JOIN 分類器（`classifySupportedLeaf` の NUMBER 分岐＝開放対象） |
| `src/execute.ts` | JOIN 後の残余 WHERE 評価経路（どの比較器を通るかの証明対象） |
| `docs/internal/ksql_b76_join_pushdown_phase_a_spec.md` | 無効化された旧判断（§5.2）。歴史として参照 |
| `docs/internal/ksql_b84_pushdown_visibility_spec.md` / `src/core/optimization/__tests__/b84PushdownDocs.test.ts` | 公開表の生成・照合（「正規化 → 分類」の観測順） |
| `docs/ksql_language_reference.md` §6 | B84 表・「押し下がる形への書き換え」表（`>= 5000000` → `> 4999999` の行は不要になる） |

## 1. 依頼

**B151 の仕様を、そのまま実装依頼に出せる形で書いてほしい。出力は全文（Markdown）1 本。**

方向＝**NUMBER の field-vs-literal 比較を、JOIN prefilter でそのまま押し下げる**。
安全性の根拠は「**ローカルと kintone の数値比較意味論の一致**」の証明（B78 local contract の形式）。

## 2. あなたがコードから証明・決定すること（ファイル:行 で根拠を示す）

1. **JOIN 後の残余 WHERE 評価が実際に通る比較器**＝`scalarCompare`（10 進）経由であることを
   経路で証明する（別の比較実装が残っている経路があれば列挙し、対象外にする）
2. **10 進比較器の導入版の特定**＝git 履歴は使えないので、コード・文書・CHANGELOG から
   分かる範囲で（B76 判断が書かれた時点との前後関係。分からなければ「未特定」と明記）
3. **開放する組の確定**＝NUMBER の `<=` / `>=` は必須。同じ根拠で
   **`<` / `>` の安全整数リテラル制限の解除・`!=`・`=` の superset→exact 昇格・`IN` / `NOT IN`** が
   開けるかを個別に判定する（端の意味論を列挙＝空セル・非数リテラル・指数表記・`+0`/`-0`・
   巨大 scale・`numberPrecision` を超えるリテラル）。開けない組は理由を書く
4. **CALC を対象外に維持する理由の現行化**（表示書式で値形式が変わる等）
5. **DATE / TIME / DATETIME の range** を Phase 2 候補として整理する
   （DATE のローカル比較は canonical 文字列＝日付順一致。kintone との一致証明に何が要るか）

## 3. 仕様に必ず含めること

1. 規則（開放する組・端の挙動の表）
2. `EXPLAIN` の表示（`relation:` の値・従来の `pushdown applied:` 行）
3. **B84 公開表・言語リファレンスの同期**（NUMBER 行のセル変更、
   「押し下がる形への書き換え」表の `>= 5000000` → `> 4999999` 行の削除または改訂、
   B76 旧判断への注記の扱い）
4. **受入条件**＝完全な SQL・公開結果で観測。**境界すれすれペア（§0-2 の実測値を含む）・
   空セル両方向・3 経路（押し下げ / FULL_SCAN / 単一表）の結果一致・prefilter 有無で結果 rows 同一・
   桁違い両方向・負リテラル・指数表記リテラル**を必須で含める
5. Phase 線引き（DATE range・CALC・TEXT 系は Phase 2 以降）
6. 未確認事項（Claude が実測すべきこと。**アプリ設定 `numberPrecision` を変えたアプリでの
   境界実測**を含めること）

## 4. 書き方の制約

- 受入条件に内部実装を要求しない／「示した形が実際に動く」ことを受入に含める
- コードで確定できることと、実行しないと分からないことを区別する
- 日本語。既存の仕様書（`ksql_b149_generate_series_spec_r2.md`）と同じ体裁
- 根拠の無い断定を書かない

上記に従い、**仕様の全文を Markdown で出力**してください。ファイルへの書き込みは不要です。
