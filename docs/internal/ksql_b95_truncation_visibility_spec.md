# 仕様: B95 案 A — 取得上限の打ち切りを `metrics` へ構造化して返す

- 作成: 2026-07-29
- 対象課題: [B95](ksql_b95_truncation_visibility_issue.md)
- ステータス: ✅ **実装済み（未リリース）**（2026-07-29・R2 で実装）
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（公開型への純加法のみ・挙動は不変）

---

## 1. 目的

**`onLimitReached: "truncate"` で打ち切られたかどうかを、文言照合なしで判別できるようにする。**

現状、判別材料は次の 2 つしかなく、どちらも使えない。

| 材料 | なぜ使えないか |
|---|---|
| `warnings`（`readonly string[]`） | **文言照合**になる。多言語・版数変更で壊れる |
| `metrics.fetchedRows` | **全アプリの合算**。JOIN では合計が上限を超えても打ち切られていない |

**本仕様は案 A のみ。**「打ち切られた入力の集計を fail-closed にする」（案 B）は
**要望が出てから判断する**（オーナー決定 2026-07-29）。

---

## 2. 追加する形

```ts
export interface QueryMetrics {
  recordGetCalls: number;
  fetchedRows: number;
  elapsedMs: number;
  cursorRecordsScanned: number;
  /** 取得上限に達したか。true なら結果は全件ではない。 */
  limitReached?: boolean;
  /** 上限に達したアプリ ID（判明した範囲・重複なし・昇順）。 */
  limitReachedApps?: readonly number[];
}
```

### 2.1 2 つの関係＝**boolean が正**

**`limitReached` が権威的な「打ち切られたか」。**
**`limitReachedApps` は「どのアプリか」が判明した範囲**を返す best-effort。

**現時点では両者は必ず一致する**（`limitReached === limitReachedApps.length > 0`）。
理由は §3 のとおり、**打ち切りを検出する 3 箇所すべてでアプリ ID が判明する**から。

**それでも 2 つに分ける。**将来アプリ ID を伴わない打ち切り経路が増えたときに、
**`limitReached` が誤りにならない**ようにするため。
**配列が空であることを「打ち切られていない」の判定に使わせない。**

> **利用者向けの案内は「`limitReached` を見てください」で統一する。**
> `limitReachedApps` はメッセージ表示（「APP912 が上限に達しました」）のための補助。

### 2.2 **任意プロパティにする**（R2 で修正）

**R1 は「`undefined` にしない（`?` を付けない）」とし、根拠を
「`QueryMetrics` はエンジンが返す型なので利用者の実装は壊れない」としたが、
これは誤りだった。**

**公開型は利用者が構築できる。**実際、こちらのテストが**利用者コードとして**構築している。

```ts
// engine-library/__tests__/publicApi.test.ts:75
const queryResult: QueryResult = {
  type: "query", rows: [...], columns: [...], rowCount: 1, warnings: [], metrics: { … },
};
```

**必須プロパティを足すと、この形のコードは型エラーになる**＝**利用者にとって破壊的変更**。

→ **両方とも `?` を付ける。**

#### 実質の使い勝手は変わらない

```ts
if (result.metrics.limitReached) { /* 打ち切られた */ }
```

**旧版では `undefined`、新版で打ち切りが無ければ `false`。どちらも falsy** なので、
**利用者の分岐は同じに書ける。**

**エンジンは常に値を入れる**（打ち切りが無ければ `false` と `[]`）。
`undefined` になるのは**旧版のエンジンが返した結果**だけである。

## 3. 実装

### 3.1 打ち切りの検出箇所は 3 つ（すべてアプリ ID を持つ）

