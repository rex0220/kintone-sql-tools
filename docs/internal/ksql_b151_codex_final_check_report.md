## 検査報告

### 指摘

1. **Medium — 単項 `+` の受理範囲が単純リテラルより広い**  
   `src/parser/parser.ts:3057-3078` で、先頭が `+` の RHS 全体を算術式パーサーへ渡し、`allowUnaryPlusNumber` を有効化している。このため意図した `WHERE 個数 = +5` だけでなく、`WHERE 個数 = +5 + 1` も `ARITH_VALUE` として受理される。また `NOT LIKE` は `parseSqlValue()` を直接使うため（同:2731-2733）、`field NOT LIKE +5` も構文上受理される。B151 の NUMBER exact には落ちないが、単純 numeric literal 受理に伴う仕様外の構文拡張である。  
   **修正案:** `parseWhereSqlValue()` に `PLUS + NUMBER` 専用分岐を設け、`parseSqlValue()` の汎用算術入口から `PLUS` と `allowUnaryPlusNumber` を外す。`= +5`、`BETWEEN +5 AND +6` は受理し、`= +5 + 1`、`LIKE +5`、符号の重複を従来どおり扱う回帰テストを追加する。

2. **Medium — §11 の「SQL・query文字列をそのまま使う」受入ゲートに差分がある**  
   `src/__tests__/b151NumberPushdownAcceptance.test.ts:265` の外部結合試験は、仕様 §11.19 の `SELECT m.製品名, t.個数 ... ORDER BY m.$id` ではなく、通常の INNER JOIN 用 SQL を `LEFT JOIN` へ文字列置換した `SELECT t.$id, t.製品名, t.個数 ... ORDER BY t.$id` を使用している。また同:155-157,239 の `IN` query 期待値は `個数 in (-6,10,1000)` だが、仕様 §11.13 は `個数 in (-6, 10, 1000)` を固定している。押し下げ非適用と値集合の主要挙動は検査できるものの、最終チェック依頼の「違う query 文字列・違う relation を1件ずつ照合」という条件を満たしていない。  
   **修正案:** §11.19 の SQL を逐語的な専用定数にし、§11.13 は仕様と実serializerのどちらを正本にするか確定して、仕様またはテストを同期する。各 §11.x の SQL・records API query・relation を個別の明示期待値として固定する。

**Critical: なし**  
**High: なし**  
**Low: なし**

### 観点別結論

1. **fail-open:** CORRECT。文字列 RHS、混在 `IN`、式、field-to-field、範囲外 literal、CALC、RECORD_NUMBER、非物理 source、曖昧 ownership は `exact` へ入らない。外部結合も実行計画側で非適用。  
2. **literal policy:** CORRECT。`raw` を `parseExactDecimal()` で判定し、30桁・小数10桁の検査後にだけ `formatPlainDecimal()` を呼ぶため、巨大指数で `"0".repeat(...)` を生成しない。`NumberLiteral.value` の丸め値を可否判定に使用していない。  
3. **parser の `+`:** FLAWED。単純 numeric literal より広い算術・LIKE RHSまで構文受理が広がる経路がある。WHERE以外の既存 DML/SELECT 経路への新たな影響は静的検査では確認されなかった。  
4. **§11 受入照合:** FLAWED。主要な値・relation・EXPLAINは対応するが、§11.19 のSQLと§11.13のquery文字列が仕様の逐語形と一致しない。  
5. **residual 維持:** CORRECT。通常 NUMBER leaf は `residualWhere` から除去されず、受入テストも `client residual` に元条件が残ることを固定している。  
6. **既存回帰:** CORRECT（静的確認）。`$id` gate、KLIKE/tree合成、ownership、外部結合、非物理source、search-aborted、B84生成表の既存経路は維持され、B76/B84にはB151による旧IEEE-754判断の失効注記がある。ただし全テストは今回実行していない。

### Claude の実測が必要なもの

- `npm test` 全体の通過確認と、修正前 fail → 修正後 pass の証跡。
- APP4228/4229で§11.2〜§11.19の3経路比較、実records API query、EXPLAIN、公開値・`$id`集合の一致。
- `numberPrecision` の5設定（16/4 HALF_EVEN、30/10 HALF_EVEN、30/0 HALF_EVEN、10/2 UP、10/2 DOWN）。
- `1e29`、`1e-10`、30桁境界、20桁＋小数10桁、`1e-11`、`1e30` のkintone query受理範囲。
- `IN` / `NOT IN` の重複・同値表記・ゼロ表記・安全整数外・空セル・最大桁・変数展開。
- Node engine、CLI、MCP、engine library、Firefox、Chromeの全surface一致。
- 取得上限改善例、上限超過、search-aborted、`onLimit=truncate` の非回帰。
- Firefox／Chromeの実ブラウザ smoke。