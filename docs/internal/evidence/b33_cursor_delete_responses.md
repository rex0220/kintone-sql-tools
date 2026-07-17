# B33 実測記録: Delete 済み／自動削除済みカーソルへの Delete 実応答

- 実施日時: 2026-07-18（UTC 2026-07-17T22:58:45Z）
- 実施者: Claude（実機・raw REST）
- 対象: [B33 実装計画](../ksql_korder_cursor_implementation_plan.md) Phase 0 Step 0-3（実装前 blocker）
- 環境: dev ドメイン・APP4221・パスワード認証（`X-Cybozu-Authorization`）・guest space なし
- endpoint: `POST/GET/DELETE /k/v1/records/cursor.json`
- 認証情報・カーソル ID は記録から除外（`<ID>` へ redact）。`id` はエラー応答内の kintone リクエスト ID

## Test A: Create → Delete → Delete（2 回目）

| 手順 | 要求 | HTTP | body |
|---|---|---:|---|
| A-1 | `POST { app: 4221, query: "order by $id asc", size: 500 }` | 200 | `{ id: "<ID>", totalCount: "8" }` |
| A-2 | `DELETE { id: "<ID>" }`（1 回目） | 200 | `{}` |
| **A-3** | `DELETE { id: "<ID>" }`（**2 回目・blocker 対象**） | **404** | `{"code":"GAIA_CN01","id":"XtRs5QV0fCh8fUftqMhq","message":"指定したカーソルは存在しないか、既に有効期限が切れています。"}` |

## Test B: Create → Get（next=false まで）→ Delete

| 手順 | 要求 | HTTP | body |
|---|---|---:|---|
| B-1 | `POST`（A-1 と同一 payload） | 200 | `{ id: "<ID>", totalCount: "8" }` |
| B-2 | `GET ?id=<ID>` | 200 | 1 ページ・8 件・`next: false`（＝kintone 側で自動削除） |
| **B-3** | `DELETE { id: "<ID>" }`（**自動削除後・blocker 対象**） | **404** | `{"code":"GAIA_CN01","id":"TUkb45y4Czwa4hzkwlx4","message":"指定したカーソルは存在しないか、既に有効期限が切れています。"}` |

## 後始末確認

- 実測直後に新規カーソルを `POST` → HTTP 200（枠が残っていない）→ `DELETE` → HTTP 200
- 作成した全カーソルは明示削除または自動削除済み。レコードへの書き込みなし

## 確定した事実

1. **2 経路（明示 Delete 済み・next=false 自動削除済み）の応答は完全に同一**: `HTTP 404` ＋ `code: GAIA_CN01` ＋ body 形状 `{code, id, message}`。別 fixture に分ける必要はない
2. Delete 成功（1 回目）は `HTTP 200`・body `{}`
3. `GAIA_CN01` の message は「存在しない」と「期限切れ」を区別しない。**「サーバー上に該当カーソル資源が無い」ことの確認としてはどちらも解放済み扱いで安全**（cleanup の目的は資源の不存在確認であり、不存在の理由の特定ではない）

## 契約への反映（cleanup の「既解放」判定）

`close()` の再確認で `HTTP 404` かつ `code === "GAIA_CN01"` を受けた場合に限り「既に解放済み」として成功扱いにできる。**このペア以外**（404 でも別 code、GAIA_CN01 でも別 status、5xx、ネットワークエラー等）は既解放と推定せず、quarantine 経路へ送る。

## 未検証のまま残る事項（本実測の対象外）

- 公式 5 分 Create timeout 後に有効カーソルが残るか（Step 0-4・別ゲート）
- guest space 経由・API トークン認証での同応答（別経路の実測は実装時に必要なら追加）
- 複数ページの順序・同値安定性（release blocker・Phase 4 Step 4-4）
