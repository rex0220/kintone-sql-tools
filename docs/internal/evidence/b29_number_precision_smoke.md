# B29 numberPrecision 実機検証証跡

- 対象: B29「kintone の数値精度・丸め設定（numberPrecision）と DML/Tier-0 の整合」
- リリース: v3.3.0（B9・B20 と同居）
- 実施日: 2026-07-18
- 環境: devenxyfi.cybozu.com（dev） / APP4221（顧客情報）・APP4148（案件管理）
- surface: Node CLI（`dist-cli/ksql.js`）＋ REST 直叩き（kSQL を迂回した実機境界確認）
- 実装 commit: `5ea2c73 feat: align DML with kintone number precision`

## 1. settings API 形状（§11-1）

`GET /k/v1/app/settings.json?app=N` の `numberPrecision`:

| app | digits | decimalPlaces | roundingMode | status |
|-----|--------|---------------|--------------|--------|
| 4221 | "16" | "4" | "HALF_EVEN" | 200 |
| 4148 | "16" | "4" | "HALF_EVEN" | 200 |

値は**文字列**で返る（`parseNumberPrecisionSettings` の `/^\d+$/` 検証・数値強制と一致）。
整数部予算 `I = digits − decimalPlaces = 16 − 4 = 12`。

## 2. §11-4 整数部予算式の実機確定（最重要）

`金額`（NUMBER）へ REST 直 POST（kSQL 検証を迂回）し、kintone の実挙動を測定:

| 入力 | 整数桁 | kintone status | 結果 |
|------|--------|----------------|------|
| `999999999999` | 12 | 200 | **受理** |
| `9999999999999` | 13 | 400 `CB_VA01`「有効桁数を超えています。」 | **拒否** |

→ **`I = digits − decimalPlaces = 12` は kintone の実ハード境界**。合計 digits(16) 制限ではなく整数部予算で拒否される。B29 の `ERR_NUMBER_INTEGER_DIGITS`（12桁許容・13桁拒否）は実機と完全一致。仕様 §5.2 の「実装前に §11-4 で確定」を**確定**。

## 3. 小数部：kintone は暗黙丸め（decimalPlaces 拒否の正当性）

kintone は小数超過を**ハード拒否せず、黙って decimalPlaces へ丸めて保存**する。REST 直 POST → kSQL SELECT 読み戻し:

| 入力 | kintone status | 保存値（読み戻し） |
|------|----------------|--------------------|
| `12.34567`（小数5桁） | 200 | **`12.3457`**（4桁へ丸め） |
| `0.00005` | 200 | **`0`**（HALF_EVEN で 0.0000） |
| `12.345678901234567`（合計17有効桁） | 200 | 4桁へ丸め |
| `999999999999.12345`（12整数+5小数） | 200 | 4桁へ丸め |

→ 合計有効桁・小数桁に**ハード上限はなく**、超過分は静かに丸められる。**B29 の `ERR_NUMBER_DECIMAL_PLACES` は「偽拒否」ではなく、この silent rounding によるデータ改変を防ぐ保護**。B1/B18 の「暗黙切り捨て・丸めをしない」と同じ原則。kSQL は仕様どおり kintone より**意図的に厳格**（丸めずに拒否）。

## 4. VALIDATE ONLY 桁検証（CLI 全経路・§11-8）

`INSERT INTO APP4221 (金額) VALUES (...) VALIDATE ONLY`:

| 入力 | ローカル判定 |
|------|--------------|
| `999999999999`（12整数） | 金額に数値エラーなし（他フィールドの required/length のみ） |
| `9999999999999`（13整数） | `ERR_NUMBER_INTEGER_DIGITS`「整数部は 13 桁です。許容は 12 桁までです (digits=16, decimalPlaces=4)」 |
| `12.34567`（5小数） | `ERR_NUMBER_DECIMAL_PLACES`「小数部は 5 桁です。許容は 4 桁までです」 |
| `100.1234`（3整数4小数） | 金額に数値エラーなし |

1フィールド1エラー・他フィールド診断と併存（Tier-0 の per-row 収集）を確認。ローカル判定は §2/§3 の実機挙動と整合（整数=ハード一致、小数=保護的により厳格）。

## 5. HALF_EVEN 単体（丸め primitive）

`quantizeDecimal` は明示丸め専用 primitive（通常 DML は呼ばない）。banker's rounding を単体テストで固定: `0.5→0`・`1.5→2`・`2.5→2`・`3.5→4`（負数対称）・`9.999,P=2→10.00`（carry）。実機の `0.00005→0`（5thが5・直前0=偶数→切り捨て）と方向一致。

## 6. cleanup（§11-11）

検証で生成した全レコード（`タイトル IN ('NPPROBE','NPPROBE2')`＝レコード番号 93/94/95/103/107/108/109/110/111）を DELETE → `COUNT(*) = 0` を確認。app settings は変更していない（read のみ）。

## 結論

- 整数部予算 `I = D − P = 12` は kintone 実機のハード境界と一致（§11-4 確定）。
- 小数部は kintone が silent rounding するため、B29 の拒否は**保護的で正当**（偽拒否ではない）。
- CLI 全経路で桁検証が発火し、fail-closed・per-field 診断・binary64 算術非変更を維持。
- B29 実装は仕様 R1 と実機の双方に整合。**v3.3.0 minor として出荷可**。
