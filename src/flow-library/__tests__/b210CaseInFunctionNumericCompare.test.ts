import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  type FlowKintoneClient,
} from "../index";

/**
 * B210: 関数の引数（集計・CAST・COALESCE・CONCAT など）の中に置いた `CASE` で、
 * **数値の項目の大小比較が辞書順**になっていた（黙って誤る）。
 *
 * 外に置いた `CASE`（列そのものが CASE）は項目の型で数値に比べていたが、
 * 関数の中の CASE には型の情報（semantics resolver）が届いていなかった。
 * `SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END)` は言語リファレンスが勧める形でもある。
 *
 * 残数は 0〜11。`> 5` は数値なら 6 件（6〜11）、辞書順なら 4 件（"6"〜"9"）。
 * 値は見ない（B171 の「実値推測禁止」）。文字列の項目は辞書順のまま。
 */
const FIELDS = [
  { code: "残数", label: "残数", fieldType: "NUMBER", writable: true },
  { code: "文字", label: "文字", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "区分", label: "区分", fieldType: "DROP_DOWN", writable: true, optionOrder: { A: 0, B: 1 } },
  // 選択肢の順が辞書順と逆（Z が先）。大小は選択肢の順で比べる
  { code: "順", label: "順", fieldType: "DROP_DOWN", writable: true, optionOrder: { Z: 0, A: 1 } },
];

const rows = Array.from({ length: 12 }, (_, index) => ({
  $id: { type: "__ID__", value: String(index + 1) },
  残数: { type: "NUMBER", value: String(index) },
  文字: { type: "SINGLE_LINE_TEXT", value: String(index) },
  区分: { type: "DROP_DOWN", value: index % 2 ? "A" : "B" },
  順: { type: "DROP_DOWN", value: index % 2 ? "A" : "Z" },
}));

interface Written { op: string; records: unknown[] }

function mockClient(written: Written[] = [], fields: unknown[] = FIELDS) {
  return {
    async getRecords(params: { query: string; totalCount?: boolean }) {
      const query = params.query ?? "";
      const id = /\$id = "?(\d+)"?/.exec(query);
      const hit = id ? rows.filter((row) => row.$id.value === id[1]) : rows;
      const offset = Number(/offset (\d+)/.exec(query)?.[1] ?? 0);
      const limit = /limit (\d+)/.exec(query)?.[1];
      const page = hit.slice(offset, limit === undefined ? undefined : offset + Number(limit));
      return params.totalCount === true
        ? { records: page, totalCount: String(hit.length) }
        : { records: page };
    },
    async openCursor() {
      let sent = false;
      return {
        totalCount: rows.length,
        async nextPage() { const records = sent ? [] : rows; sent = true; return { records, next: false }; },
        async close() {},
      };
    },
    async postRecords(params: { records: unknown[] }) {
      written.push({ op: "post", records: params.records });
      return { ids: params.records.map((_, index) => String(index + 1)) };
    },
    async putRecords(params: { records: unknown[] }) {
      written.push({ op: "put", records: params.records });
      return { records: params.records.map((record) => ({ id: String((record as { id: string }).id), revision: "2" })) };
    },
    async deleteRecords() {},
    async getApps() { return []; },
    async getFields() { return fields; },
    async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" as const }; },
    async getProcessStatuses() { return { enable: false, states: null }; },
  } as unknown as FlowKintoneClient;
}

const header = "-- @ksql dialect: 1\n";

async function run(sql: string, written: Written[] = []) {
  const parsed = parseScript(`${header}${sql}`);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new Error(`parse error: ${errors[0].message}`);
  const context = createExecutionContext({
    client: mockClient(written), statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
  });
  const results = [];
  try {
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
  } finally {
    await disposeExecutionContext(context);
  }
  const last = results[results.length - 1] as { status: string; error?: { message: string }; result?: { rows?: Array<Record<string, string>> } };
  if (last.status !== "success") throw new Error(`${last.status}: ${last.error?.message ?? ""}`);
  return last.result?.rows ?? [];
}

