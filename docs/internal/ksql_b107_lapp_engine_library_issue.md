# B107 `LAPP_<NAME>` をブラウザ向け公開 API（runQuery / runBatch）でも解決する

- 起票: 2026-08-01
- ステータス: 📝 **評価（Pro へ質問を返して回答待ち）**
- 出典: [Pro の依頼 2026-08-01](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260801-送付版.md)（K-87・優先 中・**急ぎではない＝Pro はテキスト置換のフォールバック案を保有**）
- 関連: [論理アプリ参照の実装](../ksql_issue_tracker.md)（v1.13.x・CLI / MCP）/ B66 engine ライブラリ

## 1. 依頼

**`RunQueryOptions` / `runBatch` に `logicalApps: Record<string, number>` の受け口を追加し、
SQL 中の `LAPP_<NAME>` をブラウザでも解決できるようにしてほしい。**

狙い＝設定ファイルの環境非依存化（開発 → 本番・テンプレート配布で、差し替えを
マッピング表 1 箇所にする）。

## 2. 測定（2026-08-01）

### 2.1 機構の所在と性質

| | |
|---|---|
| 解決の場所 | **`src/node/appProfiles.ts` の `normalizeSqlAppProfiles`＝Node runtime の前処理**。core パーサは `LAPP_` を知らない |
| 方式 | **字句認識つきのテキスト書き換え**＝`'文字列'`（`''` エスケープ対応）・バッククォート識別子・行/ブロックコメントを**読み飛ばして** `LAPP_X` → 物理/仮想 ID へ置換 |
| 診断表示 | **併記**＝`LAPP_ORDERS -> APP1234@prod`（`src/node/sqlDiagnostics.ts`） |
| 未定義名 | `ArgumentError: logical app LAPP_X@profile is not defined.`（**名前入り**） |
| 純粋性 | `normalizeSqlAppProfiles` 自体は純粋な文字列処理。**ただしモジュールが `fs` を import**（`parseTokenFile` 用）しており、engine bundle へ入れるには分離が要る |

> **Pro の懸念 3 点（文字列内の誤置換・表示の食い違い・字句規則の二重管理）は、
> エンジンの機構がすべて解決済みである。**依頼の筋は良い。

### 2.2 engine-library の現状

```
runQuery('SELECT * FROM LAPP_TEST', { client })
→ PARSE_ERROR | テーブル名は APP + 数字…「LAPP_TEST」は無効です（位置 14）
```

### 2.3 **⚠ 前提が覆った — 論理名は ASCII 限定**

**名前規則＝`[A-Z][A-Z0-9_]{0,63}`・大小文字を区別しない・ASCII のみ**
（スキャナ `isAsciiLogicalNameStart/Continue`・`config.ts` の `LOGICAL_APP_NAME_RE`・
言語リファレンス §1「CLI / MCP 拡張」に記載）。

**Pro の依頼文の例は日本語名である。**

```sql
FROM LAPP_案件管理 d          -- 現行構文では LAPP_ トークンとして認識されない
logicalApps: { 案件管理: 4149 }
```

**実測**＝`LAPP_案件管理` は `PARSE_ERROR`（`案` が名前開始文字でないため
論理トークンにならず、パーサが未知テーブルとして拒否）。

**Pro のフォールバック（テキスト置換）は日本語名を扱える。**
**つまり「受け口を開けるだけ」では、Pro が欲しいものにならない可能性がある。**

## 3. 論点

| 案 | 内容 | 費用 |
|---|---|---|
| **A: 受け口のみ（ASCII 名のまま）** | スキャナを共有モジュールへ分離し、`logicalApps` オプションで前処理を有効化。`@profile` 構文は browser では拒否 | 小〜中 |
| **B: A ＋ 日本語名への構文拡張** | 名前の文字種を広げる。**CLI / MCP も同時に広げる**（面で同一）。識別子境界・正規化（NFC）・言語リファレンス・`LOGICAL_APP_NAME_RE` の同期 | 中〜大 |
| **C: 見送り** | Pro はフォールバックで実現可能と明言 | 0 |

