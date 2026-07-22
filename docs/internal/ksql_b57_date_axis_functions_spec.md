# B57 仕様 — 日付集計軸関数（DAYOFWEEK / QUARTER / WEEK ＋ DATE_FORMAT 指定子 %w %a %v %G）

- ステータス: 📋 **仕様 R2（2026-07-22・codex レビュー R1→R2 反映済＝P1×5/P2×5/P3×3 全件裏取り一致・残論点なし・実装着手可）**
- 実装: ✅ **仕様 R2 どおり実装済み（2026-07-22）**。契約テスト先行（実装前 23 fail / 2 pass）・`npm test` 第1段 2,786件 / 第2段 25件 green・B55 scalar 46件 / instructions 277語へ同期済み
- 起票: [B57 issue](ksql_b57_date_axis_functions_issue.md)（起票時 codex レビュー反映済）
- 種別: 改善（日付関数の拡充）／SemVer: **minor**（純追加・既存挙動不変）
- 関連: B55（MCP 全量関数カタログ同期）／B19（予約語追加の前例）
- R1→R2 の主な変更: 妥当日付検証を**新 3 関数すべてに統一**（R1 の QUARTER=slice 非検証の 2 系統案は返り値域 1〜4 を保証できず撤回。既存 MONTH の gate は 7 文字＝「完全同型」も不正確だった）・`assertArity(1,1)` 明示（既存 YEAR/MONTH/DAY は arity 検査なし＝自動では乗らない）・不正日付時の DATE_FORMAT は**新 4 指定子のみ個別空置換**（既存 9 指定子は挙動不変）・数値意味型 3 集合の現行名へ更新・DATEDIFF は前例でなく反面教師（無検証 Date.UTC 正規化）と位置づけ

## 1. 目的

曜日別・週次・四半期の業務レポートの集計軸を kSQL 単体で表現可能にする。現状の日付抽出（`YEAR`/`MONTH`/`DAY`＋`DATE_FORMAT` 指定子 9 個）では曜日・週番号・四半期が表現できず、生データ取得後のクライアント側計算になっている。

## 2. スコープ

> **注記（最重要）**: `WEEK` は **ISO-8601 固定**であり、**MySQL `WEEK()` の既定（mode 0）とは非互換**。mode 引数は持たない。

### 2.1 追加するもの

| 追加 | 内容 | 返り値 |
|---|---|---|
| `DAYOFWEEK(日付)` | 曜日番号（**MySQL/ODBC 互換: 1=日曜〜7=土曜**） | 数字文字列 `"1"`〜`"7"` |
| `QUARTER(日付)` | 四半期（暦年固定: 1〜3月=1） | 数字文字列 `"1"`〜`"4"` |
| `WEEK(日付)` | **ISO-8601 週番号** | 数字文字列 `"1"`〜`"53"`（ゼロ埋めなし） |
| `DATE_FORMAT` 指定子 `%w` | 曜日番号（**MySQL 互換: 0=日曜〜6=土曜**） | `"0"`〜`"6"` |
| `DATE_FORMAT` 指定子 `%a` | 曜日名（**kSQL 定義の日本語短縮: 日〜土**） | `"日"`〜`"土"` |
| `DATE_FORMAT` 指定子 `%v` | ISO 週番号（2 桁ゼロ埋め） | `"01"`〜`"53"` |
| `DATE_FORMAT` 指定子 `%G` | **ISO week-year**（4 桁） | 例 `"2026"` |

- `%G` は `%Y-%v` の年跨ぎ問題（起票時 codex 指摘）の解。**週次ラベルの推奨形は `DATE_FORMAT(日付, '%G-%v')`**。
- `DAYOFWEEK`（1 起点）と `%w`（0 起点）の値域差は **MySQL の実仕様どおり**。同一日付で **`DAYOFWEEK = %w + 1`** が常に成立することを表とテストで固定する（codex 承認・認知負荷への手当）。
- `%a` は **MySQL 互換指定子ではなく kSQL 定義の日本語短縮曜日**（MySQL の `%a`=Sun〜Sat から意図的に逸脱・kintone レポート用途優先）。**将来 locale を暗黙追加しない契約**（変えるなら別指定子）。

### 2.2 追加しないもの（明示）

- `DAYNAME`/`MONTHNAME`/`WEEKDAY`/`DAYOFYEAR`/`EXTRACT` 構文/`DATE_TRUNC`/`WEEK` の mode 引数。
- `%%` エスケープ（現行 `applyDateFormat` に無い。未対応指定子・`%` リテラルの素通しは現行踏襲＝`%Q`・単独 `%`・`%%Y` の非回帰テストで固定）。
- タイムゾーン変換（既存規約＝文字列上の日付をそのまま使用）。

## 3. 意味論

