# 仕様: B88 0 行 `SELECT *` の列をアプリ定義から復元する

- 作成: 2026-07-28
- 対象課題: [B88](ksql_b88_empty_wildcard_schema_restore_issue.md)
- ステータス: ✅ **リリース済み（v3.31.0・2026-07-29）**
- 前提: **[B87](ksql_b87_metadata_cache_spec.md) 実装済み**（未リリース）— これが無いと本修正が列数のブレを生む
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（0 行時に列が増える方向のみ・1 行以上は不変）

---

## 1. 目的

**0 行の `SELECT * FROM APP` が列を失わないようにする。**

これが連鎖の起点で、ここが直れば temp・CTE・`UNION`・`INSERT ... SELECT` へ
[v2.11.0 のパイプライン伝播](ksql_empty_select_wildcard_pipeline_spec.md)がそのまま運ぶ。

```sql
CREATE TEMP TABLE #e AS SELECT * FROM APP300;   -- 0 件
SELECT * FROM #e
-- 現状: columns=[]  →  修正後: APP300 の列
```

---

## 2. 適用条件（これ以外は一切変えない）

**すべて満たすときだけ**アプリ定義から列を復元する。

1. **最終的な SELECT 結果が 0 行**（§2.1）
2. **単独の `SELECT *`**（`WILDCARD` 1 つだけ。明示列との混在・`_p.*` は対象外）
3. **JOIN が無い**
4. **FROM が物理アプリ または サブテーブル仮想テーブル**（§3.4）。
   実体化ソース（`cteName != null`）は v2.11.0 で解決済みなので対象外

### 2.1 「0 行」は**最終結果**で判定する

**R1 では曖昧だった。**FULL_SCAN では kintone から 1 行以上取得しても、
ローカルの `WHERE`・`LIMIT`/`OFFSET`・`DISTINCT` を経て 0 行になり得る。

```sql
SELECT * FROM APP100 WHERE UPPER(件名) = '存在しない値'
SELECT DISTINCT * FROM APP100 LIMIT 0
```

**利用者が体験するのは「結果が空」なので、最終結果が 0 行なら復元する。**

