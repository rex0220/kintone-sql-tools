import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type {
  BinaryExpr,
  CompareOp,
  NumberLiteral,
  StringLiteral,
} from "../../../types/ast";
import {
  classifyJoinPushdownLeaf,
  type JoinPushdownSource,
} from "../joinPredicatePushdown";

const SOURCE_PATHS = [
  "src/core/optimization/whereCapability.ts",
  "src/core/optimization/joinPredicatePushdown.ts",
] as const;
const DOCUMENT_PATH = "docs/ksql_language_reference.md";
const TABLE_START = "<!-- B84_JOIN_FIELD_LITERAL_TABLE_START -->";
const TABLE_END = "<!-- B84_JOIN_FIELD_LITERAL_TABLE_END -->";

const OPERATORS: readonly {
  readonly label: string;
  readonly op: CompareOp;
}[] = [
  { label: "=", op: "=" },
  { label: "!=", op: "!=" },
  { label: "<", op: "<" },
  { label: ">", op: ">" },
  { label: "<=", op: "<=" },
  { label: ">=", op: ">=" },
  { label: "in", op: "IN" },
  { label: "not in", op: "NOT_IN" },
];

function sourceText(relativePath: string): string {
  // B103: 作業ツリーの行末（CRLF / LF）に依存させない。
  // 検査対象は文書の内容であって、行末ではない。
  return readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

function enclosingVariableName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function collectStrings(node: ts.Node, output: Set<string>): void {
  if (ts.isStringLiteral(node)) output.add(node.text);
  node.forEachChild((child) => collectStrings(child, output));
}

/**
 * 公開表の型集合を本番分類器から導く。
 *
 * 型を表す Set、native operator map のキー、fieldType との直接比較だけを対象にし、
 * capability/reason/operator/function name など同じファイル内の別リテラルは拾わない。
 */
function fieldTypesFromClassifierSources(): readonly string[] {
  const candidates = new Set<string>();

  for (const relativePath of SOURCE_PATHS) {
    const file = ts.createSourceFile(
      relativePath,
      sourceText(relativePath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "Set"
        && enclosingVariableName(node)?.includes("TYPE")) {
        collectStrings(node, candidates);
      }

      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === "NATIVE_OPERATORS"
        && node.initializer !== undefined) {
        const initializer = node.initializer;
        initializer.forEachChild(function collectNativeOperatorKeys(child): void {
          if (ts.isArrayLiteralExpression(child)
            && child.elements.length === 2
            && ts.isStringLiteral(child.elements[0])
            && ts.isNewExpression(child.elements[1])) {
            candidates.add(child.elements[0].text);
          }
          child.forEachChild(collectNativeOperatorKeys);
        });
      }

      if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
        const pair = [node.left, node.right] as const;
        const literal = pair.find(ts.isStringLiteral);
        const expression = pair.find((part) => !ts.isStringLiteral(part));
        if (literal !== undefined
          && expression !== undefined
          && /fieldType$/i.test(expression.getText(file))) {
          candidates.add(literal.text);
        }
      }

      node.forEachChild(visit);
    };
    visit(file);
  }

  return [...candidates]
    .filter((value) =>
      /^[A-Z][A-Z0-9_]*$/.test(value)
      && !value.startsWith("KSQL_")
      && !value.startsWith("__")
    )
    .sort();
}

function scalarLiteral(fieldType: string): StringLiteral | NumberLiteral {
  if (fieldType === "NUMBER" || fieldType === "CALC" || fieldType === "RECORD_NUMBER") {
    return { type: "NUMBER", value: 1, raw: "1" };
  }
  if (fieldType === "DATE") return { type: "STRING", value: "2026-07-28" };
  if (fieldType === "TIME") return { type: "STRING", value: "09:30" };
  if (fieldType === "DATETIME"
    || fieldType === "CREATED_TIME"
    || fieldType === "UPDATED_TIME") {
    return { type: "STRING", value: "2026-07-28T00:30:00Z" };
  }
  return { type: "STRING", value: "A" };
}

function predicate(fieldType: string, op: CompareOp): BinaryExpr {
  const scalar = scalarLiteral(fieldType);
  return {
    type: "BINARY",
    op,
    left: { type: "FIELD", tableAlias: "a", field: "probe" },
    right: op === "IN" || op === "NOT_IN"
      ? { type: "IN_LIST", values: [scalar] }
      : scalar,
  };
}

function source(fieldType: string): JoinPushdownSource {
  return {
    alias: "a",
    appId: 100,
    sourceKind: "APP",
    fieldTypes: new Map([["probe", fieldType]]),
    fieldOptions: new Map([["probe", new Set(["A"])]]),
  };
}

function publicRelation(fieldType: string, op: CompareOp): string {
  const relation = classifyJoinPushdownLeaf(
    predicate(fieldType, op),
    [source(fieldType)]
  ).relation;
  return relation === "unsafe" ? "押し下がらない" : "押し下がる";
}

function generatedTable(): string {
  const header = `| フィールド型 | ${OPERATORS.map(({ label }) => `\`${label}\``).join(" | ")} |`;
  const separator = `|---|${OPERATORS.map(() => ":---:").join("|")}|`;
  const rows = fieldTypesFromClassifierSources().map((fieldType) =>
    `| \`${fieldType}\` | ${OPERATORS.map(({ op }) => publicRelation(fieldType, op)).join(" | ")} |`
  );
  return [header, separator, ...rows].join("\n");
}

function documentedTable(): string {
  const document = sourceText(DOCUMENT_PATH);
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`B84 table markers are missing or out of order in ${DOCUMENT_PATH}`);
  }
  return document.slice(start + TABLE_START.length, end).trim();
}

describe("B84 JOIN field-vs-literal pushdown documentation", () => {
  test("分類器ソースから導いた型×演算子表が公開文書と一致する", () => {
    expect(documentedTable()).toBe(generatedTable());
  });
});
