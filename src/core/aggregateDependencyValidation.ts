import type {
  FieldRef,
  GroupByKey,
  SelectColumn,
  SelectStatement,
} from "../types/ast";
import { normalizeGroupingSpec } from "./grouping";
import type {
  PlainGroupByResolutionPlan,
  PlainGroupBySourceSchema,
} from "./optimization/plainGroupByPlan";
import { resolvePlainFieldReference } from "./optimization/plainGroupByPlan";

export const NON_GROUPED_DEPENDENCY_REASON = "B65_NON_GROUPED_DEPENDENCY";

export interface AggregateDependencyIdentityPolicy {
  readonly identities: ReadonlySet<string>;
  resolveField(ref: FieldRef): string;
  readonly sourceLabel: string;
  readonly groupingLabel: string | null;
  readonly migrationSourceSql?: string;
  readonly migrationGroupingFields?: readonly string[];
}

const WRAPPER_EXPR = new Map<string, string>([
  ["ARITH_COL", "expr"],
  ["ARITH_AGG_COL", "expr"],
  ["STRFUNC_COL", "expr"],
  ["SCALAR_VALUE_COL", "expr"],
  ["CASE_COL", "expr"],
  ["ARITH_KEY", "expr"],
  ["FUNC_KEY", "expr"],
  ["FUNC_FIELD", "expr"],
  ["ARITH_FIELD", "expr"],
  ["CASE_FIELD", "expr"],
  ["ARITH_VALUE", "expr"],
  ["CASE_VALUE", "expr"],
  ["AGG_FIELD", "expr"],
]);

function refFromName(name: string): FieldRef {
  if (name.startsWith("_p.")) return { type: "FIELD", tableAlias: null, field: name };
  const dot = name.indexOf(".");
  return dot > 0
    ? { type: "FIELD", tableAlias: name.slice(0, dot), field: name.slice(dot + 1) }
    : { type: "FIELD", tableAlias: null, field: name };
}

function fieldRefFromNode(value: Record<string, unknown>): FieldRef | null {
  const type = value["type"];
  if (type === "FIELD_REF" && typeof value["field"] === "string") {
    return refFromName(value["field"] as string);
  }
  if (type === "AGG_GROUP_KEY" && typeof value["field"] === "string") {
    return {
      type: "FIELD",
      tableAlias: typeof value["tableAlias"] === "string" ? value["tableAlias"] : null,
      field: value["field"] as string,
    };
  }
  if (type === "FIELD" && typeof value["field"] === "string") {
    if (value["aggregateRef"] !== undefined) return null;
    const tableAlias = typeof value["tableAlias"] === "string" ? value["tableAlias"] : null;
    return tableAlias === null ? refFromName(value["field"] as string) : {
      type: "FIELD",
      tableAlias,
      field: value["field"] as string,
    };
  }
  return null;
}

function isQueryBoundary(value: Record<string, unknown>): boolean {
  return value["type"] === "SELECT" || value["type"] === "SCALAR_SUBQUERY"
    || value["type"] === "SCALAR_SUBQUERY_COL" || value["type"] === "SUBQUERY_IN_LIST"
    || value["type"] === "EXISTS";
}

function isAggregateBoundary(value: Record<string, unknown>): boolean {
  return value["type"] === "AGGREGATE" || value["type"] === "AGG_REF";
}

function isWindowBoundary(value: Record<string, unknown>): boolean {
  return value["type"] === "WINDOW_COL";
}

function numberMeaning(value: Record<string, unknown>): string {
  const number = value["value"];
  if (typeof number !== "number") return "?";
  if (Object.is(number, -0)) return "0";
  return String(number);
}

function canonicalExpression(
  node: unknown,
  resolveField: (ref: FieldRef) => string
): string | null {
  if (node === null) return "null";
  if (typeof node === "string" || typeof node === "boolean") return JSON.stringify(node);
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const items = node.map((item) => canonicalExpression(item, resolveField));
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  if (typeof node !== "object") return null;
  const value = node as Record<string, unknown>;
  const type = value["type"];
  if (type === "VARIABLE" || type === "VARIABLE_COL" || isQueryBoundary(value)) return null;
  if (type === "GROUP" && value["expr"] !== undefined) {
    return canonicalExpression(value["expr"], resolveField);
  }
  const wrapper = typeof type === "string" ? WRAPPER_EXPR.get(type) : undefined;
  if (wrapper !== undefined) return canonicalExpression(value[wrapper], resolveField);
  if (type === "LITERAL_COL") return `STRING:${JSON.stringify(value["value"] ?? "")}`;
  if (type === "STRING") return `STRING:${JSON.stringify(value["value"] ?? "")}`;
  if (type === "NUMBER") return `NUMBER:${numberMeaning(value)}`;
  if (type === "BOOLEAN") return `BOOLEAN:${String(value["value"])}`;
  const ref = fieldRefFromNode(value);
  if (ref !== null) {
    try {
      return `FIELD:${resolveField(ref)}`;
    } catch {
      return null;
    }
  }
  if (type === "FIELD" && value["aggregateRef"] !== undefined) return null;

  const ignored = new Set([
    "alias", "aliasDisplay", "raw", "separator", "distinct", "source",
  ]);
  const parts: string[] = [];
  for (const key of Object.keys(value)) {
    if (key === "type" || ignored.has(key)) continue;
    const child = canonicalExpression(value[key], resolveField);
    if (child === null) return null;
    parts.push(`${key}=${child}`);
  }
  const semanticType = type === "ARITH" || type === "SCALAR_ARITH" ? "ARITH" : String(type ?? "OBJECT");
  return `${semanticType}(${parts.join(",")})`;
}

