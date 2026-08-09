# B166 JOIN の ON 句がテーブル順と逆だと「JOIN key ... is not available」で落ちる

- 起票: 2026-08-09（**B53 の BOM fixture 実機実測が発見**。依頼元の想定クエリ＝
  `FROM 展開 AS e INNER JOIN APP4238 AS b ON b.parent_code = e.item_code` がこの形）
- ステータス: ✅ **v3.66.0 リリース済み（2026-08-09・B53 同梱・回帰 15 テスト・逆順 ON の実機 394 行全一致で受入）**
- 種別: バグ（正しさ・fail-closed 側＝誤結果ではなくエラーで止まる）
- 関連: B51（CTE JOIN の実体化・このガードの導入元）／B150（押し下げ層は alias で向きを解決済み）

## 1. 実測（2026-08-09・released v3.65.0 = 常駐 MCP と、b53/dev の CLI 両方で再現）

`FROM p INNER JOIN c ON <c 側> = <p 側>`（ON の左に **JOIN 側**のキーを書く）が一律に失敗する:

| 形 | 結果 |
|---|---|
| `FROM p JOIN c ON p.child_code = c.parent_code`（FROM 側が左） | ✅ 正常 |
| `FROM p JOIN c ON c.parent_code = p.child_code`（JOIN 側が左） | ❌ `ArgumentError: JOIN key c.parent_code is not available in the materialized table.` |

CTE×CTE・物理×物理の FULL_SCAN で再現（＝メモリ join 全経路）。**誤結果ではなくエラー**
（fail-closed 側）なので長期間未報告だった。SQL 標準では ON の左右に順序の意味はない。

## 2. 原因

[`applyJoin`](../../src/engine/process.ts) が **`on.left`＝蓄積済み左行・`on.right`＝結合テーブル行**という
**位置前提**でキーを引く（`leftKey = on.left...` を leftRows から探す）。
テーブルの実際の帰属（alias）を見ていない。押し下げ層（B150）は alias で向きを解決しており、
**メモリ join 層だけが位置前提**。

## 3. 修正方針（B53 同梱）

`applyJoin` 呼び出し層で **ON の両辺を alias で左右テーブルへ帰属させて正規化**する
（`leftColumns`/`rightColumns`（保存列）または行キーで判定し、逆順なら swap）。
どちらにも帰属できない場合は従来どおり fail-closed。診断文言は既存を維持。

## 4. 受入条件

1. 逆順 ON が順方向と**同一の結果**を返す: 物理×物理／CTE×CTE／CTE×物理／一時テーブル／
   再帰 CTE の再帰項（B53）× INNER/LEFT/RIGHT。
2. 順方向の既存挙動・押し下げ（B150 の型別選択・targeted `IN`）が不変。
3. 本当に存在しないキーは従来どおり `JOIN key ... is not available` で fail-closed。
4. BOM fixture の依頼元想定クエリ（ON b.parent_code = e.item_code）が実機で通る。