const sum = (list: Array<Record<string, string>>, key: string) => list.reduce((total, row) => total + Number(row[key]), 0);

describe("B210: 関数の中の CASE で数値の項目を数値として比べる", () => {
  test.each([
    ["COALESCE", "SELECT COALESCE(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 9) AS y FROM APP200"],
    ["CAST", "SELECT CAST(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END AS NUMBER) AS y FROM APP200"],
    ["ROUND", "SELECT ROUND(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 0) AS y FROM APP200"],
    ["算術の中の関数", "SELECT 0 + ROUND(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 0) AS y FROM APP200"],
  ])("集計なしの SELECT の列: %s（> 5 は 6 件）", async (_label, sql) => {
    expect(sum(await run(sql), "y")).toBe(6);
  });

  test("集計なしの SELECT の列: CONCAT（大は 6 件）", async () => {
    const result = await run("SELECT CONCAT('x', CASE WHEN 残数 > 5 THEN '大' ELSE '小' END) AS y FROM APP200");
    expect(result.filter((row) => row.y === "x大")).toHaveLength(6);
  });

  test("集計なしの SELECT の列: ORDER BY つき（全件取得の道）", async () => {
    const result = await run("SELECT 残数, COALESCE(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 9) AS y FROM APP200 ORDER BY 残数");
    expect(sum(result, "y")).toBe(6);
  });

  test.each([
    ["SUM", "SELECT SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) AS n FROM APP200", 6],
    ["SUM（< 5）", "SELECT SUM(CASE WHEN 残数 < 5 THEN 1 ELSE 0 END) AS n FROM APP200", 5],
    ["COUNT", "SELECT COUNT(CASE WHEN 残数 > 5 THEN 1 END) AS n FROM APP200", 6],
    ["MAX", "SELECT MAX(CASE WHEN 残数 > 5 THEN 残数 ELSE 0 END) AS n FROM APP200", 11],
    ["MIN（辞書順なら 10・11 が \"9\" より小さく外れて 99）", "SELECT MIN(CASE WHEN 残数 > 9 THEN 残数 ELSE 99 END) AS n FROM APP200", 10],
  ] as const)("集計の引数: %s", async (_label, sql, expected) => {
    expect(Number((await run(sql))[0].n)).toBe(expected);
  });

  test("集計の引数: GROUP BY ごと（A・B とも 3 件）", async () => {
    const result = await run(
      "SELECT 区分, SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) AS n FROM APP200 GROUP BY 区分 ORDER BY 区分"
    );
    expect(result.map((row) => [row.区分, row.n])).toEqual([["A", "3"], ["B", "3"]]);
  });

  test("集計の引数: 一時テーブルに写した NUMBER 項目", async () => {
    const result = await run(
      "CREATE TEMP TABLE #t AS SELECT 残数 FROM APP200;\n"
      + "SELECT SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) AS n FROM #t"
    );
    expect(Number(result[0].n)).toBe(6);
  });

  test("HAVING の集計の引数", async () => {
    const result = await run(
      "SELECT 区分, COUNT(*) AS c FROM APP200 GROUP BY 区分 HAVING SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) >= 3 ORDER BY 区分"
    );
    expect(result.map((row) => row.区分)).toEqual(["A", "B"]);
  });

  test("GROUP BY の式のキー", async () => {
    const result = await run(
      "SELECT CONCAT('k', CASE WHEN 残数 > 5 THEN '大' ELSE '小' END) AS k, COUNT(*) AS n FROM APP200 "
      + "GROUP BY CONCAT('k', CASE WHEN 残数 > 5 THEN '大' ELSE '小' END) ORDER BY k"
    );
    expect(result.map((row) => [row.k, row.n])).toEqual([["k大", "6"], ["k小", "6"]]);
  });

  test("ORDER BY の式", async () => {
    const result = await run(
      "SELECT 残数 FROM APP200 ORDER BY COALESCE(CASE WHEN 残数 > 5 THEN 0 ELSE 1 END, 9), 残数"
    );
    expect(result.slice(0, 6).map((row) => row.残数)).toEqual(["6", "7", "8", "9", "10", "11"]);
  });

  test("WHERE の関数の中の CASE（JS 側で評価）", async () => {
    const result = await run(
      "SELECT COUNT(*) AS n FROM APP200 WHERE COALESCE(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 0) = 1"
    );
    expect(Number(result[0].n)).toBe(6);
  });

  test("ウィンドウの引数（LAG）", async () => {
    const result = await run(
      "SELECT 残数, LAG(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END, 1) OVER (ORDER BY 残数) AS p FROM APP200"
    );
    // 残数 7〜11 の行の前の行（6〜10）が 1 → 5 件
    expect(sum(result.filter((row) => row.p !== ""), "p")).toBe(5);
  });

  test("ウィンドウの引数（SUM の累計）", async () => {
    const result = await run(
      "SELECT 残数, SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) OVER (ORDER BY 残数 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS c FROM APP200"
    );
    expect(Math.max(...result.map((row) => Number(row.c)))).toBe(6);
  });

  test("UPDATE の SET の関数の中の CASE", async () => {
    const written: Written[] = [];
    await run("UPDATE APP200 SET 文字 = CONCAT('', CASE WHEN 残数 > 5 THEN '大' ELSE '小' END) WHERE $id = 11", written);
    // $id 11 は 残数 10（数値なら 大、辞書順なら "10" > "5" が偽で 小）
    const record = (written[0]?.records[0] as { record: { 文字: { value: string } } } | undefined)?.record;
    expect(record?.文字.value).toBe("大");
  });
});

