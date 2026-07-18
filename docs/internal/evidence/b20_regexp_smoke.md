# B20 実機記録: 正規表現関数（CLI・案 A）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・CLI・すべて read-only／FROM なし SELECT）
- 対象: B20 仕様 §2 の 3 関数・R5 案 A（ゲートなし）

| 式 | 結果 | 判定 |
|---|---|---|
| `REGEXP_LIKE('130-0001','^[0-9]{3}-[0-9]{4}$')` / `('abc','^[0-9]+$')` | `1` / `0` | ✅ 書式検証 |
| `REGEXP_REPLACE('03-1234-5678','[^0-9]','')` | `0312345678` | ✅ 数字以外除去（[^0-9]＝正規表現でしか書けない実需） |
| `REGEXP_SUBSTR('order-12345-x','[0-9]+')` | `12345` | ✅ 抽出 |
| `REGEXP_LIKE('ABC','abc','i')` | `1` | ✅ フラグ i |
| `REGEXP_REPLACE('2026-07-18','([0-9]{4})-([0-9]{2})-([0-9]{2})','$1/$2/$3')` | `2026/07/18` | ✅ 置換参照 |
| `REGEXP_LIKE('a','a','v')` | `ArgumentError: flags may contain only i, m, or s` | ✅ v 拒否 |
| `REGEXP_REPLACE('a','a','$` + "`" + `')` | `ArgumentError: replacement must not contain $` + "`" + ` or $'` | ✅ 危険置換参照拒否 |
| `REGEXP_LIKE('a')` | `ArgumentError: expects 2 to 3 argument(s)` | ✅ arity |
| `REGEXP_LIKE('a','[')` | `ArgumentError: invalid regular expression: Unterminated character class` | ✅ 不正パターン |
| `SELECT REGEXP_LIKE FROM …`（素） | ParseError | ✅ 予約語 |

案 A どおり opt-in ゲートなしで既定で使える。ReDoS は防がない（暴走時の中断不能は文書明示）。
全経路（SELECT/WHERE/HAVING/ORDER BY/temp/CTE/UPDATE SET＝B21）は Node テスト 18 ケースで固定。
プラグイン面の smoke（freeze・ホスト差の目視）は v3.3.0 リリース前の最終確認へ。
