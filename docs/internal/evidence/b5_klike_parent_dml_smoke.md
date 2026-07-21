# B5 実機証跡 — 通常親 UPDATE/DELETE の WHERE で KLIKE

- 実施日: 2026-07-21
- 対象: B5（通常（APPLY なし）親 UPDATE/DELETE の WHERE で KLIKE/NOT KLIKE 解禁）
- ビルド: v3.10.0（B5 反映・`dist-cli/ksql.js`）
- 実行: CLI（Node クライアント・本番 kintone・profile dev）
- 対象アプリ: **APP730（郵便番号・住所データ・618,525 レコード・サブテーブルなし）**
- 判定: **PASS**（B47-P4 で未確認だった「KLIKE DML の10万件 fail-closed」を補完）

## EXPLAIN（静的・records/mutation API 0回）
- `EXPLAIN UPDATE APP730 SET work='B5' WHERE 都道府県K KLIKE 'ケン'`:
  - `kintone query: 都道府県K like "ケン"`（KLIKE→native like）
  - `selection: exact native pushdown; JS residual none`
  - `search abort: DML fail-closed (SearchAbortedError; mutation 0)`
- `EXPLAIN DELETE FROM APP730 WHERE 都道府県K NOT KLIKE 'ギフケン'`:
  - `kintone query: 都道府県K not like "ギフケン"`（NOT KLIKE→not like）・同上の selection/fail-closed。

## 10万件打ち切り fail-closed（B47-P4 の補完・最重要）
- `UPDATE APP730 SET work='B5' WHERE 都道府県K KLIKE 'ケン' VALIDATE ONLY`（'ケン' は 43/47 都道府県が該当＝10万件超）→ **`SearchAbortedError: kintone の検索が 10 万件で打ち切られたため、完全な対象集合を確定できません。`**。
- `AND レコード番号 IN (1,2,3)` で絞っても**同じく打ち切り**（kintone は `like` スキャンを先に評価＝AND では回避不可）。
- → KLIKE の対象解決が10万件で打ち切られると、既存 DML failClosed wrapper（`failClosed=非 SELECT`）が `SearchAbortedError` を投げ、**mutation 0**。VALIDATE ONLY と実 UPDATE は同じ対象解決 getRecords（failClosed）を通るため、実 UPDATE でも打ち切り時は PUT 0（GET 段で停止）。B7-P3 でプラグインの検出も実機 PASS 済のため全 surface で成立。

## 実 KLIKE UPDATE（可逆・target だけ書き込むことの確認）
一県のみ（`都道府県K KLIKE 'ギフケン'`＝岐阜県・数千件＜10万件）は打ち切らない（VALIDATE ONLY で `validated=3`）。
1. **実行**: `UPDATE APP730 SET work='B5' WHERE 都道府県K KLIKE 'ギフケン' AND レコード番号 IN (1,2,3)`（`--allow-dml --yes`）→ `UPDATE 3 / affected=3`。
2. **検証**: 記録 1,2,3（岐阜県）→ `work=B5`。非 target（4,5＝同じ岐阜県だが IN 外）→ `work` 空のまま。＝KLIKE UPDATE が**一致した対象だけ**に書き込む。
3. **revert**: `UPDATE APP730 SET work='' WHERE レコード番号 IN (1,2,3)` → `UPDATE 3`。確認で 1,2,3 の work が空に復元。

## 拒否・非回帰
- **サブテーブル KLIKE 拒否**: `UPDATE APP4223$テーブル SET 文字列T1='x' WHERE 文字列T1 KLIKE 'y'` → `ArgumentError: KLIKE / NOT KLIKE はサブテーブル UPDATE の WHERE では使用できません`。
- **通常 DML の LIKE 拒否（維持）**: `UPDATE APP730 SET work='x' WHERE 都道府県 LIKE '岐阜%'` → `WHERE predicate cannot be represented by kintone REST (…operator=like, reason=WHERE_RESIDUAL)`＝EXACT_PUSHDOWN ゲートが LIKE を residual と判定して拒否（書き込みなし）。

## 結論
- B5（通常親 UPDATE/DELETE の KLIKE）を **EXPLAIN・fail-closed・実 mutation・拒否系すべて実データ PASS**。
- **KLIKE DML の10万件 fail-closed を実データで確定**（B47-P4 で >100k サブテーブルアプリが無く未確認だった点を、サブテーブル不要の通常 DML で補完）。
- LIKE は EXACT_PUSHDOWN ゲート、サブテーブル KLIKE は静的検証で拒否維持＝安全境界が実機で機能。
