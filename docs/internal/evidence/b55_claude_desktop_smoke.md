# B55 実機確認 — Claude Desktop（resources 非対応経路）smoke

- 実施日: 2026-07-21
- 環境: Claude Desktop・**リモート接続のデバイスブリッジ（`remote-devices` プロキシ）経由**＝B55 の発端となった「tools のみ中継し resources/prompts capability を通さない」経路
- ビルド: v3.12.0（`release/ksql-mcp.mcpb` を再インストール・branch feat/b55-mcp-docs-tool commit 1107139）
- 判定: **全項目 PASS**

## 確認結果

### 1. プローブ抑止＋全量関数回答（B55 の主目的）— PASS

「利用できる関数」の質問に対し、**`ksql_validate` 総当たりを一切行わず**、`ksql_docs` の §5/§8 を読んで種類別の全量回答を生成した（Sources に `ksql://language-reference/05-string-number-functions` / `08-group-by-aggregates` を明記）。

- v3.11.0 時点のプローブで**漏れていた実在関数がすべて回答に含まれる**: `GREATEST`/`LEAST`・`TRANSLATE`・`LENGTH_CHAR`・`LPAD`/`RPAD`・`TRUNCATE`・`LAST_DAY`・`DATE_ADD`・`REGEXP_LIKE`/`REGEXP_SUBSTR`。
- **エイリアス 5 種を正しく併記**: `SUBSTRING`（＝`SUBSTR`）・`CEIL`（＝`CEILING`）・`TRUNCATE`（＝`TRUNC`）・`POWER`（＝`POW`）・`CAST`/`CONVERT`（言語リファレンス R2.1 追記＋カタログの効果）。
- **contextual の区別も正確**: `CURRENT_DATE()`/`CURRENT_TIMESTAMP()`（JS 評価・SELECT 列可）と kintone 専用 `TODAY()`/`NOW()` を区別して説明。
- 方言注意（予約語のバッククォート・`NULLIF(x,0)` のゼロ除算ガードが空セル=0 で効かない・0 件集計は 1 行返す）まで文書ベースで正しく言及。

### 2. `ksql_docs` 引数なし＝統合インデックス — PASS

言語リファレンス 26 章＋レシピ R1〜R12 の全キーが目次として返り、モデルが「どの節を開くか」の導線として提示した。

### 3. 不存在関数（STDDEV）の照会 — PASS

`STDDEV` に対し「kSQL の集計関数は 6 つだけで分散・標準偏差系は含まれない。**§8 の一覧が確定的**」と文書根拠で即答（v3.11.0 時点はプローブの拒否観測から推定するしかなかった）。代替式の提案も文書の制約（IEEE754・空セル=0）を踏まえた内容で、幻覚なし。

## 補足

- 未知キーのアプリレベル `ArgumentError`（envelope バイト互換）とスキーマ層 `-32602` は、実機とは別に `mcp:smoke`（io-guard 有効・バイト一致 assert）と unit（`docsTool.test.ts`）で機械検証済み。
- v3.9.0 B50 実機確認（Claude/codex クライアント＝resources 到達可の経路）と合わせ、resource 経路・tool 経路の両導線が揃ったことを確認。

## 結論

仕様 R2.1 の目的「resources 非対応クライアントでも tool だけでドキュメントへ到達し、プローブ行動を抑止する」を実機で達成。リリース（v3.12.0）可。
