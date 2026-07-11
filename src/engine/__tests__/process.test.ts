import {
  flatten,
  applyJoin,
  applyFilter,
  applyGroupBy,
  applyHaving,
  applyDistinct,
  applyOrderBy,
  applyLimit,
  project,
  runFullScan,
  ProcessRow,
} from "../process";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import type { SelectStatement, JoinClause, WhereExpr } from "../../types/ast";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";

// ヘルパー
function makeRecord(fields: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}
function parseSelect(sql: string): SelectStatement {
  return new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
}

// ----------------------------------------------------------------
// flatten
// ----------------------------------------------------------------

test("flatten: alias なし", () => {
  const rec = makeRecord({ 名前: "田中", 金額: "1000" });
  expect(flatten(rec, null)).toEqual({ 名前: "田中", 金額: "1000" });
});

test("flatten: alias あり", () => {
  const rec = makeRecord({ 名前: "田中" });
  // 修飾キー（"a.名前"）と非修飾フォールバック（"名前"）の両方が格納される
  expect(flatten(rec, "a")).toEqual({ "a.名前": "田中", "名前": "田中" });
});

// ----------------------------------------------------------------
// applyJoin
// ----------------------------------------------------------------

const leftRows: ProcessRow[] = [
  { "a.$id": "1", "a.顧客ID": "C001", "a.名前": "田中" },
  { "a.$id": "2", "a.顧客ID": "C002", "a.名前": "鈴木" },
  { "a.$id": "3", "a.顧客ID": "C999", "a.名前": "佐藤" }, // 右に存在しない
];
const rightRows: ProcessRow[] = [
  { "b.顧客ID": "C001", "b.会社": "A社" },
  { "b.顧客ID": "C002", "b.会社": "B社" },
];

const joinClause: JoinClause = {
  type: "INNER",
  table: { appId: 200, alias: "b", cteName: null },
  on: {
    left:  { tableAlias: "a", field: "顧客ID" },
    right: { tableAlias: "b", field: "顧客ID" },
  },
};

test("INNER JOIN: 一致する行のみ", () => {
  const result = applyJoin(leftRows, rightRows, joinClause);
  expect(result).toHaveLength(2);
  expect(result[0]["a.名前"]).toBe("田中");
  expect(result[0]["b.会社"]).toBe("A社");
});

test("LEFT JOIN: 右に存在しない行は空文字で残る", () => {
  const leftJoin: JoinClause = { ...joinClause, type: "LEFT" };
  const result = applyJoin(leftRows, rightRows, leftJoin);
  expect(result).toHaveLength(3);
  const unmatched = result.find((r) => r["a.名前"] === "佐藤")!;
  expect(unmatched["b.会社"]).toBe("");
});

// ----------------------------------------------------------------
// applyFilter
// ----------------------------------------------------------------

const filterRows: ProcessRow[] = [
  { ステータス: "完了", 金額: "1000" },
  { ステータス: "未完了", 金額: "500" },
  { ステータス: "完了", 金額: "2000" },
];

const whereCompleted: WhereExpr = {
  type: "BINARY", op: "=",
  left: { type: "FIELD", tableAlias: null, field: "ステータス" },
  right: { type: "STRING", value: "完了" },
};

test("applyFilter: WHERE 条件でフィルタ", () => {
  const result = applyFilter(filterRows, whereCompleted);
  expect(result).toHaveLength(2);
});

test("applyFilter: null は全件通過", () => {
  expect(applyFilter(filterRows, null)).toHaveLength(3);
});

// ----------------------------------------------------------------
// applyGroupBy
// ----------------------------------------------------------------

const groupRows: ProcessRow[] = [
  { 種別: "A", 金額: "100" },
  { 種別: "A", 金額: "200" },
  { 種別: "B", 金額: "300" },
  { 種別: "B", 金額: "400" },
  { 種別: "B", 金額: "500" },
];

test("GROUP BY + COUNT(*)", () => {
  const stmt = parseSelect("SELECT 種別, COUNT(*) AS cnt FROM APP100 GROUP BY 種別");
  const result = applyGroupBy(groupRows, stmt.groupBy, stmt.columns);
  const A = result.find((r) => r["種別"] === "A")!;
  const B = result.find((r) => r["種別"] === "B")!;
  expect(A["cnt"]).toBe("2");
  expect(B["cnt"]).toBe("3");
});

test("GROUP BY + SUM", () => {
  const stmt = parseSelect("SELECT 種別, SUM(金額) AS total FROM APP100 GROUP BY 種別");
  const result = applyGroupBy(groupRows, stmt.groupBy, stmt.columns);
  const A = result.find((r) => r["種別"] === "A")!;
  expect(A["total"]).toBe("300");
});

test("GROUP BY + AVG", () => {
  const stmt = parseSelect("SELECT 種別, AVG(金額) AS avg FROM APP100 GROUP BY 種別");
  const result = applyGroupBy(groupRows, stmt.groupBy, stmt.columns);
  const B = result.find((r) => r["種別"] === "B")!;
  expect(Number(B["avg"])).toBeCloseTo(400);
});

test("GROUP BY + MAX / MIN", () => {
  const stmt = parseSelect("SELECT 種別, MAX(金額) AS mx, MIN(金額) AS mn FROM APP100 GROUP BY 種別");
  const result = applyGroupBy(groupRows, stmt.groupBy, stmt.columns);
  const B = result.find((r) => r["種別"] === "B")!;
  expect(B["mx"]).toBe("500");
  expect(B["mn"]).toBe("300");
});

test("GROUP BY + FORMAT(SUM(...))", () => {
  const stmt = parseSelect("SELECT 種別, FORMAT(SUM(金額), '#,##0') AS 合計 FROM APP100 GROUP BY 種別");
  const result = runFullScan({ tables: new Map([[null, groupRows.map((r) => makeRecord(r as Record<string, string>))]]), stmt });
  const A = result.rows.find((r) => r["種別"] === "A")!;
  const B = result.rows.find((r) => r["種別"] === "B")!;
  expect(A["合計"]).toBe("300");
  expect(B["合計"]).toBe("1,200");
});

