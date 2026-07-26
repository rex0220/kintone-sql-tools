# B77 `TODAY()` / `NOW()` / `LOGINUSER()` が相対日付 fail-closed の対象外

- 起票: 2026-07-26（B75 Step 1 のレビュー中に発見）
- ステータス: ✅ **リリース済み（v3.25.0・2026-07-27）＝オーナー決定 案 A: fail-closed 統一**。実装は [B77+B78 仕様 R1](ksql_b77_b78_kintone_function_fail_closed_spec.md) の 5 Step。**実機 PASS**＝`TODAY()` の Phase2A が `YESTERDAY()` と同一 EXPLAIN。
  追加調査で `LOGINUSER()` が**環境判定なしに無条件で空文字を返す**ことが判明し、優先度を上げた（§3.1）。
- 関連: [B67 Phase1/Phase2 A](ksql_b67_phase2_impl_plan.md) / [B72](ksql_b72_relative_date_fullscan_exact_spec.md) / [B75](ksql_b75_relative_date_cte_temp_evaluation.md)

## 0. オーナー決定（2026-07-27）

**案 A を採用＝`TODAY()` / `NOW()` / `LOGINUSER()` を相対日付 12 関数と同じ fail-closed に統一する。**
押し下げできない位置に来たら、client 評価へフォールバックせず取得前に拒否する。

- **B78 と同一リリースで実施**（B75 も束ねる。§5 の案 B / 案 C は不採用）
- 決定の根拠として提示した事実:
  - `LOGINUSER()` の client 評価は**常に空文字＝必ず0件**で、正しくなる経路が存在しない（§3.1）。
    よって fail-closed 化は「動いていたものを壊す」のではなく**黙って0件だったものをエラーに変える**。
  - `TODAY()` / `NOW()` は **TZ が一致していれば正しく動いていた**ため、fail-closed 化は**破壊的**。
    Claude の推奨は「明文化のみ」だったが、**一貫性を優先するオーナー判断**で fail-closed を採用した。
  - プラグインだけ `getLoginUser()` で解決する案は、MCP/CLI に解決手段が無く
    **4面 parity が崩れる**ため不採用。

### 0.1 スコープの境界（重要）

**クラス C（`CURRENT_DATE()` / `CURRENT_TIMESTAMP()`）は本決定の対象外。**
これらは kintone のクエリ関数ではなく kSQL のスカラー関数で、**押し下げ経路が存在しない**。
fail-closed 化すると関数そのものが使用不能になるため、**client 評価のまま据え置き、
ローカル TZ で評価される旨を言語リファレンスに明記する**にとどめる。

### 0.2 破壊的変更の告知

`TODAY()` / `NOW()` が押し下げ不能な位置（FULL_SCAN・OR・局所式との AND など）で
**取得前エラーになる**。移行の案内を CHANGELOG と言語リファレンスに明記すること。
回避策は「`WHERE` 全体を押し下げ可能な形にする」か「日付リテラルを使う」。

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

## 1.1 対象関数の全体像（2026-07-26 調査）

環境依存の値を返す関数を3クラスに整理した。

| クラス | 関数 | 押し下げ | 崩れたときの client 評価 | 非対称 |
|---|---|---|---|---|
| **A: legacy kintone 関数** | `TODAY()` `NOW()` `LOGINUSER()` | される | される | **あり＝本課題** |
| B: 相対日付 12 関数 | `YESTERDAY()` `THIS_MONTH()` ほか | される | **拒否**（B67 fail-closed） | なし |
| C: kSQL スカラー関数 | `CURRENT_DATE()` `CURRENT_TIMESTAMP()` | **されない** | 常にされる | なし（常に client） |

- **クラス A は3つで打ち止め。** `LegacyKintoneFunction` 型（`src/types/ast.ts`）が
  `"TODAY" | "NOW" | "LOGINUSER"` に閉じており、`whereCapability.ts` の
  `isLegacyKintoneFunction()` も同じ3つを列挙している。増える余地はない。
- **クラス C は非対称ではないが TZ 依存は同じ。** `whereToKintone` にも `whereCapability` にも
  case が無く押し下げ対象外＝常に `new Date()`（実行環境の TZ）で評価される。
  Pro の D10 レシピが使う `DATE_FORMAT(CURRENT_DATE(), '%Y-%m')` がこれに該当する。
  **案 C（明文化）のスコープに含めること。**
- `PRIMARY_ORGANIZATION()` は **kSQL 未実装**。§4.1 参照。

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

### 3.1 `LOGINUSER()` は TZ ではなく「常に0件」になる（より深刻）

`resolveKintoneFunc()` に**環境判定が一切ない**。

```ts
// src/engine/evalWhere.ts
case "LOGINUSER":
  // kintone 環境外では解決不能 → 空文字（比較が常に false になる）
  return "";
```