### 3.1 週・曜日の定義（ISO-8601）

- `WEEK`/`%v`/`%G`: ISO-8601 週番号＝週は月曜始まり・**その年の木曜日を含む週が W01**。`%G` はその帰属年。
- 境界例（node 検算済み・codex 暦検算一致）: 2025-12-29（月）→ **2026**-W01／2026-01-01（木）→ 2026-W01／2026-12-31（木）→ 2026-W53／2027-01-01（金）→ **2026**-W53／2020-12-31（木）→ 2020-W53／2021-01-01（金）→ **2020**-W53。
- `QUARTER`: `ceil(月/3)`（暦年固定・会計年度オフセットなし）。

### 3.2 入力規約（新 3 関数・新 4 指定子で統一）

- **妥当日付検証あり**: `isValidYmd(dateStr)`＝先頭 10 文字が `YYYY-MM-DD` の字句形かつ**暦として実在する日付**（round-trip 検証。`Date.UTC` は `2026-02-31`→3/3 のように黙って正規化するため、正規化**前**に検証して弾く）。
- 検証 NG（空セル・10 文字未満・TIME 単独・月 `00`/`13`・非数字・うるう日不正）→ **関数は空文字**・**指定子は当該指定子のみ空文字に置換**。
- **既存関数・既存 9 指定子の挙動は一切変更しない**: `YEAR`/`MONTH`/`DAY` の slice 非検証（`MONTH` の gate は **7 文字**）・`DATEDIFF` の無検証 `Date.UTC` はそのまま（互換維持）。`DATEDIFF` は不正日付を正規化して受け入れる**反面教師**であり、その問題を新機能へ持ち込まないための検証である（前例引用ではない・codex 指摘で訂正）。
- 混在 pattern の例: 不正日付 `2026-02-31` に対する `'%Y|%w|%G-%v'` → **`"2026||-"`**（`%Y` は現行どおり `2026`・新指定子のみ空）。
- **各関数は厳密に 1 引数**: 既存経路は関数別 arity 表を持たず各 case が明示検査する方式（`assertArity`＝evalFunc.ts:433・使用前例 `LAST_DAY`:407。`YEAR`/`MONTH`/`DAY` は検査なし）のため、**新 3 case の先頭で `assertArity(expr.func, args, 1, 1)` を必須**とする。0/1/2 引数を受入条件で固定。

### 3.3 返り値型と比較（数値意味型 3 集合）

`DAYOFWEEK`/`QUARTER`/`WEEK` は数字文字列を返すが、比較・整列は数値意味とする。**3 集合へ追加**（全 grep で 3 集合で足りることを codex 確認済み）:

| 集合 | 位置 | 効果 |
|---|---|---|
| `NUMBER_RETURNING_STRING_FUNCTIONS` | execute.ts:2982 | 列メタ推論 |
| `NUMERIC_STRING_FUNCTIONS` | evalWhere.ts:166 | WHERE/HAVING 比較 |
| `NUMERIC_ORDER_FUNCTIONS` | process.ts:686 | GROUP BY キー・ORDER BY 整列 |

`DATE_FORMAT` の返り値は従来どおり文字列（`%G-%v` はゼロ埋めで辞書順=時系列順）。

## 4. 使用可能位置・実行計画（全経路 codex 裏取り済み）

- 新 3 関数は STRING_FUNC として: SELECT 射影（process.ts:866）・**GROUP BY**（FUNC_KEY＝parser.ts:2420 → 実行側 evalStringFunc＝process.ts:305）・HAVING/WHERE（evalWhere.ts:317）・ORDER BY（process.ts:691）。token map へ追加すれば `tryStringFuncName()`（parser.ts:1710）が全経路で拾い、frozen spellings は token map から自動導出（parser.ts:216）。
- 押し下げなし: 関数 leaf は JS 残余評価（selectToKintone.ts:90）・AND 兄弟の安全述語は既存プレフィルタ対象。GROUP BY は無条件 FULL_SCAN（selectToKintone.ts:67）。
- **完全入力契約は不要**（スカラー関数。B56/B58 の STATISTICAL_AGGREGATE とは無関係）。

## 5. 実装スケッチ

- `evalFunc.ts`: 新 3 case（先頭で `assertArity(…, 1, 1)`）＋純関数群（`isValidYmd`/`dayOfWeekIndex`/`isoWeekNumber`/`isoWeekYear`）。`applyDateFormat` は**単一パスの `/%[YymcdeHiswavG]/g` callback 置換への書き換えを推奨**（既存 replace chain 維持も可＝現行・新規の置換値は数字/曜日文字で `%` を含まず再置換衝突なし・`%G`/`%v` と既存指定子に包含関係なし＝codex 確認済み。ただし不正日付時の「新指定子のみ空置換」は callback の方が明確）。
- lexer/parser: 予約語 3 語・STRING_FUNC token map・`FUNC_CALL_PREFIX_KINDS`。
- 数値意味型 3 集合（§3.3）。