test("GROUP BY + FORMAT(100+SUM(...))", () => {
  const stmt = parseSelect("SELECT 種別, FORMAT(100 + SUM(金額), '#,##0') AS 合計 FROM APP100 GROUP BY 種別");
  const result = runFullScan({ tables: new Map([[null, groupRows.map((r) => makeRecord(r as Record<string, string>))]]), stmt });
  const A = result.rows.find((r) => r["種別"] === "A")!;
  const B = result.rows.find((r) => r["種別"] === "B")!;
  expect(A["合計"]).toBe("400");
  expect(B["合計"]).toBe("1,300");
});

test("COUNT(DISTINCT フィールド)", () => {
  const rows: ProcessRow[] = [
    { 種別: "X", 担当者: "田中" },
    { 種別: "X", 担当者: "田中" }, // 重複
    { 種別: "X", 担当者: "鈴木" },
  ];
  const stmt = parseSelect(
    "SELECT 種別, COUNT(DISTINCT 担当者) AS cnt FROM APP100 GROUP BY 種別"
  );
  const result = applyGroupBy(rows, stmt.groupBy, stmt.columns);
  expect(result[0]["cnt"]).toBe("2"); // 田中・鈴木の 2人
});

// ----------------------------------------------------------------
// applyGroupBy: 空入力の非グループ集計は 1 行を返す（v1.12.0）
// ----------------------------------------------------------------

test("空入力 + GROUP BY なし + COUNT(*) → 0 の 1 行", () => {
  const stmt = parseSelect("SELECT COUNT(*) AS cnt FROM APP100");
  const result = applyGroupBy([], stmt.groupBy, stmt.columns);
  expect(result).toHaveLength(1);
  expect(result[0]["cnt"]).toBe("0");
});

test("空入力 + GROUP BY なし: 全集計関数が 0 を返す", () => {
  const stmt = parseSelect(
    "SELECT COUNT(金額) AS c, COUNT(DISTINCT 金額) AS cd, SUM(金額) AS s, AVG(金額) AS a, MAX(金額) AS mx, MIN(金額) AS mn FROM APP100"
  );
  const result = applyGroupBy([], stmt.groupBy, stmt.columns);
  expect(result).toHaveLength(1);
  for (const key of ["c", "cd", "s", "a", "mx", "mn"]) {
    expect(result[0][key]).toBe("0");
  }
});

test("空入力 + 集計算術式: SUM(a) - SUM(b) → 0、0 除算は既存 NaN 挙動", () => {
  // 出力キーは合成名（末尾オペランドが集計関数の ARITH_AGG_COL は AS alias が
  // パーサで落ちる既存の別問題があるため、ここでは alias を使わない）
  const stmt = parseSelect(
    "SELECT SUM(売上) - SUM(原価), SUM(売上) / COUNT(*) FROM APP100"
  );
  const result = applyGroupBy([], stmt.groupBy, stmt.columns);
  expect(result).toHaveLength(1);
  expect(result[0]["SUM(売上)-SUM(原価)"]).toBe("0");
  expect(result[0]["SUM(売上)/COUNT(*)"]).toBe("NaN"); // 0 / 0 — 非空入力の 0 除算と同じ既存挙動
});

test("空入力 + 集計入り文字列関数 / 非集計 FIELD 混在", () => {
  const stmt = parseSelect(
    "SELECT 種別, COUNT(*) AS cnt, FORMAT(SUM(金額), '#,##0') AS 合計 FROM APP100"
  );
  const result = runFullScan({ tables: new Map([[null, []]]), stmt });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]["種別"]).toBe(""); // コピー元行なし → 空文字（ksql 独自許容の形）
  expect(result.rows[0]["cnt"]).toBe("0");
  expect(result.rows[0]["合計"]).toBe("0");
});

test("空入力 + GROUP BY あり → 0 行のまま（SQL 標準どおり）", () => {
  const stmt = parseSelect("SELECT 種別, COUNT(*) AS cnt FROM APP100 GROUP BY 種別");
  expect(applyGroupBy([], stmt.groupBy, stmt.columns)).toHaveLength(0);
});

test("空入力 + 非集計列のみの直接呼び出し → 0 行（applyGroupBy 単独の契約）", () => {
  const stmt = parseSelect("SELECT 名前 FROM APP100");
  expect(applyGroupBy([], stmt.groupBy, stmt.columns)).toHaveLength(0);
});

test("runFullScan: WHERE 全滅 + COUNT(*) → 1 行 + columns に列名", () => {
  const tables = new Map([[null, groupRows.map((r) => makeRecord(r as Record<string, string>))]]);
  const stmt = parseSelect("SELECT COUNT(*) AS cnt FROM APP100 WHERE 金額 > 999999");
  const { rows, columns } = runFullScan({ tables, stmt });
  expect(rows).toHaveLength(1);
  expect(rows[0]["cnt"]).toBe("0");
  expect(columns).toEqual(["cnt"]);
});

test("合成行はパイプライン後段の applyHaving で除外できる", () => {
  // ksql 文法では HAVING は GROUP BY とセットでのみ書けるため（parser.ts の
  // parseSelect 節）、GROUP BY なし集計 + HAVING は SQL としては到達不能。
  // ここではパイプライン順序（合成 → HAVING）の整合のみを直接検証する
  const stmt = parseSelect("SELECT COUNT(*) AS cnt FROM APP100");
  const synthesized = applyGroupBy([], stmt.groupBy, stmt.columns);
  expect(synthesized).toHaveLength(1);
  const having: WhereExpr = {
    type: "BINARY", op: ">",
    left: { type: "FIELD", tableAlias: null, field: "cnt" },
    right: { type: "NUMBER", value: 0 },
  };
  expect(applyHaving(synthesized, having)).toHaveLength(0);
});

test("runFullScan: 合成行にも LIMIT 0 / OFFSET が適用される", () => {
  const limit0 = parseSelect("SELECT COUNT(*) AS cnt FROM APP100 LIMIT 0");
  expect(runFullScan({ tables: new Map([[null, []]]), stmt: limit0 }).rows).toHaveLength(0);
  const offset1 = parseSelect("SELECT COUNT(*) AS cnt FROM APP100 LIMIT 10 OFFSET 1");
  expect(runFullScan({ tables: new Map([[null, []]]), stmt: offset1 }).rows).toHaveLength(0);
});

