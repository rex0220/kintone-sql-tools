# B34 実機記録: 書き込み可能トップレベルフィールド検査（CLI / MCP）

- 実施日時: 2026-07-18
- 実施者: Claude（実機・dev・APP4221・working tree ビルド）
- 対象: [B34 課題文書](../ksql_dml_writable_field_check_issue.md) §5 受入条件の実機 6 パターン＋非回帰
- 方法: CLI（dist-cli/ksql.js）と MCP（dist-mcp/ksql-mcp.js を stdio 直接起動・`ksql_mutate`/VALIDATE ONLY）

## 課題文書 §1 の 6 パターン（発見時→修正後）

| # | 操作（発見時の結果） | 修正後 |
|---|---|---|
| 1 | INSERT サブ子 `文字列T1`（insertedCount:1・書かれない） | ✅ `ArgumentError: DML target field 文字列T1 is inside a subtable. Use subtable DML syntax (for example, APP4221$テーブル).`（CLI/MCP 同一） |
| 2 | UPDATE サブ子（updatedCount:1・書かれない） | ✅ 同上（**MCP＝発見時と同一経路で before/after 確定**） |
| 3 | INSERT 不存在 `存在しないフィールドXYZ`（insertedCount:1） | ✅ MCP: `DML target field … does not exist.`／CLI: 既存の事前検査 `unknown field code(s): …`（v1.1.0 からの CLI 固有検査が先に発火・fail-closed 同士の文言差として許容） |
| 4 | UPDATE 不存在（updatedCount:1） | ✅ 同上 |
| 5 | VALIDATE ONLY 不存在（従来から拒否） | ✅ `does not exist.`（非回帰） |
| 6 | **VALIDATE ONLY サブ子（従来 ok:true/validRows:1 素通し）** | ✅ **`is inside a subtable.` で拒否＝B34 の中核修正** |

- 不正対象では confirm・レコード取得・書き込み API に到達しない（Node テストで fieldCalls=1 のみ・getRecords/confirm/post/put/delete=0 を 75 ケース固定。実機でもエラーのみで応答即時）
- サブ子エラーの例示 `APP4221$テーブル` は本アプリでは実サブテーブルコードと一致

## 非回帰（実書き込み）

MCP `ksql_mutate` バッチ: `INSERT INTO APP4221 (タイトル, 文字列MIN, 文字列MINMAX) VALUES ('B34OK','xxx','xxx'); DELETE FROM APP4221 WHERE タイトル = 'B34OK'` → INSERT 成功（$id 83）→ DELETE 成功（掃除済み）。**新検査は正しいトップレベル DML を阻害しない。**

## 判定

課題文書 §5 の実機チェックボックスを満たす。B34 は v3.2.0 リリース待ち。
