# B167 バッチ EXPLAIN が「物理 FROM ＋ #temp を JOIN target」で app=0 の実 API を呼び CB_VA01 になる

- 起票: 2026-08-10（オーナー報告・実行は正常で EXPLAIN だけ落ちる）
- ステータス: 📋 **修正依頼済み（v3.66.1 候補）**
- 種別: バグ（EXPLAIN/dry-run 面のみ・実行不変）／B162・B163 と同族（「実行は正常なのに EXPLAIN だけ通らない」3 例目）
- 関連: B150（結合キー prefilter 表示の導入元）／B163（temp バッチ EXPLAIN の静的 schema）／B161（metadata 要否）

## 1. 事象（実測 2026-08-10）

```sql
CREATE TEMP TABLE #z AS SELECT 製品名, SUM(個数_在庫計算用) AS 在庫数 FROM APP4228 GROUP BY 製品名;
SELECT SUM(z.在庫数 * m.仕入価格) AS メイン値
FROM APP4229 m INNER JOIN #z z ON m.製品名 = z.製品名
```

- **実行**: 正常（プラグイン実測で正値）。UNION ALL を後置した形も同様。
- **EXPLAIN / CLI `--dry-run` / プラグイン EXPLAIN**: `kintone API error 400 CB_VA01 …「app: 最小でも1以上です。」`
- **v3.65.0 の worktree ビルドでも再現＝既存穴**（v3.66.0 の回帰ではない。B161/B163 と同じ worktree 比較で確定）。
- 単文 `EXPLAIN WITH z AS (...) SELECT ... FROM APP4229 m INNER JOIN z ...` は**落ちない**（`[cte: z]` の静的 plan 経路）＝**バッチ explain（`buildBatchExplainPlans`）経路限定**。

## 2. 原因（mock クライアントの呼び出しログで特定）

呼び出し列: `getFields app=4228` → **`getFields app=0`** → 400。

[`execute.ts:10913`](../../src/execute.ts#L10913)（EXPLAIN の結合キー prefilter 表示・B150）が、
**JOIN の target 側を物理アプリと決め打ちして無条件に `getFieldsCached(join.table.appId)` を呼ぶ**。
`#z` は `{appId: 0, cteName: "#z"}` なので実 API に app=0 が飛ぶ。
**source 側（10923〜10937）には `cteName` 分岐があるのに target 側だけ無い**
（B150 の想定形が「FROM cte JOIN APPn」＝target 物理だったため。逆配置が抜けた）。

## 3. 修正方針

1. **10913 の target 側にも source 側と同じ `cteName` 分岐**を追加＝
   `join.table.cteName !== null` なら `explainRelations` の `columnMeta` から targetMeta を解決
   （静的 relation に列メタが無ければ prefilter 表示は FALLBACK/skip・**実 API は呼ばない**）。
2. **隣の経路も検査**（同じ形が 2 実装に複製されていないか＝B155 の教訓）:
   実行側の類似 fetch [`execute.ts:6502`](../../src/execute.ts#L6502) / 6511 と、
   `join.table.appId` を fetch する全 call site を `cteName` ガードの有無で監査する
   （実行は現に正常なので、実行側は「ガード済みか到達しないか」を確認して固定する）。
3. **受入**:
   - 逐語 2 形（起票の batch・UNION ALL 付き batch）の CLI `--dry-run` が成功し **app≤0 の API 呼び出し 0 回**
   - `FROM #temp JOIN 物理`（順配置）・`FROM 物理 JOIN #temp`（逆配置）・CTE 版（WITH 内）×単文/バッチの非回帰
   - B150 の既存 prefilter 表示（CTE→APP・型別選択）不変
   - 実行結果はすべて不変
   - CLI e2e に batch dry-run×temp JOIN target の形を恒久化（B153 の教訓＝mock 中心の受入は面の配線差を見逃す）
