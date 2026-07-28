import {
  explainQuery,
  runQuery,
  type ReadonlyFieldInfo,
  type ReadonlyKintoneClient,
  type ReadonlyKintoneRecord,
} from "../index";

const field = (value: unknown) => ({ value });

function records(count: number): ReadonlyKintoneRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    $id: field(String(index + 1)),
    key: field(`K${index + 1}`),
  }));
}

function outerJoinReproductionRecords(): {
  readonly left: ReadonlyKintoneRecord[];
  readonly right: ReadonlyKintoneRecord[];
} {
  const left = ["A", "B", "C"].map((key, index) => ({
    $id: field(String(index + 1)),
    key: field(key),
    value: field(""),
  }));
  const right = [
    ...Array.from({ length: 29 }, (_, index) => ({
      $id: field(String(index + 1)),
      key: field("A"),
      value: field(`a${String(index + 1).padStart(2, "0")}`),
    })),
    {
      $id: field("30"),
      key: field("B"),
      value: field("b01"),
    },
  ];
  return { left, right };
}

function clientFor(recordsByApp: Readonly<Record<number, readonly ReadonlyKintoneRecord[]>>):
ReadonlyKintoneClient {
  const fields: ReadonlyFieldInfo[] = [
    {
      code: "key",
      label: "key",
      fieldType: "SINGLE_LINE_TEXT",
      optionOrder: {},
    },
    {
      code: "value",
      label: "value",
      fieldType: "SINGLE_LINE_TEXT",
      optionOrder: {},
    },
  ];
  return {
    getRecords: async ({ app, query = "" }) => {
      const source = recordsByApp[app] ?? [];
      const limit = Number(/\blimit\s+(\d+)/i.exec(query)?.[1] ?? source.length);
      const offset = Number(/\boffset\s+(\d+)/i.exec(query)?.[1] ?? 0);
      return { records: source.slice(offset, offset + limit) };
    },
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => fields,
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
}

const truncate = {
  maxRecords: 2,
  onLimitReached: "truncate" as const,
};

test("B98: LEFT JOIN の保持されない側が打ち切られたら fail-closed にする", async () => {
  const reproduction = outerJoinReproductionRecords();
  const rejection = runQuery(
    "SELECT l.key, r.value FROM APP4226 l LEFT JOIN APP4225 r ON l.key = r.key",
    {
      client: clientFor({
        4225: reproduction.right,
        4226: reproduction.left,
      }),
      maxRecords: 20,
      onLimitReached: "truncate",
    }
  );

  await expect(rejection).rejects.toMatchObject({
    code: "FETCH_LIMIT_EXCEEDED",
  });
  await expect(rejection).rejects.toThrow(
    "外部結合の正しい結果には完全な候補集合が必要です。" +
    "complete input reason: OUTER_JOIN_NON_PRESERVED（APP4225）。" +
    "onLimit=truncateは使用できません。" +
    "取得件数が上限（20 件）を超えました。" +
    "WHERE 句で絞り込むか、maxRecords を引き上げてください。"
  );
});

test("B98: エラー理由を二重ラップしない", async () => {
  const error = await runQuery(
    "SELECT a.key FROM APP9801 a LEFT JOIN APP9802 b ON a.key = b.key",
    {
      client: clientFor({
        9801: records(2),
        9802: records(3),
      }),
      ...truncate,
    }
  ).catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.match(/complete input reason:/g)).toHaveLength(1);
});

test("B98: RIGHT JOIN は main の打ち切りを保持されない側として止める", async () => {
  await expect(runQuery(
    "SELECT a.key, b.key FROM APP9801 a RIGHT JOIN APP9802 b ON a.key = b.key",
    {
      client: clientFor({
        9801: records(3),
        9802: records(2),
      }),
      ...truncate,
    }
  )).rejects.toThrow(/OUTER_JOIN_NON_PRESERVED（APP9801）/);
});

test("B98: RIGHT JOIN は保持側だけの打ち切りなら従来どおり成功する", async () => {
  const result = await runQuery(
    "SELECT a.key, b.key FROM APP9801 a RIGHT JOIN APP9802 b ON a.key = b.key",
    {
      client: clientFor({
        9801: records(2),
        9802: records(3),
      }),
      ...truncate,
    }
  );

  expect(result.metrics.limitReached).toBe(true);
  expect(result.metrics.limitReachedApps).toEqual([9802]);
});

test("B98: INNER JOIN は両側が打ち切られても従来どおり成功する", async () => {
  const result = await runQuery(
    "SELECT a.key FROM APP9801 a INNER JOIN APP9802 b ON a.key = b.key",
    {
      client: clientFor({
        9801: records(3),
        9802: records(3),
      }),
      ...truncate,
    }
  );

  expect(result.metrics.limitReachedApps).toEqual([9801, 9802]);
});

test("B98: 多段 LEFT JOIN は中間テーブルの打ち切りを止める", async () => {
  await expect(runQuery(
    "SELECT a.key FROM APP9801 a " +
    "LEFT JOIN APP9802 b ON a.key = b.key " +
    "LEFT JOIN APP9803 c ON b.key = c.key",
    {
      client: clientFor({
        9801: records(2),
        9802: records(3),
        9803: records(2),
      }),
      ...truncate,
    }
  )).rejects.toThrow(/OUTER_JOIN_NON_PRESERVED（APP9802）/);
});

test("B98: 外側の LEFT JOIN は外部結合のない CTE 内の打ち切りへ誤爆しない", async () => {
  const result = await runQuery(
    "WITH limited AS (SELECT key AS renamed FROM APP9804) " +
    "SELECT l.renamed FROM limited l " +
    "LEFT JOIN APP9805 b ON l.renamed = b.key",
    {
      client: clientFor({
        9804: records(3),
        9805: records(2),
      }),
      ...truncate,
    }
  );

  expect(result.metrics.limitReachedApps).toEqual([9804]);
});

test("B98: onLimitReached=error と外部結合の EXPLAIN は変えない", async () => {
  const sql =
    "SELECT a.key FROM APP9801 a LEFT JOIN APP9802 b ON a.key = b.key";
  const client = clientFor({
    9801: records(2),
    9802: records(3),
  });

  const error = await runQuery(sql, {
    client,
    maxRecords: 2,
    onLimitReached: "error",
  }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "FETCH_LIMIT_EXCEEDED" });
  expect((error as Error).message).toBe(
    "取得件数が上限（2 件）を超えました。" +
    "WHERE 句で絞り込むか、maxRecords を引き上げてください。"
  );

  const explained = await explainQuery(sql, { client });
  expect(explained.lines).not.toContainEqual(
    expect.stringContaining("complete input reason:")
  );
});