| 箇所 | 関数 | アプリ ID |
|---|---|---|
| [execute.ts:3103](../../src/execute.ts#L3103) | `executeSimpleSelect` | `stmt.from.appId` |
| [execute.ts:4933](../../src/execute.ts#L4933) | `fetchTableRecordsForFullScan` | `table.appId` |
| [execute.ts:5177](../../src/execute.ts#L5177) | `tryFetchJoinRecordsBySourceKeys` | `join.table.appId` |

いずれも現在は**警告文字列を組み立てるだけ**。

```ts
const onTruncate = (max: number): void => {
  warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
};
```

**警告はそのまま残し**、同じコールバックで**アプリ ID を収集する**。

### 3.2 収集の形

- **重複を除く**（自己 JOIN で同じアプリが 2 回来得る）
- **昇順に整える**（出力の安定のため。テストが順序に依存しないようにする）
- **サブテーブル仮想テーブル（`APPn$tbl`）は親アプリの ID** を記録する
  （`table.appId` がそれ。**別の値を作らない**）

### 3.3 変更しないもの

- **警告文言**（既存テストが固定している）
- **打ち切りの判定そのもの**（`fetchAll` に手を入れない）
- **`onLimitReached: "error"` の挙動**（`FetchAllLimitError` のまま）

---

## 4. バッチでの扱い

`runBatch` の `metrics` は**文別計測ではなくバッチ全体の集計値**
（`BatchResult.results` の既存コメントに明記されている）。

**`limitReached` / `limitReachedApps` も同じ扱いにする**＝**バッチ全体で 1 つ**。
**文別に分けない。**既存の `fetchedRows` などと性質を揃える。

> 文別に欲しいという要望が出たら別途 判断する。**今回は既存の性質に合わせる。**

---

## 5. MCP / CLI

**今回は engine ライブラリのみ**とする。

MCP / CLI は**警告を表示する**面であり、**利用者が分岐するための構造化値を必要としていない**。
**要望が出てから足す。**

---

## 6. 受入条件

1. **打ち切りが検出される** — `maxRecords` 超過＋`truncate` で
   `limitReached === true` かつ `limitReachedApps` に**該当アプリ ID が入る**こと
2. **打ち切りが無ければ false と空配列** — `undefined` にならないこと
3. **アプリ単位であることが分かる** — **JOIN で片側だけが上限に達した場合**、
   `limitReachedApps` に**そのアプリだけ**が入ること
4. **合算では判定していない** — Pro の実測と同じ形
   （`APP4148` 215 件＋`APP4149` 20 件、`maxRecords=230`）で
   **`limitReached === false`** であること（合計 235 > 230 だが、どちらも上限に達していない）
5. **重複しない・昇順** — 自己 JOIN で同じアプリが 2 回検出されても**1 つ**であること
6. **利用者の型構築を壊さない** — `QueryResult` を**利用者コードとして構築している既存テスト**
   （`publicApi.test.ts`）が、**変更なしでコンパイルできる**こと（`?` にしたので通るはず）
6b. **エンジンは常に値を入れる** — 打ち切りが無い場合でも `limitReached === false` /
   `limitReachedApps` が空配列で**返る**こと（`undefined` を返さない）
7. **警告は従来どおり** — 文言・出方が変わらないこと（既存テストが通る）
8. **`"error"` の挙動が変わらない** — `FetchAllLimitError` のまま
9. **バッチではバッチ全体で 1 つ** — 文別に分かれないこと
10. **既存テスト全 green・snapshot 22 不変**

---

## 7. 注意点

- **`fetchAll` に手を入れないこと。**判定は既存のまま、コールバックで拾うだけ
- **警告文言を変えないこと**（既存テストが固定している）
- **`limitReachedApps` を「打ち切られたか」の判定に使わせないこと**（§2.1）。
  ドキュメントは **`limitReached` を見る**と書く
- **サブテーブルで別 ID を作らないこと**（親アプリの ID をそのまま使う）
- **既存テストの扱い**（R2 で明確化）
  - **止めて報告するのは「期待している挙動が変わる」書き換え**
    （エラーが警告になる／拒否が成功になる／値が変わる）
  - **`toEqual` の網羅検証へ、新しく足したフィールドを機械的に加えるのは可**。
    **既存の検証の意味は変わらない**ため。**ただし報告に「どのテストへ何を足したか」を列挙する**
  - 該当が分かっているもの: `queryResult.test.ts`（95 / 148 / 230 行付近）・
    `acceptance.test.ts`（170 行付近）の `metrics` 完全一致検証
