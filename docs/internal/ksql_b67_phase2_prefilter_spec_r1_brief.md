# B67 Phase2 SUPERSET_PREFILTER 仕様 R1 — codex 起草ブリーフ

- 作成日: 2026-07-24（Claude=仕様/観点）
- 目的: codex が **B67 Phase2 R1（相対日付 prefilter ＋ 残余のみ client 評価）** を起草するための scope と判断論点の枠組み。
- 出力先: `docs/internal/ksql_b67_phase2_superset_prefilter_spec.md`（R1 本体）
- 分担: **codex 起草 → Claude レビュー → R2**。git 操作は Claude 側。仕様は実装せず文書のみ。
- 正: [B67 Phase1 仕様 R2](ksql_b67_rest_query_functions_phase1_spec.md)（特に §5・§11.1）
- 参照実コード（要裏取り）: LIKE の safe-leaf prefilter＝`extractSafePushdownLeaves`（`src/core/optimization/wherePredicatePushdown.ts` 付近）と SUPERSET_PREFILTER 経路・`src/core/optimization/whereCapability.ts`（B32/B67 の capability・reason）・`src/core/optimization/relativeDatePushdownGuard.ts`（Phase1 の取得前拒否）・`src/converter/selectToKintone.ts`（prefilter query 生成）・`src/execute.ts` の FULL_SCAN（取得後 `evalWhere(stmt.where, ...)` 再評価）・`src/engine/evalWhere.ts` の runtime backstop（相対日付名は throw）。

## 背景（実機で踏んだ制約）

v3.20.0 browser smoke で次が文全体 fail-closed になった（Phase1 §11.1）。

```sql
SELECT 都道府県, 更新日時 FROM APP730
WHERE 更新日時 >= YESTERDAY()   -- exact 押し下げ可能
AND   LENGTH(都道府県) > 1       -- 押し下げ不能（client scalar）→ FULL_SCAN 化
```

LENGTH が FULL_SCAN を強制し、FULL_SCAN は WHERE 全体を `evalWhere` で再評価するため相対日付が client 評価経路に載り、Phase1 は拒否する。利用者が自然に踏む制約。

## スコープ（Phase2 A・AND 限定）

- `相対日付 exact 述語（複数可）AND 押し下げ不能残余` の形を**許可**する。相対日付 exact leaf を kintone へ**プレフィルタ押し下げ**（サーバ評価は1回）、取得 superset に対して**残余の押し下げ不能述語だけを client 評価**する。
- **相対日付関数は client で一切評価しない**（Phase1 の server-only を維持）。
- **対象外（Phase B 以降）**: OR に相対日付が絡む形、KORDER との併用、DML の対象選択、JOIN 後残余、VALIDATE、サブテーブル、client 評価そのもの。

## 必要セクション（Phase1 spec の構成を踏襲）

1. スコープ（対象/対象外） 2. 意味論（prefilter＋残余分解） 3. 分解規則（AND 限定・leaf 除去） 4. 既存 LIKE prefilter との差異 5. plan gate の緩和と fail-closed 維持 6. EXPLAIN 7. 面 8. 受入条件 9. Phase B 引き継ぎ 10. 工数見積り

## R1 で確定すべき判断論点（曖昧にしないこと）

1. **【最重要・正しさ】残余評価から相対日付 leaf を「除去」する（再評価しない）。** 既存 LIKE の SUPERSET_PREFILTER は「safe leaf を superset 押し下げ＋WHERE 全体を JS 再評価（exact 化）」だが、相対日付は **JS 再評価不可**（backstop が throw）。したがって相対日付 leaf は **exact 押し下げ**（superset でなく厳密一致）した上で、**残余 WHERE から当該 leaf を取り除く（TRUE に畳む）**。取得行は kintone が相対日付を exact で満たした集合なので、残余で相対日付を再チェックしなくても正しい。LIKE leaf（superset）と相対日付 leaf（exact＋除去）を**混同しない**。
2. **【正しさ】AND 限定・exact 限定。** leaf 除去が安全なのは「相対日付 leaf が AND で結合され、かつ exact 押し下げされる」場合だけ。OR に相対日付が絡む形（取得行が相対日付 OR 枝で入り得る）は leaf 除去が不正になるため **Phase2 A では拒否維持**。相対日付 leaf が Phase1 の EXACT_PUSHDOWN（4型×6比較）でない場合も従来どおり拒否。
3. **【正しさ】backstop は維持。** 残余 AST から相対日付 leaf を除去した後に `evalWhere` へ渡す。万一残っても Step 1 の runtime backstop（相対日付名 throw）が最後の砦。残余に相対日付が到達しないことを受入条件で固定。
4. **【機構】既存 prefilter 経路への組み込み。** prefilter query＝safe leaf（LIKE-safe＋相対日付 exact）で構成し、残余 client 評価＝元 WHERE から相対日付 leaf を除去したもの。LIKE leaf は残余に残す（superset の exact 化）、相対日付 leaf は残余から消す（exact 済み）。`extractSafePushdownLeaves` の拡張か、相対日付専用の分解を隣接追加するかを確定。
5. **【capability/plan gate】relativeDatePushdownGuard の緩和。** Phase1 は「WHERE 全体 exact でなければ拒否」。Phase2 A は「WHERE = 相対日付 exact leaf 群（AND・押し下げ可）＋ client 評価可能な残余」に分解でき、prefilter＋残余除去で相対日付を client 再評価しない計画になる場合を**許可**。分解不能（OR 絡み・非 exact・KORDER/DML 等）は従来 reason で拒否。
6. **【KORDER/DML/範囲】Phase2 A の適用面を確定。** SELECT の FULL_SCAN prefilter のみか。KORDER（SIMPLE+exact 必須・残余 client filter は件数を変え順序保証を崩す）は拒否維持が妥当か。DML の対象選択（残余 client filter が target 集合を変える）は既存 DML 境界どおり exact 必須維持か。JOIN 後残余・VALIDATE・サブテーブルは Phase B。
7. **【EXPLAIN】表示。** prefilter に押し下げた相対日付述語・client 評価する残余述語・evaluation の分担（server prefilter / client residual）・相対日付は client 評価0 を表示。
8. **【面】4面一致。** Node/CLI/MCP/plugin で同じ分解・prefilter query・残余評価。

## 受入条件に必ず入れる例

- `WHERE 更新日時 >= YESTERDAY() AND LENGTH(都道府県) > 1` が、prefilter query に `更新日時 >= YESTERDAY()`（＋順序/limit）を出し、取得後に `LENGTH(都道府県) > 1` だけを client 評価する。相対日付は client 評価0（backstop 未発火＝残余から除去済み）。
- `相対日付 exact AND LIKE` で、LIKE は残余で JS 評価・相対日付は prefilter＋除去。
- OR に相対日付が絡む形は従来どおり fail-closed。
- KORDER と相対日付＋非押し下げ残余は拒否維持（決定どおり）。
- 既存 Phase1 の「WHERE 全体 exact」ケースは挙動不変（prefilter 単独＝残余なし）。
- 既存3関数（TODAY/NOW/LOGINUSER）と LIKE-only prefilter は非回帰。

## 制約

- git 操作は Claude 側。仕様は実装せず文書のみ。
- 相対日付を client 評価しない（Phase1 の server-only を厳守）。leaf 除去は exact 押し下げが前提。
- 既存 LIKE prefilter の superset＋全 WHERE 再評価の意味論を壊さない。
- backstop を無効化しない。
