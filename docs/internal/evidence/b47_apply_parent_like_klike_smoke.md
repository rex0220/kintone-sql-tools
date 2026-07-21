# B47-P4 実機証跡 — APPLY 複数親 UPDATE の親 WHERE LIKE/KLIKE

- 実施日: 2026-07-21
- 対象: B47（APPLY 複数親 UPDATE の親 WHERE に LIKE＋KLIKE 解禁・prefilter→残余評価→target）
- ビルド: v3.10.0（B47-P1〜P3 反映・`dist-cli/ksql.js`）
- 実行: CLI（Node クライアント・本番 kintone・profile dev）
- 対象アプリ: **APP4223（B44/B47 テストアプリ・223 レコード・サブテーブル テーブル/テーブル2）**
- データ: UPS-001〜UPS-020（レコード 202〜221・金額 7777）・BULK-MULTI（2〜201・金額空）・B44-INS/B44-UPS-NEW 等
- 判定: **PASS**

## read-only 検証（書き込みなし）

### EXPLAIN（静的・records API 0回）
`EXPLAIN UPDATE APP4223 SET 金額=1 WHERE タイトル KLIKE 'UPS' APPLY テーブル (PATCH SET 文字列T1='x' ALL ROWS)`
- `parent selector: タイトル like "UPS"`・`parent selection: safe prefilter + JS residual evaluation`
- `kintone prefilter: タイトル like "UPS"`・`applied KLIKE: 1 / unapplied KLIKE: 0`
- `candidate limit: maxRecords=500, onLimit=error, stopAfter=none`・`target guard: dmlMaxRows=100 after JS residual evaluation`
- `search abort: DML fail-closed (B7-P3; all surfaces, no surface gate)`
- **KLIKE が APPLY 親 WHERE で受理された**（旧版は拒否）＝B47-P3 の解禁と EXPLAIN を実データで確認。

### VALIDATE ONLY（read-only・mutation なし）
- **LIKE（candidate≠target）**: `WHERE タイトル LIKE 'UPS-01%'` → `validated=10 valid=10 invalid=0`。LIKE-only は prefilter 空＝全 223 件を candidate 取得し、残余評価で **target=10**（UPS-010〜019）へ絞る。
- **KLIKE（native 選択）**: `WHERE タイトル KLIKE 'UPS'` → `validated=21`（UPS-001〜020＋B44-UPS-NEW を native like で捕捉）。
- **unapplied KLIKE（OR 配下）**: `WHERE (タイトル KLIKE 'UPS' OR 金額=7777)` → `UnsupportedError: … 安全に押し下げられない KLIKE …`（**records API 前に拒否**）。
- **通常 DML KLIKE（非回帰）**: `UPDATE … WHERE タイトル KLIKE 'UPS' VALIDATE ONLY`（APPLY なし）→ `ArgumentError: KLIKE / NOT KLIKE は通常の DML では使用できません`。

## 実 mutation（可逆・target だけ書き込むことの決定的確認）

前提: UPS-01x（211〜220）はサブテーブル テーブル 行 0 件（APPLY PATCH ALL ROWS は子 0 件＝金額のみ変更で可逆）。全 UPS の 金額=7777。

1. **実行**: `UPDATE APP4223 SET 金額=9999 WHERE タイトル LIKE 'UPS-01%' APPLY テーブル (PATCH SET 文字列T1='x' ALL ROWS)`（`--allow-dml --yes`）→ `UPDATE 10 / affected=10`。
2. **検証**:
   - **target（211〜220 = UPS-010〜019）→ 金額=9999**。
   - **非 target 不変**: UPS-001〜009（202〜210）=7777・UPS-020（221）=7777・BULK-MULTI（100）=空。
   - candidate として取得された非 target（UPS-001〜009・UPS-020）は残余評価で除外され**書き込まれていない**＝candidate≠target を実データで実証。
3. **revert**: `UPDATE APP4223 SET 金額=7777 WHERE レコード番号 IN (211..220)` → `UPDATE 10`。確認で UPS 全 20 件が 7777 に復元（GROUP BY 金額: 7777×20＋100×1）。

## 未検証（記録・リリースノート反映）

- **KLIKE DML の10万件検索打ち切り fail-closed**: >100k レコードを持つ**サブテーブル（APPLY 可能）アプリが無い**ため直接は未実施。合成的にカバー＝①B7-P3 で「プラグイン/Node の打ち切り検出」を実機 PASS（APP730・618,525 件）②KLIKE DML は既存 DML failClosed wrapper（文種別 !SELECT）を通り、打ち切り時 `SearchAbortedError`（unit 固定）③native 適用集合の完全性は EXPLAIN の `search abort: DML fail-closed` で表示。

## 結論

- B47 の親選択（safe prefilter → 元 WHERE の JS 残余評価 → target だけ mutation）を **read-only（EXPLAIN/VALIDATE ONLY）と実 mutation の両方で実データ PASS**。LIKE・KLIKE・candidate≠target・unapplied 拒否・通常 DML 非回帰を確認。
- KLIKE の打ち切り fail-closed は B7-P3＋unit＋共通 wrapper で合成的にカバー（リリースノート明記）。