## 6. 予約語

新規予約語 3 語: `DAYOFWEEK` / `QUARTER` / `WEEK`。`WEEK`・`QUARTER` は一般語で衝突リスクあり＝バッククォート注記（B19 前例）＋CHANGELOG 告知。前方一致（`WEEKLY` 等）は非影響（B19 実測・非回帰テストに含める）。

## 7. 同期箇所（実装チェックリスト・4 群）

**実装**
- `src/types/ast.ts`（StringFunc union）・`src/lexer/tokens.ts`（予約語 3 語）
- `src/parser/parser.ts`（STRING_FUNC token map・`FUNC_CALL_PREFIX_KINDS`・frozen 定数は自動導出の確認）
- `src/engine/evalFunc.ts`（3 case＋assertArity＋`applyDateFormat` 4 指定子＋純関数群）
- 数値意味型 3 集合（execute.ts:2982 / evalWhere.ts:166 / process.ts:686）

**テスト**
- 契約テスト（新ファイル推奨）: §3.1 境界表 6 日付・うるう年 2/29（有効）・不正日付（2026-02-31・2025-02-29・月 00/13・区切り不正・非数字）→空文字・混在 pattern `'%Y|%w|%G-%v'`＝`"2026||-"`・`DAYOFWEEK = %w + 1` 恒等・QUARTER 全 12 月・`%G-%v` ラベル・空セル/TIME 単独・**0/1/2 引数**・`%Q`/単独 `%`/`%%Y` 素通し非回帰・`WEEKLY` 前方一致非影響
- 経路: SIMPLE 射影・GROUP BY 集計（**GROUP BY キー値と SELECT 出力値の一致**）・HAVING・ORDER BY 数値順・WHERE 数値比較（`DAYOFWEEK(f) >= 2` で `"10">"9"` 型の誤りがない）
- lexer 予約語・既存 `DATE_FORMAT` 9 指定子と `YEAR`/`MONTH`/`DAY`/`DATEDIFF` の非回帰

**docs / MCP**
- 言語リファレンス: 日付関数表へ 3 関数（冒頭に MySQL `WEEK()` 非互換注記）・`DATE_FORMAT` 指定子表更新（`%G-%v` 推奨形・`%a`=kSQL 定義日本語・不正日付時の空置換）・予約語注記
- B55 カタログ: instructions（**scalar 43→46**・語数は**追加後の実測値へ exact assertion を再固定**＝metadataTools.test.ts:101 は現在 274 語の exact）・docsResources（docsResources.ts:35）・fixtures・drift guard・`ksql_docs`・mcp-smoke / pack-smoke 代表語
- `CHANGELOG.md` 未リリース見出しへ追記（予約語告知）・tracker / issue / spec ステータス行・実機 evidence

**リリース**（B56/B58 と同一リリース v3.13.0 想定・同梱）
- `package.json`・`package-lock.json`（先頭 2 箇所）・`prod/manifest.json`・`release/VERSION.txt`・`release/README.txt`・`prod/js/desktop.js` と `plugin/js/desktop.js` 再ビルド・4 面 smoke

## 8. 受入条件

1. **ISO 週境界表**（§3.1 の 6 日付）で `WEEK`/`%v`/`%G` が期待値一致。
2. **曜日**: 同一日付で `DAYOFWEEK = %w + 1`・`%a` が日〜土で整合。
3. **四半期**: 全 12 月で 1〜4（妥当日付のみ・不正は空文字）。
4. **不正値**: §3.2 の全パターンで関数=空文字・指定子=個別空置換・**既存 9 指定子と `YEAR`/`MONTH`/`DAY`/`DATEDIFF` は挙動不変**。
5. **経路**: SIMPLE 射影／GROUP BY（FULL_SCAN・キー値と出力値一致）／HAVING／ORDER BY（数値順）／WHERE（数値比較・AND 兄弟プレフィルタ維持）。
6. **引数**: 各関数 0 引数・2 引数が ArgumentError。
7. **非回帰**: 全テスト green・drift guard / instructions exact 語数 green。
8. **予約語**: バッククォート参照可・`WEEKLY` 非影響。

## 9. 解決済み論点

- **R1-Q1（`%a` の言語）: 日本語短縮（日〜土）を採用**（codex 承認。「kSQL 定義」と明記・locale 暗黙追加しない契約）。
- **R1-Q2（検証の系統）: 新 3 関数すべて妥当日付検証で統一**（codex 推奨採用。R1 の 2 系統案は QUARTER の返り値域を保証できず撤回。既存関数の緩い挙動は互換のため不変）。
