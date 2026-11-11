# B214 JOIN の相手の物理 APP が 0 件だと、ON を「相手の列 = こちらの列」の順に書いた形が「JOIN key … is not available」で止まる（B166 の取りこぼし）

- 起票: 2026-11-11（**kSQL アクションの依頼 KJ-12**。受注の CSV 取り込みの事例を代役で流して見つかった）
- ステータス: 🚧 **実装済み（枝 `b214-join-on-empty-physical` の PR・リリース待ち）・Codex レビュー 2 回の指摘を反映済み**（2026-11-11。2 回目は B214 に指摘なし）。
  **B215 と同じ版（v3.96.0）で出す**（2026-11-11 Takashi「1」）
- 種別: バグ（正しさ・fail-closed 側＝誤った結果ではなくエラーで止まる。ただし**データの件数だけで止まる**）
- 関連: [B166](ksql_b166_join_on_orientation_issue.md)（ON の向きの正規化・この直しの元）／[B215](ksql_b215_join_key_prefilter_null_extended_issue.md)（同じ版。外部結合の後の結合キーの絞り込み）／B51（JOIN キーの欠落の検査）／B86（項目コードの取得前の検査）／B150（結合キーで JOIN 先を絞る）
- 依頼と回答: `kintone-plugin/work-link/kSQLエンジンへの依頼-20261111-KJ12-JOINのONの順と0件の相手.md`・同じ日付の `kSQLエンジンからの回答-…`。
  Codex レビュー: `kintone-plugin/work-link/codex-review-ksql-kj12-2026-11-11.md`（末尾にこちらの確かめ）

## 1. 実測（v3.95.0・模擬の client）

ON を「JOIN 先（右）の列 = FROM 側（左）の列」の順に書くと、**片方の物理 APP の行が 0 件**のときに
`ArgumentError: JOIN key o.明細キー is not available in the materialized table.` で止まる。左の列を先に書けば止まらない。

| 形 | 止まる条件（右が先の ON） |
|---|---|
| `INNER JOIN 物理APP` | 右の取得が 0 件（右が空・結合キーの `in (...)` で 1 件も当たらない・左が 0 件で右を読まない） |
| `LEFT JOIN 物理APP` | 右が空／左（物理 APP・CTE）が 0 件で右に行がある |
| `RIGHT JOIN 物理APP` | 右が空／左が 0 件で右に行がある |

左が物理 APP・一時テーブル・CTE のどれでも同じ。右が一時テーブル・CTE なら止まらない（列の一覧を持つため）。
文としての SELECT のほか、`CREATE TEMP TABLE … AS SELECT` の元・`ASSERT` / `EXIT` のサブクエリ・`IN (SELECT …)`・
`INSERT` / `UPSERT … SELECT` の元・CTE の本体も同じ口（`runFullScan` → `applyJoin`）を通るので同じ。

**さらに、ON の順に関わらず止まる形**:

```sql
SELECT t.キー, o.明細キー, p.値 FROM APP1 AS t
LEFT JOIN APP2 AS o ON t.キー = o.明細キー     -- APP2 が 0 件
LEFT JOIN APP3 AS p ON o.明細キー = p.コード;  -- 次の ON が 0 件の APP2 を指す → JOIN key o.明細キー で止まる
```

`RIGHT JOIN` の後ろの ON が 0 件の FROM の表を指す形（`FROM APP1(0 件) RIGHT JOIN APP2 … LEFT JOIN APP3 ON t.キー = …`）も同じ。
真ん中が一時テーブルなら止まらず、真ん中の APP2 に「当たらない行」があるときも止まらない（空文字で続く）。

## 2. 原因

[`applyJoin`](../../src/engine/process.ts) の B166 の正規化（`normalizeJoinConditionSides`）は、ON の各辺が左右どちらの表かを
**列の一覧**で決める。列の一覧は、実体化した表（一時テーブル・CTE）なら保存済みの `columns`、
**物理 APP なら取った行のキー**（`Object.keys(rows[0])`）から作る。物理 APP の行が 0 件だと一覧が空になり、
その別名がどちらの表か分からず（`UNKNOWN`）、入れ替えないまま左の行で右の列を探して `assertJoinKeyAvailable` が止める。

3 表の形は同じ根: LEFT JOIN で 0 件の物理 APP を足すと、空の右の雛形（`emptyRight`）も行のキーから作るので空になり、
積み上げた行に `o.明細キー` のキーが無い。次の JOIN の `assertJoinKeyAvailable` が「行にキーが無い」で止める。

**B166 の回帰試験が見逃した理由**: 代役の `getRecords` が `in (...)` を無視して全件を返していたので、
「絞って読んだら 0 件」の形が試験に出なかった（直した本体が行のキーに頼っていることを試験が守れなかった）。

## 3. 直し方（実装済み）

