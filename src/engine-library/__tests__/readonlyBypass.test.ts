import { execute } from "../../execute";
import type { ReadonlyKintoneClient } from "../publicTypes";
import { projectReadonlyClient } from "../readonlyClient";

function field(value: unknown) {
  return { value };
}

function makeByoClient() {
  const postRecords = jest.fn(async () => ({ ids: ["1"] }));
  const putRecords = jest.fn(async () => undefined);
  const deleteRecords = jest.fn(async () => undefined);
  const client: ReadonlyKintoneClient & {
    postRecords: typeof postRecords;
    putRecords: typeof putRecords;
    deleteRecords: typeof deleteRecords;
  } = {
    getRecords: async () => ({
      records: [{ $id: field("1"), a: field("1"), key: field("K1") }],
    }),
    openCursor: async () => ({
      totalCount: 0,
      nextPage: async () => ({ records: [], next: false }),
      close: async () => undefined,
    }),
    getApps: async () => [],
    getFields: async () => [
      { code: "a", label: "a", fieldType: "NUMBER" },
      { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    ],
    getNumberPrecision: async () => ({
      digits: 30,
      decimalPlaces: 10,
      roundingMode: "HALF_EVEN",
    }),
    getProcessStatuses: async () => ({ enable: false, states: [] }),
    postRecords,
    putRecords,
    deleteRecords,
  };
  return { client, postRecords, putRecords, deleteRecords };
}

test.each([
  ["postRecords", "INSERT INTO APP1 (a) VALUES (1)"],
  ["putRecords", "UPDATE APP1 SET a = 2 WHERE $id = 1"],
  ["deleteRecords", "DELETE FROM APP1 WHERE $id = 1"],
] as const)(
  "bypassing the statement guard still blocks %s with a clean readonly error",
  async (_method, sql) => {
    const byo = makeByoClient();

    await expect(execute(sql, projectReadonlyClient(byo.client), {
      cacheContext: `b66-readonly-bypass-${_method}`,
    })).rejects.toMatchObject({
      name: "KsqlEngineError",
      code: "READ_ONLY_VIOLATION",
    });

    expect(byo.postRecords).not.toHaveBeenCalled();
    expect(byo.putRecords).not.toHaveBeenCalled();
    expect(byo.deleteRecords).not.toHaveBeenCalled();
  }
);

test("bypass failures are neither TypeError nor generic EXECUTION_ERROR", async () => {
  const byo = makeByoClient();
  try {
    await execute(
      "INSERT INTO APP1 (a) VALUES (1)",
      projectReadonlyClient(byo.client),
      { cacheContext: "b66-readonly-bypass-error-shape" }
    );
    throw new Error("expected readonly rejection");
  } catch (error) {
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      name: "KsqlEngineError",
      code: "READ_ONLY_VIOLATION",
    });
    expect(error).not.toMatchObject({ code: "EXECUTION_ERROR" });
  }
  expect(byo.postRecords).not.toHaveBeenCalled();
});