**再実行は不要である。**`sourceColumns` は
[process.ts:1161](../../src/engine/process.ts#L1161) の
`projected.length > 0 ? Object.keys(projected[0]) : [...(sourceColumns ?? [])]`
**だけで使われ、他に影響しない**ことをコードで確認した。したがって

> **`rows.length === 0 && columns.length === 0` になった後で列を埋める**（post-hoc fill）

で足りる。**`runFullScan` をやり直してはならない。**
この形なら「1 行以上なら追加 API 0 回」も自然に満たせる。

**1 行以上のときの挙動は絶対に変えない。**列は従来どおり行データから作る。

**上記を満たさない場合、追加の API 呼び出しを一切行わないこと。**

---

## 3. 列の導出

### 3.1 基本

`getFields(appId)` の**返り順を保つ**。実測で `fields.json` の順序と
1 行以上の `SELECT *` の列順は**完全に一致する**（実 kintone 5 アプリ・§6）。

### 3.2 除外するもの

| 条件 | 理由 |
|---|---|
| `inSubtable === true` | サブテーブルの**子**フィールドはレコード直下に出ない |
| `fieldType === "CATEGORY"` | レコードに出ない |
| `fieldType === "REFERENCE_TABLE"` | レコードに出ない |
| `fieldType === "GROUP"` | フィールドグループはレコードに出ない |
| `fieldType === "STATUS"` / `"STATUS_ASSIGNEE"` かつ **プロセス管理が無効** | §3.3 |

**`SUBTABLE` 本体は残す**（レコードでは JSON 文字列の 1 列として出る）。

### 3.3 `STATUS` / `STATUS_ASSIGNEE` は型では決まらない

**プロセス管理の有効・無効で出たり出なかったりする。**実測:

| アプリ | `status.json` の `enable` | `SELECT *` の ステータス |
|---|---|---|
| APP452 | `true` | ✅ 含まれる |
| APP4147 | `false` | ❌ 含まれない |
| APP424 | `false` | ❌ 含まれない |

**`getProcessStatuses(appId)` を使う。**ただし**呼ぶのは `getFields` の結果に
`STATUS` か `STATUS_ASSIGNEE` が含まれるときだけ**とし、無駄な API を撃たない。

### 3.4 サブテーブル仮想テーブル（`APPn$tbl`）

**R1 では漏れていた。**`APP100$明細` も AST 上は `cteName === null` なので、
条件をそのまま書くと**親アプリの列を復元してしまう**。

**親とは別の導出規則を使う。**実測（実 kintone 2 アプリ・2/2 一致）:

```
SELECT * FROM APP424$Table  → _pid, _rid, _idx, 作業内容, 金額, 日付
SELECT * FROM APP452$明細   → _pid, _rid, _idx, ドロップダウン_0, 数値, 文字列__1行__0, 日付
```

> **`_pid`, `_rid`, `_idx` の 3 列＋そのサブテーブルの子フィールド**（`getFields` の返り順）

- 子は `inSubtable === true` かつ `subtableCode` が当該サブテーブルのもの
- **`$id` / `$revision` は付かない**（§3.5 は親アプリ専用）
- 親アプリの列・他のサブテーブルの子を**混ぜてはならない**

### 3.5 `$revision` / `$id` は末尾へ 2 列足す（親アプリのみ）

両者は `getFields` に存在しないため**位置を導出できない**。実測では
**`$id` は 5/5 で末尾**だが、**`$revision` の位置は規則が見つからない**
（APP4147・APP424 は 作成者 の直後、APP452・APP423 は ドロップダウン の直後）。

**実害は位置ではなく列数**である。欠けると
`INSERT ... SELECT` の列数チェックが**データのある日と無い日で違う数を見る**。

→ **末尾に `$revision`, `$id` の順で足す。**

> **これは 1 行以上のときと列順が違う**（既知・意図的）。
> `$id`/`$revision` は書き込めないため実用上の影響が無く、**列数が合うことを優先する。**
> §5 の受入条件でこの差を**明示的に固定する**（曖昧なまま残さない）。

---

## 4. 変更するのは 3 箇所（post-hoc fill）

**§2.1 のとおり 0 行かどうかは実行してみるまで決まらない**ため、
`sourceColumns` を事前に渡すのではなく、**結果を見てから列を埋める。**

対象は次の 3 箇所で、いずれも
**`rows.length === 0 && columns.length === 0` かつ §2 の適用条件を満たすとき**だけ
`columns` を導出結果で置き換える。

| # | 箇所 | 経路 |
|---|---|---|
| 1 | [`executeSimpleSelect`](../../src/execute.ts#L3093) の `project(...)` 結果 | SIMPLE |
| 2 | [FULL_SCAN（物理）](../../src/execute.ts#L4355) の `runFullScan({...})` 結果 | FULL_SCAN |
| 3 | [FULL_SCAN（CTE 経路）](../../src/execute.ts#L4722) の結果 | 物理ソースのとき |

- **`project()` / `runFullScan()` の内部は変更しない**
- **`runFullScan` をやり直さない**（受入 11）
- 3 は既存の `sourceColumns` 供給（実体化ソース）を**壊さない**こと。
  実体化ソースは v2.11.0 の経路のまま
- **実体化して保存する場合は、保存より前に埋める**こと
  （`MaterializedTable.columns` が空のまま保存されると連鎖が直らない）

---

## 5. 受入条件

1. **0 行 `SELECT * FROM APP` が列を返す** — 3 供給点すべてで固定する
   （SIMPLE / FULL_SCAN 物理 / FULL_SCAN CTE 経路の物理ソース）
2. **連鎖が直る** — 以下がすべて 0 行かつ列つきで通ること
   - `CREATE TEMP TABLE #e AS SELECT * FROM APP0; SELECT * FROM #e`
   - `CREATE TEMP TABLE #e AS ...; CREATE TEMP TABLE #f AS SELECT * FROM #e; SELECT * FROM #f`
   - `WITH e AS (SELECT * FROM APP0) SELECT * FROM e`
3. **`INSERT ... SELECT *` の列数エラーが消える** — 0 行なら **POST 0 回で正常終了**すること
   （列数が合う場合。合わない場合は従来どおりエラー）
4. **JOIN 経路の `schema-unavailable` error が解消する** —
   `SELECT * FROM #f JOIN APP ...` が 0 行で通ること（B86 が error 化した形）
5. **導出が 1 行以上の実際の列と一致する** — **これが本仕様の中核**。
   代表的なフィールド構成のモックに対し、**`getFields` から導いた列**と
   **1 行ある場合の `SELECT *` の列**を突き合わせ、
   **`$revision`/`$id` を除いた並びが完全一致**することを固定する。
   最低限、次を含む構成で行うこと:
   - サブテーブル（本体は残り、子は出ない）
   - `CATEGORY` / `REFERENCE_TABLE` / `GROUP`
   - **プロセス管理が有効なアプリと無効なアプリの両方**
6. **未知のフィールド型に備える** — 除外規則が既知の型を網羅していることを機械的に確認する。
   **B84 の [b84PushdownDocs.test.ts](../../src/core/optimization/__tests__/b84PushdownDocs.test.ts)
   が分類器から型集合を導出している**ので、同じ考え方で
   **「レコードに出る／出ない」の判定が全型について決まっている**ことを固定する。
   新しい型が増えたら落ちること。
7. **`$revision`/`$id` の扱いを固定する** — 0 行では**末尾 2 列**、
   1 行以上では**元の位置**という差を、両方テストで明示する
8. **適用条件を外れたら何も変わらない** — 次で**追加 API が 0 回**であることを固定する
   - 1 行以上の `SELECT *`
   - 0 行だが明示列（`SELECT 件名 FROM APP0`）
   - 0 行だが混在（`SELECT *, x FROM APP0`）
   - 0 行だが JOIN あり
9. **`status.json` を無駄に撃たない** — `STATUS`/`STATUS_ASSIGNEE` を持たないアプリでは
   `getProcessStatuses` が呼ばれないこと
10. **サブテーブル仮想テーブルが正しく復元される** — 0 行の `SELECT * FROM APPn$tbl` が
    `_pid, _rid, _idx` ＋ 当該サブテーブルの子だけを返し、**親アプリの列も他のサブテーブルの
    子も混ざらない**こと。**`$id`/`$revision` が付かない**ことも固定する
11. **ローカル処理で 0 行になった場合も復元される** — §2.1 の 2 例
    （`WHERE UPPER(...)` で全件除外・`LIMIT 0`）で列が返ること。
    **このとき `runFullScan` が 2 回実行されていない**ことも確認する
12. **既存テスト全 green・snapshot 22 不変**

---

## 6. 実測の根拠（2026-07-28・実 kintone）

| アプリ | `getFields` | `SELECT *` | 保持列の相対順 |
|---|---:|---:|---|
| APP4147 活動履歴 | 21 | 18 | ✅ 完全一致 |
| APP452 交通費申請（テーブル・プロセス有） | 30 | 27 | ✅ 完全一致 |
| APP424 請求書２（テーブル 2 本） | 24 | 16 | ✅ 完全一致 |
| APP423 日付チェック | 31 | 25 | ✅ 完全一致 |
| **APP423（項目を後から追加）** | **33** | **27** | ✅ **完全一致** |

**後から追加した項目は末尾に付かない**（APP423 では 6・8 番目に挿入された）が、
**その予測不能な途中位置まで両者は一致する。**

> 検証はアプリへ項目を追加・デプロイ → 確認 → 削除・デプロイで**元の定義へ復元済み**。

---

## 7. 対象外（本仕様でも直さない）

- **JOIN を伴う 0 行 `SELECT *`** — 複数ソースの列合成順が行に依存し 0 行では確定不能
- **`SELECT _p.*`（`PARENT_WILDCARD`）0 行** — 同上
- **混在 `SELECT *, extra` の `*` 分** — 1 行以上でも `*` は `columns` に寄与しない現行仕様に合わせる
  （**明示列 `extra` は v2.11.0 で既に 0 行でも復活する**）

---

## 8. 注意点

- **B87 が前提。**古い `getFields` で列を作ると、**本仕様が避けようとしている
  「空の日だけ列数が違う」を本仕様が作り出す。**B87 実装済みであることを前提にしてよい
- **1 行以上の経路に手を入れないこと。**`sourceColumns` は 0 行のときだけ使われる
  （[process.ts:1161](../../src/engine/process.ts#L1161)）ので、供給しても 1 行以上には影響しないはずだが、
  **影響しないことをテストで確かめること**
- **適用条件を外れたら API を撃たないこと**（§5-8）
- **公開型を変えないこと**
