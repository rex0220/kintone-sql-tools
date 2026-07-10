# ksql_mutate: dmlMaxRows が SELECT-based DML のソース読み取りを絞ってしまう問題

作成日: 2026-07-10
ステータス: **実装済み(2026-07-10。案A + 案C 補助を v1.8.0 向けに適用)**。
変更内容のサマリは `docs/ksql_mcp_changes.md` §11.10、仕様は
`docs/ksql_mcp_server_spec.md` §7.6 / §12.4 を参照。本書は経緯・判断記録として保持する。

## 現象

以下のバッチを kSQL MCP(`ksql_mutate`)で実行すると、2文目の UPSERT が
読み取り上限エラーで失敗する。

```sql
CREATE TEMP TABLE #targets AS
  SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN ('A') LIMIT 2;

UPSERT INTO APP4149 (案件名, 顧客No_)
SELECT b.会社名, t.顧客No
FROM #targets t INNER JOIN APP4148 b ON t.顧客No = b.顧客No
ON DUPLICATE (顧客No_)
```

- MCP クライアント(AI)は「影響行数は 2 件」と判断して `dmlMaxRows: 2` で呼び出す
- UPSERT のソース SELECT が APP4148(全 209 件)を読もうとした時点で
  読み取り上限(3 件)を超過し、`onLimit: "error"` により失敗する

一見「1文目の `LIMIT 2` が次の SELECT に効いている」ように見えるが、
`LIMIT` 自体は文をまたいで伝播していない。伝播しているのは
**ツール引数 `dmlMaxRows` を流用したバッチ共通の読み取り上限**である。

## 原因

### 因果チェーン

1. `ksql_mutate` の `mutateBatch`(`src/mcp/tools.ts` 付近、`createRuntime` 呼び出し)で
   runtime が `maxRecords: dmlMaxRows + 1` として作られる。
   単文パス(`mutate`)にも同一のロジックがある。
2. この `maxRecords` は**文ごとではなくバッチ内のすべてのレコード取得に共通**で、
   `onLimit` は `DEFAULT_ON_LIMIT = "error"` 固定。
3. 2文目の UPSERT は `executeUpsertSelect`(`src/execute.ts`)で最初にソース SELECT を
   実行するが、一時テーブルとの JOIN は FULL_SCAN のため APP4148 を全件読む必要がある。
   読み取りが `dmlMaxRows + 1 = 3` 件を超えた時点でエラーになる。

1文目が成功するのは、`LIMIT 2` が kintone クエリにプッシュダウンされ
実際の読み取りが 2 件で済むため。

### 設計上のギャップ

- コメント上の設計意図(`src/execute.ts` の batch 検証部、`src/mcp/tools.ts` の
  静的ガード部)では「SELECT-based DML の件数判定は書き込み前の confirm フックが担う」
  とされており、confirm 自体は照合後の insert + update 合計(本例では 2 件)を
  正しく判定できる。
- 一方で `maxRecords = dmlMaxRows + 1` という読み取りスロットルが confirm より
  手前で効くため、**「書き込みは少数だがソース読み取りは大量」という
  SELECT-based DML の形を想定できていない**。
- UPDATE / DELETE では「対象 ID の読み取り件数 ≒ 影響行数」なので `+1` 方式
  (上限超過の検出用に 1 件多く読む)が成立するが、JOIN を含む
  INSERT_SELECT / UPSERT_SELECT ではこの等式が崩れる。
- なお、この読み取りキャップ自体は未文書の挙動ではない。`src/mcp/schemas.ts` の
  `dmlMaxRows` の describe に「For INSERT/UPSERT ... SELECT it also caps
  app-source reads (at most dmlMaxRows + 1 records)」と明記済み。
  **説明済みでもなお AI クライアントは影響行数(2)基準で値を選んでしまった**
  というのが今回の実例であり、説明改善(後述の案C)だけでは再発を防げない。

### 影響範囲

| 経路 | 該当箇所 | 影響 |
| --- | --- | --- |
| バッチ実行 | `src/mcp/tools.ts` `mutateBatch`(`maxRecords: dmlMaxRows + 1`) | あり |
| 単文実行 | `src/mcp/tools.ts` `mutate`(同上) | あり |
| saved query 経由 | `ksql_run_saved_query` → `mutate` に委譲 | あり(同根) |
| CLI | `src/cli/index.ts` | **なし(確認済み)** |

