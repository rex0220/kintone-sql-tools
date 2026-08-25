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

---

## 8. 対策案（codex）と Claude レビュー（2026-08-25）

[codex の対策案](ksql_b176_plan_codex.md)。**推奨は案 A**（`EXPLAIN UPSERT` でも対象アプリの `getFields` を引く）。**Claude も同意。**

### 8.1 【訂正】§3 に書いた「テストで捕まらなかった理由」は**誤り**だった

**§3 では「`getFields` をモックした client を渡していたので、呼び出し側が呼ぶかを検証していなかった」と書いた。これは不正確。**

codex が実装を開いて特定した、より正確な事実:

1. **`ELIGIBLE` を出せていたテストは、同じアプリへの先行 SELECT が invocation キャッシュを温めていた**（偶然）。適格性表示は**キャッシュを参照するだけで自分では取得しない**（`src/execute.ts:7457,7464`）。キャッシュが無ければ `null` → 条件 3 が `UNKNOWN`（`同:7475,7480`）
   - **こちらの MCP バッチ実測（`SELECT key_text FROM APP4253 LIMIT 1;` + UPSERT）が `UNKNOWN` だったのと整合する**＝WHERE がフィールドメタデータを要さない SELECT はキャッシュを温めない
2. **さらに悪い**＝`src/__tests__/explain.test.ts:665-681` に **「B173 AC-16/17/22: 単文 EXPLAIN は既存 SELECT 外形のまま UNKNOWN と非実行面を表示し API を増やさない」** というテストがあり、**`UNKNOWN` と `getFields` 0 回を明示的に固定している**

→ **本件は「テストが見落とした」のではなく「壊れた挙動が仕様として指定され、テストで固定された」。** §3 の記述を訂正する。**予防策も変わる**＝テストを厚くするだけでは足りず、**仕様の矛盾を先に解消しないと同じ結論に戻る**。

### 8.2 【訂正】§4 の「仕様の内部矛盾」の引用先が誤っていた

§4 は R5 の **§7** を「API・実行契約」として引いたが、**R5 の §7 は「書込順・確認・結果」**。実際に矛盾しているのは **§4.4 / §4.5 と AC-16**（codex の指摘）。**矛盾があること自体は正しい**が、条番号を訂正する。

### 8.3 codex の分析で価値が高かった点

- **根本原因の特定**＝`buildExplainWhereAnalysis` の visitor に `UPSERT` / `UPSERT_SELECT` の**対象 schema を取る分岐が無い**（`src/execute.ts:12221,12230,12432`）。SELECT / VALIDATE / UPDATE / DELETE は固有処理を持つのに UPSERT だけ一般走査で終わる
- **`resolveMetadata` は原因ではない**と切り分けた（`true` でも UPSERT target schema を読む処理が無い）。ただし修正時は**単文 EXPLAIN にも解決可否を渡せないとオフライン dry-run を維持できない**
- **`explainNeedsAppMetadata`（`src/core/explainMetadata.ts:115,123`）が UPSERT を認識しない**。**ここを無条件に変えると CLI の `--dry-run` が認証必須になる**ので用途を分離せよ、という指摘は鋭い。こちらでは見落としていた
- **`/flow` の LAPP 経由の native 統合テストが無い**／**本実行テストが `fieldCalls === 1` を固定していない**というテストギャップの指摘

### 8.4 Claude が足す論点

1. **【互換】metadata 取得失敗時に `EXPLAIN UPSERT` が新たに「失敗し得る」ようになる。** codex の推奨（SELECT EXPLAIN と同じくエラー伝播。握り潰して `UNKNOWN` にすると権限・通信障害を隠す）に**同意**するが、これは**5 面すべてでの挙動変更**なので、CHANGELOG に明記が要る
2. **【互換】単文 `execute` の `metrics.fieldCalls` が 0 → 1 になる**（公開値）。同じく明記が要る
3. **【版数】patch か minor か。** EXPLAIN の出力行が増え `rowCount` が変わり、API 呼び出しが 1 回増える。**動かない機能の修正だが、観測値が変わるので minor を推す**
4. **【順序】仕様の矛盾解消を先にする。** §8.1 のとおり、テストを直す前に「EXPLAIN では metadata API を引いてよい／レコード API は引かない」と R5 を書き分けないと、`explain.test.ts:665` を反転させる根拠が無い

### 8.5 次にやること（順序）

1. **仕様 R5 の矛盾を解消**（§4.4 / §4.5 の「API を増やさない」を**本実行・preview に限定**し、EXPLAIN は metadata API 可・レコード API 不可と書き分ける）
2. **`explain.test.ts:665-681` を反転**（`ELIGIBLE`・`getFields` 1 回へ）。**ここが本件の核**
3. 案 A を実装（`buildExplainWhereAnalysis` に UPSERT 分岐・単文 EXPLAIN への解決可否 option・`explainNeedsAppMetadata` の用途分離）
4. **再発防止テスト**＝**UPSERT 単独で開始し、実 adapter の transport 呼出し回数を固定**（先行 SELECT でキャッシュを温めない）。codex の 9 項目と面別の具体形をそのまま採る
5. codex が挙げたテストギャップ 3 件（LAPP 経由 native / 本実行の `fieldCalls` / transport-level 通し）も同時に埋める
