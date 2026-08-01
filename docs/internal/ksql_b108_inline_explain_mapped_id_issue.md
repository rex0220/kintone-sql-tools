# B108 インライン `EXPLAIN` 文が論理アプリの内部 mapped ID を表示する

- 起票: 2026-08-01
- ステータス: 📋 **仕様確定・実装待ち（v3.37.0 同梱・オーナー決定）**（2026-08-01）＝仕様は §6
- 出典: B107 の実機検証中に発見（2026-08-01）。**B107 の回帰ではない**（ASCII 名でも同じ＝v1.13.x 以来の既存ギャップ）
- 関連: [B107](ksql_b107_lapp_engine_library_issue.md) / `src/node/sqlDiagnostics.ts`

## 1. 症状（実測 2026-08-01）

**CLI で `EXPLAIN` を文として書くと、論理アプリが内部の仮想 ID のまま表示される。**

```
ksql -e "EXPLAIN SELECT COUNT(*) FROM LAPP_KENSHO"
  app:           APP900000000 (900000000)      ← 内部 mapped ID がそのまま

ksql --dry-run -e "SELECT COUNT(*) FROM LAPP_検証アプリ"
  app:           LAPP_検証アプリ@dev            ← こちらは正しく復元される
```

**バッチ形（`EXPLAIN ...; EXPLAIN ...`）も同様に復元されない。**

## 2. リファレンスとの食い違い

言語リファレンス §1（論理アプリ参照）:

> EXPLAIN と利用者向け診断は論理名・最終物理 ID・profile を表示し、内部 mapped ID は表示しない

**インライン `EXPLAIN` の経路はこの契約を満たしていない。**

## 3. 原因（配線の欠落）

`restoreSqlDiagnosticValue` の呼び出しは 2 箇所だけ:

| 経路 | 復元 |
|---|---|
| `--dry-run`（`src/cli/index.ts:2387`） | **される** |
| `buildBatchExplainPlans` 経由（同 `:2238`） | される |
| **インライン `EXPLAIN` 文**（通常実行で `result.type === "EXPLAIN"`） | **されない** |

**修正はこの経路へ同じ復元を配線するだけ**に見える（要確認）。

## 4. 調査結果（2026-08-01・実測）

### 4.1 面ごとの実態

| 経路 | 復元 | 確認方法 |
|---|---|---|
| CLI `--dry-run` | **される**（`LAPP_検証アプリ@dev`） | 実測 |
| CLI インライン `EXPLAIN` 文（単文） | **されない**（`APP900000000` 露出） | 実測 |
| CLI バッチ内 `EXPLAIN` 文 | **されない** | コード（`executeBatch` 結果に restore 無し） |
| MCP `ksql_explain`（専用ツール） | **される**（併記あり・mapped 露出なし） | **実測**（dist-mcp＋一時 config） |
| MCP `ksql_query` に `EXPLAIN` 文 | **されない**（mapped 露出） | **実測** |
| MCP `ksql_query` バッチ内 `EXPLAIN` | **されない** | **実測** |

**穴は「文として書いた EXPLAIN」に共通**——CLI・MCP とも、専用経路（`--dry-run` /
`ksql_explain`）は正しく、**汎用実行へ流れた EXPLAIN だけが素通り**している。

### 4.2 既存テストの固定

- **露出側を固定しているテストは無い**（修正に既存テストの書き換えは不要）
- 逆に **復元済みであることを固定するテストは複数ある**
  （`dml_guard.e2e` の stderr・`tools.test.ts:147` の EXPLAIN ツール出力など）＝**修正の方向と一致**

### 4.3 修正の設計注意（着手時に効く 2 点）

1. **EXPLAIN の実行結果は `result.type` が SELECT で返る**
   （`tools.ts:672` がそれを前提にしている）。**結果型では判別できない**ので、
   **文の型（AST の EXPLAIN）で復元対象を選ぶ**こと
2. **restore を全結果へ無差別に掛けないこと**＝`restoreSqlDiagnosticValue` は
   値の全体を文字列置換で歩く。**データ行（SELECT の結果）へ掛けると、
   利用者データに偶然含まれる文字列まで書き換えうる**。**EXPLAIN の計画出力に限定**する

### 4.4 修正の縫い目（3 箇所・小〜中）

| | |
|---|---|
| CLI 単文 | `cli/index.ts:2387` の条件を「`dryRun` **または EXPLAIN 文**」へ |
| CLI バッチ | `:2325` の `executeBatch` 結果のうち **EXPLAIN 文由来のものだけ** restore |
| MCP `ksql_query` | 単文・バッチ envelope の **EXPLAIN 文由来 payload だけ** restore |

## 5. 優先度の根拠

**低。** 誤った結果を返す問題ではなく、診断表示の契約違反。
`--dry-run` という正しく動く代替経路がある。
**ただし B107 で日本語論理名の利用者が増えると露出しやすくなる**ため、
次の小修正の機会に拾う価値がある。


---

## 6. 仕様（2026-08-01・v3.37.0 同梱）

**「文として書いた EXPLAIN」の 4 経路すべてで、内部 mapped ID を復元する。**

### 6.1 変更点（縫い目 3 箇所・§4.4 のとおり）

| 箇所 | 変更 |
|---|---|
| CLI 単文（`cli/index.ts:2387` 付近） | 復元条件を「`dryRun` **または文が EXPLAIN**」へ |
| CLI バッチ（`:2325` 付近） | `executeBatch` 結果のうち **EXPLAIN 文由来の結果だけ**復元 |
| MCP `ksql_query` | 単文・バッチ envelope とも **EXPLAIN 文由来の payload だけ**復元 |

### 6.2 設計制約（§4.3 の 2 点・必須）

1. **判別は文の型（AST の EXPLAIN）で行う。**実行結果は `result.type` が SELECT で
   返るため、結果型で判別しないこと（`tools.ts:672` の前提を壊さない）
2. **復元は EXPLAIN の計画出力に限定する。**SELECT 等のデータ行へ
   `restoreSqlDiagnosticValue` を掛けないこと——**利用者データに偶然
   `APP900000000` という文字列が含まれていても書き換えない**ことをテストで固定する

### 6.3 受入条件

1. **CLI 単文 EXPLAIN**（通常実行・全出力形式）で mapped ID が復元され、論理名が表示される
2. **CLI バッチ内 EXPLAIN** も同様。**同じバッチ内の SELECT データ行には復元を掛けない**
3. **MCP `ksql_query` の単文・バッチ内 EXPLAIN** も同様
4. **データ非破壊**＝`SELECT 'APP900000000' AS x` のようなデータがそのまま返る
5. **既存の復元経路（`--dry-run`・`ksql_explain`・バッチ dry-run）は不変**
6. **既存テスト全 green・snapshot 22 不変・語数予算 exact 不変**

### 6.4 やらないこと

- `restoreSqlDiagnosticValue` 本体の変更（呼び出し側の配線だけ）
- EXPLAIN 以外の文への復元拡大
- エラー経路（`restoreSqlContextError`）——既に配線済み