// ----------------------------------------------------------------
// applyHaving
// ----------------------------------------------------------------

test("HAVING: 集計後フィルタ", () => {
  const rows: ProcessRow[] = [
    { 種別: "A", cnt: "2" },
    { 種別: "B", cnt: "5" },
    { 種別: "C", cnt: "1" },
  ];
  const having: WhereExpr = {
    type: "BINARY", op: ">",
    left: { type: "FIELD", tableAlias: null, field: "cnt" },
    right: { type: "NUMBER", value: 2 },
  };
  expect(applyHaving(rows, having)).toEqual([{ 種別: "B", cnt: "5" }]);
});

// ----------------------------------------------------------------
// applyDistinct
// ----------------------------------------------------------------

test("DISTINCT: 重複行を除去", () => {
  const rows: ProcessRow[] = [
    { 種別: "A", 担当者: "田中" },
    { 種別: "A", 担当者: "田中" },
    { 種別: "B", 担当者: "鈴木" },
  ];
  const stmt = parseSelect("SELECT DISTINCT 種別 FROM APP100");
  const result = applyDistinct(rows, stmt.columns);
  expect(result).toHaveLength(2);
});

// ----------------------------------------------------------------
// applyOrderBy
// ----------------------------------------------------------------

test("ORDER BY 数値 DESC", () => {
  const rows: ProcessRow[] = [
    { 金額: "100" }, { 金額: "300" }, { 金額: "200" },
  ];
  const result = applyOrderBy(rows, [{ key: { type: "FIELD_NAME", name: "金額" }, direction: "DESC" }]);
  expect(result.map((r) => r["金額"])).toEqual(["300", "200", "100"]);
});

test("ORDER BY 複数フィールド", () => {
  const rows: ProcessRow[] = [
    { 種別: "B", 金額: "100" },
    { 種別: "A", 金額: "200" },
    { 種別: "A", 金額: "100" },
  ];
  const result = applyOrderBy(rows, [
    { key: { type: "FIELD_NAME", name: "種別" }, direction: "ASC" },
    { key: { type: "FIELD_NAME", name: "金額" }, direction: "DESC" },
  ]);
  expect(result.map((r) => `${r.種別}:${r.金額}`)).toEqual(["A:200", "A:100", "B:100"]);
});

test("ORDER BY 算術式: 金額 * 1.1 DESC", () => {
  const rows: ProcessRow[] = [
    { 金額: "1000" },
    { 金額: "3000" },
    { 金額: "2000" },
  ];
  // 金額 * 1.1 → 1100, 3300, 2200 → DESC: 3300, 2200, 1100
  const result = applyOrderBy(rows, [{
    key: { type: "ARITH_KEY", expr: {
      type: "ARITH", op: "*",
      left: { type: "FIELD_REF", field: "金額" },
      right: { type: "NUMBER", value: 1.1 },
    }},
    direction: "DESC",
  }]);
  expect(result.map((r) => r["金額"])).toEqual(["3000", "2000", "1000"]);
});

test("ORDER BY 関数: LENGTH(名前) ASC", () => {
  const rows: ProcessRow[] = [
    { 名前: "山田花子" },
    { 名前: "田" },
    { 名前: "田中太郎" },
  ];
  const result = applyOrderBy(rows, [{
    key: { type: "FUNC_KEY", expr: {
      type: "STRING_FUNC", func: "LENGTH",
      args: [{ type: "FIELD_REF", field: "名前" }],
    }},
    direction: "ASC",
  }]);
  // 長さ: 4, 1, 4 → 1 は最初、4 は後（同順はそのまま）
  expect(result[0]["名前"]).toBe("田");
});

test("ORDER BY FIELD_NAME: sortKind=string は文字列比較を優先", () => {
  const rows: ProcessRow[] = [
    { 計算値: "2" },
    { 計算値: "10" },
  ];
  const sortKinds = new Map<string, "number" | "string">([
    ["計算値", "string"],
  ]);
  const result = applyOrderBy(
    rows,
    [{ key: { type: "FIELD_NAME", name: "計算値" }, direction: "ASC" }],
    undefined,
    sortKinds
  );
  expect(result.map((r) => r["計算値"])).toEqual(["10", "2"]);
});

test("ORDER BY FIELD_NAME: sortKind=number は数値比較を優先", () => {
  const rows: ProcessRow[] = [
    { 計算値: "2" },
    { 計算値: "10" },
  ];
  const sortKinds = new Map<string, "number" | "string">([
    ["計算値", "number"],
  ]);
  const result = applyOrderBy(
    rows,
    [{ key: { type: "FIELD_NAME", name: "計算値" }, direction: "ASC" }],
    undefined,
    sortKinds
  );
  expect(result.map((r) => r["計算値"])).toEqual(["2", "10"]);
});

test("ORDER BY 選択肢: DROP_DOWN は option index 順で比較", () => {
  const rows: ProcessRow[] = [
    { 確度: "80%" },
    { 確度: "0%" },
    { 確度: "40%" },
  ];
  const optionOrders = new Map<string, Map<string, number>>([
    ["確度", new Map([["0%", 0], ["20%", 1], ["40%", 2], ["60%", 3], ["80%", 4], ["100%", 5]])],
  ]);
  const result = applyOrderBy(
    rows,
    [{ key: { type: "FIELD_NAME", name: "確度" }, direction: "ASC" }],
    optionOrders
  );
  expect(result.map((r) => r["確度"])).toEqual(["0%", "40%", "80%"]);
});

test("ORDER BY 選択肢: MULTI_SELECT は最小 index で比較", () => {
  const rows: ProcessRow[] = [
    { オプション: "[\"Z\",\"Y\"]" },
    { オプション: "[\"X\"]" },
    { オプション: "[\"Y\"]" },
  ];
  const optionOrders = new Map<string, Map<string, number>>([
    ["オプション", new Map([["X", 0], ["Y", 1], ["Z", 2]])],
  ]);
  const result = applyOrderBy(
    rows,
    [{ key: { type: "FIELD_NAME", name: "オプション" }, direction: "ASC" }],
    optionOrders
  );
  expect(result.map((r) => r["オプション"])).toEqual(["[\"X\"]", "[\"Y\"]", "[\"Z\",\"Y\"]"]);
});

