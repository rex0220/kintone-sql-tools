# B152 仕様 R1 レビュー（Claude・実装前実測付き）

- 実施: 2026-08-07
- 対象: [仕様 R1](ksql_b152_join_pushdown_phase234_spec_r1.md)（codex 作・Phase 2〜4）
- 実測環境: 検証アプリ **APP4236**（TEXT / TIME / DATETIME / USER_SELECT フィールドを追加。
  実ユーザー code `Alex2013`。検証レコードは投入→確認→削除）
- 結論: **Phase 2（日付・時刻・日時 range）と Phase 3（TEXT/LINK）は実測全一致で採用。
  Phase 4（ユーザー系 `IN`）は仕様 §4.5-9 の条件が実測で発動し、unsafe 維持（見送り）で確定。**

## 1. 実測結果

### Phase 2 — 全一致（開放を裏づけ）

| 型 | 条件 | 結果（押し下げ経路 vs FULL_SCAN 強制経路） |
|---|---|---|
| TIME | `>= '09:30'` | 一致（空セル除外） |
| TIME | `< '09:30'` | 一致（**空セル含む**＝最小値扱い） |
| DATETIME | `>= / <` canonical UTC literal | 両方向とも一致（空セル＝最小） |
| DATE | 両方向 | 起票 §2 で実測済み（一致） |

### Phase 3 — 全一致（最大リスク解消）

- **kintone の TEXT `=` は大文字小文字・全半角を同値化しない**＝`= 'abc'` は `"ABC"` に一致せず、
  `= 'ＡＢＣ'` は全角行のみ。ローカルの code-point 完全一致と**逐語一致**（両経路で同一結果）
- `!=` の空セル包含は起票 §2 で実測済み（一致）
- → §4.4 の条件節（「同値化する場合は superset 維持」）は**発動しない**。`=` の exact 昇格・
  `!=` / `IN` / `NOT IN` の開放とも成立

### Phase 4 — **条件発動・見送り**

> **【2026-08-07・オーナー判断で撤回】** kintone の型×演算子表への全面整合を優先し、
> ユーザー系6型の `IN` / `NOT IN` を exact で開放する。存在しない code の error は許容し、
> silent retry しない。`STATUS_ASSIGNEE` の process gate は追加 metadata なしへ簡素化する。

```
主担当 IN ('zz_nonexistent_user_9999')
→ kintone API error 400: GAIA_IL26「指定したユーザー（code：...）が見つかりません。」
```

- **存在しない code は空集合ではなく query error**。現在の JOIN（unsafe→ローカル判定）では
  静かに 0 行なので、開放すると**動いていたクエリがエラーへ変わる**
- 選択肢（optionOrder で実在検証できる）と違い、**ユーザー code はローカルで実在検証できない**
  （できるようになるのは [B54](ksql_b54_user_api_directory_evaluation.md)＝User API 対応後）
- → **仕様 §4.5-9 の明文の条件が発動**＝「存在しない code を query が error にする実測結果と
  なった場合は…対象型を unsafe に戻す」。**Phase 4（STATUS_ASSIGNEE 含む）は今回開放しない。**
  B84 表・実装スコープから除外し、B54 の実需材料として記録する
- 参考実測: 実在 code の `IN ('Alex2013')` は一致・`NOT IN` の空ユーザー行包含も両者一致
  （意味論自体は揃っている＝**障害は意味論でなく未知 code の エラー化のみ**）

## 2. 判断

- **実装スコープ＝Phase 2 + Phase 3**（仕様の該当部をそのまま実装。Phase 4 の節は
  「条件発動により見送り」の日付付き注記を実装時に付ける）
- 仕様の静的主張は本日の一連の検証（B151）と同じ構造で、抜き取り済みの比較器・serializer
  経路に乗っている。受入・パリティテストが実装時に全数を機械照合する
