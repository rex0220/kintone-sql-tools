import {
  KsqlEngineError,
  explainQuery,
  runBatch,
  runQuery,
  version,
  type QueryColumn,
  type QueryResult,
  type BatchResult,
  type BatchResultItem,
  type BatchStatementInfo,
  type ReadonlyKintoneClient,
  type RunBatchOptions,
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
    return [{
      code: "name",
      label: "Name",
      fieldType: "SINGLE_LINE_TEXT",
      required: true,
      minLength: "3",
      maxLength: "64",
      minValue: "0",
      maxValue: "100",
    }];
  },
  async getNumberPrecision() {
    return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" };
  },
  async getProcessStatuses() {
    return { enable: false, states: null };
  },
};

const query: Promise<QueryResult> = runQuery("SELECT 'ok' AS result", { client });
const batchOptions: RunBatchOptions = { client, maxRecords: 1000 };
const batch: Promise<BatchResult> = runBatch(
  "SELECT 'ok' AS result; SELECT 'done' AS result",
  batchOptions
);
batch.then((result) => {
  // @ts-expect-error A failed batch throws, so the successful DTO has no ok flag.
  void result.ok;
});
const batchItem: BatchResultItem | undefined = undefined;
const batchStatement: BatchStatementInfo | undefined = undefined;
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
void batch;
void batchItem;
void batchStatement;
void optionalFieldType;
void optionalSortKind;
void optionalSourceApp;
void explain;
void error;
