# B77 `TODAY()` / `NOW()` / `LOGINUSER()` が相対日付 fail-closed の対象外

- 起票: 2026-07-26（B75 Step 1 のレビュー中に発見）
- ステータス: 📝 **評価・起票（優先 中〜高／silent wrong result の可能性）**。未着手。
- 関連: [B67 Phase1/Phase2 A](ksql_b67_phase2_impl_plan.md) / [B72](ksql_b72_relative_date_fullscan_exact_spec.md) / [B75](ksql_b75_relative_date_cte_temp_evaluation.md)

## 1. 事象

B67 が導入した相対日付の fail-closed（サーバー評価できない形は取得前に拒否）の対象は
`RELATIVE_DATE_FUNCTION_NAMES` の **12 関数だけ**で、`TODAY()` / `NOW()` / `LOGINUSER()` は**含まれていない**。

```ts
// src/core/relativeDateFunction.ts
export const RELATIVE_DATE_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "YESTERDAY", "TOMORROW", "FROM_TODAY",
  "THIS_WEEK", "LAST_WEEK", "NEXT_WEEK",
  "THIS_MONTH", "LAST_MONTH", "NEXT_MONTH",
  "THIS_YEAR", "LAST_YEAR", "NEXT_YEAR",
]);
```

`TODAY` / `NOW` / `LOGINUSER` は `whereCapability.ts` の `isLegacyKintoneFunction()` で
別枠（legacy）として扱われている。

## 2. 実測（v3.24.0＋B75 Step 1・fieldType 正当なモック）

**まったく同じ形なのに、押し下げの有無が関数によって変わる。**

| WHERE | kintone へ送られたクエリ | 相対日付の client 評価 |
|---|---|---|
| `日付 = YESTERDAY() AND LENGTH(件名) > 1` | `日付 = YESTERDAY() order by $id ...` | **0**（B67 Phase2 A が leaf を採用） |
| `日付 = TODAY() AND LENGTH(件名) > 1` | `order by $id ...`（全件取得） | **あり** |
| `日付 = NOW() AND LENGTH(件名) > 1` | `order by $id ...`（全件取得） | **あり** |
| `日付 = TODAY() OR LENGTH(件名) > 1` | `order by $id ...`（全件取得） | **あり** |

WHERE 全体が exact な場合（`WHERE 日付 = TODAY()` 単独・`GROUP BY` 付き）は
`日付 = TODAY()` がそのまま押し下がるため問題ない。**押し下げが崩れた瞬間だけ挙動が変わる。**

## 3. なぜ問題か

client 評価は `src/engine/evalWhere.ts` の `resolveKintoneFunc()` が行い、
**JS の `new Date()`＝実行環境のローカルタイムゾーン**で日付文字列を組み立てる。

```ts
case "TODAY": {
  const now = new Date();          // 実行環境の TZ
  const y = now.getFullYear();     // ...
  return `${y}-${m}-${d}`;
}
```

- ブラウザプラグイン: 利用者 PC の TZ
- CLI / MCP / ライブラリ: Node プロセスの TZ（サーバー運用なら UTC のことが多い）

kintone アプリの TZ と食い違うと、**日付境界をまたぐ時間帯で結果が静かにずれる**。
これは B67 が 12 関数について排除した当のリスクであり、**`TODAY()` のほうが日常的に多用される**。

さらに `LOGINUSER()` は kintone 環境外で解決できず **空文字を返す**（比較が常に false）。
これも silent wrong result になりうる。

## 4. 論点

1. **意図的か否か。** `isLegacyKintoneFunction` という命名は B67 以前からの経緯を示唆するが、
   「B67 の対象から外す」判断が明示的に行われた記録は見つかっていない。**まず経緯の確認が必要。**
2. `TODAY()` を 12 関数と同列に fail-closed にすると、**現在動いているクエリが取得前エラーになる**
   （破壊的変更）。SemVer と移行方針の判断が要る。
3. 代替案として、client 評価時に **kintone アプリの TZ を解決して使う**（fail-closed にしない）方向もある。
   ただし TZ 解決手段（アプリ設定 API）とキャッシュの検討が必要。
4. `NOW()` は時刻を含むため境界問題がより大きい。`LOGINUSER()` は TZ ではなく
   「環境外で解決不能」という別種の問題で、分けて扱うべき。

## 5. 方針案（未決）

| 案 | 内容 | 影響 |
|---|---|---|
| A | 12 関数と同じ fail-closed に統一 | 一貫するが**破壊的**（既存クエリがエラー化） |
| B | client 評価時に kintone の TZ を解決して使う | 非破壊だが TZ 解決の実装が要る |
| C | 現状維持＋**言語リファレンスに明記**（`TODAY()`/`NOW()` は押し下げが崩れると client 評価になる） | 最小コスト・利用者が回避可能 |

**まず C（明文化）を最低限行い、A/B は経緯確認のうえ判断する**のが妥当と考える。

## 6. 補足

B75 Step 1 のレビュー中、`TODAY()` を使った拒否テストが期待どおり拒否されなかったことから発見した。
**B75 の変更が原因ではなく、B67 以来の既存挙動**である（HEAD でも同じ）。
