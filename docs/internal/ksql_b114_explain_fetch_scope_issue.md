# B114 `EXPLAIN` が取得範囲を名乗らない — 出力設計の見直し

- 起票: 2026-08-04
- ステータス: 📝 **仕様確定（段階分け・オーナー Go 2026-08-04）**＝仕様は §4（第 1 段）・§5（第 2 段）
- 出典: [Pro の依頼 2026-08-04](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260804-送付版.md)（K-110・**急ぎではない**）。
  **ただし本書は依頼の形をなぞらず、EXPLAIN の設計として検討したもの**（オーナー指示 2026-08-04）
- 関連: B94 / B105（`COUNT_TOTAL_COUNT`）/ B108・B109・B112（EXPLAIN 表示の契約）

## 1. 現状（実測 2026-08-04）

| | |
|---|---|
| 計画行を組み立てている箇所 | **145 箇所**（`src/execute.ts` の `lines.push`） |
| 行ラベルの種類 | **99 種類** |
| `mode` の値 | `SIMPLE` / `FULL_SCAN` / `FULL_SCAN_EXACT` / `KORDER_NATIVE` / `COUNT_TOTAL_COUNT` |
| 構造 | **無し**。`lines` は `text` を改行で割っただけ |

## 2. EXPLAIN は何に答えるべきか

読み手の問いは 3 つで、優先順位がある。

1. **これは動くか**（エラー・取得上限・fail-closed）
2. **いくら掛かるか**（何件取りに行くか・API を何回叩くか）
3. **なぜそうなるか**（どの述語が押し下がり、どれが JS 残余か）

**現状は 3 に厚く、1 に部分的に答え、2 に直接は答えていない。**
そして**最も目立つ 1 行目の `mode:` は、この 3 つのどれでもない内部の評価戦略名**である。

## 3. 構造的な欠陥（4 点）

**① 見出しが問いに答えていない。** `FULL_SCAN` は「取得後に JS で全行評価する」という
内部名だが、読み手には**コストの言明**に見える。しかも次の組み合わせが**正常系として頻出**する
（ダッシュボードのペインは大半が `GROUP BY` か集計を含むため）。

```
mode:          FULL_SCAN
kintone query: 確度 in ("A")        ← 絞り込みは効いている
```

**② テキストが正で、構造が無い。** 99 ラベルがフラットに並び、下流は正規表現で読むしかない
（Pro は実際に試して「表示文言の変更で壊れる」と断念した）。**構造が正・テキストはそこから
描画**が本来。B112 で「面どうしの一致テストがテキスト比較ゆえに壊れた」のも同じ根。

**③ 確定と見込みが混ざる。** `pushdown candidate: ...（実行時の型・実在確認待ち）` は
実行時に落ちうる。**「絞り込み済み」と出して実際は全件だった場合、取得上限の説明が逆に壊れる。**

**④ ソース単位の事実と全体の事実が同じ平面にある。** 実測（1 クエリ・2 枝）:

```
[union:1]  COUNT_TOTAL_COUNT   確度 in ("A") limit 1   ← 取得 0 件
[union:2]  FULL_SCAN           (全件取得)              ← 全件
```

**全体で 1 つの値に畳むと必ず嘘になる。**正しい単位は**ソース**（`app:` / `JOIN:` /
`[union:n]` / CTE・一時テーブル）。

## 4. 第 1 段の仕様（人間向け出力・型変更なし）

### 4.1 ソースごとに `fetch:` を 1 行足す

**`kintone query:` の直後**に置く（同じソースブロック内）。

```
  app:           APP4149@dev AS APP4149
  kintone query: 確度 in ("A")
  fetch:         PREFILTERED (未確定)
  fields:        確度
```

| 値 | 意味 |
|---|---|
| `NONE` | **レコードを取得しない**（`COUNT_TOTAL_COUNT` の totalCount 単発 GET） |
| `EXACT` | WHERE 全体を kintone で絞り込み、**JS 残余なし** |
| `PREFILTERED` | 一部の述語だけ kintone で絞り込み、**残余は JS 評価** |
| `ALL` | **全件取得**（`kintone query: (全件取得)`） |