// ----------------------------------------------------------------
// applyLimit
// ----------------------------------------------------------------

test("LIMIT", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i: String(i) }));
  expect(applyLimit(rows, 3, null)).toHaveLength(3);
  expect(applyLimit(rows, null, null)).toHaveLength(10);
});

test("LIMIT + OFFSET", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i: String(i) }));
  expect(applyLimit(rows, 3, 2)).toEqual([{ i: "2" }, { i: "3" }, { i: "4" }]);
  expect(applyLimit(rows, null, 5)).toHaveLength(5);
  expect(applyLimit(rows, 3, 9)).toHaveLength(1); // 末尾を超える
});

// ----------------------------------------------------------------
// project
// ----------------------------------------------------------------

test("project: フィールド選択 + alias", () => {
  const rows: ProcessRow[] = [{ 名前: "田中", 金額: "1000", 備考: "メモ" }];
  const stmt = parseSelect("SELECT 名前 AS name, 金額 FROM APP100");
  const { rows: result, columns } = project(rows, stmt.columns);
  expect(result[0]).toEqual({ name: "田中", 金額: "1000" });
  expect(columns).toEqual(["name", "金額"]);
});

test("project: SELECT *", () => {
  const rows: ProcessRow[] = [{ 名前: "田中", 金額: "1000" }];
  const stmt = parseSelect("SELECT * FROM APP100");
  const { rows: result } = project(rows, stmt.columns);
  expect(result[0]).toEqual({ 名前: "田中", 金額: "1000" });
});

test("project: qualified field falls back to unqualified key", () => {
  const rows: ProcessRow[] = [{ オーダー番号: "20260430" }];
  const stmt = parseSelect("SELECT a.オーダー番号 FROM APP69 AS a");
  const { rows: result, columns } = project(rows, stmt.columns);
  expect(result[0]).toEqual({ オーダー番号: "20260430" });
  expect(columns).toEqual(["オーダー番号"]);
});

test("project: duplicate unqualified names fall back to qualified keys", () => {
  const rows: ProcessRow[] = [{ "a.顧客ID": "C001", "b.顧客ID": "C001", 顧客ID: "C001" }];
  const stmt = parseSelect(
    "SELECT a.顧客ID, b.顧客ID FROM APP100 AS a INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID"
  );
  const { rows: result, columns } = project(rows, stmt.columns);
  expect(result[0]).toEqual({ "a.顧客ID": "C001", "b.顧客ID": "C001" });
  expect(columns).toEqual(["a.顧客ID", "b.顧客ID"]);
});

// ----------------------------------------------------------------
// runFullScan: 統合テスト
// ----------------------------------------------------------------

