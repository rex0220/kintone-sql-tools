# 仕様: B94 `SELECT COUNT(*)` を `totalCount` で 1 リクエストにする

- 作成: 2026-07-29
- 対象課題: [B94](ksql_b94_count_star_totalcount_issue.md)
- ステータス: ✅ **リリース済み（v3.32.0・2026-07-29・R3 で実装）**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（公開型へ純加法／`maxRecords` の扱いが変わる＝§3）

---

## 1. 目的

**`SELECT COUNT(*)` が全件取得しているのをやめ、1 リクエストで件数を得る。**

```
現状: EXPLAIN SELECT COUNT(*) FROM APP4147
  mode: FULL_SCAN / kintone query: (全件取得) / fields: $id
```

---

## 2. 適用条件（**実行時**に判定する）

**すべて満たすときだけ**適用する。1 つでも欠けたら**従来どおり全件取得**する。

1. **`SELECT COUNT(*)` 1 列だけ**（alias は可。他の列・他の集計関数を含まない）
2. **`GROUP BY` / `HAVING` / `DISTINCT` / window が無い**
3. **`JOIN` が無い**
4. **FROM が物理アプリ**（`cteName === null` かつ `subtableCode` 無し）
5. **`LIMIT` / `OFFSET` が無い**（付いていたら従来経路。判断を単純に保つ）
6. **`whereCapability.capability === "EXACT_PUSHDOWN"`**（§2.1）

### 2.1 判定は既存の仕組みを使う（**新規に書かない**）

