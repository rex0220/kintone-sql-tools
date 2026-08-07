# B152 JOIN 押し下げ条件の全型棚卸し（B151 の枠組みを全フィールド型へ）

- 起票: 2026-08-07（オーナー依頼「項目タイプすべての押し下げ条件を見直して」）
- ステータス: 🚧 **Phase 2+3 実装済み・実機確認済み（2026-08-07）・codex 最終チェック中 → B151 と v3.60.0 同梱リリースへ**
- 実機確認（APP4236・LINK フィールド追加）: **TEXT エスケープ（`A"\B`）・NFD 結合文字・半角カナとも
  kintone は正規化せず逐語一致**（両経路一致）／LINK の `=`・`IN` 3 経路一致／
  DATETIME range の JOIN が `relation: exact` で押し下げ。検証レコードは削除済み
- 仕様: [R1](ksql_b152_join_pushdown_phase234_spec_r1.md)（codex 作）／[レビュー](ksql_b152_codex_review_1.md)（実装前実測＝
  Phase 2 の TIME/DATETIME 空セル両方向一致・**TEXT の `=` は大小文字・全半角を逐語区別**（両経路一致）・
  **Phase 4 は見送り確定**＝`IN ('存在しない code')` が **GAIA_IL26 の query error** になり、
  開放すると動いていたクエリが壊れる。code のローカル実在検証は不可＝ **B54（User API）後に再評価**）
- 関連: [B151](ksql_b151_join_inclusive_range_pushdown_issue.md)（NUMBER＝Phase 1・実装中。本件はその親課題）／
  [B76 Phase A](ksql_b76_join_pushdown_phase_a_spec.md)／[B84](ksql_b84_pushdown_visibility_spec.md)

## 1. 原理（B151 §2.7 の一般化）

- 押し下げの正しさの条件（取得集合 ⊇ ローカルが欲しい行＋再評価）は**単一表と JOIN で同一**
- **v3.0.0 の型付き比較契約は kintone 整合を目的に設計されており、ローカルと kintone の
  意味論は原則一致している**（NUMBER・DATE・TEXT の空セル方向を実測で確認済み＝§2）
- JOIN 固有の制約は構造 3 つ（葉の切り出し・外部結合・所有権）だけ。
  **型×演算子で JOIN だけ絞ってよいのは「意味論が本当に違う組」と「kintone が受けない組」のみ**

## 2. 先行実測（2026-08-07・APP4228・検証レコードは削除済み）

| 型 | 条件 | 結果 |
|---|---|---|
| NUMBER | 境界すれすれ・空セル 8 演算子 | **一致**（B151 で確認済み） |
| DATE | `< '2000-01-01'`（空セル） | **両経路とも含む**（空＝最小） |
| DATE | `>= '2000-01-01'`（空セル） | **両経路とも除外** |
| TEXT | `!= 'ほげ'`（空セル） | **両経路とも含む** |
| TEXT | `IN (...)`（空セル） | 両経路とも除外 |

## 3. 型×演算子の棚卸し（kintone 演算子表 × 現行 B84 × 開放判定）

**凡例**: ◎=済（現行○）／▲=開放候補（証明すれば開く）／✕=開放不能（理由が本質的）

| 型 | kintone が受ける演算子 | 現行 JOIN | 判定と必要な証明 |
|---|---|---|---|
| NUMBER | `= != < > <= >= in not in` | `=`S・strict 整数のみ | **B151 実装中（全 8 を exact へ）** |
| DATE / TIME | `= != < > <= >=` | `=` S のみ | **▲ Phase 2 本命**＝range・`!=` の開放と `=` exact 昇格。空セル両方向は実測済み。残＝非 canonical literal の server 挙動・`IN`（kintone 不可＝対象外） |
| DATETIME / CREATED_TIME / UPDATED_TIME | `= != < > <= >=` | `=` S のみ | **▲ Phase 2**＝同上＋TZ 表現（`Z`／offset）・秒の server 正規化の証明 |
| SINGLE_LINE_TEXT / LINK | `= != in not in (like)` | `=` S のみ | **▲ Phase 3**＝`!=` / `in` / `not in` 開放・`=` exact 昇格。`!=` 空セルは実測済み。残＝kintone `=` の完全一致性（正規化・全半角・エスケープ）・ルックアップ経由も同型 |
| RADIO_BUTTON / DROP_DOWN / STATUS | `in not in`（STATUS は `=` `!=` も） | ◎（`=`/`!=` は B126 正規化で実質○） | 済み。STATUS の素の `=` 直接押しは正規化がカバー |
| CHECK_BOX / MULTI_SELECT | `in not in` | ◎ | 済み。他の演算子は kintone が受けない |
| CREATOR / MODIFIER / USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT / STATUS_ASSIGNEE | `in not in` | 全✕ | **▲ Phase 4**＝`in` / `not in` 開放。証明＝値表現（`code`・ゲスト `guest/...`）と kSQL ローカル IN（P2a の型メタ付き評価）の一致。単一表では既に押しており片側実績あり |
| RECORD_NUMBER | `= != < > <= >= in not in` | 全✕ | ▲（優先低）＝アプリコード有無 2 形態の証明が要る。**`$id` が全演算子 exact で代替済み** |
| CALC | `= != < > <= >= in not in` | 全✕ | ▲（数値形式のみ・Phase 5）＝表示書式で値領域が変わる（時間 `49:30` 等）。書式別の証明が要る（B151 仕様 §5 の 6 点） |
| CATEGORY | **なし** | 全✕ | ✕ 正当（kintone が受けない） |
| MULTI_LINE_TEXT / RICH_TEXT / FILE | `like` / `is` のみ | 全✕ | ✕ 正当（比較演算子を受けない。`like` 系は KLIKE が担当） |
| 全型の `LIKE` | — | ✕ | ✕ 維持（v2.0.0 の意図的な JS 統一。KLIKE が代替） |

## 4. 進め方

**B151（NUMBER）と同じ回し方を Phase ごとに繰り返す**＝
仕様（codex・意味論一致の証明をコードから）→ レビュー（Claude・端の実測を実装前に）→ 実装 → 実機。

- **Phase 2（日付・日時 range）が実需の本命**（期間絞り込み JOIN は 0 埋め・期間分析で頻出。
  B149 の日付系列 JOIN とも相性が良い）
- Phase 3（TEXT/LINK）・Phase 4（ユーザー系 in）・Phase 5（CALC 数値・RECORD_NUMBER）は実需順で
- 各 Phase の受入は B151 §11 の形（3 経路一致・空セル両方向・境界・B84 表パリティ・全 surface）を踏襲

## 5. 単一表側の点検（本件の範囲外だが記録）

単一表は「WHERE 全体の exact 直列化」で kintone の演算子表とほぼ 1:1 に押せており、
今回の実測でも JOIN 側と食い違う挙動は観測されていない。**単一表に開いていて JOIN に開いていない
非対称を解消するのが本件**であり、単一表側の変更は不要（乖離が見つかった場合のみ別途起票）。
