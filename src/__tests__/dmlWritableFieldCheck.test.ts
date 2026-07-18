import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo } from "../execute";
import type { KintoneRecord } from "../converter/dmlToKintone";

type DmlForm = {
  name: string;
  sql: (target: string) => string;
};

type Modifier = "none" | "validate" | "skip";
type TargetKind = "missing" | "subtable" | "topLevel";

const DML_FORMS: DmlForm[] = [
  { name: "INSERT VALUES", sql: (target) => `INSERT INTO APP100 (${target}) VALUES (1)` },
  { name: "INSERT SELECT", sql: (target) => `INSERT INTO APP100 (${target}) SELECT source FROM APP200` },
  { name: "UPDATE normal", sql: (target) => `UPDATE APP100 SET ${target} = 1 WHERE $id = 1` },
  { name: "UPDATE arithmetic", sql: (target) => `UPDATE APP100 SET ${target} = ${target} + 1 WHERE $id = 1` },
  { name: "UPDATE CASE", sql: (target) => `UPDATE APP100 SET ${target} = CASE WHEN $id = 1 THEN 1 ELSE 2 END WHERE $id = 1` },
  { name: "UPDATE string function", sql: (target) => `UPDATE APP100 SET ${target} = UPPER(key) WHERE $id = 1` },
  {
    name: "UPDATE FROM",
    sql: (target) => `UPDATE APP100 SET ${target} = s.source FROM APP200 s WHERE APP100.$id = s.key`,
  },
  {
    name: "UPSERT VALUES",
    sql: (target) => `UPSERT INTO APP100 (key, ${target}) VALUES ('K1', 1) ON DUPLICATE (key)`,
  },
  {
    name: "UPSERT SELECT",
    sql: (target) => `UPSERT INTO APP100 (key, ${target}) SELECT key, source FROM APP200 ON DUPLICATE (key)`,
  },
];

const MODIFIERS: Modifier[] = ["none", "validate", "skip"];
const TARGETS: Array<{ kind: TargetKind; field: string }> = [
  { kind: "missing", field: "missingField" },
  { kind: "subtable", field: "childField" },
  { kind: "topLevel", field: "topField" },
];

function record(values: Record<string, unknown>): KintoneRecord {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, { value }])
  ) as KintoneRecord;
}

function makeB34Client(): KintoneClient & {
  getCalls: number;
  fieldCalls: number;
  fieldCallsByApp: Record<number, number>;
  postCalls: number;
  putCalls: number;
  deleteCalls: number;
} {
  const targetRecords = [record({ $id: "1", key: "K1", topField: "1" })];
  const sourceRecords = [record({ $id: "10", key: "1", source: "2" })];
  const targetFields: KintoneFieldInfo[] = [
    { code: "key", label: "key", fieldType: "SINGLE_LINE_TEXT" },
    { code: "topField", label: "topField", fieldType: "NUMBER" },
    { code: "childField", label: "childField", fieldType: "NUMBER", inSubtable: true },
    { code: "readOnlyField", label: "readOnlyField", fieldType: "CALC", writable: false },
  ];
  const sourceFields: KintoneFieldInfo[] = [
    { code: "key", label: "key", fieldType: "NUMBER" },
    { code: "source", label: "source", fieldType: "NUMBER" },
  ];

  return {
    getCalls: 0,
    fieldCalls: 0,
    fieldCallsByApp: {},
    postCalls: 0,
    putCalls: 0,
    deleteCalls: 0,
    async getRecords(params) {
      this.getCalls++;
      return { records: params.app === 100 ? targetRecords : sourceRecords };
    },
    async openCursor() { throw new Error("unexpected cursor call"); },
    async postRecords(params) {
      this.postCalls++;
      return { ids: params.records.map((_entry, index) => String(index + 1)) };
    },
    async putRecords() { this.putCalls++; },
    async deleteRecords() { this.deleteCalls++; },
    async getApps() { return []; },
    async getFields(appId) {
      this.fieldCalls++;
      this.fieldCallsByApp[appId] = (this.fieldCallsByApp[appId] ?? 0) + 1;
      return appId === 100 ? targetFields : sourceFields;
    },
    async getProcessStatuses() { return { enable: false, states: [] }; },
  };
}

function withModifier(sql: string, modifier: Modifier): string {
  if (modifier === "validate") return `${sql} VALIDATE ONLY`;
  if (modifier === "skip") return `${sql} ON ERROR SKIP INTO #err; SELECT * FROM #err`;
  return sql;
}

describe.each(DML_FORMS)("B34 $name", ({ name, sql }) => {
  test.each(MODIFIERS.flatMap((modifier) => TARGETS.map((target) => ({ modifier, ...target }))))(
    "$modifier / $kind",
    async ({ modifier, kind, field }) => {
      const client = makeB34Client();
      let confirmCalls = 0;
      const statement = withModifier(sql(field), modifier);
      const options = {
        cacheContext: `b34-${name}-${modifier}-${kind}`,
        confirm: async () => { confirmCalls++; return true; },
      };

      if (kind === "topLevel") {
        if (modifier === "skip") {
          const result = await executeBatch(statement, client, options);
          expect(result.ok).toBe(true);
        } else {
          await expect(execute(statement, client, options)).resolves.toBeDefined();
        }
        expect(Object.values(client.fieldCallsByApp).every((calls) => calls === 1)).toBe(true);
        return;
      }

      const expected = kind === "missing"
        ? `ArgumentError: DML target field ${field} does not exist.`
        : `ArgumentError: DML target field ${field} is inside a subtable.`;

      if (modifier === "skip") {
        const result = await executeBatch(statement, client, options);
        expect(result.ok).toBe(false);
        expect(result.statements[0].error?.message).toContain(expected);
        expect(result.statements[0].error?.code).toBe("ArgumentError");
      } else {
        await expect(execute(statement, client, options)).rejects.toThrow(expected);
      }
      if (kind === "subtable") {
        const message = modifier === "skip"
          ? (await executeBatch(statement, makeB34Client(), { cacheContext: `${options.cacheContext}-message` })).statements[0].error?.message
          : await execute(statement, makeB34Client(), { cacheContext: `${options.cacheContext}-message` }).catch((error: Error) => error.message);
        expect(message).toContain("APP100$テーブル");
      }
      expect(client.getCalls).toBe(0);
      expect(confirmCalls).toBe(0);
      expect(client.postCalls).toBe(0);
      expect(client.putCalls).toBe(0);
      expect(client.deleteCalls).toBe(0);
      expect(client.fieldCalls).toBe(1);
    }
  );
});

test.each(MODIFIERS)("B34 書き込み不可型も共有検査で文単位拒否する: %s", async (modifier) => {
  const client = makeB34Client();
  let confirmCalls = 0;
  const statement = withModifier(
    "INSERT INTO APP100 (readOnlyField) VALUES (1)",
    modifier
  );
  const options = {
    cacheContext: `b34-read-only-${modifier}`,
    confirm: async () => { confirmCalls++; return true; },
  };

  if (modifier === "skip") {
    const result = await executeBatch(statement, client, options);
    expect(result.statements[0].error?.message).toContain(
      "ArgumentError: DML target field readOnlyField is not writable (CALC)."
    );
  } else {
    await expect(execute(statement, client, options)).rejects.toThrow(
      "ArgumentError: DML target field readOnlyField is not writable (CALC)."
    );
  }
  expect(client.getCalls).toBe(0);
  expect(confirmCalls).toBe(0);
  expect(client.postCalls).toBe(0);
  expect(client.putCalls).toBe(0);
});
