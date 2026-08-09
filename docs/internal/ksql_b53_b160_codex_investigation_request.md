# B53＋B160 事前調査依頼（codex）——実装着手前の静的読解調査

**目的**: B53（`WITH RECURSIVE`/`CYCLE`・[Phase1 仕様 R2](ksql_b53_recursive_cte_cycle_phase1_spec.md)）を
B160（[全順序警告の免除文言](ksql_b160_window_warning_generated_column_issue.md)）同梱で進める判断のため、
**仕様 R2（2026-07-23 凍結）の前提が v3.65.0 の実装とどれだけずれたか**を事実確認する。
実装方針の提案は不要。**事実（現行コードがどうなっているか）と、仕様の記述と食い違う点の列挙**が成果物。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（`main`・v3.65.0）

前提資料（すべて読むこと）:
- [B53 Phase1 仕様 R2](ksql_b53_recursive_cte_cycle_phase1_spec.md)（§7.3 ソフトキーワード・§4 戦略 B・§5.2 設定配管が主な検証対象）
- [B53 評価](ksql_b53_recursive_cte_cycle_evaluation.md)
- [B160 起票](ksql_b160_window_warning_generated_column_issue.md)
- [B140 起票](ksql_b140_cte_groupby_total_order_issue.md)（免除文言の導入元）
- [B149 起票](ksql_b149_generate_series_issue.md)（v3.59.0 の生成列免除）

## 0. 禁止事項

**調査は静的読解のみ。** コード変更・ファイル書き込み・`git` 操作・kSQL MCP・ビルド・テスト実行
（read-only sandbox では jest が EPERM で起動できない。実行を試みない）をすべて禁止。
報告は最終メッセージのみで完結させる。

## 1. 調査項目

### A. パーサ・lexer 前提の検証（仕様 §7.3）

1. `SET` のトークン状態の現状（仕様は `src/lexer/tokens.ts:47` のハードトークンを前提。行位置と扱いは今もそうか）
2. `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` の現状＝トークンとして存在するか、識別子として通るか。
   **`DEFAULT` と `TO` が現行文法で既に使われる文脈があれば全数列挙**（GENERATE_SERIES・CHECK・UPSERT 等）
3. v3.63.0 の `CROSS` 予約語化はどう実装されたか（ハード予約か文脈判定か・該当 file:line）。
   仕様 §7.3 の「文脈限定ソフトキーワード」方式と現行の流儀のどちらが近いか＝**事実として両方式の現行実例**を挙げる
4. 仕様 §7.3 の 4 段階の文脈限定手順（右括弧直後の `CYCLE` 認識等）を現行 parser 構造
   （WITH/CTE パースの実装）に重ねたとき、**構造上成立しない箇所があるか**

### B. CTE 実行経路（仕様 §4 戦略 B の接続点）

1. `WITH` 実行の現行フロー＝入口→CTE 実体化→JOIN/外側評価の主要関数と file:line
   （`executeQueryWithCte` 相当の現在形。GENERATE_SERIES 文 CTE が入った後の形）
2. B155（v3.62.0）で統一された共有 leaf policy のモジュールの場所と、
   **CTE/一時テーブル実体化の取得時に行フィルタ押し下げを制御している点**。
   仕様 §4.2 の「再帰では行フィルタ押し下げ原則不可・列射影の最小化のみ」を実装する場合に
   触ることになる箇所の列挙（変更方針の提案は不要・箇所の特定まで）
3. B14 の `MaterializedColumnMeta` 相当の現在の型名・伝播点。仕様 §3.4 の
   「seed/再帰項の型整合を planning で検査」に使える情報がどの段階で揃うか
4. `UNION ALL` の射影対応（仕様 §4.4 が再利用を前提とする資産）の現在の実装点

### C. 設定配管（仕様 §5.2）

1. `ExecuteOptions` / `BatchExecuteOptions` の現在形（file:line）
2. **直近リリースで追加されたオプションの配管実例を 1 つ選び**（例: B158/B159 のガード値、なければ `maxRecords`）、
   env → profile → CLI → MCP → plugin の各面で触っているファイルと行を**全数列挙**する
   （仕様 §5.2 の 3 値×5 面の配管コストを実数で見積もる材料）
3. プラグインの実行オプション UI と localStorage 保存の現行実装（file:line）

### D. dry-run／VALIDATE ONLY／EXPLAIN 経路

1. B157・B161（v3.63.0）で修正された dry-run 表示経路の現在形＝
   **新しい WITH 形（WITH RECURSIVE）が追加されたとき通ることになる経路の全数列挙**
2. EXPLAIN の WITH/CTE 出力を生成している箇所（仕様 §9.1 の表示追加点）
3. プラグイン `prod/js/desktop.js` へバンドルされるソースの範囲＝EXPLAIN・エンジン文言の変更が
   プラグイン再ビルドを要するかを判定できる事実（バンドル対象の入口ファイル）

### E. B160＝全順序警告の生成点と免除の実装

1. 全順序警告（既定 RANGE フレーム）の生成関数の場所（`collectDefaultRangeWindowWarnings` 相当の現在形）と、
   B140 免除文言（「元の集約のキーをすべて ORDER BY に含めているなら〜」）の文字列がある file:line
2. **警告文言を逐語で固定しているテストの全数**（文言変更＝案 A の直接コスト）
3. v3.59.0 の生成列免除の判定条件＝コード上の「生成列を直接読む」の定義（file:line）。
   その判定点で **JOIN 由来か・パーティション内一意か**の情報が見えるか＝**見える情報の列挙**
   （B160 案 B の実現可能性の材料。可否の判断は不要・情報の有無まで）
4. 実体化 CTE（一時テーブル・通常 CTE）越しのウィンドウが同じ警告経路を通ることの確認
   （B53 の再帰 CTE 出力にも同じ警告が付くという前提の裏取り）

### F. ガード前例・文書同期の対象

1. B158（CROSS JOIN 出力 10,000 ガード）・B159（GENERATE_SERIES 上限 10,000）の実装点＝
   検出位置・エラーコード/文言の命名（仕様 §5.1 の 3 境界のエラーコード流儀を合わせる材料）
2. 「再帰 CTE は非対応」相当の記述の**全数**＝docs（言語リファレンス 2485 行・3559 行は把握済み。他にあるか）
   ＋ `src/` 内（MCP サーバー instructions・文型テンプレート・カタログ・エラー文言）
3. 既存 docs パリティテスト（`b136DocsColumnParity` / `b141EmptyAggregateDocsParity`）の照合対象の構造＝
   仕様 §5.1 の境界既定値表（depth=100 等）を将来照合する場合にどちらの形式に乗るか（事実のみ）

## 2. 報告形式

[B164 調査報告](ksql_b164_codex_investigation_report.md)と同形式:

- 冒頭に「調査は静的読解のみ・変更なし」の宣言と**結論の要約**
- 項目 A〜F ごとに、事実を file:line 付きで列挙
- **仕様 R2 の記述と現行実装が食い違う点を独立の節にまとめる**（仕様側の修正候補リストになる）
- 仕様 §11 の見積り（18〜29 人日）を**増減させる事実**があれば、該当項目を指して明記
  （見積りのやり直しは不要）
- 判断・提案・実装方針は書かない（それはオーナーと Claude 側の工程)
