# B22 実機記録: 切り出し・桁揃え関数のサロゲートペア安全化（CLI）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・working tree ビルド・CLI dist-cli/ksql.js）
- 対象: [B22 課題文書](../ksql_surrogate_pair_split_issue.md) §7 受入条件の実機分
- 方法: FROM なし SELECT（read-only）＋実アプリ `maxLength` フィールドへの VALIDATE ONLY（書き込みゼロ）

## 代表例（§1 の欠陥ケース → 修正後）

| 式 | 旧（欠陥） | 修正後（実測） | 判定 |
|---|---|---|---|
| `LEFT('𩸽あ😀', 1)` | `"\ud867"`（孤立上位） | `""`（len=0） | ✅ 「1 ユニットに収まる安全な先頭は空文字だけ」 |
| `RIGHT('𩸽あ😀', 1)` | `"\ude00"`（孤立下位） | `""` | ✅ |
| `SUBSTRING('𩸽あ😀', 1, 1)` | `"\ud867"` | `""` | ✅ |
| `LPAD('😀😀', 3, '0')` | `"😀\ud83d"` | `"😀"`（len=2） | ✅ 切り詰め経路 |
| `LPAD('7', 4, '😀')` | `"😀\ud83d7"` | `"😀7"`（len=3・n 未満許容） | ✅ 埋め経路 |
| `RPAD('7', 4, '😀')` | `"7😀\ud83d"` | `"7😀"`（len=3） | ✅ |
| `LEFT('𩸽あ😀', 2)` | — | `"𩸽"`（len=2） | ✅ ペア保存 |
| `LENGTH(LEFT('😀😀', 3))` | 3（孤立含む） | `2` | ✅ 予算内の最大安全長 |
| `LENGTH(LEFT('😀'×6, 10))` | — | `10` | ✅ 偶数境界は切らない |

## 書き込み経路（§7・実アプリの maxLength と一致させる条件）

```sql
CREATE TEMP TABLE #t AS SELECT LEFT('😀😀😀😀😀😀', 10) AS v, '4' AS k;
UPDATE APP4221 SET 文字列MAX = s.v FROM #t s WHERE APP4221.$id = s.k VALIDATE ONLY
-- 文字列MAX は maxLength=10 の実フィールド
```

→ `validatedRows=1 / validRows=1 / invalidRows=0`。**`LEFT(x, n)` の結果が `maxLength=n` の検証を必ず通る**（案 A のコードポイント解釈なら 10 コードポイント＝20 ユニットで拒否されていた）。

## 判定

§7 の実機分を満たす。性質テスト（18 入力 × 全境界 × 4 埋め・予算/包含/ペア保存/最大性）と非回帰（LENGTH/LIKE '_'/INSTR/BMP）は Node テストで固定済み（61 suites / 1,651 tests green）。B22 は v3.2.0 リリース待ち。