[`resolveSelectWhereCapability`](../../src/execute.ts#L2418) が返す
[`PredicateCapability`](../../src/core/optimization/whereCapability.ts#L15) を使う。

| 値 | `totalCount` |
|---|---|
| **`EXACT_PUSHDOWN`** | **使える** |
| `SUPERSET_PREFILTER` | **使えない**（サーバーが広く返し client で絞る） |
| `LOCAL_ONLY` / `UNSUPPORTED` | 使えない |

**同じ判定で分岐している前例が 2 つある。**

- [`canonicalOrderPlanner`](../../src/core/optimization/canonicalOrderPlanner.ts#L101) … `!== "EXACT_PUSHDOWN"` なら `WHERE_NOT_EXACT`
- [`joinPredicatePushdown`](../../src/core/optimization/joinPredicatePushdown.ts#L228) … `!== "EXACT_PUSHDOWN"` なら `unsafe()`

**`resolveSelectWhereCapability` は実行時にフィールドの意味型を解決する**ため、
計画時の「候補」ではなく**確定した可否**が得られる。

> 計画には `pushdown candidate: 売上 > 100（実行時の型・実在確認待ち）` と出る。
> **計画時の見込みで判断してはならない。**

### 2.2 `COUNT(列)` は対象外

`totalCount` は**レコード件数**であり、**空セルを除外する `COUNT(列)` とは意味が違う。**

---

## 3. `maxRecords` は適用しない（**挙動が変わる**）

**現状、`COUNT(*)` は `maxRecords` を超えると失敗する**（実測）。

```
SELECT COUNT(*) FROM APP4147   maxRecords=5
→ FetchAllLimitError: 取得件数が上限（5 件）を超えました。
```

**MCP の既定 `maxRecords` は 500** なので、
**500 件を超えるアプリの件数は、今日 MCP から取得できない。**

**本修正は性能改善であると同時に、この不能を解消する。**
`totalCount` はレコードを取得しないので、**取得件数の上限を適用する理由が無い。**

> **これは挙動の変更である。**従来エラーだった形が成功するようになる。
> **失われる正しい結果は無い**（エラーは件数ではない）が、CHANGELOG に明記する。

**`onLimitReached` も同様に適用しない。**

---

## 4. 実装

### 4.1 案 A（本線）＝`getRecords` に `totalCount` を送る

```
GET /k/v1/records.json?app=N&query=<条件> limit 1&totalCount=true
→ { "records": [...], "totalCount": "123456" }
```

**型の追加（いずれも純加法）**

| 型 | 追加 |
|---|---|
| [`PageFetchParams`](../../src/api/fetchAll.ts#L36) | `totalCount?: boolean` |
| [`KintoneGetResponse`](../../src/api/fetchAll.ts#L27) | `totalCount?: string` |
| 公開 `ReadonlyGetRecordsParams` / `ReadonlyGetRecordsResult` | 同上 |

**`nodeKintoneClient.getRecords` がクエリ文字列へ `totalCount=true` を足す。**

### 4.2 BYO クライアントが返さない場合＝**従来経路へ落とす**

**`totalCount` が返ってこなければ、全件取得へフォールバックする。**
**`undefined` や `0` を件数にしない。**

> [B85](ksql_b85_library_validate_constraints_issue.md) / [B93](ksql_b93_getfields_contract_error_issue.md) の教訓＝
> **BYO クライアントは契約から外れる。**外れたときに**誤った件数を返す余地を作らない。**

### 4.3 検索打ち切りは **fail-closed**（R3 で再修正）

**R1「従来どおり fail-closed」→ R2「今日と同じ警告」→ R3「fail-closed」と二転した。
結論は R1 に戻るが、根拠が違う。**

#### R2 の誤り

R2 は「通常の `SELECT` は警告＋部分結果だから、それに合わせる」とした。
**一般論としては正しいが、集計は既に例外として fail-closed が選ばれていた。**

[B72 仕様 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md) が明記している。

> 通常 read-only SELECT は warning 付与であるが、**この既存契約を B72 の local 集計へ
> そのまま適用すると部分集計を成功結果として返し得る**。
> B72 では … `searchAborted: true` は **`SearchAbortedError`** とする。
> これはユーザーが明示的に選ぶ truncate とは異なり、**kintone 側の 10 万件打切りによる
> 不完全入力**であるため、**7.1 の訂正後も緩和しない**。

**既存テストがこれを固定していた。**

```
test("searchAborted は B72 local-processing で warning結果にせず fail-closed")
  SELECT COUNT(*) AS c FROM APP100 WHERE 日付 = THIS_MONTH()
  → rejects SearchAbortedError
```

**R2 のまま実装すると、この決定を覆して警告へ緩めることになる**（実際に実装差分で
このテストが書き換えられて発覚した）。

#### 決定＝**`totalCount` 経路は fail-closed**

**`searchAborted: true` を検出したら `SearchAbortedError` で停止する。**

**理由は B72 §7.2 がそのまま当てはまる。**
打ち切り後の `totalCount` は**部分集計を成功結果として返す**ものであり、
**利用者が明示的に選んだ truncate ではない。**

**件数は 1 つの数値で権威的に見える**ため、警告は見落とされる。
**B94 は性能改善であって、既存の安全側の決定を緩める場面ではない。**

#### 既存テストは**書き換えない**

`b72RelativeDateFullScanExactStep2.test.ts` の当該テストは**元のまま通ること**。
**通らないなら実装が誤っている。**

### 4.4 案 B（フォールバック）は**今回作らない**

カーソル作成のレスポンスにも `totalCount` はあるが、
**2 リクエスト＋カーソル枠を消費する**ため、案 A のフォールバックとしては割に合わない。

**案 A が使えなければ現状維持（全件取得）。**2 段階に留める。

---

## 5. 受入条件

1. **1 リクエストになる** — 適用条件を満たす `COUNT(*)` で、
   レコード取得の呼び出しが **1 回**であることを数値で固定する
2. **`maxRecords` を超えても成功する** — §3 の実測例（`maxRecords=5`）が
   **エラーにならず正しい件数を返す**こと
3. **`EXACT_PUSHDOWN` 以外では使わない** — **これが中核**。次を**それぞれ**固定する
   - `SUPERSET_PREFILTER`（相対日付の prefilter 等）
   - `LOCAL_ONLY`（`LIKE`・関数・算術）
   - **DROP_DOWN の `=`**（`WHERE_RESIDUAL` になる実例）

   いずれも**従来どおり全件取得し、正しい件数を返す**こと
4. **適用条件を外れたら従来どおり** — 次で**件数が正しい**こと
   - `COUNT(列)` / 他の集計関数との併用 / 他の列との併用
   - `GROUP BY` / `HAVING` / `DISTINCT` / window / `JOIN`
   - 一時テーブル・CTE・サブテーブル仮想テーブル
   - `LIMIT` / `OFFSET` あり
5. **BYO が `totalCount` を返さないとフォールバックする** — 全件取得になり、
   **件数が正しい**こと。**`0` を返さない**こと
6. **検索打ち切りは fail-closed** — `searchAborted` のとき `SearchAbortedError` で停止すること。
   **`b72RelativeDateFullScanExactStep2.test.ts` の既存テストを書き換えないこと**（元のまま通る）
7. **`EXPLAIN` が実態を映す** — 適用される場合、計画から**全件取得しないことが読める**こと
8. **既存テスト全 green・snapshot 22 不変**

---

## 6. 注意点

- **判定を新規に書かないこと**（§2.1）。`EXACT_PUSHDOWN` の意味を再定義しない
- **計画時の見込みで判断しないこと**（§2.1）。押し下げは実行時に確定する
- **件数は検算されにくい。**利用者は返ってきた数を信じるので、
  **迷ったら従来経路へ落とす**。速さより正しさを優先する
- **公開型の変更は純加法に留める**（`?` 付きの追加のみ）。
  declaration snapshot が動くので、**変化が想定どおりか確認する**
- **`COUNT(*)` 以外の集計（`SUM` 等）は対象外。**今回は広げない
- **既存テストを書き換えないこと。**書き換えが要るなら、それは**既存の決定を覆している**合図。
  止めて報告する（R2 の誤りは、まさにこの形で実装差分に現れた）