function explicitAlias(column: SelectColumn): string | null {
  return "alias" in column && typeof column.alias === "string" ? column.alias : null;
}

function aliasesByName(columns: readonly SelectColumn[]): Map<string, SelectColumn[]> {
  const result = new Map<string, SelectColumn[]>();
  for (const column of columns) {
    const alias = explicitAlias(column);
    if (alias === null) continue;
    result.set(alias, [...(result.get(alias) ?? []), column]);
  }
  return result;
}

function displayField(ref: FieldRef): string {
  return ref.tableAlias === null ? ref.field : `${ref.tableAlias}.${ref.field}`;
}

const AGGREGATE_SYNTHETIC_REFERENCE =
  /^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV_POP|STDDEV_SAMP|VAR_POP|VAR_SAMP|MEDIAN|MODE)\(/;

/**
 * 違反箇所の呼び名。**エラー文は保存クエリ・プラグイン利用者にとって唯一の案内**なので、
 * 「式」とだけ書くと列の多い SELECT でどれを直せばよいか分からない（Claude レビュー C / D）。
 *
 * 優先順は 1. 列名 2. 別名 3. 関数名 4. 「式」。
 * **素の列を別名より優先する**のは、`expressionLabel === dependencyLabel` が
 * 具体的な書き換え例を出す条件になっているためで、ここを別名にすると例が消える。
 */
function displayExpression(node: unknown): string {
  if (node && typeof node === "object") {
    const value = node as Record<string, unknown>;
    const ref = fieldRefFromNode(value);
    if (ref !== null) return displayField(ref);
    if (value["type"] === "FIELD_NAME" && typeof value["name"] === "string") return value["name"];
    if (value["type"] === "WILDCARD") return "*";
    if (value["type"] === "PARENT_WILDCARD") return "_p.*";
    // 別名があればそれが利用者の呼び名。`DATE_FORMAT(...) AS 月` は「月」と書く。
    // 関数名より先に見るのは、同じ関数の列が 2 つあると関数名では絞れないためと、
    // 算術式（別名にしか落ちない）と関数式で呼び名が割れるのを防ぐため。
    const alias = value["alias"];
    if (typeof alias === "string" && alias.length > 0) return alias;
    const wrapper = typeof value["type"] === "string" ? WRAPPER_EXPR.get(value["type"] as string) : undefined;
    if (wrapper !== undefined) {
      const inner = displayExpression(value[wrapper]);
      if (inner !== "式") return inner;
    }
    // 別名が無い式は、せめて関数名を出す。`DATE_FORMAT(...)` まで分かれば探せる。
    const func = value["func"];
    if (typeof func === "string" && func.length > 0) return `${func}(...)`;
  }
  return "式";
}

function dependencyError(
  clause: "SELECT" | "HAVING" | "ORDER BY",
  expression: unknown,
  dependency: FieldRef | "WILDCARD",
  policy: AggregateDependencyIdentityPolicy
): Error {
  const dependencyLabel = dependency === "WILDCARD" ? "wildcard" : displayField(dependency);
  const expressionLabel = dependency === "WILDCARD" ? displayExpression(expression) : displayExpression(expression);
  const groupText = policy.groupingLabel === null
    ? "GROUP BY がないため入力全体が1グループになり"
    : `${policy.groupingLabel} の各グループでは`;
  const migration = dependency === "WILDCARD"
    ? "必要な grouping 列を明示して SELECT してください。"
    : `「${dependencyLabel}」を MIN() などの集計関数で包むか、GROUP BY へ追加してください。`;
  const concreteMigration = dependency !== "WILDCARD"
    && dependency.tableAlias === null
    && expressionLabel === dependencyLabel
    && policy.migrationSourceSql !== undefined
    ? policy.migrationGroupingFields && policy.migrationGroupingFields.length > 0
      ? ` 実行可能な書き換え例: 「SELECT ${policy.migrationGroupingFields.join(", ")}, MIN(${dependencyLabel}) ` +
        `FROM ${policy.migrationSourceSql} GROUP BY ${policy.migrationGroupingFields.join(", ")}」。`
      : ` 実行可能な書き換え例: 「SELECT MIN(${dependencyLabel}) FROM ${policy.migrationSourceSql}」。`
    : "";
  return new Error(
    `ArgumentError: ${clause} 式「${expressionLabel}」は集計もグループ化もされていません` +
    `（${policy.sourceLabel}、非グループ化依存: ${dependencyLabel}）。` +
    `${groupText}、どの行の値を返すか決まりません。${migration}${concreteMigration} ` +
    `(reason=${NON_GROUPED_DEPENDENCY_REASON})`
  );
}

interface WalkContext {
  readonly clause: "SELECT" | "HAVING" | "ORDER BY";
  readonly expression: unknown;
  readonly policy: AggregateDependencyIdentityPolicy;
  readonly aliases: ReadonlyMap<string, SelectColumn[]>;
  readonly resolvingAliases: ReadonlySet<string>;
}

function walkDependency(node: unknown, context: WalkContext): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkDependency(child, context);
    return;
  }
  const value = node as Record<string, unknown>;
  if (isQueryBoundary(value) || isAggregateBoundary(value) || isWindowBoundary(value)) return;
  if (value["type"] === "GROUPING_REF" || value["type"] === "GROUPING_FIELD"
    || value["type"] === "GROUPING_COL" || value["type"] === "GROUPING_KEY") return;
  if (value["type"] === "WILDCARD" || value["type"] === "PARENT_WILDCARD") {
    throw dependencyError(context.clause, context.expression, "WILDCARD", context.policy);
  }

  const ref = fieldRefFromNode(value);
  if (ref !== null) {
    if (context.clause !== "SELECT" && ref.tableAlias === null
      && AGGREGATE_SYNTHETIC_REFERENCE.test(ref.field)) return;
    if (context.clause !== "SELECT" && ref.tableAlias === null) {
      const targets = context.aliases.get(ref.field) ?? [];
      if (targets.length === 1 && !context.resolvingAliases.has(ref.field)) {
        const resolvingAliases = new Set(context.resolvingAliases);
        resolvingAliases.add(ref.field);
        walkDependency(targets[0], { ...context, resolvingAliases });
        return;
      }
    }
    const canonical = canonicalExpression(value, context.policy.resolveField);
    if (canonical !== null && context.policy.identities.has(canonical)) return;
    const identity = `FIELD:${context.policy.resolveField(ref)}`;
    if (!context.policy.identities.has(identity)) {
      throw dependencyError(context.clause, context.expression, ref, context.policy);
    }
    return;
  }

  const canonical = canonicalExpression(value, context.policy.resolveField);
  if (canonical !== null && context.policy.identities.has(canonical)) return;

  const wrapper = typeof value["type"] === "string" ? WRAPPER_EXPR.get(value["type"] as string) : undefined;
  if (wrapper !== undefined) {
    walkDependency(value[wrapper], context);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === "type" || key === "alias" || key === "aliasDisplay" || key === "raw") continue;
    walkDependency(value[key], context);
  }
}

