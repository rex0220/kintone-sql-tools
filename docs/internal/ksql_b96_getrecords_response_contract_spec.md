# 仕様: B96 — `getRecords()` の応答契約を文書化する

- 作成: 2026-07-29
- 対象課題: [B96](ksql_b96_getrecords_response_contract_issue.md)
- ステータス: ✅ **実装済み（未リリース）**（2026-07-29）
- 分担: Claude=仕様/レビュー、codex=実装
- SemVer: **patch**（文書のみ・コードと挙動は変更しない）

---

## 1. 目的

**BYO client やラッパーが `getRecords()` の応答から `searchAborted` を落とすと、
`SEARCH_ABORTED` の fail-closed が静かに無効になる**ことを、文書で防ぐ。

**コードでは防げない**（[B96 §2](ksql_b96_getrecords_response_contract_issue.md)）。
`false` と欠落を区別する手段が無く、**打ち切りが無ければ省略するのが正常な実装**である。

---

## 2. **`getRecords()` だけが脆い**（実装で確認済み）

**落としてもコンパイルが通る応答型は `ReadonlyGetRecordsResult` だけである。**

| 型 | 追加プロパティ | 落とせるか |
|---|---|---|
| `ReadonlyGetRecordsResult` | `totalCount?: string` / `searchAborted?: boolean` | ✅ **落とせる**（どちらも `?`） |
| `ReadonlyCursorPage` | `next: boolean` | ❌ **必須**。落とすと型エラー |
| `ReadonlyCursorHandle` | `totalCount: number` | ❌ **必須**。落とすと型エラー |

→ **文書は `getRecords()` に絞る。**Cursor 側へ同じ注意を書かない
（**書くと「型で守られている」ことが伝わらなくなる**）。

---

## 3. 危険度が違うことを書く

**これが本節の要点。**「両方大事です」と書くと、**どちらも軽く読まれる。**

| 落ちたもの | 影響 | engine 側 |
|---|---|---|
| `totalCount` | **遅くなる／上限でエラー**（`COUNT(*)` の単発取得が効かない） | ✅ **自分で塞ぐ**。無い／不正なら全件取得へフォールバックする |
| **`searchAborted`** | **10 万件で打ち切られた検索を完全な結果として扱う** | ❌ **塞げない。防御が全部素通りする** |

**`totalCount` は性能、`searchAborted` は正しさ**である。

---

## 4. 書く場所

### 4.1 `### getRecords() の契約` を新設する

**[`docs/ksql_engine_library.md`](../ksql_engine_library.md) の
`### getFields() の契約`（197 行付近）の直前**に置く。

**理由**＝`getFields()` の契約は**同じ節（`## client の供給` → `### BYO readonly client`）に
既にある**。**同じ形の契約を並べる**のが読み手にとって自然であり、
`getRecords` は 6 method のうち**最初に挙げられている**ので順序も合う。

### 4.2 **B93 と同じ表の形にする**

`getFields()` の契約が「渡す」「渡さない」の 2 行表になっている。**同じ形にする。**

**ただし本件は「渡す／渡さない」ではなく「落とさない」なので、見出し語を変える。**

```markdown
### `getRecords()` の契約

**応答をそのまま返してください。`records` 以外の項目を落とさないでください。**

| | |
|---|---|
| **必ず残す** | **`searchAborted`。**落とすと検索打ち切り（10 万件）の fail-closed が**無効になり、
                打ち切られた結果を完全な結果として扱います** |
| **残すと速い** | `totalCount`。`params.totalCount === true` のときに kintone へ渡し、
                  応答の値をそのまま返すと `SELECT COUNT(*)` が 1 リクエストで返ります。
                  **落としても正しさは保たれます**（全件取得へフォールバックします） |
```

### 4.3 **ラッパーの注意を独立させる**

**`createReadonlyKintoneClient()` を使っていても踏む**ため、
「BYO client を書く人向け」の文脈に埋めない。

```markdown
**キャッシュ・計測・リトライのために client を包む場合も同じです。**
応答を組み立て直すときに項目が落ちます。

    // 誤り — totalCount と searchAborted が落ちる
    return { records: [...res.records] };

    // 正しい — 応答をそのまま返す
    return res;

`getRecords()` は**追加項目が任意プロパティである唯一の応答**です。
落としてもコンパイルは通ります（`openCursor()` の `next` / `totalCount` は必須なので型で防げます）。
```

### 4.4 既存の記述との重複を避ける

**369 行付近に「検索打ち切りと Cursor」の節が既にある。**

> client が `searchAborted: true` を返した場合、simple query、JOIN、GROUP BY を問わず
> 常に `SEARCH_ABORTED` の **hard error** です。

**この記述は挙動の説明として残す。**
**新設の節から相互参照を張る**（「この挙動は §…（検索打ち切りと Cursor）を参照」）。

**同じことを 2 回書かない。**新設の節は**義務**を、既存の節は**挙動**を書く。

---

## 5. 変更しないもの

- **コード**（`src/` は 1 行も触らない）
- **公開型**（`searchAborted?` を必須化しない。[B96 §5.2](ksql_b96_getrecords_response_contract_issue.md) で不採用と判断済み）
- **既存の記述**（369 行付近の「検索打ち切りと Cursor」）
- **`getFields()` の契約**（B93 でそのままにする）

---

## 6. 受入条件

1. **`getRecords()` の契約が新設され、`getFields()` の契約の直前にある**
2. **`searchAborted` を落とすと fail-closed が無効になる**ことが明記されている
3. **`totalCount` と `searchAborted` の危険度の差**（性能／正しさ）が読み取れる
4. **ラッパーの例（誤り／正しい）が載っている**
5. **`getRecords()` だけが任意プロパティであること**が書かれている
6. **既存の「検索打ち切りと Cursor」節と重複していない**（相互参照になっている）
7. **`src/` の変更が 0 件**
8. **`npm run engine:docs-smoke` が通る**（文書中のコード例を実行する gate）
9. **既存テスト全 green・snapshot 22 不変**

---

## 7. 注意点

- **`docs/internal/ksql_*.md` は編集しないこと**（本仕様書と課題文はこちらが管理する）
- **CHANGELOG へは「未リリース」節に追記すること**（`### 修正（B96 …）`）
- **文書中のコード例は `engine:docs-smoke` の対象になり得る。**
  **実行される形で書くか、実行されない形（説明用の断片）と分かるようにすること**
- **既存テストの扱いは従来どおり**——挙動の期待が変わる書き換えは止めて報告、
  純加法の機械的な追記は可（報告に列挙）
