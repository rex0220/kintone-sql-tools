# B176 EXPLAIN の native 適格性表示が実経路では常に `UNKNOWN` — 可視化が機能していない

- 状態: 📝 **起票（v3.73.0 リリース後の実機確認で発覚・2026-08-25）**＝**B173 で入れた可視化が、実運用では目的を果たしていない**。エラーにはならず、**常に `UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得）` を返す**ので `ELIGIBLE` に到達できない
- 種別: 課題（機能が意図どおり動かない）
- 優先: **中**（結果は誤らない。**表示が無価値なだけ**。ただし B173 のレビュー 2 周を費やした機能が死んでいる）
- 影響版: **v3.73.0**（B173 と同時に入った）
- 関連: [B173 仕様 R5](ksql_b173_native_upsert_spec.md) §10・AC-16 / AC-17 ／ [B173 起票](ksql_b173_native_upsert_update_key_issue.md) §7.3（可視化の目的）

## 1. 実機で観測したこと（2026-08-25・v3.73.0・APP4253）

**MCP（単文）**:

```
UPSERT INTO APP4253 (key_text, payload) VALUES ('V1','a') ON DUPLICATE (key_text)
```
```
native UPSERT statement/data eligibility: UNKNOWN（条件 3: KEY_SCHEMA — フォームメタデータ未取得; 条件 6: SOURCE_DUPLICATE — キー型情報が未確定のため重複判定不能）
native UPSERT execution surface: NOT_APPLICABLE（この面では実行しない）
```

**MCP（バッチ・SELECT + UPSERT の 2 文）**: 同じく `UNKNOWN`。

**CLI（`--allow-dml --native-upsert` 付き・単文 `EXPLAIN UPSERT`）**: 同じく `UNKNOWN`。

→ **面依存条件の分割（R4 の Major 修正）は正しく効いている**（`NOT_APPLICABLE` と `statement/data` の 2 行が出る）。**しかし文・データ側が常に `UNKNOWN` なので、結局「この文は native になるのか」が読めない。**

## 2. 直接の原因 — `EXPLAIN UPSERT` はフォーム定義を取得していない

CLI の `--debug` でリクエストを観測した。

| EXPLAIN 対象 | `app/form/fields.json` の呼び出し |
|---|---|
| `EXPLAIN SELECT key_text FROM APP4253 WHERE key_text = 'x'` | **1 回**（引いている） |
| `EXPLAIN UPSERT INTO APP4253 … ON DUPLICATE (key_text)` | **0 回**（**API を 1 回も呼ばない**） |

条件 3（キーが単一・重複禁止・`SINGLE_LINE_TEXT` / `NUMBER`）は `isUnique` と `fieldType` を要するので、schema が無ければ判定できない。**条件 6（ソース重複）もキー型が要るため連鎖して `UNKNOWN` になる。**

## 3. なぜテストで捕まらなかったか — **モックが実経路より親切だった**

`ELIGIBLE` を固定しているテストは、いずれも **`getFields` をモックした client** を渡している。

- `src/ui/__tests__/b170BatchExplain.test.ts:33,50`（`const getFields = jest.fn(async () => [...])` → `expect(text).toContain("native UPSERT statement/data eligibility: ELIGIBLE")`）
- `src/flow-library/__tests__/publicApi.test.ts:115-119`
- `src/__tests__/explain.test.ts:55`

**モックは呼ばれれば schema を返すので、「呼び出し側が getFields を呼ぶかどうか」を検証していない。** 実経路では呼ばないため、テストが通っても本番では `UNKNOWN` になる。

**これは [[check-sibling-path-when-fixing]] の変種**＝「助言を出す機能に、助言をそのまま実行するテストを 1 本」。今回は**「実クライアントで EXPLAIN したら何が出るか」を固定するテストが無かった**。

## 4. 仕様側の内部矛盾（レビューでも見落とした）

仕様 R5 は次の 2 つを同時に要求している。

- §7（API・実行契約）: **「適格性判定のための API 呼び出しを増やさない。既に取得済みの metadata だけを再利用する」**
- §10.3 / AC-16 / AC-17: **`ELIGIBLE` を表示する**

**`EXPLAIN UPSERT` が schema を取得しない以上、この 2 つは両立しない。** 実装は前者に忠実で、結果として `UNKNOWN` を返している＝**仕様どおりだが、目的（起票文書 §7.3）を達していない。**

**codex も Claude もこの矛盾に気づかなかった。** R3 の Major 指摘（非 opt-in 面で常に `INELIGIBLE`）を直した結果が、**別の「常に同じ値」に置き換わっただけ**だった。

## 5. 案

| 案 | 内容 | 評価 |
|---|---|---|
| **A** | **`EXPLAIN UPSERT` でも対象アプリの `getFields` を引く**（他の EXPLAIN と同様に）。`resolveMetadata: false` のときと CLI の完全オフライン `--dry-run` では従来どおり `UNKNOWN` | **見立て**。`EXPLAIN SELECT` は既に引いており、**「EXPLAIN はレコード API を呼ばない」契約は維持される**（metadata API は元から許可）。条件 3・6 が判定でき、`ELIGIBLE` に到達する |
| B | 仕様から `ELIGIBLE` の要求を落とし、`UNKNOWN` を正とする | **可視化の目的が消える**ので採らない |
| C | 何もしない | 表示が無価値なまま残る |

**案 A を採る場合の確認事項**＝①metadata 取得が増えることを許容するか（**`EXPLAIN SELECT` は既に引いているので面としての一貫性はむしろ上がる**）②`resolveMetadata: false` と CLI `--dry-run` では `UNKNOWN` のままでよいか（**よい。判定材料が無いので正しい**）。

## 6. 次にやること

1. **実クライアントでの EXPLAIN 出力を固定するテストを足す**（モックの `getFields` に頼らない形）。**これが無かったのが根本**
2. 案 A を実装する
3. 仕様 R5 の §7 と §10 の矛盾を解消する（「metadata API は引いてよい。レコード API は引かない」と書き分ける）

## 7. 影響と暫定の扱い

- **結果は誤らない。** `UNKNOWN` は「判定できない」という正しい表示であり、`INELIGIBLE` と誤表示しているわけではない
- **native UPSERT の本体（B173 の中核）は影響を受けない。** 本実行と `previewStatement` は schema を持っているので適格性判定は正しく動く（v3.73.0 の API 削減効果は出る）
- **困るのは「オーサリング中に本番の挙動を読みたい」用途だけ**（起票文書 §7.3 の目的そのもの）
- 依頼元への通知では **「EXPLAIN で適格性を確認できます」と書かない**（B176 解消までは実質確認できないため）
