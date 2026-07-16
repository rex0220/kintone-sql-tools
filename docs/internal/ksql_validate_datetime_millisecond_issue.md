# 課題: DML 事前検証がミリ秒付き ISO 日時を誤って拒否する（`NOW()` の定番パターンが false isolation）

- 作成日: 2026-07-16
- 発見経緯: B14/B16 のレシピ反映作業中（2026-07-16）。B12 §6 のレシピを実機で検証していて、`UPDATE … SET 日時 = @now … VALIDATE ONLY` が `ERR_TYPE_DATE` を返すことに気づいた。
- ステータス: **Codex 実装済み。コードレビュー・実機再確認待ち。**
- 分担: Claude=課題/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 事象

B12-A の事前検証器（`VALIDATE ONLY` / `ON ERROR SKIP` が共有）が、**kintone が実際には受理する値**を拒否する。対象は**ミリ秒付き ISO 8601 日時**＝ **`NOW()` / `SET @now = NOW()` が返す形式そのもの**。

### 実機実測（APP4221・2026-07-16）— **同一 SQL で判定が割れる**

| 経路 | 結果 |
|---|---|
| **`VALIDATE ONLY`**（検証器） | ❌ `日時` → `ERR_TYPE_DATE`「日時 の日付・時刻形式が不正です」 |
| **実書き込み**（kintone API） | ✅ **受理**（`$id=19` 作成）。保存値 **`2026-07-16T11:21:00Z`**（ミリ秒を分精度へ丸め） |

```sql
-- どちらも同じ値。検証は落ちるが、実書き込みは通る
INSERT INTO APP4221 (タイトル, 文字列MIN, 文字列MINMAX, 日時)
VALUES ('MSTEST', 'abc', 'abc', '2026-07-16T11:21:25.174Z') VALIDATE ONLY INTO #v;  -- → ERR_TYPE_DATE
INSERT INTO APP4221 (タイトル, 文字列MIN, 文字列MINMAX, 日時)
VALUES ('MSTEST', 'abc', 'abc', '2026-07-16T11:21:25.174Z');                        -- → insertedCount: 1
```

`NOW()` の実測値は `2026-07-16T11:21:25.174Z`（**ミリ秒付き**）。

## 2. 原因（コード裏取り済み）

