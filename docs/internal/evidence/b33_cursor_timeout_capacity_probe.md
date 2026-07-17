# B33 実測記録: 5 分 Create timeout の再現試行とドメイン容量上限

- 実施日時: 2026-07-18（UTC 2026-07-17T23:08:30Z 以降）
- 実施者: Claude（実機・raw REST）
- 対象: [B33 実装計画](../ksql_korder_cursor_implementation_plan.md) Phase 0 Step 0-4（非 blocker ゲート）
- 環境: dev ドメイン・パスワード認証・guest space なし・他製品のカーソル利用なし（実測前後の Create 成功で確認）
- 認証情報・カーソル ID は redact。`id` はエラー応答内の kintone リクエスト ID

## Test T: 5 分 Create timeout の再現試行 — **再現不能**

高コスト Create を 2 回試行（計画の「1 回だけ」は timeout 発生カーソルの堆積防止が目的であり、成功した Create は即削除している）。

| # | 対象 | query | 結果 |
|---|---|---|---|
| T1 | APP730 | `町域 like "町" order by 住所1K asc, 町域K desc, 郵便番号 asc, $id asc` | HTTP 200・**5.4 秒**・totalCount=35（`like` は語単位検索のため 35 件に絞られ高コストにならず＝試行設計の失敗として記録） |
| T2 | APP730 | `order by 住所1K asc, 町域K desc, 郵便番号 asc, $id asc`（WHERE なし・**全 618,525 件**） | HTTP 200・**9.1 秒**・totalCount=618525 |

いずれも作成後すぐ DELETE（HTTP 200）。

**結論: 618K 件＋複合 4 キー order by でも Create は約 9 秒で完了し、この環境では公式 5 分 timeout を再現できない。** 「timeout 後に有効カーソルが残るか」は**未検証のまま**とし、Create outcome unknown を quarantine する R4 契約を維持する。再開条件＝これより十分大きい／複雑なデータを持つ環境での再試行、または公式回答。

## Test C: ドメイン容量上限と超過時応答 — **実測確定**

軽量カーソル（APP4221・totalCount=8）を順に作成:

- **#1〜#10: すべて HTTP 200**（公式上限 10 と一致）
- **#11: HTTP 429**

```json
{"code":"GAIA_TM12","id":"G0Tzd0kxTjsgmuOOu556","message":"作成できるカーソルの上限に達しているため、カーソルを作成できません。不要なカーソルを削除するか、しばらく経ってから再実行してください。"}
```

- cleanup: 10 個すべて DELETE HTTP 200（失敗 0）
- 後始末確認: 直後の Create 200 → Delete 200（枠復帰済み）

## 確定した事実

1. **1 ドメイン同時 10 個の公式上限は実挙動と一致**する（10 個目まで成功・11 個目で拒否）
2. **容量超過の実応答は `HTTP 429` + `code: GAIA_TM12`**・body 形状 `{code, id, message}`。メッセージは削除または時間経過を案内する
3. 診断への含意: kSQL 内部の permit 不足（`CursorCapacityError`・API 前）と、**ドメイン全体の枠不足（R4 制限 3）＝`429`/`GAIA_TM12`（API 応答）**を区別して表示できる
4. `429` は一般に rate-limit 系として自動 retry されやすい status だが、**Create Cursor は R4 §10 のとおり自動再試行禁止**（この実測はその重要性の裏付けでもある）

## 未検証のまま残る事項

- 公式 5 分 Create timeout の実応答と、timeout 後の有効カーソル残存有無（本環境で再現不能）
- 複数ページの順序・同値安定性（release blocker・Phase 4 Step 4-4。APP730 が実測 fixture の有力候補）