**接尾辞**（該当時のみ・順に並べる）

- `(limit N)` — 押し下げたクエリが `limit` を伴う（top-N / `KORDER_NATIVE` / `COUNT_TOTAL_COUNT`）
- `(未確定)` — **`pushdown candidate` 由来**＝実行時の型・実在確認で落ちうる（欠陥③）

### 4.2 判定規則

**判定に必要な材料は、`fetch:` を出す位置にすべて揃っている**（`src/execute.ts:10555-10600` 付近の
`mainQ` / `mainPushDown` / `exactOriginalWhere` / `mainCandidate` / `relation` / `runtimeJoinPlan`）。
**新しい解析を足さないこと。**

1. 文の mode が `COUNT_TOTAL_COUNT` → `NONE`
2. そのソースの `kintone query:` が `(全件取得)` → `ALL`
3. そのソースの WHERE が exact に消費されている（`relation: exact` / whole-WHERE exact） → `EXACT`
4. それ以外（prefilter＋残余 / `relation: superset`） → `PREFILTERED`

**迷ったら安全側（`PREFILTERED` より `ALL`、`EXACT` より `PREFILTERED`）に倒すこと。**
誤って「絞り込み済み」と名乗るほうが、名乗らないより有害である。

### 4.3 文ごとの要約行

**各文の計画の先頭**に 1 行置く。

```
fetch summary: ALL
```

- 値はその文の**全ソースの最悪値**。順序は **`NONE` < `EXACT` < `PREFILTERED` < `ALL`**
- **kintone から取得しないソース（一時テーブル・CTE 参照のみ）は集計対象外**。
  物理ソースが 1 つも無い文では**この行を出さない**
- `UNION` は枝ごとに `[union:n]` ブロックがあるため、**要約は文全体で 1 行**（枝の最悪値）

### 4.4 変えないもの

- **`mode` の値・意味・位置**（改名しない＝既存の利用者コードとテストの互換性。Pro も改名は希望していない）
- 既存 99 ラベルの文言・順序（`fetch:` の挿入以外）
- DML・`VALIDATE` の計画（**第 1 段は SELECT / UNION / CTE・一時テーブルの取得計画に限る**）
- 押し下げ判定そのもの（表示のみの変更）

### 4.5 受入条件

1. 実測 4 形が正しく名乗る＝`COUNT(*)`→`NONE` / 日付範囲の単一表→`EXACT` /
   `GROUP BY`＋`確度 in ('A')`→`PREFILTERED (未確定)` / `LIKE`→`ALL`
2. **JOIN で alias ごとに別の値が出る**（片方 `EXACT`・片方 `ALL`）
3. **`UNION` で枝ごとに別の値が出る**（実測の `[union:1] NONE` / `[union:2] ALL`）
4. 要約行が最悪値になる（上記 3 のクエリで `ALL`）
5. 物理ソースの無い文（一時テーブルのみ）で要約行が出ない
6. `mode` 行が完全不変・既存テスト全 green・snapshot 22 不変・語数予算 exact 不変
7. CLI / MCP / engine ライブラリの 3 面で同じ行が出る

## 5. 第 2 段の設計（構造化・純加法）

**`text` から構造を作るのではなく、構造から `text` を描画する**向きにする。

```ts
// ExplainResult へ純加法（optional・ただし常に埋める。B110 の displayName と同じ流儀）
plan?: {
  statements: readonly {
    index: number;
    fetch: "none" | "exact" | "prefiltered" | "all";
    sources: readonly {
      app: number;
      alias: string | null;
      role: "main" | "join" | "union" | "cte" | "temp";
      fetch: "none" | "exact" | "prefiltered" | "all";
      pending: boolean;          // 実行時の型・実在確認待ち
      kintoneQuery: string | null;   // 全件取得なら null
      limit: number | null;
    }[];
  }[];
};
```

