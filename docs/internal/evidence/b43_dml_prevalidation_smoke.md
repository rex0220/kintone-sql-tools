# B43 DML 事前検証（complete post-image）CLI 実機証跡

- 対象: B43「DML 事前検証（`VALIDATE ONLY` / `ON ERROR SKIP`）が既存サブテーブル違反を検出しない false pass」の解消
- 仕様: [ksql_b43_dml_prevalidation_subtable_spec.md](../ksql_b43_dml_prevalidation_subtable_spec.md)（R1 Approved）
- 実装計画: [ksql_b43_dml_prevalidation_impl_plan.md](../ksql_b43_dml_prevalidation_impl_plan.md)（Phase 1〜6 実装済）
- 版数: v3.9.0（実機テスト用ビルド）
- 実行: ローカル CLI（`dist-cli/ksql.js`・B43 反映で再ビルド）・dev プロファイル
- 実施日: 2026-07-21

## baseline（B42 で既存違反を確認）

APP4221 `$id=7` は 文字列MIN='ABC'。サブテーブル `テーブル` の子 `文字列T2` に minLength 違反が2行（行1,2・永続行 ID 7224309/7224313）。

```
VALIDATE APP4221 WHERE $id = 7
→ 文字列T2 ERR_LENGTH_MIN 「文字列T2 は 3 文字以上で指定してください（2行: 1,2）」
  $err_subtable=テーブル $err_subrow=1,2 $err_subrow_id=7224309,7224313  errorCount=2
```

## 実機結果（全 pass）

| # | ケース | SQL | 結果 |
|---|---|---|---|
| T1 | **false pass 反転（決定的）** | `UPDATE APP4221 SET 文字列MIN='ddd' WHERE $id=7 VALIDATE ONLY` | **validatedRows=1 / validRows=0 / invalidRows=1 / errorCount=2**（旧版は validRows=1/errorCount=0）。SET は 文字列MIN（トップレベル）のみだが post-image 検証で子 `文字列T2` の既存違反2行を検出。`$err_operation=UPDATE`・`$err_subtable=テーブル`・`$err_subrow=1,2`・`$err_subrow_id=7224309/7224313`（≡B42 の値＝`_rid`）・10メタ列 |
| T2 | **no-false-positive** | `UPDATE APP4223 SET 文字列MIN='ZZZ' WHERE $id=2 VALIDATE ONLY`（$id=2 は B42 で違反0） | validatedRows=1 / **validRows=1 / invalidRows=0 / errorCount=0**。既存違反のないレコードは誤検出しない |
| T3 | **ON ERROR SKIP true isolation** | `UPDATE APP4221 SET 文字列MIN='ddd' WHERE $id=7 ON ERROR SKIP INTO #err; SELECT … FROM #err` | `updated=0 affected=0 **skipped=1** errTable=#err`。#err に2行（文字列T2 ERR_LENGTH_MIN・subrow_id 7224309/7224313）。**書き込み0**で `文字列MIN` は 'ABC' のまま＝違反親を隔離し、旧版なら CB_VA01 でチャンク全滅していた挙動を回避 |

## 要点

- **決定的証拠 = T1**: SET 対象外（サブテーブル子）の既存違反を complete post-image 検証で捕捉し、起票時の false pass（validRows=1/errorCount=0）を validRows=0/errorCount=2 へ反転。`$err_subrow_id` が B42 VALIDATE と一致（≡`_rid`）。
- **T2** で誤検出（false positive）がないことを確認。
- **T3** で ON ERROR SKIP が違反親を書き込み0で隔離（true isolation）することを確認。
- B42（監査）→ B43（事前検証・隔離）→ B44（同時修復）の三段連携のうち B43 が実機で成立。
- 全て read-only もしくは隔離により書き込み0のため、フィクスチャ（$id=7）は温存（`文字列MIN='ABC'` のまま）。
- 自動回帰: 全2,515 テスト green（Phase 6 gate）。
