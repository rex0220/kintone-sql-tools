# B126 / B127 仕様 R3 codex レビュー依頼（2 回目）

**レビュー依頼であり実装依頼ではない。コードは 1 行も変更しないこと。**
git 操作をしないこと。kSQL MCP を叩かないこと（headless で無言停止する）。`npm test` は不要。

## 依頼

**B126 を「警告」から「押し下げ正規化」へ方針転換した R3** のレビューをお願いしたい。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.46.0）

読むもの:

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b126_b127_warnings_phase1_spec.md` | **レビュー対象の R3** |
| `docs/internal/ksql_b126_b127_codex_review_1.md` | 1 回目のレビュー（R2 まで反映済み） |
| `src/core/optimization/whereCapability.ts` | 分類。`LOCAL_SCALAR_TYPES` / `NATIVE_OPERATORS` ほか |
| `src/converter/whereToKintone.ts` / `selectToKintone.ts` | 押し下げの生成 |
| `src/core/fieldSemantics.ts` | `optionOrder` |
| `src/core/optimization/joinPredicatePushdown.ts` | JOIN の prefilter |
| `docs/ksql_language_reference.md` §6 / §4（447 行） | 押し下げ表・定義外選択肢の GAIA_IQ10 |

1 回目のレビューで高 4・中 6・低 1 をもらい全件反映した。**今回は方針が変わっている**ので、
R2 向けの指摘がそのまま当たらない箇所がある。**R3 の前提から見てほしい。**

## R3 の中心的な主張（これが崩れると設計が変わる）

> 正規化後の述語を **「利用者が最初から `IN ('X')` と書いた場合の AST」と同一**にすれば、
> 下流（単一表 / JOIN prefilter / `COUNT_TOTAL_COUNT` / `KORDER` 等）に**分岐を 1 つも足さずに済む**。

## 特に見てほしい点

### 1. 【最優先】正規化を差し込む位置と、`EXPLAIN` / 実行の一致

R3 §6-1。`classifyWhereCapability` の中で AST を書き換えるのか、その手前に正規化パスを置くのか。
**`ksql_explain` と実際の実行が必ず同じ述語を使うことが条件。**
現状 `EXPLAIN` と実行が WHERE をどこで共有しているかを示したうえで、
**正規化を置ける位置の候補と、それぞれの落とし穴**を挙げてほしい。

### 2. その位置で `optionOrder` を参照できるか

R3 §2.1 条件 5。`optionOrder` はフォーム定義の取得後に `ResolvedFieldSemantics` へ載る。
**正規化を行う位置でそれが確実に参照できるか**（取得前に走る経路が無いか）。
参照できない経路があるなら、そこでは正規化しない（fail-closed）で足りるか。

### 3. 「`IN` と同じ AST に落とせば下流は不変」は本当か

**下流に `=`（`BINARY` の `=`）を前提にした分岐が無いか**を確認してほしい。
たとえば

- kintone query 文字列の生成（`whereToKintone`）
- JOIN の prefilter 判定（`joinPredicatePushdown`）
- `COUNT_TOTAL_COUNT` / `KORDER` の適用判定
- `EXPLAIN` の `reason` / `fetch` の算出
- ローカル再評価（`evalWhere`）— **ここは元の `=` のまま評価してほしいのか、
  正規化後の `IN` で評価しても同じか**

とくに最後が重要。**正規化した述語でローカル再評価すると意味が変わる型が無いか。**

### 4. `= ''`（空文字）と `IS NULL` の関係

R3 は空文字を対象外にした（条件 6）。ただし言語リファレンス §6 の書き換え表は
`確度 IS NULL` → `確度 IN ('')` を「押し下がる形」として挙げている。
**`IN ('')` は実際に押し下がるのか**（`optionOrder` に空文字は無いはずで、
条件 5 と矛盾しないか）。`= ''` を対象外にする判断が妥当かを見てほしい。

### 5. `!=` を Phase 2 にする根拠（superset 性）

R3 §2.5 は「`not in` は空セル次第で部分集合になり得るので行が落ちる」としている。
**kintone の `not in` が未選択レコードを含むのか除くのか**、
既存の `NOT IN` 押し下げがどう扱っているかを確認してほしい。
**現在の `NOT IN` 押し下げが正しいなら、`!=` → `not in` も同時に入れられる**可能性がある。

### 6. B127 の抑止条件 2〜4 をどの情報から判定するか

R3 §3.2。「単一物理アプリ・JOIN なし・サブテーブルなし・CTE/UNION を経ていない」を
**どの構造体から判定できるか**。判定できないものがあれば、その条件は
「抑止しない（警告を出す）」側に倒せば安全か。

### 7. 受入条件で検出できない穴

R3 §4。とくに **`metrics.fetchedRows` が減ることを効果の証拠にする**という設計が
機能するか（減らない経路が無いか）。

## 出したい成果物

`docs/internal/ksql_b126_b127_codex_review_2.md` に、次の形で。

- 結論（実装着手可能 / 要修正・件数）
- 指摘（重要度 高/中/低・該当 §/file:line・内容・**コード引用による根拠**・提案）
- 上の 7 点への回答（コード引用つき）
- 仕様が正しかった点（R4 で消さないため）

重要度: 高 = そのまま実装すると誤る/既存を壊す、中 = 実装が詰まる/受入の穴、低 = 表現。
**根拠のないコメントは書かないでほしい。** 確認できなかった項目は「未確認」と明記のこと。
