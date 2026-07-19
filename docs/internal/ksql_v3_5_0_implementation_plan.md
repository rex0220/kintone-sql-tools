# v3.5.0 実装計画（B41 ＋ B3 ＋ B10 Part B）

- 作成日: 2026-07-19
- 対象版: **v3.5.0**（現行 3.4.0・[package.json:3](../../package.json#L3)・[manifest.json:3](../../prod/manifest.json#L3)）
- SemVer: **minor**（いずれも純加法・既存構文/意味の破壊なし）
- 分担: **Codex=実装/テスト・Claude=レビュー（コード裏取り必須）**・実機検証は dev 環境（devenxyfi・APP4221/APP4148）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B41 / B3 / B10

## 1. スコープ

v3.5.0 に 3 機能を束ねる（2 実装ユニット）。

| 機能 | 内容 | 仕様 | 状態 |
|---|---|---|---|
| **B3 ＋ B10-B** | バッチ変数の参照拡張＝配列変数＋`IN @list`（B3）／SELECT 列 `@var`（B10-B） | [参照拡張 統合仕様 R2](ksql_batch_variable_reference_extension_spec.md) | Claude レビュー承認・実装可 |
| **B41** | `VALIDATE` 文＝既存レコードの制約チェック（read-only 監査） | [VALIDATE 文 仕様 R4](ksql_existing_record_validation_spec.md) | codex 4 次レビュー通過・実装可 |

- B3 と B10-B は**同一実装ユニット**（共有基盤を 1 回作る）。B41 は**独立**（新文・読み取り経路）。
- 対象外（v2/後続）: B41 のサブテーブル監査・フル WHERE・専用 result 型／B3 の数値配列・サブクエリ配列代入／B10 Part A（NULL 変数＝クローズ済）。

## 2. 実装フェーズと順序

2 ユニットは触るコード領域がほぼ重ならない（バッチ変数 vs 新文）ため、**独立ブランチで並行可**。レビュー容易性から各ユニット内は下記順で逐次に進める。

### Phase 1: バッチ変数の参照拡張（B3 ＋ B10-B）
統合仕様 §10 の順（共有基盤 → B10-B → B3 → 公開面）。
1. **共有基盤**: `VARIABLE_COL`/`VARIABLE_IN_LIST`/`BOOLEAN` AST・parser 分岐（**§3.2 の CONCAT_OP 検出より後**＝`@x||field` 退行防止）・visitor 群（collect/find/resolve）・静的 array/scalar 検査・exhaustive switch。
2. **B10-B**: `VARIABLE_COL` → 既存 `LITERAL_COL`/`ARITH_COL` 解決（型メタ保持）・`AS` 必須・SIMPLE/FULL_SCAN・UNION/GROUP/DISTINCT・0 行スキーマ。
3. **B3 基本**: array `VarValue`・`VARIABLE_IN_LIST`・非空展開（リテラル IN と同一 AST）・型二重検査。
4. **空配列 / DML 安全**（最重要）: `BOOLEAN`・親 aware 固定点簡約・更新系 root TRUE 拒否・`x AND NOT IN @empty → x` 許可。
5. **EXPLAIN / 全条件位置**: 配列 SET の EXPLAIN 実値評価・HAVING/CASE/CHECK/サブクエリ。
6. **公開面 / 回帰**。

### Phase 2: B41 `VALIDATE` 文
仕様 §6/§10/§12/§13 の確定に沿う。
1. **パーサ / AST**: 先頭 `VALIDATE <app>` 文（`VALIDATE ONLY` サフィックスと分離）・`ValidateStatement`。
2. **read-only 配管**: `isReadOnlyType` 追加・非 `isDmlType`・`writesKintone=false`・**onLimit=error を executor＋全 surface で強制**・単文/バッチ dispatch。
3. **取得**: 内部行契約 `{id, record, flat}`・VALIDATE 専用 collector（制約∪全 NUMBER∪WHERE∪CHECK∪$id）・`fetchAll`（offset＋$id keyset）＋prefilter（§13.3）＋local `evalWhere` 再評価。
4. **検証**: 組み込み＝生値 `validateAndNormalizeDmlValue`／CHECK＝flat `evaluateCustomChecks`／`$err_value`＝B41 レンダラ（空→`""`・非空→`renderValidationValue(normalizeRaw)`）。
5. **出力**: `INTO #err` 実体化（固定 5 列＋列メタ・B12 validateOnly 分岐を範）・単文 INTO 拒否・通常出力＝`SelectResult`。
6. **WHERE 制約**: KLIKE/サブクエリ/**修飾参照**を静的拒否。
7. **EXPLAIN 専用 plan builder**（SELECT fallthrough 回避・form def/number precision 表示）。
8. **公開面 / 回帰**。

各機能ユニットは 1 つ以上の feature ブランチ → codex 実装＋テスト → Claude レビュー → 実機 smoke → main へ。両ユニット完了後に release 化（§6）。

## 3. 工数見積り

| ユニット | 目安 |
|---|---:|
| Phase 1（B3＋B10-B・統合） | 5.2〜8.2 人日 |
| Phase 2（B41・保守 v1） | 4.5〜8.5 人日（計画上 6〜8.5 寄り） |
| **合計** | **約 10〜17 人日** |

## 4. 主要リスクと対策

- **B3: `BOOLEAN` を全 WhereExpr consumer へ漏れなく配線**（統合仕様が挙げた最大リスク）→ exhaustive switch を compile＋手組み AST テストで固定。root/局所境界（whereToKintone は内部エラー・evalWhere は値返し）を受入で固定。
- **B3: `@x || field` 退行**（§3.2 の分岐順）→ `SELECT @x || 'Y' AS c`（SCALAR_VALUE_COL 維持）と `SELECT @x AS c`（新 VARIABLE_COL）の非回帰テスト必須。
- **B41: 配線点が多い**（read-only 分類・onLimit 2 段・EXPLAIN 専用 builder・#err 実体化）→ 各 dispatch/surface に VALIDATE を通すテスト。**書込み API 0 回**を受入で固定。
- **B41: 修飾参照/サブクエリ/KLIKE の静的拒否漏れ**→ 各拒否の parse/analyze テスト。
- **実機 APP4221 は全レコードが既存 minLength 違反**で PUT 不可 → B41 は read-only なので影響なし・B3 の書込み検証は `VALIDATE ONLY`／`INSERT`＋`DELETE`（過去の検証パターン）で行う。

## 5. テスト・検証

- **単体**: 各仕様の受入条件（統合仕様 §9・B41 §7/§10.8/§12.11/§13.6）。
- **実機 smoke（dev・read-only 中心）**:
  - B41: `VALIDATE APP4221` で既存の文字列MIN/MINMAX 違反・選択肢/必須（USER/ORG/GROUP 空）を検出・`INTO #err`＋`SELECT FROM #err`・`EXPLAIN VALIDATE`・書込み API 0。
  - B3: `SET @l=['X','Y']; SELECT $id FROM APP4221 WHERE チェックボックス IN @l`（実機で `in ("X","Y")`）・空配列 `SET @e=[]; … IN @e`=0 件（`in ()` を送らない）・`NOT IN @e`=全件・親 DML `NOT IN @e` はエラー。
  - B10-B: `SET @b=NOW(); SELECT @b AS バッチID, $id FROM APP4221`・数値変数の型保持・`@x||field` 非回帰。
- **plugin browser smoke**: 最新プラグインを build して Chromium/Firefox で B3/B10-B/B41 の代表 SQL。
- **全面回帰**: `npm test` green（現行 1,3xx テスト）＋既存 batch-variable/IN/選択系/空 SELECT/DML WHERE 必須の非回帰。

## 6. リリース手順（v3.5.0）

両ユニットが main にマージ済みの前提で release 化（[release-procedure] 準拠）。

1. **版数更新（すべて 3.5.0 へ）**: `package.json` / `package-lock.json`（先頭 2 箇所）/ `prod/manifest.json`（**build 前**）/ `release/VERSION.txt` / `release/README.txt`（先頭エントリ＋`ksql-plugin-v3.5.0.zip` 参照）/ `CHANGELOG.md`（B41・B3・B10-B の 3 エントリ・互換性=破壊なし minor・実機証跡）。
2. `npm test` → `npm run build`（**desktop.js 必須**）→ 成果物を `release/` へ copy（`ksql-plugin-v3.5.0.zip`・`ksql-app-template` は変更なければ据え置き）。
3. 版数検証（表示版数と成果物の一致）。
4. commit（**`.claude/settings.local.json` 除外**）→ PR → merge。
5. tag `v3.5.0` → GitHub Release（アセット3点）。
6. **npm publish（ユーザー操作）**。
7. memory（MEMORY.md／issue-tracker-doc）と台帳のリリース履歴を同期。

## 7. 判断ポイント（着手前に確認）

- **束ね方**: 本計画は指示どおり 3 機能を **1 つの v3.5.0** に束ねる。分割したい場合は B3+B10-B=v3.5.0／B41=v3.6.0 等に変更可（両ユニット独立のため容易）。
- **順序**: Phase 1／2 は独立。並行実装するか逐次かは実装リソース次第（本計画は並行可・各ユニット内は逐次）。
- **CHANGELOG 互換性注意**: いずれも additive。B41 は read-only 新文・B3/B10-B は従来 ParseError だった位置の受理拡大で、既存クエリの挙動は不変。

## 8. 着手条件（確定済み）

- B41: 仕様 R4・実装着手可（§13）。B3+B10-B: 統合仕様 R2・Claude 承認（§14）。
- 実装は feature ブランチ・codex 実装＋テスト → Claude レビュー（コード裏取り）→ 実機 smoke → merge。
- release は両ユニット完了後に §6 で一括。