test("runFullScan: GROUP BY + ORDER BY + LIMIT", () => {
  const records = [
    makeRecord({ 種別: "B", 金額: "200" }),
    makeRecord({ 種別: "A", 金額: "100" }),
    makeRecord({ 種別: "A", 金額: "300" }),
    makeRecord({ 種別: "B", 金額: "400" }),
    makeRecord({ 種別: "C", 金額: "50"  }),
  ];
  const stmt = parseSelect(
    "SELECT 種別, SUM(金額) AS total FROM APP100 GROUP BY 種別 ORDER BY total DESC LIMIT 2"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(2);
  expect(result[0]["種別"]).toBe("B");
  expect(result[0]["total"]).toBe("600");
  expect(result[1]["種別"]).toBe("A");
  expect(result[1]["total"]).toBe("400");
});

test("runFullScan: 3テーブル INNER JOIN", () => {
  // 注文(a) → 顧客(b) ON 顧客ID → 配送(c) ON 配送ID
  const aRecords = [
    makeRecord({ 注文ID: "O1", 顧客ID: "C1", 配送ID: "D1", 金額: "1000" }),
    makeRecord({ 注文ID: "O2", 顧客ID: "C2", 配送ID: "D2", 金額: "2000" }),
  ];
  const bRecords = [
    makeRecord({ 顧客ID: "C1", 顧客名: "田中" }),
    makeRecord({ 顧客ID: "C2", 顧客名: "鈴木" }),
  ];
  const cRecords = [
    makeRecord({ 配送ID: "D1", 配送先: "東京" }),
    makeRecord({ 配送ID: "D2", 配送先: "大阪" }),
  ];
  const stmt = parseSelect(
    "SELECT a.金額, b.顧客名, c.配送先 " +
    "FROM APP100 AS a " +
    "INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID " +
    "INNER JOIN APP300 AS c ON a.配送ID = c.配送ID"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", aRecords],
    ["b", bRecords],
    ["c", cRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ 金額: "1000", 顧客名: "田中", 配送先: "東京" });
  expect(result[1]).toEqual({ 金額: "2000", 顧客名: "鈴木", 配送先: "大阪" });
});

test("runFullScan: 3テーブル JOIN + LEFT JOIN 混在", () => {
  // 注文(a) INNER JOIN 顧客(b) LEFT JOIN 配送(c)
  // O2 に対応する配送レコードなし → c.* は空文字
  const aRecords = [
    makeRecord({ 注文ID: "O1", 顧客ID: "C1", 配送ID: "D1" }),
    makeRecord({ 注文ID: "O2", 顧客ID: "C2", 配送ID: "D9" }), // D9 は存在しない
  ];
  const bRecords = [
    makeRecord({ 顧客ID: "C1", 顧客名: "田中" }),
    makeRecord({ 顧客ID: "C2", 顧客名: "鈴木" }),
  ];
  const cRecords = [
    makeRecord({ 配送ID: "D1", 配送先: "東京" }),
  ];
  const stmt = parseSelect(
    "SELECT a.注文ID, b.顧客名, c.配送先 " +
    "FROM APP100 AS a " +
    "INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID " +
    "LEFT JOIN APP300 AS c ON a.配送ID = c.配送ID"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", aRecords],
    ["b", bRecords],
    ["c", cRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(2);
  const o1 = result.find((r) => r["注文ID"] === "O1");
  const o2 = result.find((r) => r["注文ID"] === "O2");
  expect(o1!["配送先"]).toBe("東京");
  expect(o2!["配送先"]).toBe(""); // LEFT JOIN → 空文字
});

test("runFullScan: 3テーブル JOIN + WHERE", () => {
  const aRecords = [
    makeRecord({ 注文ID: "O1", 顧客ID: "C1", 配送ID: "D1", ステータス: "完了" }),
    makeRecord({ 注文ID: "O2", 顧客ID: "C2", 配送ID: "D2", ステータス: "未完了" }),
  ];
  const bRecords = [
    makeRecord({ 顧客ID: "C1", 顧客名: "田中" }),
    makeRecord({ 顧客ID: "C2", 顧客名: "鈴木" }),
  ];
  const cRecords = [
    makeRecord({ 配送ID: "D1", 配送先: "東京" }),
    makeRecord({ 配送ID: "D2", 配送先: "大阪" }),
  ];
  const stmt = parseSelect(
    "SELECT a.注文ID, b.顧客名, c.配送先 " +
    "FROM APP100 AS a " +
    "INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID " +
    "INNER JOIN APP300 AS c ON a.配送ID = c.配送ID " +
    "WHERE a.ステータス = '完了'"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", aRecords],
    ["b", bRecords],
    ["c", cRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]["顧客名"]).toBe("田中");
  expect(result[0]["配送先"]).toBe("東京");
});

test("runFullScan: INNER JOIN + WHERE（JS 評価）", () => {
  const aRecords = [
    makeRecord({ $id: "1", 顧客ID: "C001", 名前: "田中", ステータス: "完了" }),
    makeRecord({ $id: "2", 顧客ID: "C002", 名前: "鈴木", ステータス: "未完了" }),
  ];
  const bRecords = [
    makeRecord({ 顧客ID: "C001", 会社: "A社" }),
    makeRecord({ 顧客ID: "C002", 会社: "B社" }),
  ];
  const stmt = parseSelect(
    "SELECT a.名前 AS name, b.会社 AS company FROM APP100 AS a " +
    "INNER JOIN APP200 AS b ON a.顧客ID = b.顧客ID " +
    "WHERE a.ステータス = '完了'"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", aRecords],
    ["b", bRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ name: "田中", company: "A社" });
});

test("runFullScan: RIGHT JOIN — 右テーブルの全行を返す", () => {
  // 左: 受注（C001, C002）、右: 顧客マスタ（C001, C002, C003）
  // RIGHT JOIN → 右の C003 も含まれる（左側は空文字）
  const orderRecords = [
    makeRecord({ 顧客ID: "C001", 金額: "1000" }),
    makeRecord({ 顧客ID: "C002", 金額: "2000" }),
  ];
  const customerRecords = [
    makeRecord({ 顧客ID: "C001", 会社: "A社" }),
    makeRecord({ 顧客ID: "C002", 会社: "B社" }),
    makeRecord({ 顧客ID: "C003", 会社: "C社" }),
  ];
  const stmt = parseSelect(
    "SELECT a.金額 AS amount, b.会社 AS company FROM APP100 AS a " +
    "RIGHT JOIN APP200 AS b ON a.顧客ID = b.顧客ID"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", orderRecords],
    ["b", customerRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(3);
  // C003 は左側が空文字
  const c003 = result.find((r) => r["company"] === "C社");
  expect(c003).toBeDefined();
  expect(c003!["amount"]).toBe("");
  // C001 は正常マッチ
  const c001 = result.find((r) => r["company"] === "A社");
  expect(c001!["amount"]).toBe("1000");
});

test("runFullScan: RIGHT JOIN — マッチなし左行は含まれない", () => {
  // 左: C001, C099（C099 は右にない）、右: C001, C002
  // RIGHT JOIN → 右の C002 は空左行、C099 は出力されない
  const leftRecords = [
    makeRecord({ 顧客ID: "C001", 備考: "あり" }),
    makeRecord({ 顧客ID: "C099", 備考: "なし" }),
  ];
  const rightRecords = [
    makeRecord({ 顧客ID: "C001", 会社: "A社" }),
    makeRecord({ 顧客ID: "C002", 会社: "B社" }),
  ];
  const stmt = parseSelect(
    "SELECT a.備考, b.会社 FROM APP100 AS a RIGHT JOIN APP200 AS b ON a.顧客ID = b.顧客ID"
  );
  const tables = new Map<string | null, KintoneRecord[]>([
    ["a", leftRecords],
    ["b", rightRecords],
  ]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(2);
  const b社 = result.find((r) => r["会社"] === "B社");
  expect(b社!["備考"]).toBe(""); // 左が存在しない → 空文字
});

// ----------------------------------------------------------------
// CASE WHEN
// ----------------------------------------------------------------

test("project: CASE WHEN — 条件に一致した THEN 値を返す", () => {
  const rows: ProcessRow[] = [
    { ステータス: "完了", 金額: "1000" },
    { ステータス: "未着手", 金額: "500" },
    { ステータス: "進行中", 金額: "800" },
  ];
  const stmt = parseSelect(
    "SELECT CASE WHEN ステータス = '完了' THEN '済' ELSE '未' END AS 状態 FROM APP100"
  );
  const { rows: result, columns } = project(rows, stmt.columns);

  expect(columns).toEqual(["状態"]);
  expect(result[0]["状態"]).toBe("済");
  expect(result[1]["状態"]).toBe("未");
  expect(result[2]["状態"]).toBe("未");
});

test("project: CASE WHEN — 複数 WHEN 分岐", () => {
  const rows: ProcessRow[] = [
    { ランク: "A" },
    { ランク: "B" },
    { ランク: "C" },
    { ランク: "D" },
  ];
  const stmt = parseSelect(
    "SELECT CASE WHEN ランク = 'A' THEN '優秀' WHEN ランク = 'B' THEN '良好' ELSE 'その他' END AS 評価 FROM APP100"
  );
  const { rows: result } = project(rows, stmt.columns);

  expect(result[0]["評価"]).toBe("優秀");
  expect(result[1]["評価"]).toBe("良好");
  expect(result[2]["評価"]).toBe("その他");
  expect(result[3]["評価"]).toBe("その他");
});

test("project: CASE WHEN — ELSE なし、非該当は空文字", () => {
  const rows: ProcessRow[] = [
    { 値: "X" },
    { 値: "Y" },
  ];
  const stmt = parseSelect(
    "SELECT CASE WHEN 値 = 'X' THEN '正解' END AS チェック FROM APP100"
  );
  const { rows: result } = project(rows, stmt.columns);

  expect(result[0]["チェック"]).toBe("正解");
  expect(result[1]["チェック"]).toBe(""); // ELSE なし → 空文字
});

test("project: CASE WHEN — THEN に数値・算術式", () => {
  const rows: ProcessRow[] = [
    { 区分: "A", 金額: "1000" },
    { 区分: "B", 金額: "500" },
  ];
  const stmt = parseSelect(
    "SELECT CASE WHEN 区分 = 'A' THEN 金額 * 1.1 ELSE 金額 END AS 税込 FROM APP100"
  );
  const { rows: result } = project(rows, stmt.columns);

  expect(result[0]["税込"]).toBe("1100");
  expect(result[1]["税込"]).toBe("500");
});

test("runFullScan: CASE WHEN in full scan", () => {
  const records = [
    makeRecord({ ステータス: "完了", 担当者: "田中" }),
    makeRecord({ ステータス: "未着手", 担当者: "鈴木" }),
  ];
  const stmt = parseSelect(
    "SELECT 担当者, CASE WHEN ステータス = '完了' THEN '○' ELSE '×' END AS 状態 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result, columns } = runFullScan({ tables, stmt });

  expect(columns).toEqual(["担当者", "状態"]);
  expect(result[0]).toEqual({ 担当者: "田中", 状態: "○" });
  expect(result[1]).toEqual({ 担当者: "鈴木", 状態: "×" });
});

test("runFullScan: DISTINCT + ORDER BY", () => {
  const records = [
    makeRecord({ 種別: "B" }),
    makeRecord({ 種別: "A" }),
    makeRecord({ 種別: "A" }),
    makeRecord({ 種別: "C" }),
  ];
  const stmt = parseSelect(
    "SELECT DISTINCT 種別 FROM APP100 ORDER BY 種別 ASC"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result.map((r) => r["種別"])).toEqual(["A", "B", "C"]);
});

// ----------------------------------------------------------------
// ORDER BY 算術式・関数（SQL パース経由）
// ----------------------------------------------------------------

test("runFullScan: ORDER BY 算術式 (金額 * 1.1 DESC)", () => {
  const records = [
    makeRecord({ 名前: "A", 金額: "1000" }),
    makeRecord({ 名前: "B", 金額: "3000" }),
    makeRecord({ 名前: "C", 金額: "2000" }),
  ];
  const stmt = parseSelect("SELECT 名前, 金額 FROM APP100 ORDER BY 金額 * 1.1 DESC");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result.map((r) => r["名前"])).toEqual(["B", "C", "A"]);
});

test("runFullScan: ORDER BY UPPER(名前) ASC — 大文字化してソート", () => {
  const records = [
    makeRecord({ 名前: "charlie" }),
    makeRecord({ 名前: "Alice" }),
    makeRecord({ 名前: "bob" }),
  ];
  const stmt = parseSelect("SELECT 名前 FROM APP100 ORDER BY UPPER(名前) ASC");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result.map((r) => r["名前"])).toEqual(["Alice", "bob", "charlie"]);
});

test("runFullScan: ORDER BY LENGTH(名前) ASC — 文字数順", () => {
  const records = [
    makeRecord({ 名前: "田中太郎" }),
    makeRecord({ 名前: "佐" }),
    makeRecord({ 名前: "山田花子太" }),
  ];
  const stmt = parseSelect(
    "SELECT 名前 FROM APP100 ORDER BY LENGTH(名前) ASC"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["名前"]).toBe("佐");       // length 1
  expect(result[1]["名前"]).toBe("田中太郎"); // length 4
  expect(result[2]["名前"]).toBe("山田花子太"); // length 5
});

test("runFullScan: ORDER BY ROUND(金額, -3) — 千単位で丸めてソート", () => {
  const records = [
    makeRecord({ 名前: "A", 金額: "1499" }),
    makeRecord({ 名前: "B", 金額: "2600" }),
    makeRecord({ 名前: "C", 金額: "1600" }),
  ];
  const stmt = parseSelect("SELECT 名前 FROM APP100 ORDER BY ROUND(金額, -3) ASC, 金額 ASC");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  // ROUND(-3): 1499→1000, 2600→3000, 1600→2000
  expect(result.map((r) => r["名前"])).toEqual(["A", "C", "B"]);
});

// ----------------------------------------------------------------
// WHERE 句での関数
// ----------------------------------------------------------------

test("runFullScan: WHERE UPPER(f) = '...' — 大文字小文字を無視した一致", () => {
  const records = [
    makeRecord({ ステータス: "完了" }),
    makeRecord({ ステータス: "KANRYO" }),
    makeRecord({ ステータス: "未着手" }),
  ];
  const stmt = parseSelect(
    "SELECT ステータス FROM APP100 WHERE UPPER(ステータス) = '完了'"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  // "完了".toUpperCase() === "完了" → マッチ、"KANRYO" は不一致
  expect(result).toHaveLength(1);
  expect(result[0]["ステータス"]).toBe("完了");
});

test("runFullScan: WHERE LENGTH(f) > N — 文字数フィルタ", () => {
  const records = [
    makeRecord({ 名前: "田中" }),
    makeRecord({ 名前: "山田太郎" }),
    makeRecord({ 名前: "佐" }),
  ];
  const stmt = parseSelect(
    "SELECT 名前 FROM APP100 WHERE LENGTH(名前) > 2"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]["名前"]).toBe("山田太郎");
});

test("runFullScan: WHERE TRIM(f) != '' — 空白のみ行を除外", () => {
  const records = [
    makeRecord({ 備考: "  " }),
    makeRecord({ 備考: "あり" }),
    makeRecord({ 備考: "" }),
  ];
  const stmt = parseSelect(
    "SELECT 備考 FROM APP100 WHERE TRIM(備考) != ''"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]["備考"]).toBe("あり");
});

test("runFullScan: WHERE 関数 AND 通常条件の複合", () => {
  const records = [
    makeRecord({ 名前: "田中太郎", 金額: "5000" }),
    makeRecord({ 名前: "鈴木",     金額: "10000" }),
    makeRecord({ 名前: "山田花子", 金額: "3000" }),
  ];
  const stmt = parseSelect(
    "SELECT 名前 FROM APP100 WHERE LENGTH(名前) >= 4 AND 金額 > 4000"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]["名前"]).toBe("田中太郎");
});

test("runFullScan: WHERE ROUND(f, 0) = 1235 — 数値関数フィルタ", () => {
  const records = [
    makeRecord({ 値: "1234.7" }),
    makeRecord({ 値: "1234.2" }),
  ];
  const stmt = parseSelect(
    "SELECT 値 FROM APP100 WHERE ROUND(値) = 1235"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result).toHaveLength(1);
  expect(result[0]["値"]).toBe("1234.7");
});

// ----------------------------------------------------------------
// 文字列関数
// ----------------------------------------------------------------

test("runFullScan: UPPER / LOWER", () => {
  const records = [
    makeRecord({ 名前: "tanaka", コード: "ABC" }),
  ];
  const stmt = parseSelect(
    "SELECT UPPER(名前) AS 大文字, LOWER(コード) AS 小文字 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result, columns } = runFullScan({ tables, stmt });

  expect(columns).toEqual(["大文字", "小文字"]);
  expect(result[0]["大文字"]).toBe("TANAKA");
  expect(result[0]["小文字"]).toBe("abc");
});

test("runFullScan: TRIM / LTRIM / RTRIM", () => {
  const records = [makeRecord({ 備考: "  hello  " })];
  const stmt = parseSelect(
    "SELECT TRIM(備考) AS t, LTRIM(備考) AS lt, RTRIM(備考) AS rt FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["t"]).toBe("hello");
  expect(result[0]["lt"]).toBe("hello  ");
  expect(result[0]["rt"]).toBe("  hello");
});

test("runFullScan: LENGTH", () => {
  const records = [makeRecord({ 名前: "田中太郎" })];
  const stmt = parseSelect("SELECT LENGTH(名前) AS len FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["len"]).toBe("4");
});

test("runFullScan: SUBSTRING (1-indexed, start+len)", () => {
  const records = [makeRecord({ コード: "ABCDE" })];
  const stmt = parseSelect("SELECT SUBSTRING(コード, 2, 3) AS sub FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["sub"]).toBe("BCD"); // 1-indexed → slice(1,4)
});

test("runFullScan: SUBSTRING (start のみ)", () => {
  const records = [makeRecord({ コード: "ABCDE" })];
  const stmt = parseSelect("SELECT SUBSTRING(コード, 3) AS sub FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["sub"]).toBe("CDE");
});

test("runFullScan: CONCAT", () => {
  const records = [makeRecord({ 姓: "田中", 名: "太郎" })];
  const stmt = parseSelect("SELECT CONCAT(姓, ' ', 名) AS 氏名 FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["氏名"]).toBe("田中 太郎");
});

test("runFullScan: REPLACE", () => {
  const records = [makeRecord({ 説明: "Hello World World" })];
  const stmt = parseSelect("SELECT REPLACE(説明, 'World', '世界') AS r FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["r"]).toBe("Hello 世界 世界");
});

test("runFullScan: ネスト UPPER(TRIM(名前))", () => {
  const records = [makeRecord({ 名前: "  tanaka  " })];
  const stmt = parseSelect("SELECT UPPER(TRIM(名前)) AS u FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["u"]).toBe("TANAKA");
});

test("runFullScan: COALESCE — 最初の非空値を返す", () => {
  const records = [
    makeRecord({ 備考: "",     代替: "あり" }),
    makeRecord({ 備考: "メモ", 代替: "無視" }),
    makeRecord({ 備考: "",     代替: ""     }),
  ];
  const stmt = parseSelect(
    "SELECT COALESCE(備考, 代替, '未設定') AS val FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["val"]).toBe("あり");   // 備考が空 → 代替
  expect(result[1]["val"]).toBe("メモ");   // 備考が非空
  expect(result[2]["val"]).toBe("未設定"); // 両方空 → リテラル
});

test("runFullScan: ROUND — 正の桁数", () => {
  const records = [makeRecord({ 金額: "1234.567" })];
  const stmt = parseSelect(
    "SELECT ROUND(金額, 2) AS r2, ROUND(金額, 1) AS r1, ROUND(金額) AS r0 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["r2"]).toBe("1234.57");
  expect(result[0]["r1"]).toBe("1234.6");
  expect(result[0]["r0"]).toBe("1235");
});

test("runFullScan: ROUND — 負の桁数（10 の位・100 の位）", () => {
  const records = [makeRecord({ 金額: "1234.567" })];
  const stmt = parseSelect(
    "SELECT ROUND(金額, -1) AS r_1, ROUND(金額, -2) AS r_2 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["r_1"]).toBe("1230");  // 10 の位で丸め
  expect(result[0]["r_2"]).toBe("1200");  // 100 の位で丸め
});

test("runFullScan: FLOOR — 桁指定あり・なし・負", () => {
  const records = [makeRecord({ 値: "1234.567" })];
  const stmt = parseSelect(
    "SELECT FLOOR(値) AS f0, FLOOR(値, 2) AS f2, FLOOR(値, -2) AS f_2 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["f0"]).toBe("1234");
  expect(result[0]["f2"]).toBe("1234.56");
  expect(result[0]["f_2"]).toBe("1200");
});

test("runFullScan: CEIL — 桁指定あり・なし・負", () => {
  const records = [makeRecord({ 値: "1234.123" })];
  const stmt = parseSelect(
    "SELECT CEIL(値) AS c0, CEIL(値, 2) AS c2, CEIL(値, -2) AS c_2 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["c0"]).toBe("1235");
  expect(result[0]["c2"]).toBe("1234.13");
  expect(result[0]["c_2"]).toBe("1300");
});

test("runFullScan: CEILING (CEIL の別名)", () => {
  const records = [makeRecord({ 値: "3.1" })];
  const stmt = parseSelect("SELECT CEILING(値) AS c FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["c"]).toBe("4");
});

test("runFullScan: ROUND — 算術式を引数に", () => {
  const records = [makeRecord({ 金額: "1000", 税率: "0.1" })];
  const stmt = parseSelect("SELECT ROUND(金額 * 税率) AS 税額 FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["税額"]).toBe("100");
});

// ----------------------------------------------------------------
// CAST / CONVERT / FORMAT
// ----------------------------------------------------------------

test("runFullScan: CAST(f AS TEXT) — 数値を文字列に", () => {
  const records = [makeRecord({ 金額: "1234" })];
  const stmt = parseSelect("SELECT CAST(金額 AS TEXT) AS t FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["t"]).toBe("1234");
});

test("runFullScan: CAST(f AS NUMBER) — 文字列を数値に変換して比較", () => {
  const records = [makeRecord({ コード: "  42  " })];
  const stmt = parseSelect("SELECT CAST(TRIM(コード) AS NUMBER) AS n FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["n"]).toBe("42");
});

test("runFullScan: CONVERT(f, INT) — CAST と等価", () => {
  const records = [makeRecord({ 値: "3.7" })];
  const stmt = parseSelect("SELECT CONVERT(値, INT) AS n FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["n"]).toBe("3.7");
});

test("runFullScan: FORMAT — 千区切り整数", () => {
  const records = [makeRecord({ 金額: "1234567" })];
  const stmt = parseSelect("SELECT FORMAT(金額, '#,##0') AS f FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["f"]).toBe("1,234,567");
});

test("runFullScan: FORMAT — 小数2桁＋千区切り", () => {
  const records = [makeRecord({ 金額: "1234.5" })];
  const stmt = parseSelect("SELECT FORMAT(金額, '#,##0.00') AS f FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["f"]).toBe("1,234.50");
});

test("runFullScan: FORMAT — パーセント表示", () => {
  const records = [makeRecord({ 比率: "0.156" })];
  const stmt = parseSelect("SELECT FORMAT(比率, '0.00%') AS f FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["f"]).toBe("15.60%");
});

test("runFullScan: FORMAT — MySQL スタイル (整数桁数)", () => {
  const records = [makeRecord({ 金額: "1234567.891" })];
  const stmt = parseSelect("SELECT FORMAT(金額, 2) AS f FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["f"]).toBe("1,234,567.89");
});

test("runFullScan: FORMAT — AS が元項目名と同じでも式結果を優先", () => {
  const records = [makeRecord({ 売上: "3600000" })];
  const stmt = parseSelect("SELECT FORMAT(売上) AS 売上 FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result, columns } = runFullScan({ tables, stmt });
  expect(columns).toEqual(["売上"]);
  expect(result[0]["売上"]).toBe("3,600,000");
});

test("runFullScan: FORMAT — '#,##0.##' 末尾ゼロ省略", () => {
  const records = [
    makeRecord({ 値: "1234.5" }),
    makeRecord({ 値: "1234.0" }),
  ];
  const stmt = parseSelect("SELECT FORMAT(値, '#,##0.##') AS f FROM APP100");
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });
  expect(result[0]["f"]).toBe("1,234.5");
  expect(result[1]["f"]).toBe("1,234");
});

test("runFullScan: CASE WHEN THEN 文字列関数", () => {
  const records = [
    makeRecord({ 種別: "A", 名前: "tanaka" }),
    makeRecord({ 種別: "B", 名前: "suzuki" }),
  ];
  const stmt = parseSelect(
    "SELECT CASE WHEN 種別 = 'A' THEN UPPER(名前) ELSE LOWER(名前) END AS 表示名 FROM APP100"
  );
  const tables = new Map([[null, records]]);
  const { rows: result } = runFullScan({ tables, stmt });

  expect(result[0]["表示名"]).toBe("TANAKA");
  expect(result[1]["表示名"]).toBe("suzuki");
});

// ----------------------------------------------------------------
// MAX / MIN — 大量要素（スプレッド起因の RangeError 回避）
// ----------------------------------------------------------------

test("MAX / MIN: 150,000 行でも RangeError にならない", () => {
  const bigRows: ProcessRow[] = Array.from({ length: 150_000 }, (_, i) => ({
    金額: String(i + 1),
  }));
  const stmt = parseSelect("SELECT MAX(金額) AS mx, MIN(金額) AS mn FROM APP100");
  const result = applyGroupBy(bigRows, stmt.groupBy, stmt.columns);
  expect(result[0]["mx"]).toBe("150000");
  expect(result[0]["mn"]).toBe("1");
});

// ----------------------------------------------------------------
// DISTINCT — キー同一性（区切り文字衝突・キー集合の差異）
// ----------------------------------------------------------------

test("DISTINCT: 値に区切り文字（\x00）を含んでも誤同一視しない", () => {
  const rows: ProcessRow[] = [
    { a: "1\x002", b: "3" },
    { a: "1", b: "2\x003" },
  ];
  const stmt = parseSelect("SELECT DISTINCT a, b FROM APP100");
  const result = applyDistinct(rows, stmt.columns);
  expect(result).toHaveLength(2);
});

test("DISTINCT *: 後続行にのみ存在するキーも重複判定に含める", () => {
  const rows: ProcessRow[] = [
    { a: "1" },
    { a: "1", b: "" },
    { a: "1" },
  ];
  const stmt = parseSelect("SELECT DISTINCT * FROM APP100");
  const result = applyDistinct(rows, stmt.columns);
  // {a:"1"}（b 欠損）と {a:"1", b:""} は別の行、3 行目は 1 行目と重複
  expect(result).toHaveLength(2);
});

test("DISTINCT *: 同一値の行は重複除去される", () => {
  const rows: ProcessRow[] = [
    { a: "1", b: "x" },
    { a: "1", b: "x" },
    { a: "2", b: "x" },
  ];
  const stmt = parseSelect("SELECT DISTINCT * FROM APP100");
  const result = applyDistinct(rows, stmt.columns);
  expect(result).toHaveLength(2);
});