CLI は `maxRecords` を `--max-records` / 環境変数 / プロファイル(既定 500)から解決し、
`--dml-max-rows` は confirm フックの件数ガードにのみ使っている
(`src/cli/index.ts` の maxRecords 解決部と `executeBatch` 呼び出し部)。
つまり読み取り上限と書き込み上限が最初から分離されており、**案Aは CLI の挙動に
MCP を揃える修正**とも言える。修正時に CLI 側を触る必要はない。

影響する文種: INSERT_SELECT / UPSERT_SELECT のうち、ソース SELECT の読み取り件数が
`dmlMaxRows + 1` を超えるもの(JOIN・広い WHERE・LIMIT なしソースなど)。

## 当面の回避策(利用者向け)

`dmlMaxRows` をソース読み取り件数を賄える値(例: 500)にして呼び出す。
confirm は実際の影響行数で判定されるが、**拒否しきい値も同じ値に引き上がる**点に注意。
例えば「2 件のつもり」で 500 を指定した場合、SELECT が想定外に 200 行を返しても
そのまま 200 件書き込まれる。読み取りは通るようになるが、書き込みガードは
その分弱くなるトレードオフであり、あくまで応急処置。

## 対策案

### 案A: SELECT-based DML を含む場合、読み取り上限を dmlMaxRows から分離する(推奨)

- validate 結果に INSERT_SELECT / UPSERT_SELECT が含まれる場合、
  `createRuntime` に `maxRecords: dmlMaxRows + 1` を**渡さない**(undefined のまま)。
  これにより runtime 側の通常解決
  `input.maxRecords ?? KSQL_MAX_RECORDS ?? profile.query.maxRecords ?? 500`
  (`src/node/runtime.ts` `createKsqlRuntime`)に戻る。
  ※「固定 500 を明示的に渡す」実装にすると env / profile による調整を
  バイパスしてしまうため不可。あくまで「上書きをやめる」のが正。
- 書き込み件数ガードは従来どおり confirm フック(`count > dmlMaxRows` で拒否)が担う。
- 注意: 現在の `mutateInputSchema` に `maxRecords` パラメータは**存在しない**
  (`src/mcp/schemas.ts`)。「上書きをやめて runtime 既定に戻す」だけなら
  スキーマ変更なしで成立する(env / profile では調整可能になる)。
  ツール引数として読み取り上限を明示制御させたい場合は `mutateInputSchema` への
  `maxRecords` 追加が必要だが、それは案A の範囲外として別判断とする(案B 参照)。
- UPDATE / DELETE など「対象読み取り件数 ≒ 影響行数」が成立する文種のみの
  バッチは、当面 `dmlMaxRows + 1` のままでよい(現行の +1 検出方式が有効)。
- 長所: dmlMaxRows の意味が「影響行数の上限」に純化される。CLI は既に
  読み取り上限(`--max-records` / env / profile、既定 500)と書き込みガード
  (`--dml-max-rows`)を分離しており、MCP を CLI と同じ解決モデルに揃えることになる。
- 短所: UPDATE / DELETE のみのバッチと SELECT-based DML 混在バッチで
  読み取り上限の決まり方が変わるため、仕様書での明記が必要。
  また schemas.ts の `dmlMaxRows` describe(`mutateInputSchema` /
  `runSavedQueryInputSchema` の両方に「reads も cap する」と記載)の書き換えが必須。

### 案B: ソース読み取り上限用のパラメータを追加する(将来拡張)

- `ksql_mutate` に読み取り上限の任意パラメータを追加し、SELECT-based DML の
  ソース読み取りに適用。未指定時は案Aと同じ runtime 既定にフォールバック。
- 新概念 `dmlSourceMaxRows` を増やすより、**既に他ツールにある `maxRecords` を
  `ksql_mutate` に追加する方が一貫性が高い**。その場合 `ksql_run_saved_query` の
  DML 委譲経路(`mutate()` 呼び出し)への引き回しも併せて行う。
- 長所: 読み取り側も明示的に制御したい利用者に対応できる。
- 短所: MCP クライアントに追加の数値判断を要求する。今回の問題の本質が
  「AI が説明を読んでも dmlMaxRows を影響行数基準で選んだ」ことである以上、
  新しい数値パラメータは同種の選択ミスを再生産しうる。初手には重い。

### 案C: 現状維持 + ツール説明とエラーメッセージの改善のみ

- 上限超過エラーに「SELECT-based DML ではソース読み取りも dmlMaxRows + 1 で
  キャップされる。JOIN 等を含む場合は読み取り件数を賄える値を指定すること」
  というヒントを含める。
- 注意: 読み取り上限エラーは通常 SELECT でも発生する汎用エラーのため、
  fetch 層の共通メッセージに一律追記すると通常 SELECT に無関係なヒントが出る。
  **`ksql_mutate` の実行コンテキスト側(または SELECT-based DML と判定できる箇所)で
  補足を付与する**実装にする。
