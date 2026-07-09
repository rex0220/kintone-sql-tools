// ============================================================
// console 入力判定（decideConsoleInput / decideRun）のテスト（S7）
// ============================================================

import { decideConsoleInput, decideRun, isBatchConstruction } from "../consoleInput";

// ----------------------------------------------------------------
// メタコマンド
// ----------------------------------------------------------------

test("`:` 始まりはバッファ空でもメタ", () => {
  expect(decideConsoleInput("", ":help")).toEqual({ kind: "meta" });
});

test("`:` 始まりはバッファ非空でもメタ（SQL に混入しない）", () => {
  expect(decideConsoleInput("SELECT 顧客名", ":buffer")).toEqual({ kind: "meta" });
  expect(decideConsoleInput("CREATE TEMP TABLE #t AS SELECT 1", ":run")).toEqual({ kind: "meta" });
});

// ----------------------------------------------------------------
// 従来互換: `;` 終端までは蓄積
// ----------------------------------------------------------------

test("空行（バッファ空）は無視", () => {
  expect(decideConsoleInput("", "")).toEqual({ kind: "ignore" });
  expect(decideConsoleInput("", "   ")).toEqual({ kind: "ignore" });
});

test("`;` で終わらない行は完結していても蓄積（従来互換）", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100");
  expect(d).toEqual({ kind: "continue", buffer: "SELECT * FROM APP100" });
});

test("複数行入力の蓄積と `;` での単文実行", () => {
  const d1 = decideConsoleInput("", "SELECT 顧客名");
  expect(d1.kind).toBe("continue");
  const d2 = decideConsoleInput("SELECT 顧客名", "FROM APP100;");
  expect(d2).toEqual({ kind: "execute-single", sql: "SELECT 顧客名\nFROM APP100;" });
});

test("`;` のみは無視", () => {
  expect(decideConsoleInput("", ";")).toEqual({ kind: "ignore" });
});

test("@profile 構文(正規化前)も判定できる(実行 SQL は生のまま)", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP88@guest;");
  expect(d).toEqual({ kind: "execute-single", sql: "SELECT * FROM APP88@guest;" });
});

// ----------------------------------------------------------------
// 複文
// ----------------------------------------------------------------

test("1行複文は `;` 終端で即バッチ実行", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100; SELECT * FROM APP200;");
  expect(d).toEqual({
    kind: "execute-batch",
    sql: "SELECT * FROM APP100; SELECT * FROM APP200;",
  });
});

// ----------------------------------------------------------------
// バッチ構築モード（CREATE TEMP TABLE）
// ----------------------------------------------------------------

test("CREATE TEMP TABLE 開始は `;` 終端でも実行せず蓄積", () => {
  const d = decideConsoleInput("", "CREATE TEMP TABLE #t AS SELECT * FROM APP100;");
  expect(d.kind).toBe("continue");
});

test("先頭コメント付きの CREATE TEMP TABLE も構築モードに入る", () => {
  const d = decideConsoleInput("", "-- 高額顧客の抽出\nCREATE TEMP TABLE #t AS SELECT * FROM APP100;");
  expect(d.kind).toBe("continue");
});

test("構築モード中は空行も `;` 行も蓄積される", () => {
  const buf = "CREATE TEMP TABLE #t AS SELECT * FROM APP100;";
  const d1 = decideConsoleInput(buf, "");
  expect(d1.kind).toBe("continue");
  const d2 = decideConsoleInput(buf, "SELECT * FROM #t;");
  expect(d2.kind).toBe("continue");
});

test("SELECT 開始でも完結入力に CREATE TEMP TABLE を含めば構築モード", () => {
  const d = decideConsoleInput(
    "",
    "SELECT * FROM APP100; CREATE TEMP TABLE #t AS SELECT * FROM APP200;"
  );
  expect(d.kind).toBe("continue");
});

test("isBatchConstruction: 大文字小文字・コメント・空白に耐える", () => {
  expect(isBatchConstruction("create temp table #t as select 1")).toBe(true);
  expect(isBatchConstruction("/* c */ -- x\n  CREATE TEMP TABLE #t AS SELECT 1")).toBe(true);
  expect(isBatchConstruction("SELECT * FROM APP100")).toBe(false);
});

// ----------------------------------------------------------------
// 継続可能な失敗 vs 即エラー
// ----------------------------------------------------------------

test("未閉じ文字列内の `;` では実行しない（蓄積継続）", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100 WHERE 名前 = '倉;");
  expect(d.kind).toBe("continue");
});

test("未終端ブロックコメント中は蓄積継続", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100 /* メモ ;");
  expect(d.kind).toBe("continue");
});

test("括弧未閉じのまま `;` は即エラー（エラー位置が ; トークン = 閉じ忘れ）", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100 WHERE 顧客ID IN (1, 2;");
  expect(d.kind).toBe("error");
});

test("括弧未閉じで `;` なしなら蓄積される（複数行入力の途中）", () => {
  const d = decideConsoleInput("", "SELECT * FROM APP100 WHERE 顧客ID IN (1, 2");
  expect(d.kind).toBe("continue");
});

test("typo は `;` 終端時に即エラー（バッファ破棄は呼び出し側）", () => {
  const d = decideConsoleInput("", "SELEC * FROM APP100;");
  expect(d.kind).toBe("error");
});

// ----------------------------------------------------------------
// :run
// ----------------------------------------------------------------

test(":run は空バッファでエラー", () => {
  const d = decideRun("");
  expect(d.kind).toBe("error");
});

test(":run は完結バッファをバッチ実行に回す", () => {
  const buf = "CREATE TEMP TABLE #t AS SELECT * FROM APP100;\n\nSELECT * FROM #t;";
  expect(decideRun(buf)).toEqual({ kind: "execute-batch", sql: buf });
});

test(":run は未完バッファをエラーとして報告する（バッファは保持）", () => {
  const d = decideRun("CREATE TEMP TABLE #t AS SELECT * FROM");
  expect(d.kind).toBe("error");
});
