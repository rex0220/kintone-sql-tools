import { extractIds, fetchAll, type PageFetcher } from "../../api/fetchAll";
import type { KintoneRecord } from "../../converter/dmlToKintone";

export interface SharedFetchOptions {
  maxRecords: number;
  parallel: number;
  onLimit?: "error" | "truncate";
  onTruncate?: (max: number) => void;
  onSearchAborted?: () => void;
}

export interface SharedFetchMetrics {
  fetchedRows: number;
}

export interface DmlTargetResolution {
  ids: number[];
  metrics: SharedFetchMetrics;
}

export async function fetchRecordsForSharedPlan(
  getRecords: PageFetcher,
  app: number,
  query: string,
  fields: string[],
  options: SharedFetchOptions
): Promise<{ records: KintoneRecord[]; metrics: SharedFetchMetrics }> {
  const records = await fetchAll(getRecords, app, query, fields, {
    maxRecords: options.maxRecords,
    parallel: options.parallel,
    onLimit: options.onLimit ?? "error",
    onTruncate: options.onTruncate,
    onSearchAborted: options.onSearchAborted,
  });
  return {
    records,
    metrics: { fetchedRows: records.length },
  };
}

export async function resolveDmlTargetIds(
  getRecords: PageFetcher,
  app: number,
  query: string,
  options: SharedFetchOptions
): Promise<DmlTargetResolution> {
  const { records, metrics } = await fetchRecordsForSharedPlan(
    getRecords,
    app,
    query,
    ["$id"],
    options
  );
  return {
    ids: extractIds(records),
    metrics,
  };
}
