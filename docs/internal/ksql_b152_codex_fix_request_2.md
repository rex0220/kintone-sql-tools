# B152 修正依頼 2（codex・CALC の JOIN 開放＝オーナー判断）

**オーナー判断（2026-08-07）: 「CALC は書式にかかわらず、単一表と同様に押し下げてよい。
書式に合わない値を指定したときは kintone エラーになる（それで構わない）」。**
これを B152 のスコープへ追加実装する。禁止事項は実装依頼と同じ。

## 1. 実装内容

- **JOIN prefilter で CALC を開放**する。演算子は kintone の CALC 演算子表どおり
  `=` `!=` `<>` `<` `>` `<=` `>=` `IN` `NOT IN`
- **literal policy**＝B151 の numeric literal policy を満たす数値 literal、
  または非空 string literal（エスケープは既存 serializer）。**canonical 制約は課さない**
  （CALC は表示書式で値領域が変わり、単一表の直列化も書式検査を課していない。単一表とそろえる）
- **relation は `superset`**（`exact` にしない）＝全書式の順序意味論を証明していないため、
  正しさは従来どおり JOIN 後の残余再評価で担保する
- **書式に合わない literal による kintone query error はそのまま表面化**する
  （単一表と同じ。全件取得への silent retry 禁止＝既存 fail-closed 原則）
- 空文字 literal・空 list・式・field-to-field は従来どおり unsafe

## 2. 文書

- B84 表の CALC 行を ○×8 へ（パリティ生成器経由）。凡例または注記に
  「CALC は superset（取得後に再評価）・書式に合わない値は kintone のエラーになる」を追記
- 仕様 R1 §5 の CALC 行・§5.1 の理由表・B151 仕様 §5（CALC を対象外に維持する理由）へ
  **日付付きのオーナー判断注記**を追加（「単一表との一致を優先し superset で開放。
  時間書式等の順序は kintone 準拠＝単一表と同一」）
- 言語リファレンスの CALC 記述を同期

## 3. テスト

- 数値書式 CALC の 3 経路一致（実測済み＝{-108,-115,-105} の形を mock で固定）
- `relation: superset`・`fetch: PREFILTERED` の EXPLAIN 固定
- mock client が query error を返す場合に**握りつぶさず表面化**することの固定
- 空文字 literal・混在 IN の unsafe 維持
- 修正前 fail の確認・既存テスト変更の列挙・`npm test` 全体（環境変数除外可・EPERM 時は報告のみ）

最終メッセージ＝修正報告のみ。
