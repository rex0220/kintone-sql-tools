# B152 仕様 R1 作成依頼（codex）——Phase 2〜4 を B151 と同梱リリース

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作をしないこと。kSQL MCP を叩かないこと。MEMORY.md を読まないこと。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`
（**B151 実装済みの作業ツリー**＝`joinNumberLiteralPolicy.ts`・NUMBER 8 演算子 exact が既に入っている。
これを土台・先行例として使う）

## 0. 依頼

**B152 のうち Phase 2〜4 を 1 本の仕様 R1 にまとめて書く**（オーナー判断＝B151 と同梱リリース）。

| Phase | 対象 | 開放する組（kintone が受ける範囲で） |
|---|---|---|
| 2 | `DATE` / `TIME` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | `!=` と範囲（`< > <= >=`）・既存 `=` の exact 昇格可否 |
| 3 | `SINGLE_LINE_TEXT` / `LINK` | `!=`・`IN` / `NOT IN`・既存 `=` の exact 昇格可否 |
| 4 | `CREATOR` / `MODIFIER` / `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | `IN` / `NOT IN` |

**CALC・RECORD_NUMBER（Phase 5）は含めない**（表示書式・アプリコードの値領域証明が別格。
`$id` が代替。理由を Phase 線引きに書く）。

出力は仕様全文（Markdown）1 本。参照体裁は [B151 仕様 R1](ksql_b151_join_number_pushdown_spec_r1.md) と同じ。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b152_join_pushdown_all_types_issue.md` | 起票（棚卸し表・先行実測＝DATE/TEXT の空セル方向一致） |
| `docs/internal/ksql_b151_join_number_pushdown_spec_r1.md` | 先行例（意味論契約・受入・EXPLAIN・文書同期の型） |
| `src/core/optimization/joinPredicatePushdown.ts` / `joinNumberLiteralPolicy.ts` | B151 後の分類器 |
| `src/core/scalarCompare.ts` / `src/core/fieldSemantics.ts` | 型別のローカル比較（string / option / user 系の実体） |
| `src/engine/evalWhere.ts` | `IN` のローカル評価（型メタ付き・v2.5.0〜v2.7.0 の選択系 IN） |
| `src/converter/whereToKintone.ts` / `src/core/optimization/whereCapability.ts` | 単一表で既に押せている組（片側実績） |

## 1. 前提（実測済み・再導出しない）

- DATE: `< '2000-01-01'` は空セルを**両経路とも含む**／`>= '2000-01-01'` は**両経路とも除外**
- TEXT: `!= 'ほげ'` は空セルを**両経路とも含む**／`IN (...)` は両経路とも除外
- NUMBER の意味論一致は B151 で確立（10 進厳密・空＝最小）
- v3.0.0 の型付き比較契約は kintone 整合が設計目的

## 2. あなたがコードから証明・決定すること（ファイル:行）

1. **型ごとのローカル比較の実体**＝DATE/TIME/DATETIME は canonical 文字列の
   コードポイント順・TEXT は code-point 比較・ユーザー系の `IN` はセル値のどの表現
   （`code` か）と比較するか。**JOIN 残余評価が通る経路が単一表と同じ評価器であること**
2. **canonical 判定の再利用**＝既存の `isCanonicalDate` / `isCanonicalTime` /
   `isCanonicalDateTime`（B76 の `=` 用）を範囲へ広げる条件。**非 canonical literal は fail-closed**
3. **DATETIME の TZ**＝`Z` 以外の offset 付き literal・秒省略の扱い（canonical 外として拒否か）
4. **TEXT の kintone `=` 完全一致性**＝エスケープ（`"` `\`）・空文字 literal・
   大文字小文字/全半角の正規化有無で server/local が割れる余地。**割れる余地が残る組は
   exact ではなく superset に留める判断も可**（理由を書く）
5. **ユーザー系 `IN` の値契約**＝literal は `code`・ゲスト形式（`guest/...`）・
   実在検証の要否（選択系 P2a の optionOrder 相当が user 系に無い場合の扱い）・
   複数値フィールド（USER_SELECT 等）の「いずれかを含む」意味論が local IN と一致すること
6. **STATUS_ASSIGNEE**＝プロセス管理無効アプリでの挙動（メタ取得・拒否・fail-closed）

## 3. 仕様に必ず含めること（B151 §と同じ型で）

1. 型×演算子の開放表（relation の値付き）と、**開けない組の理由**（例: TEXT の範囲比較は
   kintone が受けない・DATETIME の非 canonical literal）
2. 空セルの固定表（型ごと・全演算子。DATE/TEXT の実測値と整合させる）
3. literal 検証規則（canonical 形式・エスケープ・空文字 literal の扱い）
4. `EXPLAIN` 契約・B84 公開表の全型セル更新・言語リファレンス同期・B76/B84 失効注記の追記
5. 受入条件＝**B151 §11 の形（3 経路一致・境界・空セル両方向・逐語 SQL・
   query 文字列は実 serializer 形）**を型ごとに。TEXT はエスケープ必要文字を含む literal を必須で
6. Phase 線引き（CALC・RECORD_NUMBER・kintone が受けない組・LIKE）
7. Claude が実測すべき未確認事項（**DATETIME の TZ/秒・TEXT の正規化有無・
   ユーザー系のゲスト形式・プロセス無効アプリ**を必ず含める）

## 4. 書き方の制約

B151 依頼と同じ（内部実装を受入に書かない・示した形が動く・静的/動的の区別・
日本語・根拠の無い断定を書かない）。

上記に従い、**仕様の全文を Markdown で出力**してください。