**A か B かは Pro の実際の要件（ASCII で足りるか）で決まる。**
**先に測った事実を返し、回答を待ってから実装を判断する。**

## 4. 実装時の注意（A の場合・事前調査）

- `normalizeSqlAppProfiles` を **`fs` に依存しない共有モジュールへ分離**（engine bundle guard・
  ゼロ依存の維持）
- **`@profile` は browser に存在しない概念**＝`LAPP_X@prof` / `APPn@prof` は明確なエラーで拒否
- 診断の併記（`LAPP_X -> APPnnnn`）を engine-library のエラー整形にも配線
- `runBatch` / `runQuery` / `explainQuery` の 3 面で同一に

## 5. Pro の質問への答え（測定済み・返信に使用）

1. **未定義名** → `ArgumentError`（`ARGUMENT_ERROR` 相当の分類）で **名前入り**の文言
2. **文字種** → **ASCII `[A-Z][A-Z0-9_]{0,63}`・大小無視・日本語不可**。言語リファレンス §1「CLI / MCP 拡張: 論理アプリ参照」に記載
3. **表示** → 診断は**併記**（`LAPP_ORDERS -> APP1234@prod`）。engine-library 対応時も同じ形を配線する想定
4. **渡し方** → バッチ単位のオプション（`variables` と同じ渡し方）で問題ない

---

## 6. 案 B（日本語名）のリスク評価（2026-08-01・オーナー問いへの回答）

**可能。地盤は想定より良く、費用は「中〜大」→「中」寄りへ下方修正。**

### 6.1 可能性の根拠（実測）

- **lexer の `isJapanese` とスキャナの `isSqlIdentContinue` が同じ 4 範囲を既に持ち一致**（ひらがな・カタカナ 0x3040-30FF／CJK 統合 0x3400-9FFF／互換 0xF900-FAFF／全角英数記号 0xFF01-FF60）
- **サブテーブル部は既に日本語を走査している**（`LAPP_ORDERS$明細` が公式構文）。名前部の文字集合を識別子と同じにするだけ
- `$` と `@` は識別子文字でないため**境界は自然に切れる**
- **サロゲート拡張漢字は kSQL 識別子自体が対象外**（lexer と一致）。論理名も同じ制限で一貫させれば走査のコードポイント化は不要

### 6.2 リスク（重い順）

1. **破壊的変更**＝`LAPP_案件管理` は今日**正当なフィールド参照**。拡張で予約空間が日本語へ広がり、該当フィールドを使う既存 SQL がエラー化する。kintone のフィールドコードに `LAPP_`＋日本語は合法。実際に踏む確率は低く fail-closed で音が出る方向・バッククォート退避も既存だが、**B86/B89 と同じ移行案内つき破壊的変更として扱う**
2. **「定義済みのときだけ解決」という逃げは取らない**＝同じ SQL の意味が config で変わる silent 系になる。**予約は決定的に**（1 を受け入れる）
3. **正規化の設計**＝NFC/NFD・全角英数の大小・「ASCII の範囲で大小無視」の書き直し。**config キーと SQL 側を同じ正規化で照合**しないと「見た目が同じなのに is not defined」になる
4. **規則の 4 重定義の同期**＝スキャナ・config の `LOGICAL_APP_NAME_RE`・**MCP の zod regex（`schemas.ts:14`）**・言語リファレンス（＋Pro の UI 検査で 5 つ目）。**単一ソース化が前提条件**
5. 小＝全角 `＄`・`＠`（U+FF04/FF20）は識別子文字扱いで名前に取り込まれる。文書化と試験で足りる

### 6.3 CLI / MCP でも効果がある（オーナー指摘）

**同意。むしろ主戦場**＝kintone のアプリ名は日本語が普通で、ASCII 論理名は英字コードの発明を強いる。
**config の可読性・MCP で AI が書く SQL の自然さ・Pro の設定 UI のすべてに効く。**
**やるなら全面同時**（面で同一）で、**案 A の共有モジュール化と一度にやるのが効率的**。