describe("B210: UPDATE の SET の CASE（関数の外）", () => {
  test("SET 文字 = CASE WHEN 残数 > 5 …（$id 11 = 残数 10 は 大）", async () => {
    const written: Written[] = [];
    await run("UPDATE APP200 SET 文字 = CASE WHEN 残数 > 5 THEN '大' ELSE '小' END WHERE $id = 11", written);
    const record = (written[0]?.records[0] as { record: { 文字: { value: string } } } | undefined)?.record;
    expect(record?.文字.value).toBe("大");
  });
});

describe("B210: 集計の結果・UPDATE … FROM", () => {
  test("集計の結果を関数の中の CASE で比べる（COUNT(*) = 12 は 100 より小さい）", async () => {
    const result = await run("SELECT CONCAT('', CASE WHEN COUNT(*) > 100 THEN 'many' ELSE 'few' END) AS y FROM APP200");
    expect(result[0].y).toBe("few");
  });

  test("集計の結果を算術の中の CASE で比べる", async () => {
    const result = await run("SELECT ROUND(CASE WHEN COUNT(*) > 100 THEN 1 ELSE 0 END, 0) AS y FROM APP200");
    expect(result[0].y).toBe("0");
  });

  test("UPDATE … FROM の SET の CASE（$id 11 = 残数 10 は 大）", async () => {
    const written: Written[] = [];
    await run(
      "CREATE TEMP TABLE #s AS SELECT $id AS id FROM APP200 WHERE $id = 11;\n"
      + "UPDATE APP200 SET 文字 = CASE WHEN 残数 > 5 THEN '大' ELSE '小' END FROM #s AS s WHERE APP200.$id = s.id",
      written
    );
    const record = (written[0]?.records[0] as { record: { 文字: { value: string } } } | undefined)?.record;
    expect(record?.文字.value).toBe("大");
  });
});

