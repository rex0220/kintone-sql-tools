import {
  KsqlEngineError,
  explainQuery,
  runQuery,
  version,
  type QueryColumn,
  type QueryResult,
  type ReadonlyKintoneClient,
} from "@rex0220/kintone-sql-tools/engine";

const client: ReadonlyKintoneClient = {
  async getRecords() {
    return { records: [] };
  },
  async openCursor() {
    return {
      totalCount: 0,
      async nextPage() {
        return { records: [], next: false };
      },
      async close() {},
    };
  },
  async getApps() {
    return [];
  },
  async getFields() {
    return [];
  },
  async getNumberPrecision() {
    return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" };
  },
  async getProcessStatuses() {
    return { enable: false, states: null };
  },
};

const query: Promise<QueryResult> = runQuery("SELECT 'ok' AS result", { client });
const column: QueryColumn = {
  name: "result",
  valueType: "string",
  fieldType: "KSQL_STRING",
  sortKind: "string",
  sourceApp: 100,
};
const optionalFieldType: string | undefined = column.fieldType;
const optionalSortKind: "number" | "string" | undefined = column.sortKind;
const optionalSourceApp: number | undefined = column.sourceApp;
const explain = explainQuery("SELECT 'ok' AS result", { client });
const error = new KsqlEngineError("EXECUTION_ERROR", version);
void query;
void optionalFieldType;
void optionalSortKind;
void optionalSourceApp;
void explain;
void error;