### 5.1 決定（2026-08-04・第 1 段の完了後に確定。v3.40.0 で同梱）

**第 1 段が出している事実をそのままデータに写す。**`fetch: NONE (limit 1)` は
`{ fetch: "none", limit: 1 }`、`PREFILTERED (未確定)` は `{ fetch: "prefiltered", pending: true }`、
JOIN の alias 別・`UNION` の枝別は `sources[]` の要素になる。

| | 決定 |
|---|---|
| **構造化する範囲** | **取得計画だけ。** 99 ラベル全部はやらない（詳細層＝JOIN 押し下げ診断・`complete input` 等はテキストのまま）。全部やると第 3 段（命名統一）と同じ規模になる |
| **描画の向き** | **取得計画の行だけ構造から描画**する。残る 145 箇所の `lines.push` は現状維持。これが費用を中に留める鍵 |
| **公開型** | `ExplainResult.plan?`（**optional・ただし常に埋める**。B110 の `displayName` と同じ流儀） |
| **面** | **engine ライブラリのみ。** MCP / CLI の出力は**不変**（第 1 段の `fetch:` 行で足りる） |
| **値の将来拡張** | `fetch` の 4 値は将来増えうる（cursor 利用・取得上限つき等）。**「未知の値が来たら未分類として扱う」ことを `docs/ksql_engine_library.md` に明記**し、消費側へ求める |
| **バッチ** | `statements[]` は**文ごと**。EXPLAIN 単文と batch plan の**両経路**で埋める（B109 で触った 2 経路） |

### 5.1bis `sources` と `role` の定義（2026-08-04 追記・実装中に仕様の穴が判明）

初回実装で `SELECT * FROM #t`（一時テーブル参照のみ）が
`{ app: 0, alias: "#t", role: "temp" }` を返し、**存在しないアプリ ID 0 を名乗った**。
また `CREATE TEMP TABLE #t AS SELECT ... FROM APP100` の物理ソース APP100 が
`role: "temp"` になり、**同じ `temp` が「一時テーブルを作る文の物理ソース」と
「一時テーブルそのもの」の 2 つの意味を持っていた**。§5 で `role` を定義していなかったのが原因。

| | 決定 |
|---|---|
| **`sources[]` に載せるもの** | **kintone から取得する物理ソースだけ。** 一時テーブル・CTE の「参照」は載せない。**`app` に 0 のような偽の ID を作らない** |
| **`role` の値** | `main`（文の主 FROM）/ `join` / `union`（枝）/ `cte`（CTE 本体）/ `subquery`（スカラーサブクエリ）。**`temp` は廃止する** |
| **`CREATE TEMP TABLE ... AS SELECT` の物理ソース** | **`main`**（内側 SELECT の主 FROM であるため） |
| **物理ソースが無い文** | `statements[]` には**載せる**（`sources: []`・`fetch: "none"`）。「kintone からレコードを取得しない」は事実である |

**テキストが要約行を省くこと（§4.3）と、構造が `fetch: "none"` を持つことは矛盾しない。**
前者は表示上の判断（雑音を出さない）、後者は事実の記録であり、**消費側は形が揃うほうが扱いやすい**。
この差は意図的なものとして文書に明記する。

### 5.1ter `NONE` を `COUNT_ONLY` へ改名し、値を 5 つにする（2026-08-04・v3.41.0）

**v3.40.0 の `NONE` は実態と 1 件ずれていた。**オーナーの指摘で実測したところ、
`COUNT(*)` は `limit 1`・`fields=["$id"]`・`totalCount=true` の**単発 GET で 1 件を転送**する
（`metrics.fetchedRows` も 1）。**「取得しない」ではなく「走査しない」**が正しく、
同じ API で返している `fetchedRows: 1` とも見た目が矛盾していた。

**改名するが、機械的な置換ではない。**`none` には**性質の違う 2 つ**が入っていた。

