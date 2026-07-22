# B57 — 日付集計軸関数（DAYOFWEEK / QUARTER / WEEK ＋ DATE_FORMAT 指定子）

- 起票日: 2026-07-22
- ステータス: 📋 **[仕様 R2](ksql_b57_date_axis_functions_spec.md) 確定・実装着手（2026-07-22・codex 仕様レビュー R1→R2 反映＝妥当日付検証を新3関数で統一・assertArity 明示・不正日付は新指定子のみ個別空置換・%a=kSQL 定義日本語・WEEK=ISO 固定）**。起票時 codex レビュー反映済
- 種別: 改善（日付関数の拡充）
- 効果種別: 機能（業務レポートの集計軸）
- 関連: **B55**（MCP instructions 全量関数カタログ＝追加時の同期必須）／**B56**（統計集約と組で「エンジン側集計」を完結させる）

## 1. 背景・課題

曜日別・週次・四半期のレポートは kintone 業務の定番だが、kSQL の日付抽出は `YEAR` / `MONTH` / `DAY` と `DATE_FORMAT`（対応指定子は `%Y %y %m %c %d %e %H %i %s` の 9 個のみ＝`src/engine/evalFunc.ts` applyDateFormat）に限られ、**曜日・週番号・四半期が表現できない**。結果、生データを取得してクライアント側で軸を計算することになる。

## 2. 追加候補

| 追加 | 内容 | 用途例 |
|---|---|---|
| `DAYOFWEEK(日付)` | 曜日番号 | `GROUP BY DAYOFWEEK(受注日)` |
| `QUARTER(日付)` | 四半期（1〜4） | `GROUP BY YEAR(受注日), QUARTER(受注日)` |
| `WEEK(日付)` | 週番号 | 週次推移の集計 |
| `DATE_FORMAT` 指定子 `%w` / `%a` / `%v` | 曜日番号 / 曜日名 / 週番号の書式化 | ラベル用途 |

## 3. 論点（仕様 R1 で確定すべき点）

1. **`DAYOFWEEK` の起点**: MySQL は 1=日曜〜7=土曜、ISO は 1=月曜。どちらを採るか（MySQL 互換名を使うなら MySQL 定義が無難。ISO を採るなら関数名を変える選択も）。
2. **`WEEK` の週定義**: MySQL の `WEEK` は mode 引数で挙動が変わり複雑。**ISO-8601 週番号（`%v` 相当）単一定義**を既定候補とし、mode 引数は導入しない。年跨ぎ週（12/29〜1/4）の帰属を明記。
3. **ISO week-year（週番号年）**: ISO 週番号の「年」は暦年 `%Y` と一致しない場合がある（例: 2026-01-01 は ISO では 2026-W01 だが、年によっては前年 W53 に属する）→ **`%Y-%v` を年跨ぎラベルに使うと誤る**。R1 で次のいずれかを選ぶ: (a) `%G` 相当の ISO week-year 指定子を同時追加（第一候補）、(b) `%Y-%v` は年跨ぎ週に使えないと明記して見送る。12/29〜1/4 の境界表を受入条件に含める。
4. **指定子の返却形式**: `%w` の値域（0=日曜 か 1=月曜 か＝論点1と連動）・`%a` の表記（`Sun`/`Mon` か `日`/`月` か。kintone 利用者層を踏まえ日本語既定も検討。`DAYNAME` 関数は追加せず指定子のみで賄う）・`%v` のゼロ埋め（`01`〜`53` の 2 桁）・`WEEK()` 関数（数値）と `%v`（ゼロ埋め文字列）の差・未対応指定子は現行どおり素通し維持・`%%` の扱い。境界例付きで規定。
5. **適用型・空値・不正値・引数の規約**: 既存 `YEAR`/`MONTH`/`DAY` は**日付妥当性を検証せず文字列 slice**（`evalFunc.ts:389`・`parseDateParts` も非検証）。新関数を `Date.UTC` で計算すると**不正日付が翌月へ正規化される等、既存と挙動が割れ得る**→不正入力（空セル・10 文字未満・不正月日・うるう日不正）の返り値を既存関数の規約（空文字）に揃えて明文化。適用範囲（DATE/DATETIME/作成・更新日時/文字列リテラル可、TIME 単独は拒否か空文字か）・**各新関数は厳密に 1 引数**・DATETIME は**文字列上の日付をそのまま使う（TZ 変換なし）**＝既存 `YEAR`/`MONTH`/`DAY` と同一規約であることを明記。
6. **予約語追加の影響**: 新規予約語 3 語（`DAYOFWEEK`/`QUARTER`/`WEEK`）。同名フィールドコードはバッククォート必須＝B19 の前例に従い言語リファレンスに注記・CHANGELOG で告知。
7. **四半期の起点**: 暦年固定（1〜3月=Q1）。会計年度オフセットは対象外と明記。