/** Common SELECT/HAVING/ORDER BY dependency walk used by ordinary and B65 policies. */
export function validateAggregateDependencies(
  stmt: SelectStatement,
  policy: AggregateDependencyIdentityPolicy
): void {
  const aliases = aliasesByName(stmt.columns);
  for (const column of stmt.columns) {
    if (column.type === "WINDOW_COL") continue;
    walkDependency(column, {
      clause: "SELECT",
      expression: column,
      policy,
      aliases,
      resolvingAliases: new Set(),
    });
  }
  if (stmt.having !== null) {
    walkDependency(stmt.having, {
      clause: "HAVING",
      expression: stmt.having,
      policy,
      aliases,
      resolvingAliases: new Set(),
    });
  }
  for (const order of stmt.orderBy) {
    const key = order.key.type === "FIELD_NAME" ? refFromName(order.key.name) : order.key;
    walkDependency(key, {
      clause: "ORDER BY",
      expression: key,
      policy,
      aliases,
      resolvingAliases: new Set(),
    });
  }
}

function hasAggregateNode(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasAggregateNode);
  const value = node as Record<string, unknown>;
  if (isQueryBoundary(value) || isWindowBoundary(value)) return false;
  if (isAggregateBoundary(value) || value["type"] === "ARITH_AGG_COL") return true;
  return Object.values(value).some(hasAggregateNode);
}