describe("B210: Codex レビューで足した形", () => {
  test("集計を含む CASE の条件で GROUP BY の項目を比べる（10・11 だけ 1）", async () => {
    const result = await run(
      "SELECT 残数, CASE WHEN 残数 > 9 THEN COUNT(*) ELSE 0 END AS c FROM APP200 GROUP BY 残数 ORDER BY 残数"
    );
    expect(result.filter((row) => row.c === "1").map((row) => row.残数)).toEqual(["10", "11"]);
  });

  test("同（関数の中）", async () => {
    const result = await run(
      "SELECT 残数, CONCAT('', CASE WHEN 残数 > 9 THEN COUNT(*) ELSE 0 END) AS c FROM APP200 GROUP BY 残数 ORDER BY 残数"
    );
    expect(result.filter((row) => row.c === "1").map((row) => row.残数)).toEqual(["10", "11"]);
  });

  test("$id の大小（> 9 は 10・11・12 の 3 件）", async () => {
    const result = await run("SELECT SUM(CASE WHEN $id > 9 THEN 1 ELSE 0 END) AS n FROM APP200");
    expect(Number(result[0].n)).toBe(3);
  });

  test("同じ文を、型の違う 2 つの実行で同時に動かしても混ざらない", async () => {
    const parsed = parseScript(`${header}SELECT SUM(CASE WHEN 残数 > 5 THEN 1 ELSE 0 END) AS n FROM APP200`);
    const textFields = FIELDS.map((field) => (field.code === "残数" ? { ...field, fieldType: "SINGLE_LINE_TEXT" } : field));
    const runWith = async (fields: unknown[]) => {
      const context = createExecutionContext({
        client: mockClient([], fields), statements: parsed.statements, meta: parsed.meta, maxRecords: 1000,
      });
      try {
        const result = await executeStatement(parsed.statements[0], context) as { result?: { rows?: Array<Record<string, string>> } };
        return Number(result.result?.rows?.[0].n);
      } finally {
        await disposeExecutionContext(context);
      }
    };
    const [asNumber, asText, asNumberAgain] = await Promise.all([runWith(FIELDS), runWith(textFields), runWith(FIELDS)]);
    expect([asNumber, asText, asNumberAgain]).toEqual([6, 4, 6]);
  });

  test("UPDATE … FROM の SET の CASE は元（FROM）の列を参照できない（構文で止まる）", () => {
    const parsed = parseScript(
      `${header}CREATE TEMP TABLE #s AS SELECT $id AS id, 残数 AS n FROM APP200;\n`
      + "UPDATE APP200 SET 文字 = CASE WHEN s.n > 5 THEN '大' ELSE '小' END FROM #s AS s WHERE APP200.$id = s.id"
    );
    expect(parsed.diagnostics.some((item) => item.severity === "error" && /ソース列/.test(item.message))).toBe(true);
  });
});

describe("B210: 変えないこと", () => {
  test("文字列の項目は辞書順のまま（'10' > '5' は偽）", async () => {
    const result = await run("SELECT SUM(CASE WHEN 文字 > '5' THEN 1 ELSE 0 END) AS n FROM APP200");
    expect(Number(result[0].n)).toBe(4);
  });

  test("外に置いた CASE は今までどおり数値", async () => {
    expect(sum(await run("SELECT CASE WHEN 残数 > 5 THEN 1 ELSE 0 END AS y FROM APP200"), "y")).toBe(6);
  });

  test("選択肢の項目の大小は、外に置いた CASE と同じ（選択肢の順。A は Z より後）", async () => {
    const outside = await run("SELECT CASE WHEN 順 > 'Z' THEN 1 ELSE 0 END AS y FROM APP200");
    const inside = await run("SELECT SUM(CASE WHEN 順 > 'Z' THEN 1 ELSE 0 END) AS n FROM APP200");
    expect(sum(outside, "y")).toBe(6);
    expect(Number(inside[0].n)).toBe(6);
  });

  test("関数の中でも = は今までどおり", async () => {
    const result = await run("SELECT SUM(CASE WHEN 区分 = 'A' THEN 1 ELSE 0 END) AS n FROM APP200");
    expect(Number(result[0].n)).toBe(6);
  });
});