`isValidTemporal`（[dmlValidation.ts:169-183](../../src/core/dmlValidation.ts#L169)）の DATETIME 分岐がミリ秒を許容していない:

```ts
// :181  ← .sss を受理する箇所が無い
return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  isValidTemporal(value.slice(11, value.endsWith("Z") ? -1 : value.length - 6), "TIME");
```

- 秒（`:\d{2}`）までは optional で許容するが、**小数部 `.\d+` の受理が無い**ため `…:25.174Z` が正規表現に一致しない。
- 仮に :181 を通しても、:182 が時刻部を `"11:21:25.174"` として `isValidTemporal(_, "TIME")` に渡し、TIME 側の正規表現 `/^(\d{2}):(\d{2})(?::(\d{2}))?$/`（[:171](../../src/core/dmlValidation.ts#L171)）にも一致しない。**2 箇所の対応が要る**。
- 入口の `isValidTemporalInput`（[:88-97](../../src/core/dmlValidation.ts#L88)）は、ミリ秒付き文字列を :96 の `isValidTemporal(normalized, "DATETIME")` へ素通しするため、結局 :181 で落ちる。

## 3. 影響

### 3.1 `ON ERROR SKIP` の false isolation（最も深刻）

`ON ERROR SKIP INTO #err` は**この検証器と同一基準**（Tier 0 厳格・[親仕様 §7.3](ksql_on_error_skip_isolation_spec.md)）で隔離する。したがって:

> **kintone に書けるはずの正常行が `#err` へ隔離され、書き込まれない。**

これは B12 仕様 R4/R5 が実装前ゲートとして最も警戒した **false isolation** そのものであり、しかも**公開レシピの定番パターンで発生**する。

### 3.2 定番パターンを直撃する

[レシピ集 R1](../ksql_batch_recipes.md) は `確保日時 = @now` / `処理日時 = @now`（いずれも**日時フィールド**）を差分バッチの標準形として案内し、「`確保日時`・`処理日時` は日時フィールドで可（丸めは無害）」と明記している。**この記載は正しい**（§1 の実機実測で kintone が丸めて保存することを確認）。

つまり **R1 に従ったバッチへ `VALIDATE ONLY` / `ON ERROR SKIP` を足すと、自分のタイムスタンプ列が原因で偽陽性/誤隔離が起きる**。

### 3.3 「検証器は書き込み経路より厳しくてよい」の範囲外

親仕様 §3.2 は「`VALIDATE ONLY` は…句なし DML より厳しい場合がある」と許容している。しかしそれは**「ローカルで判定できる不正を先に捕まえる」**という意味であり、本件は **kintone が受理する正当な値を不正と判定**している＝単なる誤判定。§3.2 の免責には当たらない。

## 4. 修正方針

**ミリ秒（小数秒）を受理する**。判定基準は「kintone が受理する値を拒否しない」こと。

- `isValidTemporal` の DATETIME 正規表現（:181）に小数部を追加: `(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`
- :182 が TIME 判定へ渡す時刻部から**小数部を除去**してから渡す（TIME 側の正規表現は変更しない＝`TIME` フィールドの意味論を変えない）。
- 小数部の桁数は**任意桁を許容**（ISO 8601 準拠。kintone 側で丸められる）。
- `DATE` / `TIME` フィールドの判定は**変更しない**（`NOW()` はそれらへは使わない。挙動変更の範囲を最小化する）。

## 5. 受入条件

- [x] `2026-07-16T11:21:25.174Z`（ミリ秒付き・`NOW()` の実形式）が DATETIME で**検証を通る**。
- [x] **`SET @now = NOW(); UPDATE … SET 日時フィールド = @now … VALIDATE ONLY`** がエラーゼロ（R1 の定番パターン）。
- [x] **`ON ERROR SKIP` で当該行が `#err` へ隔離されない**（＝実書き込みと同じく合格扱い）。
- [x] 小数部の桁数違い（`.1` / `.174` / `.123456`）をすべて受理。
- [x] オフセット形式（`2026-07-16T11:21:25.174+09:00`）も受理。
- [x] **既存の有効形式に回帰なし**（`…T11:21Z` / `…T11:21:25Z` / `2026-07-16 11:21:25` / `2026/07/16` 等）。
- [x] **無効形式は引き続き拒否**（`2026-13-01T00:00Z`（月13）・`2026-07-16T25:00Z`（時25）・`abc`・小数部のみで時刻不正 `…T99:99:99.1Z`）。
- [x] `DATE` / `TIME` フィールドの判定に回帰なし（TIME にミリ秒を足しても従来どおり拒否）。
- [ ] 実機パリティ: 検証が通った値は実書き込みでも通る（§1 の実測と一致）。

## 6. SemVer・リスク

- **SemVer: patch**。**受理範囲の拡大のみ**で、既存の通っていた値の挙動は不変。挙動変更は「誤って拒否していた値を受理する」方向だけ。
- **リスク: 小**。正規表現の局所修正。TIME 判定を変えないため波及なし。
- **リリース**: 出荷済み（v2.13.0）の不具合であり、**`ON ERROR SKIP` の看板価値（正しい行は書く）を損なう**ため、次リリース（v2.15.0）に同梱するのが妥当。

## 7. 関連

- 親仕様: [ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md)（§3.2 厳格度の免責範囲・§7.3 Tier 0 厳格の決定）
- レシピ: [ksql_batch_recipes.md](../ksql_batch_recipes.md) R1（`@now` を日時フィールドへ書く定番）
- 併せて判明した B12 §6 レシピの誤り（本件とは別・同時に修正）:
  - `UPDATE … WHERE $id IN (SELECT …)` は実行不能（`KintoneQueryError: IN (SELECT ...) は kintone クエリに変換できません`）。DML の WHERE 全般が対象で、一時テーブル参照に限らない。**`ksql_validate` は `ok:true` を返すため静的には捕捉できない**
  - `処理日時 = NOW()` は実行不能（`DmlConvertError: NOW() は INSERT / UPDATE の値として使用できません`）。`SET @now = NOW()` 経由が必要
