import {
  execute,
  executeBatch,
  type KintoneClient,
  type SelectResult,
} from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

function record(id: number, values: Record<string, string>): KintoneRecord {
  return Object.fromEntries(
    Object.entries({ $id: String(id), ...values }).map(([field, value]) => [field, { value }])
  ) as KintoneRecord;
}

function makeClient(options: {
  advanceOnGet?: Date;
  records?: KintoneRecord[];
} = {}): KintoneClient & {
  queries: string[];
  putCalls: Array<Parameters<KintoneClient["putRecords"]>[0]>;
} {
  const queries: string[] = [];
  const putCalls: Array<Parameters<KintoneClient["putRecords"]>[0]> = [];
  let advanced = false;
  const records = options.records ?? [
    record(1, { 件名: "a", 日付: "2026-08-21", 日時: "" }),
    record(2, { 件名: "b", 日付: "2026-08-21", 日時: "" }),
  ];
  return {
    queries,
    putCalls,
    async getRecords(params) {
      queries.push(params.query ?? "");
      if (!advanced && options.advanceOnGet) {
        advanced = true;
        jest.setSystemTime(options.advanceOnGet);
      }
      return { records };
    },
    async openCursor() {
      return {
        totalCount: records.length,
        async nextPage() { return { records, next: false }; },
        async close() { /* noop */ },
      };
    },
    async postRecords(params) { return { ids: params.records.map((_row, i) => String(i + 1)) }; },
    async putRecords(params) { putCalls.push(params); },
    async deleteRecords() { /* noop */ },
    async getApps() { return []; },
    async getFields() {
      return [
        { code: "件名", label: "件名", fieldType: "SINGLE_LINE_TEXT" },
        { code: "日付", label: "日付", fieldType: "DATE" },
        { code: "日時", label: "日時", fieldType: "DATETIME" },
      ];
    },
    async getNumberPrecision() {
      return { digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" };
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

describe("B169 statement-scoped CURRENT_DATE/CURRENT_TIMESTAMP", () => {
  test("AC1/3: 射影・WHERE・GROUP BY・ORDER BY は文開始時刻を共有する", async () => {
    const started = new Date("2026-08-21T12:34:56.789Z");
    jest.useFakeTimers().setSystemTime(started);
    try {
      const client = makeClient({ advanceOnGet: new Date("2026-08-21T12:35:30.123Z") });
      const result = await execute(
        "SELECT CURRENT_TIMESTAMP() AS ts, COUNT(*) AS n FROM APP100 " +
          "WHERE CURRENT_TIMESTAMP() = '2026-08-21T12:34:56.789Z' " +
          "GROUP BY CURRENT_TIMESTAMP() ORDER BY CURRENT_TIMESTAMP()",
        client
      ) as SelectResult;

      expect(result.rows).toEqual([{ ts: "2026-08-21T12:34:56.789Z", n: "2" }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("AC1/3: UPDATE の全行の DML 値も文開始時刻を共有する", async () => {
    const started = new Date("2026-08-21T12:34:56.789Z");
    jest.useFakeTimers().setSystemTime(started);
    try {
      const client = makeClient({ advanceOnGet: new Date("2026-08-21T12:35:30.123Z") });
      await execute(
        "UPDATE APP100 SET 日時 = CURRENT_TIMESTAMP() WHERE $id IN (1, 2)",
        client
      );

      expect(client.putCalls).toHaveLength(1);
      expect(client.putCalls[0].records.map((entry) => entry.record.日時.value))
        .toEqual([started.toISOString(), started.toISOString()]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("AC2: バッチは文ごとに instant を確定する", async () => {
    const first = new Date("2026-08-21T12:34:56.789Z");
    const second = new Date("2026-08-21T12:35:30.123Z");
    jest.useFakeTimers().setSystemTime(first);
    try {
      const batch = await executeBatch(
        "SELECT CURRENT_TIMESTAMP() AS ts FROM APP100; SELECT CURRENT_TIMESTAMP() AS ts;",
        makeClient({ advanceOnGet: second })
      );
      expect((batch.statements[0].result as SelectResult).rows.map((row) => row.ts))
        .toEqual([first.toISOString(), first.toISOString()]);
      expect((batch.statements[1].result as SelectResult).rows)
        .toEqual([{ ts: second.toISOString() }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("AC3/5: 深夜跨ぎでも CURRENT_DATE は開始日の YYYY-MM-DD、timestamp はミリ秒付き ISO", async () => {
    const started = new Date("2026-08-21T14:59:59.987Z"); // Asia/Tokyo では 23:59:59.987
    jest.useFakeTimers().setSystemTime(started);
    try {
      const result = await execute(
        "SELECT CURRENT_DATE() AS d, CURRENT_TIMESTAMP() AS ts FROM APP100",
        makeClient({ advanceOnGet: new Date("2026-08-21T15:00:00.001Z") })
      ) as SelectResult;
      expect(result.rows).toEqual([
        { d: "2026-08-21", ts: "2026-08-21T14:59:59.987Z" },
        { d: "2026-08-21", ts: "2026-08-21T14:59:59.987Z" },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("AC4/5: SET NOW・DECLARE TODAY の形式と server-only TODAY の query 素通しを維持する", async () => {
    const started = new Date("2026-08-21T03:04:05.006Z");
    jest.useFakeTimers().setSystemTime(started);
    try {
      const client = makeClient();
      const batch = await executeBatch(
        "SET @now = NOW(); DECLARE @today = TODAY(); " +
          "SELECT @now AS n, @today AS d; " +
          "SELECT 日付 FROM APP100 WHERE 日付 = TODAY();",
        client
      );
      expect((batch.statements[2].result as SelectResult).rows)
        .toEqual([{ n: "2026-08-21T03:04:05.006Z", d: "2026-08-21" }]);
      expect(client.queries.some((query) => query.includes("日付 = TODAY()"))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
