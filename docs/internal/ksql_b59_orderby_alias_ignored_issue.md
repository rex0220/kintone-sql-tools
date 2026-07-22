# B59 — `ORDER BY <alias>` が黙って無視される（silent wrong order）

- 起票日: 2026-07-22
- ステータス: 🐞 **起票（B57 実機で発見・診断一次済み・修正未着手）**
- 種別: バグ（正しさ・silent wrong results 級）
- 効果種別: 正しさ
- 優先: **高**（エラーにならず誤った並びを返す）
- 関連: B57（発見の経緯・[evidence §5](evidence/b57_date_axis_smoke.md)）／B30（「部分・不正な整列を黙って返さない」fail-closed の前例）／B26（v3 整列意味論）

## 1. 事象（2026-07-22・dev APP4221 実測）

SELECT 列の **alias を `ORDER BY` に指定すると、ソートが黙って行われず元の行順のまま**返る。エラーも警告も出ない。

```sql
-- ① GROUP BY あり: 出力は出現順 6,3,4,2,9,10 のまま（len 昇順にならない）
SELECT LENGTH(タイトル) AS len, COUNT(*) AS 件数 FROM APP4221 GROUP BY LENGTH(タイトル) ORDER BY len;

-- ② GROUP BY なし: 出力 4,4,4,3,1 のまま（dw3 昇順にならない）
SELECT DAYOFWEEK(日付) AS dw3 FROM APP4221 WHERE 日付 IS NOT NULL ORDER BY dw3 LIMIT 5;

-- ③ 関数直書きは正常: 1, 3, 4 の数値昇順
SELECT DAYOFWEEK(日付) AS dw2, COUNT(*) AS 件数 FROM APP4221 WHERE 日付 IS NOT NULL
GROUP BY DAYOFWEEK(日付) ORDER BY DAYOFWEEK(日付);
```

- **既存の `LENGTH` でも再現**＝B57（DAYOFWEEK 等）の回帰ではなく**既存バグ**。GROUP BY の有無に関係なし。
- 回避策: **関数直書き `ORDER BY 関数(列)`**（③・正常動作を実測済み）。

## 2. 一次診断

- `evalOrderKey` の `FIELD_NAME` 分岐（`src/engine/process.ts:694`）が `row[key.name] ?? ""` で解決するため、**ソート時点の行に alias キーが存在しないと全行 `""` → 安定ソートで no-op**（＝黙って元順）。
- 一方で `deriveOutputOrderSemantics`（process.ts:1190 付近）は **alias → 整列 semantics の対応表を作っており**（B56/B58 でも整備した経路）、alias での ORDER BY は**意図された機能**に見える。型メタは用意されているのに**キー値の解決側で alias→列式の対応が欠けている**（射影前の行に対して評価している／合成名と alias の食い違い）疑い。

## 3. 影響範囲（要マトリクス調査・「組み合わせは列挙して試す」教訓の適用対象）

- 列種: STRFUNC_COL（実測 NG）× AGGREGATE alias（`COUNT(*) AS c ORDER BY c`＝**未検証**）× ARITH_COL × WINDOW_COL × CASE_COL × SCALAR_VALUE_COL
- 文脈: GROUP BY 有無（両方 NG 実測）× UNION × CTE/temp 経由 × サブテーブル仮想テーブル
- どの組み合わせで動く/動かないかを全列挙してから修正方針を決める（1 例の成功で「動く」と結論しない）。

## 4. 対処方向（修正時に選択）

1. **alias 解決の追加**: ORDER BY の FIELD_NAME キーを射影列の alias と突合し、一致すれば当該列式を評価（または射影後の行でソート）。
2. **fail-closed**: 解決できない ORDER BY キーを実行前エラーにする（「黙って誤るよりエラー」＝B30/B32 の原則。少なくとも修正 1 が届かない列種はこちらへ倒す）。

言語リファレンスの ORDER BY 節に alias 可否の現状記載があるかの確認（文書と実装の乖離の有無）も修正時に行う。

## 5. 次アクション

- 影響マトリクス調査（§3）→ 修正方針確定 → 仕様/修正 spec → codex 実装 → 実機。