- 長所: 実装変更が最小。
- 短所: 根本解決にならない。ツール説明側は**既に記載済み**
  (schemas.ts の `dmlMaxRows` describe)にもかかわらず今回の誤設定が起きており、
  説明改善だけでは再発を防げないことが実証されている。

### saved query 経路の補足

- `ksql_run_saved_query` の DML 経路は `mutate()` に委譲されるため、
  案Aは `mutate()` 側の修正で同根解決できる。
- ただし `runSavedQueryInputSchema` には `maxRecords` / `onLimit` が**存在する**のに、
  DML saved query では現在どちらも `mutate()` に渡していない(`MutateInput` に
  該当パラメータがなく、DML 経路の `onLimit` は `DEFAULT_ON_LIMIT`("error")固定)。
  案Aを「runtime 既定へ戻す」だけに留めるなら必須修正ではないが、仕様書に
  「DML saved query の `maxRecords` / `onLimit` は現状 read-only 実行時のみ有効」と
  セットで明記する。将来 `ksql_mutate` に `maxRecords` を追加する(案B)なら、
  DML saved query でも引き回す。

### 推奨(最終仕様)

**案A を本体対応とし、案C のエラーメッセージ改善を補助として併せて行う。**

- SELECT-based DML を含む `ksql_mutate` は、読み取り上限に `dmlMaxRows + 1` を使わない。
- 読み取り上限は runtime の通常 `maxRecords` 解決
  (env `KSQL_MAX_RECORDS` → profile `query.maxRecords` → 500)に戻す。
- `dmlMaxRows` は影響行数ガード(confirm フック)専用にする。
- UPDATE / DELETE など対象読み取りと影響行数が近い文種のみの場合は、
  当面 `dmlMaxRows + 1` のままでよい。
- エラーメッセージは補助として改善するが、主対策にはしない。

confirm フックによる影響行数ガードはそのまま残るため、**書き込みの安全性は
下がらない**。一方で読み取り上限は広がる(3 件 → 既定 500 件)ので、
読み取り量・実行コストに対する安全弁としては弱くなる点を仕様書に明記する。

## 対応時のチェックリスト(2026-07-10 全項目実施済み)

- [x] `src/mcp/tools.ts`: `mutateBatch` / `mutate` で SELECT-based DML を含む場合は
      `createRuntime` への `maxRecords` 上書きをやめる(undefined → runtime 通常解決)。
      helper `containsSelectBasedDml` / `resolveMutateRuntimeMaxRecords` で単文・バッチ共通化
- [x] `src/mcp/schemas.ts`: `mutateInputSchema` と `runSavedQueryInputSchema` の
      `dmlMaxRows` describe を新挙動(「does NOT limit source reads ...
      runtime maxRecords resolution」)に書き換え。`src/mcp/index.ts` のツール
      description(「caps affected rows only, not source reads」)と
      `scripts/mcp-smoke.mjs` の assertion も同時更新(旧文言での失敗を確認済み)
- [x] 上限超過時のエラーメッセージに SELECT-based DML 向けヒントを追加
      (mutate コンテキスト側で付与。単文 = 例外メッセージ、バッチ = 当該
      INSERT_SELECT / UPSERT_SELECT 文の error.message のみ)。文言は案A採用後の
      新挙動(「読み取り上限は maxRecords 解決値、dmlMaxRows は影響行数ガード」)
- [x] テスト: JOIN ソースで「読み取り > dmlMaxRows・影響行数 ≦ dmlMaxRows」の成功
      (単文・バッチ混在ソースとも)/影響行数超過の confirm 拒否維持/
      UPDATE / INSERT VALUES のみのバッチは `dmlMaxRows + 1` 維持/
      runtime maxRecords(既定 500)超過時のヒント付与(単文・バッチ)/
      照合読み取り低選択性ケースの成功化。jest 620 件パス・tsc 既存10件のみ・
      mcp:verify ok
- [x] `docs/ksql_mcp_server_spec.md`: §7.6(読み取り上限の分離と経緯)・§7.6.1〜7.6.2・
      §7.7(DML saved query の maxRecords / onLimit は read-only 実行時のみ有効)・
      §12.4(DML の読み取り上限の分岐)を更新
- [x] `docs/ksql_language_reference.md` §25(複文): SELECT-based DML の読み取り上限を
      新仕様に更新
- [x] (追加)`docs/ksql_batch_temp_table_spec.md` §7.3・`docs/ksql_mcp_changes.md`
      §11.10(v1.8.0 変更履歴)を更新
