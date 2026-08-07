# B150 仕様 R1 作成依頼（codex）——案 D＝結合キーの範囲 prefilter

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.60.0）

## 0. 依頼

**B150（CTE→物理 APP の結合キー押し下げが DATE キーで kintone 生エラー）の仕様 R1 を、
そのまま実装依頼に出せる形で書く。** 方向はオーナー判断（2026-08-07）で確定済み＝
**案 D＋案 A**（[起票 §3](ksql_b150_cte_join_date_pushdown_issue.md)）。

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b150_cte_join_date_pushdown_issue.md` | 起票（実測＝GAIA_IQ03・案 D の骨子） |
| `src/core/optimization/whereCapability.ts` | `NATIVE_OPERATORS`＝型別の受理演算子の正 |
| `src/execute.ts` ほか | **結合キー押し下げ（CTE 実値→`in` リスト生成）の実装箇所をあなたが特定する** |
| `docs/internal/ksql_b152_join_pushdown_phase234_spec_r1.md` | 日付系 canonical・範囲 exact の前提（v3.60.0） |

## 1. 決まっていること（変更しない）

- **結合キー押し下げは、キーのフィールド型が受ける演算子を `NATIVE_OPERATORS` で判定して選ぶ**:
  1. `in` を受ける型（数値・テキスト・リンク・選択系など）→ **従来どおり `in` リスト**（回帰なし）
  2. `in` は受けないが範囲を受ける型（DATE / TIME / DATETIME / CREATED_TIME / UPDATED_TIME）→
     **キー実値の min / max による `>= min and <= max` の範囲 prefilter（relation: superset）**
  3. どちらも受けない型 → **押し下げず全件取得へフォールバック**（案 A。エラーを出さない）
- **結果は変えない**（JOIN の突合が最終判定。範囲は superset として広めに取得するだけ）
- **kintone が受けない演算子をエンジンが選んで生エラーになる経路を残さない**
  （これは「値が不正なら kintone エラー許容」の v3.60.0 原則とはクラスが違う＝
  エンジンの演算子選択の問題。起票 §3 の区別を仕様にも明記）

## 2. あなたがコードから決めること（ファイル:行）

1. **結合キー押し下げの実装箇所と現在の `in` リスト生成・空値の扱い**
   （CTE キー値に空文字が混ざる場合、現状 `in` リストへどう入るか。
   範囲 prefilter では空セル行が `>= min` で欠落し得るため、
   **空値を含むキー集合はフォールバック**か、既存挙動に整合する別の安全策かを決める）
2. **min / max の算出**＝実体化済みキー値の比較器（型メタ）で選ぶこと。
   **非 canonical 値（式で作った文字列など）が混ざる場合はフォールバック**
3. **範囲 prefilter の relation 合成**＝既存 field-vs-literal leaf との AND 合成・EXPLAIN 表示
4. 対象となる JOIN の形（CTE→APP・一時テーブル→APP・APP→APP の各経路のうち
   結合キー押し下げが働くもの全部）

## 3. 仕様に必ず含めること

1. 型×選択（`in` / 範囲 / フォールバック）の表と判定順
2. 空値・非 canonical・巨大キー集合（`in` リストの既存上限があればその整合）の扱い
3. `EXPLAIN` 契約（範囲 prefilter の表示・`relation: superset`・フォールバック時の理由表示）
4. **受入条件**＝B150 の再現形（日付系列→APP の直接 JOIN）が**エラーなく動き結果が正しい**こと・
   3 経路一致・空値混在でフォールバック・`in` 可能型の従来挙動回帰・
   EXPLAIN の逐語固定（実 serializer 形）・mock error を握りつぶさない
5. Phase 線引きと未確認事項（Claude 実測項目）

## 4. 書き方の制約

B151/B152 と同じ（内部実装を受入に書かない・示した形が動く・静的/動的の区別・日本語・
根拠の無い断定を書かない）。**仕様の全文（Markdown）を最終メッセージで出力**。