export function isAggregateQueryBlock(stmt: SelectStatement): boolean {
  return normalizeGroupingSpec(stmt).type !== "NONE"
    || stmt.columns.some((column) => column.type !== "WINDOW_COL" && hasAggregateNode(column));
}

function groupByKeyNode(key: GroupByKey): unknown {
  if (key.type === "FIELD_NAME") return refFromName(key.name);
  return key.expr;
}

export function buildOrdinaryDependencyPolicy(
  stmt: SelectStatement,
  plan: PlainGroupByResolutionPlan,
  schemas: readonly PlainGroupBySourceSchema[]
): AggregateDependencyIdentityPolicy {
  const normalized = normalizeGroupingSpec(stmt);
  if (normalized.type !== "PLAIN") {
    throw new Error("InternalError: ordinary dependency policy requires plain GROUP BY.");
  }
  const groupBy = normalized.allItems;
  const resolveField = (ref: FieldRef): string => {
    const resolution = resolvePlainFieldReference(ref, schemas);
    if (resolution.kind === "AMBIGUOUS") {
      throw new Error(`ArgumentError: field ${resolution.name} is ambiguous across multiple sources.`);
    }
    if (resolution.kind === "UNKNOWN") return `unknown:${resolution.name}`;
    return `source:${resolution.sourceIndex}:${resolution.fieldCode}`;
  };
  const identities = new Set<string>();
  plan.items.forEach((item, index) => {
    if (item.kind === "PHYSICAL") {
      identities.add(`FIELD:source:${item.sourceIndex}:${item.fieldCode}`);
      return;
    }
    if (item.kind === "ALIAS_SAFE") {
      const key = canonicalExpression(stmt.columns[item.columnIndex], resolveField);
      if (key !== null) identities.add(key);
      return;
    }
    if (item.kind === "EXPRESSION") {
      const key = canonicalExpression(groupByKeyNode(groupBy[index]), resolveField);
      if (key !== null) identities.add(key);
    }
  });
  const sources = [stmt.from, ...stmt.joins.map((join) => join.table)];
  // サブテーブル仮想テーブルは `APPn$表` で 1 つの表。`APPn` だけを書くと別の表を指す。
  // 親には `_pid` も明細項目も無いので、それを案内すると unknown field code(s) で落ちる
  // （codex 最終チェック 1・実測で再現）。しかもその文面は v3.56.1 で
  // 「そんな項目は無い」と誤読されると直したばかりのもので、二重に悪い。
  const sourceSql = (source: typeof stmt.from): string =>
    `APP${source.appId}${source.subtableCode != null ? `$${source.subtableCode}` : ""}`;
  const sourceLabel = sources.map((source) => source.cteName ?? sourceSql(source)).join(" / ");
  const groupingLabel = `GROUP BY ${groupBy.map((key) =>
    key.type === "FIELD_NAME" ? key.name : displayExpression(key)
  ).join(", ")}`;
  const directAppSource = sources.length === 1 && sources[0].cteName === null
    ? `${sourceSql(sources[0])}${sources[0].alias && sources[0].alias !== sourceSql(sources[0])
      ? ` ${sources[0].alias}` : ""}`
    : undefined;
  const migrationGroupingFields = groupBy.every((key, index) =>
    key.type === "FIELD_NAME" && plan.items[index]?.kind === "PHYSICAL"
  )
    ? groupBy.map((key) => (key as Extract<GroupByKey, { type: "FIELD_NAME" }>).name)
    : undefined;
  return {
    identities,
    resolveField,
    sourceLabel,
    groupingLabel,
    migrationSourceSql: directAppSource,
    migrationGroupingFields,
  };
}

/** AST-only certainty used by ksql_validate: no-GROUP-BY aggregate has no identities. */
export function validateAggregateDependenciesStatic(stmt: SelectStatement): void {
  if (normalizeGroupingSpec(stmt).type !== "NONE" || !isAggregateQueryBlock(stmt)) return;
  const policy: AggregateDependencyIdentityPolicy = {
    identities: new Set(),
    resolveField: (ref) => `ast:${displayField(ref)}`,
    sourceLabel: stmt.from.cteName ?? `APP${stmt.from.appId}`,
    groupingLabel: null,
    migrationSourceSql: stmt.from.cteName === null && stmt.joins.length === 0
      ? `APP${stmt.from.appId}${stmt.from.alias && stmt.from.alias !== `APP${stmt.from.appId}`
        ? ` ${stmt.from.alias}` : ""}`
      : undefined,
  };
  validateAggregateDependencies(stmt, policy);
}

export function canonicalGroupingFieldIdentity(canonicalId: string): string {
  return `FIELD:${canonicalId}`;
}
