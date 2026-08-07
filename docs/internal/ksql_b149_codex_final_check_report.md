# B149 最終検査報告

## 指摘

### High — 数値リテラルが `Number` 丸め後に整数判定され、非整数を誤受理する

- 箇所: [src/core/generateSeries.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/generateSeries.ts:33)、[src/core/generateSeries.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/generateSeries.ts:86)
- 根拠: `numberLiteralText()` の正確な字句を `Number(...)` に変換してから `Number.isSafeInteger()` を適用している。仕様 R2 §3.1 の「指数表記を解決した値も整数」「安全整数」を字句どおりに検証できない。
- 実測:
  - `GENERATE_SERIES(1e-400, 1e-400)` → 本来 `ArgumentError` だが `"0"` を1行生成
  - `GENERATE_SERIES(1.0000000000000000001, ...)` → `"1"` として誤受理
  - `GENERATE_SERIES(9007199254740990.9, ...)` → `"9007199254740991"` として誤受理
- テスト不足: [src/__tests__/b149GenerateSeries.test.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/__tests__/b149GenerateSeries.test.ts:213) は通常の小数だけで、浮動小数点丸め・underflow 境界を検査していない。
- 修正案: NUMBER 引数は `numberLiteralText()` の正規化結果が整数文字列であることを先に確認し、`BigInt` で安全整数範囲を検査してから `number` に変換する。丸め後の `Number.isSafeInteger()` を正当性判定に使わない。上記3例の回帰テストを追加する。

### Medium — TIME が仕様所定の DATETIME/TIME 診断にならない

- 箇所: [src/core/generateSeries.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/core/generateSeries.ts:112)、[src/__tests__/b149GenerateSeries.test.ts](C:/Users/rex02/Projects/kintone-sql-tools/src/__tests__/b149GenerateSeries.test.ts:218)
- 根拠: 未対応日時判定が `YYYY-MM-DDT...` の DATETIME だけを認識し、TIME を認識しない。仕様 R2 §10.9 は DATETIME / TIME 共通の公開診断を定めている。
- 実測: `GENERATE_SERIES('12:00','13:00','1 day')` は、所定の「DATETIME と TIME は使用できません」ではなく「実在する YYYY-MM-DD 形式の DATE」を返す。
- 修正案: DATE 判定より前に TIME 形式も未対応 temporal として分類する。DATETIME だけでなく `HH:mm` などの TIME ケースを、公開メッセージ全文を固定するテストへ追加する。

Critical 指摘なし。

## 観点別結論

1. 仕様 R2・§12受入条件: 主要なSQL・結果・例外・警告は一致。ただし上記の厳密数値判定とTIME診断に仕様逸脱あり。
2. 診断文・文書SQL: FROM直置きの修正例、言語リファレンス、構文カタログの具体例は機械的にparse成功。「従うと壊れる」SQLは検出なし。
3. 警告抑止のfail-open: JOIN、自己JOIN、UNION、通常CTE再実体化、一時テーブル、式参照、生成列なしを実測し、すべて警告を維持。直接参照・WHERE・正しい修飾参照だけ抑止され、Critical経路は検出なし。
4. 上限ガード回避: 再帰走査は `CREATE TEMP TABLE AS WITH` と `EXPLAIN WITH` に到達し、超過を実測拒否。サブクエリ内WITHは現行文法で構築不能。保存クエリも実行時共通検証経路を通るため、静的には回避経路なし。
5. 境界の1行ずれ: 正負stepの全4象限、`start = stop`、stop到達、stop直前、DATE正負stepについて `countRows` と生成ループは一致。
6. 既存挙動の回帰: 通常識別子・バッククォート識別子、既存 `$id` 証明、既存警告文、DECLARE契約にB149起因の回帰は検出なし。

## Claudeによる実測が必要なもの

- 通常の書込み可能な環境で `src/__tests__/b149GenerateSeries.test.ts` 全体、特に保存クエリ試験を再実行すること。現在環境ではJestがキャッシュ書込みの `EPERM` と `.tmp/b110-release-baseline/package/package.json` のmodule-name collisionで起動できなかった。
- `tsc --noEmit` はB149対象外の既存 `src/ui/desktop.ts` 型エラーで終了したため、標準のリリース用build/testによる全体コンパイル確認が必要。