1. **左右の帰属を SQL の別名で先に決める**: `runFullScan` が JOIN ごとに「左 = FROM と先行 JOIN の別名」
   「右 = この JOIN の別名」を `applyJoin` に渡し（`sideAliases`）、`normalizeJoinConditionSides` は別名が
   どちらか一方にだけあるならそれで決める。別名の無い参照などは今までどおり列の一覧で決める。
2. **行が 0 件の物理 APP は、項目定義で在ると確かめた列だけ、JOIN キーを行で検査しない**（`rowlessVerifiedFields`）。
   呼び出し側（`execute.ts` の `loadRowlessPhysicalJoinFields`。`runFullScan` を呼ぶ 2 か所）が、取得 0 件の物理 APP
   （サブテーブルの仮想表を除く）について項目定義のコードと `$id` / `$revision` の集合を渡す。項目定義は B86 の検査で
   読み込み済みのことが多い（キャッシュ）。**項目定義が空なら渡さない＝従来どおり行で検査して止める**。
   集合に無い列（`$typo` のような名前を含む）も従来どおり検査する。実体化した表は保存済みの列で今までどおり検査する。
   積み上げた行にキーが無いときの値は `?? ""`＝空文字（相手の行に「当たらない」ときと同じ）。

**B214 だけでは、今まで通っていた SQL の結果は変わらない**: 行がある表では、別名による帰属と行のキーによる帰属が一致する
（Codex レビューでも反例なし）。変わるのは「止まっていた形」だけで、左の列を先に書いた形と同じ結果を返す。
ただし、止まっていた形の一部は、直すと [B215](ksql_b215_join_key_prefilter_null_extended_issue.md)（v3.95.0 からある
結合キーの絞り込みの誤り）にそのまま当たって黙って誤る（Codex レビューの BLOCKER）ので、**B215 と同じ版で出す**。

## 4. 受入条件

1. 逆順 ON が順方向と同じ行・列を返す: 物理→物理／一時テーブル→物理／CTE→物理 × INNER/LEFT/RIGHT ×
   左（あり・0 件）× 右（空・当たらない・当たる）の 54 通り。
2. 3 表の連鎖で真ん中の物理 APP が 0 件のとき、真ん中に「当たらない行」があるときと同じ結果（ON の順の両方。
   3 つ目に空のキーの行があるときも＝空文字どうしで当たる）。
3. `CREATE TEMP TABLE` の元・`ASSERT` のサブクエリ・`IN (SELECT …)`・`INSERT … SELECT` の元で止まらない。
4. B214 が行の検査を飛ばすのは項目定義にある列だけ（物理 APP の存在しない列は取得前に `unknown field code(s)`、実体化した表は
   `JOIN key … is not available`、0 件の表を次の ON が指すときの `o.$typo` と、項目定義が取れない表は `JOIN key … is not available`）。
   ただし `$` / `_` で始まる名前が取得前の検査から外れる穴と、0 件の表を左の列が先の ON で指す形が止まらないのは v3.95.0 から（§5）。
5. B166・B51・B86・B150・B153・B155・B53 の既存の試験が変わらない。

試験: `src/__tests__/b214JoinOnRowlessPhysical.test.ts`（81 件。B215 の 11 件を含む）。代役は本物に寄せた
（`in (...)` で絞る・`fields` で列を絞る・limit / offset で切る・読んだ問い合わせを記録する・項目定義を空にできる）。
**直す前の本体では 45 件が落ちる**（型の検査を外して流して確かめた）。
全体: 336 スイート中 8 スイート 45 件が落ちるが、Mac の環境の差（CLI の e2e と MCP の tools）で main と同じ件数。

## 5. 範囲外（別件）

- `$` / `_` で始まる存在しない名前（`o.$typo`）は、B86 が項目定義の検査から外している（v3.95.0 から）。
  0 件の表を左の列が先の ON で指すと、v3.95.0 から止まらずに 0 行／空文字で続く。B214 で増えるのは「右の列が先」の形だけで、
  同じ扱いになる。B86 で親 APP は `$id` / `$revision`、サブテーブルの仮想表は `_pid` など、表の種類ごとの正確な一覧で
  検査すれば塞げる（起票するかは判断待ち）。
- サブテーブルの仮想表（`subtableCode`）が 0 件のときは、今までどおり行で検査する（右の列が先なら止まる）。
- `SELECT *` の JOIN で相手が 0 件のとき、相手の列が結果に出ない（列の数がデータで変わる）。今までどおり。
- 別名なしの ON（`ON キー = 明細キー`）はデータに関係なく `unknown field code(s)` で止まる（言語仕様は別名の修飾を求めている）。今までどおり。
- `SELECT t.キー, o.*`（別名つきのワイルドカード）が、拒否されずに「`*`」という空の列を返す。今回は触らない（B216 の候補・判断待ち）。
