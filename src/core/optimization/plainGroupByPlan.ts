import { aggregateSyntheticName } from "../aggregateExpression";
import { containsAggregate } from "../groupingValidation";
import { APP_SYSTEM_FIELD_CODES } from "../systemFields";
import type {
  GroupByKey,
  SelectColumn,
  SelectStatement,
  TableRef,
} from "../../types/ast";

export interface PlainGroupByResolutionPlan {
  readonly items: readonly PlainGroupByResolution[];
}

export type PlainGroupByResolution =
  | { readonly kind: "EXPRESSION" }
  | {
      readonly kind: "PHYSICAL";
      readonly sourceIndex: number;
      readonly fieldCode: string;
      readonly runtimeKey: string;
    }
  | { readonly kind: "ALIAS_SAFE"; readonly columnIndex: number }
  | {
      readonly kind: "ALIAS_REJECT";
      readonly reason: "AGGREGATE" | "POST_GROUP_ONLY" | "DUPLICATE";
    }
  | { readonly kind: "UNKNOWN"; readonly name: string }
  | { readonly kind: "DEFERRED"; readonly name: string; readonly reason: string };

export type PreGroupAliasClass =
  | "SAFE"
  | "AGGREGATE_DEPENDENT"
  | "POST_GROUP_ONLY";

const AGGREGATE_REFERENCE_PREFIX =
  /^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV_POP|STDDEV_SAMP|VAR_POP|VAR_SAMP|MEDIAN|MODE)\(/;

/**
 * CASE condition 等では aggregate が SelectColumn 相当の node として保持される。
 * 既存 containsAggregate() の AGG_REF / AGG_ARITH 判定を変えず、その形だけ補う。
 */
function containsAggregateColumnNode(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsAggregateColumnNode);
  const value = node as Record<string, unknown>;
  if (value["type"] === "AGGREGATE" || value["type"] === "ARITH_AGG_COL") return true;
  if (value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY") return false;
  // CASE condition の aggregate は parser が合成名付き FIELD として保持する。
  if (value["type"] === "FIELD" && typeof value["field"] === "string") {
    return AGGREGATE_REFERENCE_PREFIX.test(value["field"]);
  }
  return Object.values(value).some(containsAggregateColumnNode);
}

/**
 * GROUP BY 前に評価できる SELECT 列かを分類する。
 * alias の有無は候補抽出側の責務とし、ここでは全 SelectColumn kind を扱う。
 */
export function classifyPreGroupAlias(column: SelectColumn): PreGroupAliasClass {
  switch (column.type) {
    case "AGGREGATE":
    case "ARITH_AGG_COL":
      return "AGGREGATE_DEPENDENT";
    case "GROUPING_COL":
    case "WINDOW_COL":
      return "POST_GROUP_ONLY";
    case "VARIABLE_COL":
      throw new Error("InternalError: unresolved VARIABLE_COL reached GROUP BY alias planning.");
    case "WILDCARD":
    case "PARENT_WILDCARD":
    case "FIELD":
    case "LITERAL_COL":
    case "ARITH_COL":
    case "CASE_COL":
    case "STRFUNC_COL":
    case "SCALAR_VALUE_COL":
    case "SCALAR_SUBQUERY_COL":
      return containsAggregate(column) || containsAggregateColumnNode(column)
        ? "AGGREGATE_DEPENDENT"
        : "SAFE";
  }
}

/** schema lookup が返す、API 呼び出し済みの source 列情報。 */
export type PlainGroupBySourceSchemaInput =
  | {
      readonly kind: "APP";
      readonly fieldCodes: readonly string[];
    }
  | {
      readonly kind: "SUBTABLE";
      readonly childFieldCodes: readonly string[];
      readonly parentFieldCodes: readonly string[];
    }
  | {
      readonly kind: "MATERIALIZED";
      /** MaterializedTable.columns。rows が空でもこの列定義を使う。 */
      readonly columns: readonly string[];
    };

export type PlainGroupBySourceSchemaLookup = (
  source: TableRef,
  sourceIndex: number
) => PlainGroupBySourceSchemaInput;

export interface PlainGroupBySourceSchema {
  readonly sourceIndex: number;
  /** SQL で修飾に使う source 名。alias、なければ CTE/temp 名。 */
  readonly qualifier: string | null;
  readonly columns: readonly string[];
}

const SUBTABLE_SYSTEM_COLUMNS = ["_pid", "_rid", "_idx"] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sourceColumns(input: PlainGroupBySourceSchemaInput): string[] {
  switch (input.kind) {
    case "APP":
      return unique([
        ...input.fieldCodes,
        ...APP_SYSTEM_FIELD_CODES,
      ]);
    case "SUBTABLE":
      return unique([
        ...input.childFieldCodes,
        ...SUBTABLE_SYSTEM_COLUMNS,
        ...input.parentFieldCodes.map((field) => `_p.${field}`),
      ]);
    case "MATERIALIZED":
      return unique(input.columns);
  }
}

/**
 * SELECT の FROM/JOIN 順を source identity として固定し、pure な schema view を作る。
 * lookup は既に取得済みの metadata/materialized columns だけを返し、API を呼ばない。
 */
export function resolvePlainGroupBySourceSchemas(
  stmt: Pick<SelectStatement, "from" | "joins">,
  lookup: PlainGroupBySourceSchemaLookup
): readonly PlainGroupBySourceSchema[] {
  const sources = [stmt.from, ...stmt.joins.map((join) => join.table)];
  return sources.map((source, sourceIndex) => ({
    sourceIndex,
    qualifier: source.alias ?? source.cteName,
    columns: sourceColumns(lookup(source, sourceIndex)),
  }));
}

interface ParsedGroupName {
  readonly qualifier: string | null;
  readonly fieldCode: string;
}

function parseGroupName(name: string): ParsedGroupName {
  // _p.<parent-field> は修飾名ではなく、サブテーブル仮想列そのもの。
  if (name.startsWith("_p.")) return { qualifier: null, fieldCode: name };
  const dot = name.indexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return { qualifier: null, fieldCode: name };
  }
  return { qualifier: name.slice(0, dot), fieldCode: name.slice(dot + 1) };
}