| 状況 | v3.40.0 | v3.41.0 |
|---|---|---|
| `COUNT(*)` を `totalCount` で解く（**1 件転送・走査なし**） | `NONE` | **`COUNT_ONLY`** |
| kintone から取得するソースが 1 つも無い文（一時テーブル参照のみ・**本当にゼロ**） | `NONE` | **`NONE`（据え置き）** |

- **値は 5 つ**: `NONE` / `COUNT_ONLY` / `EXACT` / `PREFILTERED` / `ALL`
- **最悪値の順序**: `NONE` < `COUNT_ONLY` < `EXACT` < `PREFILTERED` < `ALL`
- **公開型の union は文・ソースで同じ 5 値**にする（消費側が 1 つの型で分岐できるため）。
  ただし**`none` は「取得ソースが無い文」でのみ現れる**ことを文書に明記する
- **テキストに `NONE` は現れない**（物理ソースの無い文では要約行を出さないため・§4.3）。
  したがって**テキストの変更は `NONE` → `COUNT_ONLY` の置き換えだけ**

**これは公開型の値集合の変更＝破壊的変更**だが、v3.40.0 の publish 直後で、
**唯一の消費者である Pro にはまだ連絡していない**ため実被害はほぼ無い。
`role` の `temp` をリリース前に直したのと同じ判断で、**直せる機会はいましか無い**。
SemVer は **minor＋移行案内**（B86 / B89 / B107 の前例に従う）。

### 5.2 最重要の制約 — テキストは 1 文字も変えない

**構造から描画した結果が、第 1 段の出力と完全に一致すること。**
第 2 段は「同じ事実をデータでも返す」だけで、**人間向け出力の変更ではない**。

- 既存テスト全 green・**snapshot 22 不変**・語数予算 exact 不変
- `b76` の配布面一致テスト・`console.e2e` の計画行数が**そのまま通ること**

### 5.3 受入条件

1. `explainQuery` の結果に `plan` が入り、**第 1 段の `text` と同じ事実**を表す
2. **JOIN** で `sources` が alias ごと、**`UNION`** で枝ごと、**CTE / 一時テーブル**の `role` が付く
3. `pending` / `limit` / `kintoneQuery`（全件取得なら `null`）が正しい
4. **バッチ**（複数文）で `statements` が文ごとに並ぶ
5. **公開型の差分が `plan?` の純加法のみ**（declaration snapshot で確認）
6. **`text` が第 1 段と 1 文字も変わらない**（§5.2）
7. **MCP / CLI の出力が不変**
8. bundle guard green（ゼロ依存維持）

### 5.4 やらないこと（第 2 段）

- MCP / CLI への構造化 payload の露出（別途・実需が出てから）
- 詳細層 99 ラベルの構造化
- `fetch` 以外の診断（JOIN 押し下げ・`complete input`）の構造化

## 6. やらないこと

| | 理由 |
|---|---|
| `mode` の改名 | 互換性。既存コード・テストが見ている可能性がある |
| **件数の予測**（「約 N 件取得します」） | 取得前に行数は分からない（`totalCount` の場合を除く）。**言えないことは言わない** |
| 「利用者向け」と「開発者向け」で出力を 2 本に分ける | 必ず片方が腐る。1 つの出力を**要約→ソース別→詳細**の層にする |
| 詳細層 99 ラベルの命名統一（第 3 段） | 互換リスクが高い。実需が出るまで手を付けない |
| EXPLAIN を性能予測器にすること | 責務が違う |

## 7. 優先度

**中。** 誤った結果を返す問題ではないが、**押し下げが効いていても `FULL_SCAN` と出る形が
正常系として頻出**し、読み手（Pro 経由では非エンジニアの kintone アプリ管理者）が
恒常的に誤読している。**原因はこちらの命名**であり、Pro の依頼の有無によらず直す価値がある。

**第 1 段だけで読み手の問い①②に答えられるようになる。**
