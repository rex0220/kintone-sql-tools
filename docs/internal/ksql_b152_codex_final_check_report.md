## 検査報告

### 指摘

1. **Medium — 4桁年の canonical 判定が不完全**

   - 箇所: `src/core/optimization/joinDateTimeLiteralPolicy.ts:2-11,21-23`
   - 根拠: `Date.UTC()` は年 `0～99` を `1900～1999` と解釈するため、仕様上の4桁実在日である `0001-01-01`～`0099-12-31`を誤って `unsafe` にする。一方、`0100`～`0999`は受理されるため、年境界の方針も明示されていない。
   - 影響: 前者は安全側の過剰拒否だが、後者がkintone serverで拒否される場合はquery errorを招く可能性がある。公式REST API仕様は形式を `YYYY-MM-DD` とするものの、年の受理範囲は明記していないため、実測が必要。[kintone REST API共通仕様](https://cybozu.dev/ja/kintone/docs/rest-api/overview/kintone-rest-api-overview/)
   - 修正案: `generateSeries.ts`と同様に年範囲を明示し、`setUTCFullYear()`で実在日を判定する。DATE/DATETIME双方に `0001`、`0099`、`0100`、`0999`、`1000`、`9999`の境界テストを追加する。

2. **Medium — §11.3の空セル期待表が独立した期待値として固定されていない**

   - 箇所: `src/__tests__/b152DateTextPushdownAcceptance.test.ts:136-166`
   - 根拠: 3経路の相互一致だけを検査しており、DATEの `<`・`!=`・`<=` は空セルを含み、`>=` は除外するという仕様上の期待ID集合を直接assertしていない。mock serverとlocal evaluatorが同じ方向に誤った場合も通過する。
   - 修正案: 演算子ごとの期待 `$id` を固定表として追加する。TEXT/LINKについても `=`、`!=`、`IN`、`NOT IN`の空セル包含・除外を固定する。

### 観点別結論

- **fail-open:** Critical指摘なし。非canonical日付・日時、空文字、空文字混在IN、TEXT/LINK範囲比較、ユーザー系全般、STATUS_ASSIGNEE、CALC、外部結合はいずれも`unsafe`または計画非適用を維持している。
- **canonical policy:** うるう年、`24:00`、秒付きTIME、DATETIMEのoffset・秒省略・小数秒・前後空白は正しく拒否される。`=`とrangeで判定差もない。ただし4桁年境界に上記指摘あり。
- **既存テスト書き換え:** 範囲外の意味変更は確認されなかった。server-only関数を含むwhole-WHERE exact消費は既存第5-W規則の自然な帰結。B76 mock変更も元WHERE residual維持の確認範囲内。
- **§受入逐語照合:** Phase 2全演算子、Phase 3全対象演算子、`<> → !=`、`in/not in`、引用符・バックスラッシュのserializer形、`relation: exact`、`fetch: EXACT`、canonical外EXPLAIN非適用は一致。空セル固定表のみ不足。
- **residual・B151回帰:** 通常述語は元WHEREをJOIN後に再評価する。NUMBER、`$id`、KLIKE、選択系の既存分岐に回帰は確認されなかった。
- **文書:** B84表、言語リファレンス、B76/B84歴史注記は実装と一致。Phase 4は全セル✕を維持している。
- **総合判定:** Critical/Highなし。Medium 2件を修正後、出荷判定を再実施するのが妥当。

### テスト結果

- B152重点5 suite: **181/181 PASS**
- 全体: **241/242 suites PASS、5747/5749 tests PASS**
- 失敗2件は`src/cli/__tests__/logicalExecution.test.ts`で、実行環境の`KSQL_USERNAME`/`KSQL_PASSWORD`がテスト設定のtoken認証を上書きしたもの。B152との関連なし。
- 環境変数除外後の再実行はJest cacheへの`EPERM`で完了できず。

### Claudeの実測が必要なもの

- DATE/DATETIMEの年境界、とくに`0001`～`1000`付近のserver query受理範囲。
- 実LINKフィールドでの`=`・`!=`・`<>`・`IN`・`NOT IN`、空セル、`"`・`\`の3経路一致。
- TEXT/LINKのNFC/NFD、半角/全角カナ、前後空白、escapeを各補集合演算子まで個別確認。
- DATE/TIME/DATETIME/CREATED_TIME/UPDATED_TIMEの全比較演算子と空セル期待表の実server確認。
- Node、CLI、MCP、Firefox、Chrome、engine libraryの全surface一致。