コメントは「kintone 環境外」と書いているが、実際は**無条件で空文字**。
つまり**ブラウザプラグインで実行していても、押し下げが崩れた瞬間に
`LOGINUSER()` が空文字になり比較が常に false**（＝結果0件）になる。
TODAY()/NOW() の「TZ がずれる」より影響が大きく、本課題の優先度を上げる根拠。

**補強すべき事実:**

- `src/ui/types.d.ts` に `getLoginUser(): { code: string; name: string }` が
  **宣言されているのに未使用**。プラグイン環境には解決手段があるのに使っていない。
  → **案 B（環境から解決する）はプラグイン面では実装コストが低い**可能性がある。
- MCP の function catalog（`src/mcp/index.ts` の `FUNCTION_CATALOG_PARAGRAPH`）は
  「**LOGINUSER resolves to an empty string in Node/MCP**」と書いており、
  **Node/MCP 固有の制約であるかのように読める**。実態と食い違うので修正対象に含めること。

## 4. 論点

1. **意図的か否か。** `isLegacyKintoneFunction` という命名は B67 以前からの経緯を示唆するが、
   「B67 の対象から外す」判断が明示的に行われた記録は見つかっていない。**まず経緯の確認が必要。**
2. `TODAY()` を 12 関数と同列に fail-closed にすると、**現在動いているクエリが取得前エラーになる**
   （破壊的変更）。SemVer と移行方針の判断が要る。
3. 代替案として、client 評価時に **kintone アプリの TZ を解決して使う**（fail-closed にしない）方向もある。
   ただし TZ 解決手段（アプリ設定 API）とキャッシュの検討が必要。
4. `NOW()` は時刻を含むため境界問題がより大きい。`LOGINUSER()` は TZ ではなく
   「環境外で解決不能」という別種の問題で、分けて扱うべき。

### 4.1 B67 評価文書に残っていた記録（2026-07-26 追加調査）

`docs/internal/ksql_b67_rest_query_functions_evaluation.md` に次の記載がある。

- 対象関数表に「組織 | `PRIMARY_ORGANIZATION()`」を含み、「（`TODAY`/`NOW`/`LOGINUSER` は**対応済み**。）」と注記。
  → **B67 は既存の3関数を「対応済み」として扱い、fail-closed の対象に含めなかった**ことがわかる。
- §3「`LOGINUSER()` / `PRIMARY_ORGANIZATION()` は**サーバ側のユーザー文脈**が要るため、
  client 側だけでは再現困難。**押し下げが本来の姿**。」
- §4.2「plugin は `kintone.getLoginUser()` が使えるが、Node/MCP は取得手段がない
  （**現状 `LOGINUSER` は Node/MCP で空文字**）。B54（User API）と相乗の可能性。」
  → **この記述が実装と食い違う**（実装は環境判定なしで無条件に空文字。§3.1）。
- Phase 分けで「**対象外（Phase2）**: `PRIMARY_ORGANIZATION()`（B54 User API と相乗）」。
  CHANGELOG にも同旨の記載がある。

**したがって `PRIMARY_ORGANIZATION()` は「未実装」ではなく「意図的に Phase2 へ送られた未着手項目」**である。
実装する場合、client 側に組織文脈を取得する手段が無い（プラグインの `getLoginUser()` は
ユーザーであって主組織ではない）ため、**押し下げ専用＝押し下げできない位置では fail-closed**、
つまり相対日付 12 関数と同じ扱いが自然で、本課題のような非対称を最初から作らずに済む。

## 5. 方針案（未決）

| 案 | 内容 | 影響 |
|---|---|---|
| A | 12 関数と同じ fail-closed に統一 | 一貫するが**破壊的**（既存クエリがエラー化） |
| B | client 評価時に kintone の TZ / ユーザー文脈を解決して使う | 非破壊。**`LOGINUSER` はプラグイン面なら `getLoginUser()` が既に宣言済みで低コストの可能性**。TODAY/NOW の TZ 解決はアプリ設定 API とキャッシュの検討が別途必要 |
| C | 現状維持＋**言語リファレンスに明記**（`TODAY()`/`NOW()`/`LOGINUSER()` は押し下げが崩れると client 評価になる。`CURRENT_DATE()`/`CURRENT_TIMESTAMP()` は常に client 評価）＋**MCP function catalog の記述是正** | 最小コスト・利用者が回避可能 |

**まず C（明文化）を最低限行い、A/B は経緯確認のうえ判断する**のが妥当と考える。

## 6. 補足

B75 Step 1 のレビュー中、`TODAY()` を使った拒否テストが期待どおり拒否されなかったことから発見した。
**B75 の変更が原因ではなく、B67 以来の既存挙動**である（HEAD でも同じ）。
