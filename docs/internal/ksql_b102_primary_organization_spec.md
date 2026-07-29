# 仕様: B102 — `PRIMARY_ORGANIZATION()` を `LOGINUSER()` と同じ形で足す

- 作成: 2026-07-29
- 対象課題: [B102](ksql_b102_primary_organization_issue.md)（**§6 が実測・§7 が判断**）
- ステータス: ✅ **完了（v3.35.0 でリリース）**（2026-07-29）＝**受入 1〜10 すべて満たし全ゲート green**。**語数は予想と一致**（`{ total: 554, catalog: 259, prose: 295 }`）。**codex の停止 0 回**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（機能追加。公開型・既存の挙動は不変）

## 1. 決めたこと

**`PRIMARY_ORGANIZATION()` を `LOGINUSER()` とまったく同じ経路に足す。**
**加えて、DML の WHERE に現れたら fail-closed で拒否する。**

```sql
SELECT 案件名 FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())
SELECT 案件名 FROM APP100 WHERE 担当組織 NOT IN (PRIMARY_ORGANIZATION())
```

**用途はダッシュボードでの自組織抽出**（[B102 §1.1](ksql_b102_primary_organization_issue.md)）。

## 2. kintone 側の契約（[公式](https://cybozu.dev/ja/kintone/docs/overview/query/)）

| | |
|---|---|
| 使える型 | **組織選択（`ORGANIZATION_SELECT`）のみ** |
| 使える演算子 | **`in` / `not in` のみ** |

> **⚠ 優先組織が未設定のユーザーでは、条件が無視され全件が返る**（公式の記述）。
> **こちらでは再現できていない**（[B102 §6](ksql_b102_primary_organization_issue.md)）。
> **文書には「公式の記述による」と明記し、「実測した」とは書かないこと。**

## 3. 変更点

### 3.1 パーサ

**`LOGINUSER` と同じ扱いにする。**

| 箇所 | 変更 |
|---|---|
| token 定義 | `PRIMARY_ORGANIZATION` を足す |
| `src/parser/parser.ts:226` の名前対応表 | `[TokenKind.PRIMARY_ORGANIZATION]: "PRIMARY_ORGANIZATION"` |
| 同 `:276` の contextual token 一覧 | 追加 |
| 同 `:508` の `SET` / `DECLARE` 右辺拒否 | **`LOGINUSER` と同じく拒否する**（文言は同じ形に揃える） |
| `parseInValues()`（同 `:2645` 付近） | **`IN` / `NOT IN` リストの単独要素としてのみ受理**。`LOGINUSER` の分岐と同じ形 |

**`LOGINUSER` の既存の文言・挙動は一切変えないこと。**

### 3.2 サーバ専用関数の集合

**`src/core/relativeDateFunction.ts` の `LEGACY_KINTONE_FUNCTION_NAMES` に足す。**

これにより `SERVER_ONLY_WHERE_FUNCTION_NAMES` へ自動的に入り、
**ローカル評価が要る経路では既存の仕組みで拒否される。**

### 3.3 型×演算子の契約

**`src/core/optimization/whereCapability.ts` の 2 つの Map に足す。**

```ts
LEGACY_KINTONE_FUNCTION_FIELD_TYPES:
  ["PRIMARY_ORGANIZATION", new Set(["ORGANIZATION_SELECT"])]
LEGACY_KINTONE_FUNCTION_OPERATORS:
  ["PRIMARY_ORGANIZATION", new Set(["in", "not in"])]
```

**`ORGANIZATION_SELECT` × `in` / `not in` は `NATIVE_OPERATORS` に既にある。そちらは触らない。**

### 3.4 押し下げの直列化

**`src/converter/whereToKintone.ts` の `convertKintoneFunc` に `case "PRIMARY_ORGANIZATION"` を足し、
`PRIMARY_ORGANIZATION()` をそのまま出力する。**

### 3.5 ローカル解決

**`src/engine/evalWhere.ts` の `resolveKintoneFunc` は `LOGINUSER` と同じ扱い。**

**解決不能なら空文字を返す**＝**比較が常に false になり、閉じる側へ倒れる。**

> **これは kintone 側の fail-open とは逆向きで正しい。**
> **ローカル評価に落ちたときに全件を返してはならない。**

### 3.6 **DML は fail-closed**

