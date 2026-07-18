# B21 実機記録: UPDATE SET の文字列関数（CLI）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・APP4221・working tree ビルド）

| 操作 | 結果 |
|---|---|
| `SET 文字列MAX = UPPER(文字列MAX)`（'abc'） | ✅ 書き込み成功・読み返し `ABC`（文字列のまま） |
| **`SET 文字列MAX = LPAD(文字列MAX, 5, '0')`（'7'）** | ✅ **読み返し `00007`＝先頭ゼロ保持（数値化されていない決定的証拠・B19 の LPAD がようやく書き戻せる）** |
| **`SET 文字列MAX = LPAD(文字列MAX, 11, '0') VALIDATE ONLY`（maxLength=10）** | ✅ **新経路の評価値 `00000000007` を `ERR_LENGTH_MAX` で捕捉**（validated=1/valid=0/invalid=1・「文字列MAX は 10 文字以下で指定してください」） |
| `SET x = LENGTH(y) * 1`（算術内） | ✅ 従来どおり `DmlConvertError`（非回帰） |
| `SET a = b`（FIELD_REF 単独） | ✅ 新文言の `ParseError`「SET の値にフィールド参照を単独で指定することはできません」 |
| `UPDATE … FROM` の `SET x = UPPER(s.v)` | ✅ `ParseError`「UPDATE ... FROM の SET では文字列関数を直接使用できません」（明示拒否・黙って無視しない） |
| 後始末 | ✅ DELETE 済み |

B21 は v3.2.0 リリース待ち。CASE WHEN 版・SOURCE_FIELD・サブテーブル拒否等の非回帰は Node テストで固定済み（63 suites / 1,761 tests green）。