function runtimeKey(source: PlainGroupBySourceSchema, fieldCode: string): string {
  return source.qualifier === null ? fieldCode : `${source.qualifier}.${fieldCode}`;
}

function explicitAlias(column: SelectColumn): string | null {
  return "alias" in column && typeof column.alias === "string" ? column.alias : null;
}

function resolveFieldName(
  name: string,
  columns: readonly SelectColumn[],
  schemas: readonly PlainGroupBySourceSchema[]
): PlainGroupByResolution {
  const parsed = parseGroupName(name);
  const candidateSources = parsed.qualifier === null
    ? schemas
    : schemas.filter((source) => source.qualifier === parsed.qualifier);
  const physical = candidateSources.filter((source) => source.columns.includes(parsed.fieldCode));

  if (physical.length > 1) {
    throw new Error(
      `ArgumentError: GROUP BY field ${name} is ambiguous across multiple sources ` +
      "(reason=GROUP_BY_FIELD_AMBIGUOUS)."
    );
  }
  if (physical.length === 1) {
    const source = physical[0];
    return {
      kind: "PHYSICAL",
      sourceIndex: source.sourceIndex,
      fieldCode: parsed.fieldCode,
      runtimeKey: runtimeKey(source, parsed.fieldCode),
    };
  }

  // 修飾名は SELECT alias へ fallback しない。
  if (parsed.qualifier !== null) return { kind: "UNKNOWN", name };

  const aliases = columns.flatMap((column, columnIndex) =>
    explicitAlias(column) === name ? [{ column, columnIndex }] : []
  );
  if (aliases.length > 1) return { kind: "ALIAS_REJECT", reason: "DUPLICATE" };
  if (aliases.length === 1) {
    const candidate = aliases[0];
    const classification = classifyPreGroupAlias(candidate.column);
    if (classification === "SAFE") {
      return { kind: "ALIAS_SAFE", columnIndex: candidate.columnIndex };
    }
    return {
      kind: "ALIAS_REJECT",
      reason: classification === "AGGREGATE_DEPENDENT" ? "AGGREGATE" : "POST_GROUP_ONLY",
    };
  }

  const aggregateSyntheticMatch = columns.some((column) =>
    column.type === "AGGREGATE"
    && column.alias === null
    && aggregateSyntheticName(column.func, column.distinct, column.arg) === name
  );
  if (aggregateSyntheticMatch) return { kind: "ALIAS_REJECT", reason: "AGGREGATE" };
  return { kind: "UNKNOWN", name };
}

/**
 * plain GROUP BY の解決 plan を作る純粋関数。
 * 返却順そのものが group item index を保持する。
 */
export function planPlainGroupByResolution(
  groupBy: readonly GroupByKey[],
  columns: readonly SelectColumn[],
  schemas: readonly PlainGroupBySourceSchema[]
): PlainGroupByResolutionPlan {
  return {
    items: groupBy.map((key) =>
      key.type === "FIELD_NAME"
        ? resolveFieldName(key.name, columns, schemas)
        : { kind: "EXPRESSION" }
    ),
  };
}