**DML の WHERE に `PRIMARY_ORGANIZATION()` が現れたら、
レコード取得も書き込みも行わずにエラーにする。**

**対象**＝`UPDATE` / `DELETE` / `UPSERT` と、`INSERT ... SELECT` / `UPSERT ... SELECT` の
**SELECT 側 WHERE**も含む。

**理由**——**条件が無視されると全件が対象になる。**

```sql
DELETE FROM APPn WHERE 担当組織 IN (PRIMARY_ORGANIZATION())
-- 優先組織が未設定 → 条件が消える → アプリ全件が対象
```

**用途は SELECT に閉じているので、拒否しても失うものが無い。**

**実装箇所は任せる。**KLIKE の DML 拒否（`src/core/klikeValidation.ts`）が近い前例。
**ただし、既存の DML の挙動を他に一切変えないこと。**
**自然な実装箇所が無いと判断したら、黙って広げず、止めて報告すること。**

> **`LOGINUSER()` の DML での扱いは変えないこと。**
> **今回入れる拒否は `PRIMARY_ORGANIZATION()` だけが対象。**

### 3.7 カタログと文書

| | |
|---|---|
| `src/mcp/docsResources.ts:50` の `contextual` | **`LOGINUSER` の隣に `PRIMARY_ORGANIZATION` を足す**（15 → 16 個） |
| `src/mcp/__tests__/fixtures/ksqlFunctionCatalogFixtures.ts` | 対応する期待値を更新 |
| `docs/ksql_language_reference.md:682` の表 | **`ORGANIZATION_SELECT` / singleton の `in` `not in` のみ**の行を足す |
| 同 `:691` 付近の説明 | **組織選択だけに使える**旨と、**優先組織が未設定なら条件が無視される**（公式の記述による）を書く |

## 4. 語数予算（B81）

**カタログに 1 語増える。**

```
現在: { total: 553, catalog: 258, prose: 295 }
予想: { total: 554, catalog: 259, prose: 295 }   ← catalog だけ +1
```

- **`prose` は変わらない**（散文を足さないため）
- **段落数は 6 のまま**

> **実測が予想と違ったら、期待値を勝手に合わせず、止めて報告すること。**

## 5. 受入条件

1. **`WHERE 組織 IN (PRIMARY_ORGANIZATION())` が押し下げられ、kintone クエリへ素通しされる**
2. **`NOT IN` も同じ**
3. **`ORGANIZATION_SELECT` 以外の型では取得前に拒否される**
4. **`in` / `not in` 以外の演算子では取得前に拒否される**
5. **`IN` リストの単独要素以外（他の値と混在）では ParseError**
6. **`SET` / `DECLARE` の右辺では ParseError**
7. **DML の WHERE に現れたらエラーになり、レコード取得も書き込みも行わない**
8. **`LOGINUSER()` の既存の挙動・文言が変わっていない**
9. **語数予算が `{ total: 554, catalog: 259, prose: 295 }`**
10. **既存テスト全 green・snapshot 22 不変**

## 6. テスト

**`LOGINUSER` の既存テストと同じ観点を、`PRIMARY_ORGANIZATION` について足す。**

- パーサ（受理・混在拒否・`SET` / `DECLARE` 拒否）
- 型×演算子（`ORGANIZATION_SELECT` 以外／`in` `not in` 以外の拒否）
- 押し下げの直列化（`PRIMARY_ORGANIZATION()` が出力される）
- **DML 拒否**——**書き込み API が 1 回も呼ばれないこと**を確かめる
- カタログ（16 個）

## 7. 今回やらないこと

| | 理由 |
|---|---|
| **条件の脱落を検出する仕組み**（案 B'） | **狭い条件のために常時 `COUNT(*)` 2 回は重い**。実運用で踏むと分かってから |
| **User API での優先組織確認**（案 C） | **B54 を引き込む**。案 A' で足りるか見てから |
| **ローカル評価（FULL_SCAN）対応** | **サーバ側の文脈が要る**。`LOGINUSER` と同じ扱い |
| **`ORDER BY` での使用** | kintone のクエリ関数は WHERE 用 |
| **`LOGINUSER()` の挙動変更** | **一切触らない** |
| **`release/README.txt` と `docs/internal/ksql_*.md`** | リリース時にこちらで書く |
