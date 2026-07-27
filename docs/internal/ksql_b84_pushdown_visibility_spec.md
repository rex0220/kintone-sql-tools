# B84 実装計画 — 押し下げ可否を公開文書へ（生成方式）

- 作成: 2026-07-28
- ステータス: 📋 **仕様確定・実装待ち**
- 課題: [B84 issue](ksql_b84_pushdown_visibility_docs_issue.md)
- 関連: [B76 Phase A spec §5.2](ksql_b76_join_pushdown_phase_a_spec.md) / [B83](ksql_b83_mcp_validate_columns_docs_issue.md) / [B60](ksql_b60_mcp_syntax_hints_spec.md)

## 0. 実証済みの前提（着手前に確認した）

**表は生成できる。実挙動とも一致する。**

### 0.1 分類器を直積で叩いて表が出た

`classifyJoinPushdownLeaf` へ **20 型 × 8 演算子 = 160 通り**を流し、**34ms** で表が出た。

```
型                           =       !=        <        >       <=       >=       in   not in
SINGLE_LINE_TEXT     superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
MULTI_LINE_TEXT        unsafe   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
NUMBER               superset   unsafe superset superset   unsafe   unsafe        -        -
CALC                   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
DATE                 superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
TIME                 superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
DATETIME             superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
CREATED_TIME         superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
UPDATED_TIME         superset   unsafe   unsafe   unsafe   unsafe   unsafe        -        -
DROP_DOWN              unsafe   unsafe   unsafe   unsafe   unsafe   unsafe    exact    exact
RADIO_BUTTON           unsafe   unsafe   unsafe   unsafe   unsafe   unsafe    exact    exact
CHECK_BOX              unsafe   unsafe   unsafe   unsafe   unsafe   unsafe    exact    exact
MULTI_SELECT           unsafe   unsafe   unsafe   unsafe   unsafe   unsafe    exact    exact
STATUS                 unsafe   unsafe   unsafe   unsafe   unsafe   unsafe    exact    exact
CREATOR                unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe
MODIFIER               unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe
USER_SELECT            unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe
ORGANIZATION_SELECT    unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe
GROUP_SELECT           unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe   unsafe
```

`-` は構文的に成立しない組み合わせ。

### 0.2 生成結果が実挙動と一致した（実 kintone・v3.29.0）

**表の予測がそのまま観測できる。**`superset` / `exact` は押し下がり、`unsafe` は全件取得になる。

| 述語 | 表の予測 | 実挙動 |
|---|---|---|
| `d.会社名 = 'x'`（TEXT） | superset | `会社名 = "x"` ✅ |
| `d.対応日付 = '2025-08-01'`（DATE） | superset | `対応日付 = "2025-08-01"` ✅ |
| `d.対応種別 in ('電話')`（DROP_DOWN） | exact | `対応種別 in ("電話")` ✅ |
| `d.作成者 in ('rex0220')`（CREATOR） | unsafe | **(全件取得)** ✅ |
| `d.内容 = 'x'`（MULTI_LINE_TEXT） | unsafe | **(全件取得)** ✅ |

**分類器の出力＝観測可能な押し下げ挙動**であることが確認できた。表は嘘にならない。

## 1. 方針＝案 B（テストで生成・照合）

課題 §3.3 で挙げた2案のうち **B を採る**。

| 案 | 内容 | 判断 |
|---|---|---|
| A | 分類器をデータ表へリファクタし、挙動と docs を同じ表から導く | **却下**。本番ロジックに手を入れる。押し下げの安全性は過去に何度も事故った領域（v2.0.0 の `LIKE` 全廃）で、docs のためにそこを触る理由がない |
| **B** | **テストで直積を分類器へ流し、公開文書の表と照合する** | **採用**。本番コードに触らず drift を止められる |

**このプロジェクトが既に採っている手法**でもある（[[enumerate-combinations-when-verifying]]＝軸が見えたら直積を全件流す）。

## 2. スコープ＝この表が説明するのは1つの軸だけ

**最も注意すべき点。**表が扱うのは
**「JOIN における、フィールドとリテラルを比較する単一の leaf」**だけである。

押し下げには**別機構の軸が複数ある**ので、表だけを載せると誤解を生む。

