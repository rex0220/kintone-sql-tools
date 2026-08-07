# B151 仕様 R1 作成依頼（codex）

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと（`git status` も含む）。kSQL MCP を叩かないこと。`npm test` は不要。
**自分の MEMORY.md は読まないこと**（このファイルと参照先だけで完結させる）。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.59.0）

## 0. 依頼

**B151（JOIN の `<=` / `>=` の widening 正規化押し下げ）の仕様 R1 を、
そのまま実装依頼に出せる形で書いてほしい。** 本件に旧版は無い（R1 が初版）。

**出力は R1 の全文（Markdown）1 本。** レビューは別途 Claude が行う。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b151_join_inclusive_range_pushdown_issue.md` | **起票（実測 3 本・案 A の骨子）** |
| `docs/internal/ksql_b76_join_pushdown_phase_a_spec.md` | strict 限定の判断元（§5.2 の表・IEEE-754 境界） |
| `docs/internal/ksql_b84_pushdown_visibility_spec.md` | 公開表の生成・照合の仕組み |
| `src/core/optimization/joinPredicatePushdown.ts` | JOIN 分類器（`classifySupportedLeaf` の NUMBER 分岐） |
| `src/core/optimization/whereCapability.ts` | B126 正規化（`normalizeChoiceEquality`）＝同じ型の先行例 |
| `src/core/optimization/__tests__/b84PushdownDocs.test.ts` | 公開表のパリティテスト（**「正規化 → 分類」の観測順**へ変更済み） |
| `src/execute.ts` | 正規化の適用点（WHERE AST 共有・EXPLAIN の `pushdown normalized:` 行） |
| `docs/ksql_language_reference.md` §6 | B84 表・「押し下がる形への書き換え」表（`>= 5000000` → `> 4999999` の行がある） |

## 1. 決まっていること（変更しない・方針論に戻らない）

- **案 A＝widening 正規化を採用**（オーナー判断 2026-08-07）＝
  **安全整数リテラル L** に対し `x <= L` → `x < L+1`／`x >= L` → `x > L-1` へ正規化してから
  **既存の strict 分類（superset）に乗せる**
- **新しい安全性証明を持ち込まない**ことが本件の要点。境界安全性・空セル・再評価の意味論は
  **リリース済みの strict `<` / `>` 押し下げのものをそのまま継承**する。
  継承で説明できない拡張は Phase 1 に入れない
- **`L±1` が安全整数を外れる場合は正規化しない**（fail-closed・従来どおり全件取得）
- **結果は変えない**（superset＋取得後の再評価。変わるのは取得量と `fetch:` 表示だけ）
- **`EXPLAIN` で正規化を可視化する**（B126 の `pushdown normalized:` と同様の行）
- **単一表経路の挙動は変えない**（単一表の `<=` / `>=` は既に exact 直列化で押し下がっている。
  実測済み＝`WHERE 個数 <= 100` は `kintone query: 個数 <= 100` のまま EXACT）
- **B84 公開表の追随**＝実装後、NUMBER の `<=` / `>=` セルが ○ になる。
  パリティテストは「正規化 → 分類」の観測順なので、生成側に本正規化を通す形で同期する

## 2. 実測で確定している事実（再導出せず、そのまま使うこと。v3.59.0・APP4228/4229）

```
単一表  WHERE 個数 <= 100        → EXACT（kintone query: 個数 <= 100）
JOIN    WHERE t.個数 <= 100      → join pushdown not applied: UNSAFE_RELATION・JOIN 側 fetch: ALL
JOIN    WHERE t.個数 < 100       → pushdown applied: 個数 < 100・relation: superset・PREFILTERED
```

kintone のクエリ構文は数値の `<=` / `>=` を受け付ける（公式ドキュメントの演算子表）。

## 3. R1 で決めること（あなたがコードを読んで決め、根拠を ファイル:行 で示す）

1. **正規化の適用点**＝B126 と同じく WHERE AST 共有前に全経路で書き換えるか、
   JOIN prefilter の分類入力に限定するか。**単一表の `kintone query` 表示・
   `whereToKintone` 直列化・`evalWhere` 残余評価への影響を列挙して選ぶこと**
   （単一表の表示が `<= 100` から `< 101` に変わる案を採るなら、変わらない案との
   比較と理由を明記する）
2. **非整数リテラルの扱い**＝`<= 100.5` → `< 101` などの整数境界 widening を
   Phase 1 に入れるか。**strict 分類器が安全整数リテラルを要求している現行実装に
   矛盾なく載るか**をコードから判定し、入れないなら理由を Phase 線引きに書く
3. **負リテラル・0 跨ぎ・`L±1` の安全整数境界**の正確な条件式
4. **EXPLAIN 表示の形式**（`pushdown normalized:` の書式・既存 B126 行との並び）

## 4. R1 に必ず含めること

1. **規則**（対象＝NUMBER × `<=` / `>=` × 安全整数リテラル。正規化式・fail-closed 条件）
2. **適用単位**（JOIN の形・複数 JOIN・AND 合成・OR 内・`NOT` 内・単一表への影響有無）
3. **`EXPLAIN` の表示**と、`relation: superset` の維持
4. **B84 公開表・言語リファレンスの同期**（表のセル変更・書き換え表の該当行の扱い＝
   `>= 5000000` → `> 4999999` の行は**自動化後も手動の書き換えとして残すか削るか**を決める）
5. **受入条件**＝完全な SQL・公開結果（`EXPLAIN` の行・mock client の取得件数・結果 rows の同一性）で観測。
   **境界ちょうど（`L`・`L±1` の各値を持つレコード）・桁違い両方向・
   安全整数境界（`<= 9007199254740991` は正規化しない）・負リテラル・
   単一表回帰（`<=` のまま EXACT）・prefilter 有無で結果 rows が同一**を必須で含める
6. **Phase の線引き**（DATE / DATETIME / TIME range・`!=`・TEXT `in` 等は対象外＝
   空セル意味論の新規証明が要るため。B76 の「やらないこと」を維持）
7. **未確認事項**（あなたは実行できないので、Claude が実測すべきことを列挙する）

## 5. 書き方の制約

- **受入条件に内部実装を要求しない**
- **「示した形が実際に動く」ことを受入に含める**
- **コードで確定できることと、実行しないと分からないことを区別する**
- **日本語。既存の仕様書（`ksql_b149_generate_series_spec_r2.md`）と同じ体裁**
- **根拠の無い断定を書かない**

上記に従い、**R1 の全文を Markdown で出力**してください。ファイルへの書き込みは不要です。