## 4. 実装スケッチ

- スカラー 3 関数は**既存スカラー関数と同じ AST・評価経路（`evalFunc.ts` dispatch）へ追加**。計算本体は `YEAR`/`MONTH`/`DAY` の slice と異なり**`Date.UTC` ベースの新規純関数**（曜日・ISO 週は暦計算が必要）。入口の不正値ガードは §3-5 の規約で既存関数に揃える。
- `DATE_FORMAT` 指定子は `applyDateFormat` の replace チェーン拡張。
- **押し下げ**: 関数 leaf は押し下げず JS 残余評価（`whereCapability.ts:122`・`whereToKintone.ts:165` で拒否）。ただし**同じ WHERE の AND 配下にある他の安全な述語は既存プレフィルタ押し下げの対象になり得る**（`wherePredicatePushdown.ts`）＝既存日付関数と同じ扱い。SELECT / GROUP BY / HAVING / ORDER BY で使用可。

## 5. 同期箇所チェックリスト（追加時必須）

- `src/types/ast.ts`（スカラー関数 union）
- lexer / parser（予約語 3 語・token map・frozen 定数）
- `evalFunc.ts`（スカラー評価＋`applyDateFormat`）
- **数値意味型集合（3 箇所）**: `execute.ts:2961` / `evalWhere.ts:166` / `process.ts:620`（YEAR 等を数値扱いする集合に DAYOFWEEK/QUARTER/WEEK を追加＝比較・ORDER BY の型が変わる）
- 言語リファレンス §日付・日時関数表（`DATE_FORMAT` 指定子表の更新・予約語注記＝B19 前例）
- **B55 MCP instructions 全量関数カタログ**（scalar 43→N。「This list is complete」表明のため更新漏れ厳禁。語数 guard 240–280＝`metadataTools.test.ts:101` の再実測）
- パーサ受理集合の frozen 定数 export＋三者 drift guard（`functionCatalog.test.ts`・`ksqlFunctionCatalogFixtures.ts`）
- `ksql_docs` embed ドキュメント
- mcp-smoke / pack-smoke の instructions 代表語 assertion に新関数を追加（stale bundle 検出のため）
- `CHANGELOG.md`（新規予約語の告知＝B19 前例）・`release/README.txt`
- プラグイン `desktop.js` バンドル再ビルド（prod/plugin 両方）

## 6. 受入条件（スケッチ）

- **SIMPLE 経路**: `SELECT QUARTER(日付), DAYOFWEEK(日付) …` の単純射影（WHERE に関数なし）が正しい値を返す。
- **FULL_SCAN 経路**: `GROUP BY QUARTER(…)` / HAVING / 関数 ORDER BY / 関数 WHERE が正しく動く（**GROUP BY がある SELECT は無条件 FULL_SCAN**＝`selectToKintone.ts:71`。「SIMPLE で GROUP BY」という組み合わせは存在しない）。
- 年跨ぎ週の境界表（12/29〜1/4）・閏年・月末を含む境界日で外部計算と一致。
- 不正入力（空セル・不正月日）が §3-5 の規約どおり（既存 YEAR/MONTH/DAY と同じ側に倒れる）。
- 既存 `DATE_FORMAT` 指定子・日付関数の非回帰。

## 7. 次アクション

- 仕様 R1（§3 論点＝週定義・曜日起点・week-year・返却形式・不正値規約の確定）→ codex レビュー → 実装 → Claude コードレビュー → 実機検証。