| 軸 | 機構 | 表に含めるか |
|---|---|---|
| **JOIN・field vs literal** | `classifyJoinPushdownLeaf` | **✅ 表にする** |
| **単一表** | `WHERE` 全体を直列化し `whereCapability` が exact 判定 | ❌ 表にしない。**型を問わず通る**ので原則を文章で書く |
| **`$id` / レコード番号** | `isSafeIdComparison`（**フィールド型ではなく `$id` という名前**で判定） | ❌ 表にしない。**全比較演算子が可**と文章で書く |
| **server-only 15関数** | 第5-W / 第5-L（B76 Phase B） | ❌ 表にしない。専用節が既にある |
| **KLIKE** | `klikePushdownPlan` | ❌ 表にしない。専用節が既にある |

> **`$id` を表に入れてはならない。**probe では `RECORD_NUMBER` 型のフィールドが全て `unsafe` になったが、
> `$id` は**型ではなく名前で判定される別経路**を通り、`$id <= 3000` は JOIN でも押し下がる。
> 型の表に混ぜると**逆の結論を読ませる**ことになる。

Pro が「単一表では押し下がるのに JOIN では」と混乱したのは、**まさにこの2機構の差**だった。
したがって**表の前に「どの軸の話か」を明示**すること。

## 3. 実装

### 3.1 生成・照合テスト

- 型の集合は**実装から導く**（`classifyWhereCapability` が扱う型・`fieldTypes` に現れる型）。
  手書き列挙にすると B83 と同じ drift を起こす
- 演算子は `=` `!=` `<` `>` `<=` `>=` `in` `not in`
- 各組み合わせで `classifyJoinPushdownLeaf` を呼び、`exact` / `superset` / `unsafe` / `-` を得る
- **公開文書から表を抽出して照合**する。差があればテストが落ちる

抽出は `docs/ksql_language_reference.md` の**マーカー付きコードブロック**を読む。
`scripts/engine-docs-examples-smoke.mjs` が docs を読む前例がある。

### 3.2 公開文書の構成

言語リファレンスに**押し下げの節を新設**する。現状は相対日付・KLIKE・JOIN の各節に分散しており、
**横断的に読めない**。

1. **どの軸の話かの説明**（§2 の表）
2. **単一表の原則**＝`WHERE` 全体を exact に直列化できれば型を問わず押し下がる
3. **JOIN の型 × 演算子表**（生成・照合対象）
4. **`$id` は別扱い**＝全比較演算子が可
5. **関数で包むと押し下げ不可**＝`DATE_FORMAT(field, ...)` は kintone クエリとして表現できない
6. **選択系は `in` を使う**＝`=` は kintone のクエリ文法に無い（B83 で言語リファレンスへ追記済み）

### 3.3 読み方の補足も書く

`exact` / `superset` の違いは利用者には**実用上ほぼ同じ**（どちらも押し下がる）。
**内部の安全性区分**なので、公開文書では **「押し下がる / 押し下がらない」の2値**に落として書き、
`exact` / `superset` の区別は `EXPLAIN` の `relation` を見れば分かる、と案内する。

> 3値のまま出すと「superset だと結果が違うのか」という疑問を生む。
> **実際は元の `WHERE` を client で再評価するので結果は同じ**である。

## 4. 受入条件

| # | 条件 |
|---|---|
| 1 | 型 × 演算子の直積が**実装から導いた型集合**で網羅されている |
| 2 | 公開文書の表と生成結果が**一致**し、ずれたらテストが落ちる |
| 3 | 表の**適用範囲**（JOIN・field vs literal）が文書に明記されている |
| 4 | **`$id` が表に含まれていない**（別扱いと明記） |
| 5 | 単一表・server-only 関数・KLIKE が**別軸**として案内されている |
| 6 | 公開文書は **2値**（押し下がる / 押し下がらない）で書かれている |
| 7 | 新しいフィールド型が追加されたら**テストが落ちる** |

## 5. 規模

| 作業 | 見積 |
|---|---:|
| 生成・照合テスト | 0.25 |
| 言語リファレンスの押し下げ節（新設・既存節からの整理を含む） | 0.5 |
| 4面 smoke・docs-smoke への配線 | 0.25 |

**合計 1.0 人日。公開挙動の変更なし。**

## 6. やらないこと

- **分類器のリファクタ**（案 A）。本番ロジックに触らない
- **単一表の表**。機構が違い、型を問わず通るので表にする意味がない
- **`>=` / `<=` を押し下げ対象へ加えること**。B76 Phase A で
  「IEEE-754 境界のため inclusive は不可」と判断済み。**本課題は可視化であって拡張ではない**
