# B23/B24 実機記録: LENGTH_CHAR・TRANSLATE（CLI）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・working tree ビルド・CLI・すべて read-only）
- 対象: [B23 仕様](../ksql_length_char_spec.md) §8／[B24 仕様](../ksql_translate_spec.md) §9 の実機分・レシピ R8 の実行確認（B18 の教訓）

## B23 `LENGTH_CHAR`

| 式 | 結果 | 判定 |
|---|---|---|
| `LENGTH_CHAR('𠮟')` / `LENGTH('𠮟')` | `1` / `2` | ✅ 常用漢字のサロゲートペア実例・差=ペア数 |
| `LENGTH_CHAR('𠮷野家')` | `3` | ✅ |
| `LENGTH('éé')` / `LENGTH_CHAR('éé')` | `2` / `2` | ✅ 紛らわしいケースで差 0（LENGTHB では判定不能だった系） |
| `SELECT LENGTH_CHAR FROM …`（素） | ParseError | ✅ 予約語 |

## B24 `TRANSLATE`

| 式 | 結果 | 判定 |
|---|---|---|
| `TRANSLATE('𠮟責と嚙み合わせ', 40字FROM, 40字TO)` | `叱責と噛み合わせ` | ✅ 記事の実データ |
| **`TRANSLATE('屢々沪過して蠟燭', …)`** | **`屡々濾過して蝋燭`** | ✅ **コードポイント整列の決定的証拠**（コードユニット整列なら `濾々蝋過して燭`） |
| `TRANSLATE('コード１２３ＡＢ', 全角英数, 半角)` | `コード123AB` | ✅ 全角→半角 |
| `TRANSLATE('a','aa','XY')` | `X` | ✅ 重複は最初優先 |
| `TRANSLATE('x','abc','AB')` | `ArgumentError: … from と to は同じ文字数である必要があります（from=3, to=2）` | ✅ コードポイント数で表現 |

## レシピ R8 の実行確認（read-only）

[R8「Shift_JIS で出力できない漢字を変換する」](../../ksql_batch_recipes.md) の公開 SQL（40 字表の `TRANSLATE` SELECT）を APP4148 で**そのまま実行し 3 行取得成功**。`ksql_validate` 相当では捕捉できない実行時エラーが無いことを確認（B18 の教訓に従う）。

## 判定

B23 §8・B24 §9 の実機分を満たす。性質・全数（40 字）・全経路は Node テストで固定済み（62 suites / 1,679 tests green）。v3.2.0 リリース待ち。
