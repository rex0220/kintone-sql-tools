# 課題: B30 `ORDER BY` と取得打ち切りが誤った top-N を返す

- 作成日: 2026-07-17
- ステータス: **仕様確定・v3.0.0 公開済み（2026-07-17）**
- 種別: **バグ（結果正当性 / fail-closed）**
- 優先度: **高**
- 関連: [型付き順序・安全なORDER BY仕様案](ksql_local_order_by_draft.md)、B8、B26、B27

## 1. 問題

`onLimit: "truncate"` は、取得件数が `maxRecords` に達した時点で候補取得を打ち切り、その部分集合を後続処理へ渡す。

`ORDER BY` をローカル評価するクエリでは、全候補を取得する前に打ち切ると、真の最小値・最大値・top-N が取得済み部分集合の外に残り得る。部分集合をsortしても、完全集合に対する `ORDER BY ... LIMIT N` の答えにはならない。

## 2. 実測

Claudeレビュー時、APP4148（214件）で確認した。

```sql
SELECT 会社名
FROM APP4148
WHERE 会社名 LIKE '%'
ORDER BY 会社名 ASC
LIMIT 1
```

実行条件:

```text
maxRecords=100
onLimit=truncate
```

結果:

```text
返却: "サンプル株式会社 第10支店"
警告: "取得上限（100 件）に達したため、100 件で打ち切って表示しています。"

全214件での正しい先頭:
"サイボウズ物産株式会社"
```

正しい先頭行は `$id` 取得順の先頭100件に含まれなかった。警告は件数を省略したように読めるが、実際には返した1行自体が完全集合に対する最小値ではない。

## 3. コード上の原因

- `src/api/fetchAll.ts`: `onLimit === "truncate"` の場合、上限までの行を成功結果として返す
- `src/execute.ts:1286` 付近: SELECTの `onLimitReached` をfetchへ渡す
- `src/execute.ts:1328` 付近: FULL_SCANは取得済み行へ `applyOrderBy` を実行する

したがって処理順が次になる。

```text
$id順などで先頭maxRecords件を取得
→ truncateで候補取得を成功終了
→ 取得済み部分集合だけをORDER BY
→ LIMIT
```

必要な順序は次である。

```text
完全な候補集合を取得
→ ORDER BY
→ OFFSET
→ LIMIT
```

## 4. 決定

`ORDER BY` を含む SELECT は完全入力を必要とする文として扱う。

- 呼出し側が `onLimit: "truncate"` を指定しても、取得上限到達時は `error` とする
- 部分集合をsortして警告付き成功にしない
- CLI / MCP / プラグイン / 保存クエリで同じ判定を使う
- temp / CTE / UNION / WITH / サブクエリ / WINDOW内のORDER BYを横断して判定する
- `VALIDATE ONLY` とDMLが既に完全入力を要求して `truncate` を `error` へ上書きする前例に倣う

REST top-N allowlistで**ORDER BYキーだけでなくWHERE全体と最終窓の完全同値**を証明した計画は、サーバがcanonical順の正しい窓を返すため、候補全件取得を必要としない。ただしWHEREのローカル再評価が残る場合や、実行計画がallowlist top-Nであることをplannerが確定できない段階では、楽観的に`truncate`を許可しない。

別構文`KORDER BY`案は、生REST順・明示LIMIT・単発GETを選ぶB31の言語機能であり、本課題の通常`ORDER BY` local sortとは分けて扱う。B31でも`LIMIT > maxRecords`を`truncate`で縮めずplanning errorとする。

初期実装は単純さと安全性を優先し、**SQL ASTにORDER BYが存在するSELECTでは一律に取得上限到達をerror**とする。将来、REST top-N計画だけ例外化する場合は、計画確定後の明示的な分岐と回帰試験を追加する。

## 5. エラーと説明

既存の `FetchAllLimitError` を利用できるが、ORDER BYの完全性が理由であることを利用者へ示す。

例:

```text
FetchAllLimitError: ORDER BYの正しい結果には完全な候補集合が必要です。
取得件数が上限（100件）を超えたため、onLimit=truncateは使用できません。
WHEREで候補を絞るか、maxRecordsを引き上げてください。
```

CLI/MCPの入力説明には「local ORDER BYは完全入力が必要」と明記する。サーフェスが文面だけで一律に上書きせず、plannerがREST top-N / `KORDER_NATIVE`とlocal sortを区別する。local sortで単に「100件で打ち切って表示」と警告して成功させない。

## 6. 実装面

- batch解析の `requiresCompleteInput` を、ORDER BYを含むread-only SELECTへ拡張するか、ORDER BY専用の完全性フラグを追加する
- 単文SELECT、WITH、UNION、temp参照、保存クエリで同じ解析結果を利用する
- EXPLAINに「ORDER BY requires complete input / truncate disabled」を表示する
- MCP schema `.describe()`、CLIヘルプ、プラグイン設定説明、公開リファレンスを同期する
- query planがREST top-N allowlistかlocal sortかを持つようになった後、例外化の必要性を再評価する

## 7. 受入条件

### fail-closed

- FULL_SCAN + ORDER BY + `maxRecords`超過 + `truncate` が `FetchAllLimitError`
- temp / CTE / WITH / UNIONの最終ORDER BYでも同じ
- WINDOW用ORDER BYとトップレベルORDER BYの完全入力要否を区別し、部分partitionを完全結果として返さない
- `LIMIT 1`でも候補集合の完全性要件を緩めない
- ASC / DESC、単一キー / 複数キーで同じ

### 非回帰

- ORDER BYなしの通常read-only SELECTは、既存契約どおり `truncate` を利用できる
- VALIDATE ONLY、SELECT-based DML、temp実体化の既存 `error` 固定を維持する
- REST top-N allowlistを例外化する場合、初期allowlistの`$id`について正しい窓を試験する。`RECORD_NUMBER`を含むallowlist外キー、またはWHEREにローカル再評価が残るqueryは、必ずerror/local完全取得へ落ちる
- 警告だけ出して誤ったtop-Nを返す経路がCLI / MCP / プラグインに残らない

## 8. SemVer

明示的に `truncate` を選んだ成功クエリがエラーへ変わるため、互換性影響はある。一方、完全集合に対して誤ったtop-Nを返す正当性バグであり、従来成功を維持しない。

リリース判断は **v3.0.0へ統合**で確定した。B30だけのv2.18.0は出さず、B26 / B27 / B31 / B32と同じmajor移行で告知する。実装コミットと回帰試験はB30を先行させてよいが、公開リリースは分けない。
