# Pro への返信 — EXPLAIN が取得範囲を名乗る（B114 / K-110）

- 作成: 2026-08-04
- ステータス: 📝 **送付前**（v3.40.0 リリース後に送付）
- 受領: [Pro の依頼 2026-08-04](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260804-送付版.md)
- 関連: [B114](ksql_b114_explain_fetch_scope_issue.md)

## 送付前の確認

1. **依頼どおり両方入った**（人間向け 1 行＋構造化）ことを最初に。改名していないことも
2. **形は 3 値ではなく 4 値・スカラーではなくソース単位**——**理由を実測で示す**
   （`COUNT(*)` は件数のみ＝1 件だけ転送／`UNION` の枝で取得のされ方が違う）
3. **`fetch` の値は将来増えうる**ので未知の値の扱いを頼む——これは運用の契約
4. 「読むべきは mode ではなく kintone query の行」という注意書きは**不要になった**と伝える
5. 社内メモ（この節）を削除してから送ること

---

# 本文（送付版）

## 【返信】K-110 — v3.40.0 で入りました。ご指摘のとおり、原因はこちらの命名でした

```
npm i @rex0220/kintone-sql-tools@3.41.0
```

**「私たち自身が誤読していました」と書かれていましたが、誤読させていたのはこちらです。**
`FULL_SCAN` は「取得後に JS で全行評価する」という内部の評価戦略名なのに、
読み手にはコストの言明に見えます。しかも**ダッシュボードのペインは大半が `GROUP BY` か
集計を含むため、押し下げが効いていても常に `FULL_SCAN` と出る**——正常系のほうが
紛らわしい表示になっていました。

## 1. ①人間向けの 1 行

```
  mode:          FULL_SCAN
  kintone query: 確度 in ("A")
  fetch:         PREFILTERED (未確定)
```

**文の先頭には最悪値の `fetch summary:`** も出ます。
`mode` は**改名していません**（ご希望どおり・互換性優先）。

## 2. ②構造化フィールド

`ExplainResult` に `plan` が入りました（純加法）。

```ts
const { plan } = await explainQuery(sql, { client });
plan.statements[0].fetch;                   // "count_only" | "exact" | "prefiltered" | "all" | "none"
plan.statements[0].sources[0].kintoneQuery; // 全件取得なら null
```

**ご要望の「設定画面に一言出す」はこれで書けます。**`text` の文字列解析は不要です。

## 3. ご提案から 2 点だけ形を変えました（実測が理由です）

### 3.1 3 値ではなく **5 値**——`COUNT_ONLY`（件数のみ）を足しました

```
mode:          COUNT_TOTAL_COUNT
kintone query: 確度 in ("A") limit 1
fetch:         COUNT_ONLY (limit 1)
fetch API:     GET records.json (totalCount=true)
```

**`COUNT(*)` はレコードを走査しません。**`limit 1` の単発 GET で `totalCount` だけを使うため、
アプリの件数に関係なく **1 リクエスト・転送は `$id` だけの 1 件**です（`metrics.fetchedRows` も 1）。
ダッシュボードのカウント系ペインはこの形が主力のはずで、`EXACT` とも `PREFILTERED` とも違います。

**残る `NONE` は「kintone から取得するソースが 1 つも無い文」**（一時テーブル参照のみ）
でだけ現れます。最悪値の順序は `NONE` < `COUNT_ONLY` < `EXACT` < `PREFILTERED` < `ALL` です。

### 3.2 スカラー 1 個ではなく **ソース単位**にしました

ご提案の `fetch: "exact" | "prefiltered" | "all"` を `ExplainResult` に 1 つ置く形は、
**次のクエリで必ず嘘になります**（実測）。

```
[union:1]  fetch: COUNT_ONLY (limit 1)   ← 件数のみ（走査なし）
[union:2]  fetch: ALL                ← 全件
```

`JOIN` でも同じで、片方の alias は絞り込み済み・もう片方は全件、が普通に起こります。
そこで **`sources[]`（ソース単位）＋ 文ごとの最悪値**という形にしました。
UI に一言出すだけなら `statements[n].fetch`（最悪値）を読めば足ります。

## 4. お願いが 1 つ — `fetch` の値は将来増えます

cursor 利用や取得上限つきなど、**分類が増える可能性があります。**
**未知の値が来たら「未分類」として扱う**実装にしておいてください
（`switch` の `default` で落とさない、など）。こちらも文書に明記しました。

## 5. 「読むべきは mode ではなく kintone query の行」の注意書きは不要になりました

押し下げ早見表（K-109）に書く予定とのことでしたが、**`fetch:` の行を読めば済みます。**
その注意書き自体が「本来なら要らない説明」だというご指摘はそのとおりでした。

なお §4 でご確認いただいた 3 点（`LIKE` は前方一致でも押し下がらない／日付リテラルの
範囲比較は単一表で押し下がる／`IS NULL` は押し下がらない）は、こちらの実測でも
リファレンスの記述どおりで齟齬はありませんでした。

## 6. まとめ

| | |
|---|---|
| **①人間向け 1 行** | `fetch:`（ソースごと）＋ `fetch summary:`（文ごとの最悪値） |
| **②構造化** | `ExplainResult.plan`（純加法）。文字列解析は不要 |
| **形の変更 2 点** | **5 値**（`COUNT_ONLY` を追加）・**ソース単位**（`UNION` / `JOIN` で 1 値にならない） |
| **`mode`** | **改名なし**（ご希望どおり） |
| **お願い** | `fetch` の未知の値は「未分類」として扱ってください |

**MCP をお使いの場合は、更新後に再起動し、新しい会話を始めてください。**
`instructions` の 1 行目が `kSQL MCP server version 3.41.0.` になっていれば切り替わっています。
