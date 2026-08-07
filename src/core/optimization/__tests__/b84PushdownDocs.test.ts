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
import {
  normalizeChoiceEquality,
  type WhereFieldSemanticsResolver,
} from "../whereCapability";
import { resolveFieldSemantics } from "../../fieldSemantics";

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
  // 公開表は「観測可能な挙動」を写す。実行経路は WHERE を各プランナーで共有する前に
  // B126 の選択系 = / != 正規化（in / not in へ）を通すため、表の判定も同じ順で行う。
  // 分類器を生で呼ぶと、単一値選択系の = / != が実挙動と食い違う（✕に見える）。
  const resolver: WhereFieldSemanticsResolver = () =>
    resolveFieldSemantics({ fieldType, optionOrder: { A: 0 } });
  const normalized = normalizeChoiceEquality(
    predicate(fieldType, op),
    resolver
  ).normalizedWhere;
  const relation = classifyJoinPushdownLeaf(
    normalized as BinaryExpr,
    [source(fieldType)]
  ).relation;
  return relation === "unsafe" ? "✕" : "○";
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

  test("B151 NUMBER の追加 literal 条件を固定する", () => {
    const numberSource = source("NUMBER");
    const relation = (op: CompareOp, right: BinaryExpr["right"]) =>
      classifyJoinPushdownLeaf({
        type: "BINARY",
        op,
        left: { type: "FIELD", tableAlias: "a", field: "probe" },
        right,
      }, [numberSource]).relation;
    const number = (raw: string): NumberLiteral => ({
      type: "NUMBER",
      value: Number(raw),
      raw,
    });

    for (const raw of ["999999999999.99985", "9007199254740993", "-5", "1e3", "-0"]) {
      expect(relation("=", number(raw))).toBe("exact");
    }
    expect(relation(">=", number("1e-11"))).toBe("unsafe");
    expect(relation("IN", { type: "IN_LIST", values: [number("-5"), number("1e3")] }))
      .toBe("exact");
    expect(relation("NOT_IN", {
      type: "IN_LIST",
      values: [number("1"), { type: "STRING", value: "2" }],
    })).toBe("unsafe");
  });

  test("分類器または文書の NUMBER 1セルを戻すとパリティが崩れる", () => {
    const generated = generatedTable();
    const documented = documentedTable();
    const oldNumberRow = "| `NUMBER` | ○ | ✕ | ○ | ○ | ○ | ○ | ○ | ○ |";
    const currentNumberRow = "| `NUMBER` | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |";
    expect(generated.replace(currentNumberRow, oldNumberRow)).not.toBe(documented);
    expect(documented.replace(currentNumberRow, oldNumberRow)).not.toBe(generated);
  });

  test("B152 Phase 2+3 の分類器または文書の1セルを戻すとパリティが崩れる", () => {
    const generated = generatedTable();
    const documented = documentedTable();
    for (const [currentRow, oldRow] of [
      [
        "| `DATE` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |",
        "| `DATE` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |",
      ],
      [
        "| `SINGLE_LINE_TEXT` | ○ | ○ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |",
        "| `SINGLE_LINE_TEXT` | ○ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |",
      ],
    ]) {
      expect(generated.replace(currentRow, oldRow)).not.toBe(documented);
      expect(documented.replace(currentRow, oldRow)).not.toBe(generated);
    }
  });

  test("B152 owner decisions: CALC/RECORD_NUMBER superset and user-code exact", () => {
    const relation = (fieldType: string, op: CompareOp, right: BinaryExpr["right"]) =>
      classifyJoinPushdownLeaf({
        type: "BINARY",
        op,
        left: { type: "FIELD", tableAlias: "a", field: "probe" },
        right,
      }, [source(fieldType)]).relation;
    const number = (raw: string): NumberLiteral => ({ type: "NUMBER", value: Number(raw), raw });
    const string = (value: string): StringLiteral => ({ type: "STRING", value });

    for (const fieldType of ["CALC", "RECORD_NUMBER"]) {
      expect(relation(fieldType, ">=", number("-108"))).toBe("superset");
      expect(relation(fieldType, "=", string("CODE-1"))).toBe("superset");
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [number("1"), number("2")] }))
        .toBe("superset");
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [] })).toBe("unsafe");
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [string("")] })).toBe("unsafe");
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [number("1"), string("2")] }))
        .toBe("unsafe");
    }

    for (const fieldType of [
      "CREATOR", "MODIFIER", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT",
      "STATUS_ASSIGNEE",
    ]) {
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [string("code")] }))
        .toBe("exact");
      expect(relation(fieldType, "NOT_IN", { type: "IN_LIST", values: [string("code")] }))
        .toBe("exact");
      expect(relation(fieldType, "IN", { type: "IN_LIST", values: [string("")] }))
        .toBe("unsafe");
    }
  });

  test("B152 owner decisions の公開表1セルを戻すとパリティが崩れる", () => {
    const generated = generatedTable();
    const documented = documentedTable();
    for (const [currentRow, oldRow] of [
      [
        "| `CALC` | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |",
        "| `CALC` | ✕ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |",
      ],
      [
        "| `CREATOR` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |",
        "| `CREATOR` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ |",
      ],
      [
        "| `RECORD_NUMBER` | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |",
        "| `RECORD_NUMBER` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ○ |",
      ],
    ]) {
      expect(generated.replace(currentRow, oldRow)).not.toBe(documented);
      expect(documented.replace(currentRow, oldRow)).not.toBe(generated);
    }
  });
});
