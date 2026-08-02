# B112 `EXPLAIN` の `app:` / `JOIN:` 行で profile が二重になり、別名形では内部仮想 ID が残る

- 起票: 2026-08-02
- ステータス: 📝 **評価（実測済み・3 面すべてで再現）**
- 出典: B111 の相談（Pro 2026-08-02c）を実測中に発見。**B109 / B110 の回帰ではない**（v3.37.0 のコードでも同形。c460757＝v1.13.x 以来の既存欠陥）
- 関連: [B108](ksql_b108_inline_explain_mapped_id_issue.md) / [B109](ksql_b109_library_explain_mapped_id_issue.md)（**同じ契約違反の残り**）/ `src/core/sqlDiagnostics.ts`

## 1. 症状（実測 2026-08-02）

**症状は 2 つあり、同じ原因から出ている。**

### 1.1 別名なし → profile が二重（物理アプリのみ）

```
  metadata API: form definition APP4149@dev      ← 正しい
  app:           APP4149@dev@dev                 ← 二重
```

CLI `--dry-run`・MCP `ksql_explain`・MCP `ksql_query` の EXPLAIN 文で再現。

### 1.2 別名 / JOIN 形 → 括弧内の内部 ID が残る（**論理アプリでは内部仮想 ID の露出**）

```
CLI / MCP    app:           LAPP_案件管理@dev AS a (900000000)
             JOIN:        LAPP_検証アプリ@dev AS c (900000001)
ライブラリ    app:           LAPP_案件管理 -> APP4149 AS a (900000000)
             JOIN:        LAPP_検証アプリ -> APP4148 AS c (900000001)
物理アプリ    app:           APP4149@dev AS a (4149)          ← 無害だが雑音
```

**engine ライブラリ面でも露出する**（実測）。**B108 / B109 で塞いだはずの「内部仮想 ID を
利用者に見せない」という契約が、別名・JOIN の形だけ残っていた。**

## 2. 原因

`restoreSqlDiagnosticValue`（`src/core/sqlDiagnostics.ts:45-47`）の 2 段置換:

```ts
restored = restored
  .split(`${internal} (${binding.mappedAppId})`).join(display)   // ①括弧つき
  .split(internal).join(display);                                // ②裸のトークン
```

- **症状 1.1**: 物理アプリでは `display`（`APP4149@dev`）が `internal`（`APP4149`）を**含む**ため、
  ①の出力を②が**もう一度拾う** → `APP4149@dev@dev`。
  論理アプリは `display` が `LAPP_名前@dev` で internal を含まないため起きない
- **症状 1.2**: 計画本文の別名つきの行は `APP<n> AS <alias> (<n>)` の形で、
  **①のパターン（`APP<n> (<n>)` 隣接）に一致しない** → ②だけが効き、括弧内の内部 ID が残る

`target:` 行（DML）は専用規則が先に返すため正しい。

## 3. 影響範囲

| 面 | 別名なし | 別名 / JOIN |
|---|---|---|
| CLI `--dry-run` / EXPLAIN 文 | 物理で profile 二重 | **内部仮想 ID 露出**（論理） |
| MCP `ksql_explain` / `ksql_query` | 同上 | 同上 |
| engine ライブラリ `explainQuery` / `runBatch` | 正しい（B109） | **内部仮想 ID 露出**（論理） |

**Pro の実行計画ボタン（K-88）が踏む。** Pro のダッシュボード SQL は JOIN を使う
（K-87 の依頼文の例そのものが `LAPP_案件管理 d JOIN LAPP_顧客管理 c` の形）。

## 4. 方針（仕様案）

**2 段の `split`/`join` をやめ、1 パスの置換にする。**

- **トークン形をまとめて 1 回で置換する**＝`APP<n>` に続く「省略可能な `AS <別名>`」と
  「省略可能な `(<同じ n>)`」までを 1 つのパターンとして捉え、**関数形の置換**で
  `display` ＋ 別名（あれば）へ畳む。**自分の出力を再処理しない**ことが要点
- **括弧内の内部 ID は落とす**（別名なしの形が既にそうなっており、揃う）
- `target:` の専用規則・`logicalAppDisplay: "physical"`（ライブラリ）・
  B108 §6.2 の制約（文の型で判別・データ行に掛けない）は**すべて不変**
- 置換対象は**bindings に存在する ID のみ**（現行と同じ）

### 4.1 期待する出力

| 現行 | 期待 |
|---|---|
| `app: APP4149@dev@dev` | `app: APP4149@dev` |
| `app: LAPP_案件管理@dev AS a (900000000)` | `app: LAPP_案件管理@dev AS a` |
| `JOIN: LAPP_検証アプリ -> APP4148 AS c (900000001)` | `JOIN: LAPP_検証アプリ -> APP4148 AS c` |
| `app: APP4149@dev AS a (4149)` | `app: APP4149@dev AS a` |

### 4.2 受入条件

1. 物理アプリの `app:` 行の profile が二重にならない（CLI / MCP）
2. 別名・JOIN 形で括弧内の内部 ID が残らない（**3 面すべて**・論理／物理とも）
3. **内部仮想 ID（APP9000000xx）が EXPLAIN 出力のどこにも現れない**（論理アプリ・別名あり）
4. `target:`（DML）・`--dry-run`・`ksql_explain`・B109 のライブラリ経路の既存表示が不変
5. データ行への非適用（B108 §6.2）が不変＝`SELECT 'APP900000000' AS x` が壊れない
6. 既存テスト全 green・snapshot 22 不変・語数予算 exact 不変

## 5. 優先度

**中。** 誤った結果ではなく診断表示の契約違反だが、**B108 / B109 と同じ契約の残り**であり、
**Pro の実利用機能が JOIN 形で直接踏む**。修正は小（置換 1 箇所）。

**B108 の範囲を 2 度取り落とした**（B109＝ライブラリ面、B112＝別名 / JOIN 形）。
仕様を書くとき「経路」だけを列挙し、**出力の形を列挙していなかった**ことが共通の原因。
