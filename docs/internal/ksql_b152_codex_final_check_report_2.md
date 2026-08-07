## 検査報告

### 指摘

1. **Medium — B84 仕様注記が現行実装・公開表と不整合**

   - 箇所: `docs/internal/ksql_b84_pushdown_visibility_spec.md:190-195`
   - 根拠: ユーザー系・作業者系を「全セル✕を維持」と記載しているが、現行分類器と公開表では6型の `IN` / `NOT IN` が `exact`／○。CALC・RECORD_NUMBERの8演算子 `superset` 化も注記されていない。
   - 修正案: 2026-08-07のオーナー判断による撤回注記を追加し、ユーザー系6型、CALC、RECORD_NUMBER、query error表面化を現行契約として明記する。

2. **Medium — B152仕様R1内でSTATUS_ASSIGNEEのprocess gateが相互矛盾**

   - 箇所: `docs/internal/ksql_b152_join_pushdown_phase234_spec_r1.md:192,403-421,563-565,598-614`
   - 根拠: オーナー判断注記は「追加metadataなし・プロセス無効時もkintone errorを表面化」とする一方、後続の規範本文は `getProcessStatuses()` gate必須、無効時は送信禁止・`unsafe` としている。実装は前者に従い、`STATUS_ASSIGNEE`を無条件のnative候補に追加している。
   - 修正案: 旧gate要件を失効扱いと明記するか、該当する規範項目を現行オーナー判断へ置換する。

### 観点別結論

1. **fail-open:** Critical指摘なし。空文字、空・混在リスト、式、field-to-field、型不一致、未解決値は `exact` / `superset` に入らない。ユーザー系scalar比較も開放されていない。
2. **relation:** ユーザー系6型の `IN` / `NOT IN` は `exact`、CALC・RECORD_NUMBERは `superset`。通常WHEREは元のresidualに残り、JOIN後に再評価される。`$id`の既存exact契約も維持。
3. **エラー表面化:** records API例外を全件取得へretryする経路なし。mockのGAIA_IL26表面化テストも存在する。
4. **STATUS_ASSIGNEE:** `NATIVE_OPERATORS`への追加により、単一表でも `IN` / `NOT IN` がREST queryへ送られる。プロセス有効性metadata取得は増えず、無効アプリの拒否もkintone API errorとして表面化する設計。コードは一貫しているが、仕様文書は上記指摘のとおり不整合。
5. **B151/B152回帰:** NUMBER exact・numeric policy、日付canonical policy、TEXT/LINK exact、`$id`、KLIKE、選択系の既存分岐に回帰は確認されない。
6. **B84:** 公開表、凡例、CALC・RECORD_NUMBERのsuperset注記、ユーザー系とquery error注記は実装と一致し、パリティ生成テストも更新済み。内部B84仕様注記のみ不整合。

### Claudeの実測が必要なもの

- プロセス管理無効アプリへ `STATUS_ASSIGNEE IN/NOT IN` を送った際、想定どおりAPI errorが表面化すること。
- CREATOR、MODIFIER、USER_SELECT、ORGANIZATION_SELECT、GROUP_SELECT、STATUS_ASSIGNEEそれぞれの実在codeによる `IN` / `NOT IN` 3経路一致。
- 存在しないユーザー・組織・グループcodeの実エラーコードと、全surfaceでsilent retryされないこと。
- CALCの各表示書式、およびアプリコード付きRECORD_NUMBERの8演算子について、server候補集合がlocal結果のsupersetになること。
- Node、CLI、MCP、Firefox、Chrome、engine libraryのsurface確認。
- 指示の書き込み禁止に従い、今回テストコマンドは実行していない。