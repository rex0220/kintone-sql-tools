# B28 実機記録: DML 値の単項符号（CLI）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・APP4221・working tree ビルド）

| 操作 | 結果 |
|---|---|
| `INSERT … VALUES ('B28', -5, …), ('B28', +0.5, …)` | ✅ affected=2・読み返し `-5` / `0.5`（`+` は正規化） |
| `UPDATE … SET 金額 = +7` | ✅ affected=2・読み返し両行 `7` |
| `VALUES (…, - -5, …)`（空白入りネスト） | ✅ `ParseError: INSERT の単項符号の直後には数値リテラルが必要です（位置 68、トークン: 「-」）` |
| `--5`（空白なし） | ✅ SQL 行コメントとして字句解析され後続が消える→VALUES 不完全の ParseError（＝拒否成立。課題文書 §5 に注記済み） |
| 後始末 | ✅ DELETE 2 行 |

副産物: 実測中に `数値T2`（サブテーブル子）を誤って指定し、**B34 の検査が正しく発火**（`is inside a subtable`）＝B34 の追加非回帰実測。

B35（⚠のみ表示の fallback）は Node ユニットで固定済み。プラグイン画面での表示確認は v3.2.0 リリース前の最終 smoke（ブラウザ・1 分＝DevTools で cursor.json か records.json をブロック→fallback 文言表示）に残す。
