import type { Statement } from "../types/ast";

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * B203: 外部注入で受ける値。文字列（スカラー）と文字列配列（`IN @x` / `NOT IN @x` 専用）。
 * どちらを渡せるかは DECLARE 側が決める（配列の宣言には配列、スカラーの宣言には文字列）。
 */
export type BatchVariableInput = string | readonly string[];

/** B203: 配列の要素数の既定の上限。実際の壁は kintone へ送るクエリ（URL）の長さ。 */
export const DEFAULT_VARIABLE_ARRAY_MAX_ELEMENTS = 500;

export interface BatchVariableLimits {
  /** 配列の要素数の上限（正の安全な整数。省略時は DEFAULT_VARIABLE_ARRAY_MAX_ELEMENTS） */
  readonly arrayMaxElements?: number;
}

/** 外部注入キーを DECLARE/SET と同じ名前規則へ正規化する。 */
export function normalizeBatchVariableName(name: string): string {
  if (!VARIABLE_NAME_RE.test(name)) {
    throw new Error(
      `ArgumentError: invalid variable name "${name}". Use a name without @ matching [A-Za-z_][A-Za-z0-9_]{0,63}.`
    );
  }
  return name.toLowerCase();
}

function assertInjectedValue(name: string, value: unknown): BatchVariableInput {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const bad = value.findIndex((element) => typeof element !== "string");
    if (bad >= 0) {
      throw new Error(
        `ArgumentError: injected variable @${name} must be an array of strings; element ${bad + 1} is ${
          value[bad] === null ? "null" : typeof value[bad]
        }.`
      );
    }
    return value as readonly string[];
  }
  throw new Error(
    `ArgumentError: injected variable @${name} must be a string or an array of strings; found ${
      value === null ? "null" : typeof value
    }.`
  );
}

/** MCP/CLI/flow の注入オブジェクトを正規化し、大文字小文字違いの重複を拒否する。 */
export function normalizeBatchVariables(
  input: Readonly<Record<string, BatchVariableInput>> | undefined
): Readonly<Record<string, BatchVariableInput>> {
  // `__proto__` も変数名として有効なため、prototype setter を持たない辞書を使う。
  const normalized: Record<string, BatchVariableInput> = Object.create(null) as Record<string, BatchVariableInput>;
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = normalizeBatchVariableName(rawName);
    if (Object.prototype.hasOwnProperty.call(normalized, name)) {
      throw new Error(`ArgumentError: variable "${rawName}" is specified more than once.`);
    }
    normalized[name] = assertInjectedValue(name, value);
  }
  return normalized;
}

function resolveArrayMaxElements(limits: BatchVariableLimits | undefined): number {
  const value = limits?.arrayMaxElements;
  if (value === undefined) return DEFAULT_VARIABLE_ARRAY_MAX_ELEMENTS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `ArgumentError: variableArrayMaxElements must be a positive safe integer; found ${String(value)}.`
    );
  }
  return value;
}

/**
 * 注入先を DECLARE 文だけに限定し、実行開始前にタイポを拒否する。
 * B203: 宣言が種類（スカラー / 配列）を決めるので、食い違いと要素数の超過もここで止める
 * （records API を 1 回も呼ばず、書き込みも 0 回のまま）。
 */
export function validateDeclaredBatchVariables(
  statements: readonly Statement[],
  input: Readonly<Record<string, BatchVariableInput>> | undefined,
  limits?: BatchVariableLimits
): Readonly<Record<string, BatchVariableInput>> {
  const normalized = normalizeBatchVariables(input);
  const arrayMaxElements = resolveArrayMaxElements(limits);
  const declarations = new Map<string, Statement & { type: "DECLARE_VARIABLE" }>();
  for (const stmt of statements) {
    if (stmt.type === "DECLARE_VARIABLE" && !declarations.has(stmt.name)) declarations.set(stmt.name, stmt);
  }
  for (const [name, declaration] of declarations) {
    if (declaration.annotation === "RELATIVE_DATE" || declaration.default.type !== "ARRAY") continue;
    assertArrayLength(name, declaration.default.elements.length, arrayMaxElements, "DECLARE default");
  }
  for (const [name, value] of Object.entries(normalized)) {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      throw new Error(`ArgumentError: injected variable @${name} is not declared.`);
    }
    const declaredArray = declaration.annotation !== "RELATIVE_DATE" && declaration.default.type === "ARRAY";
    const injectedArray = Array.isArray(value);
    if (declaration.annotation === "RELATIVE_DATE" && injectedArray) {
      throw new Error(
        `ArgumentError: variable @${name} is declared as RELATIVE_DATE; inject a relative date token string.`
      );
    }
    if (declaredArray && !injectedArray) {
      throw new Error(
        `ArgumentError: variable @${name} is declared as an array (DECLARE @${name} = [...]); inject an array of strings.`
      );
    }
    if (!declaredArray && injectedArray) {
      throw new Error(
        `ArgumentError: variable @${name} is declared as a scalar; inject a string, or declare it as an array (DECLARE @${name} = []).`
      );
    }
    if (injectedArray) {
      assertArrayLength(name, (value as readonly string[]).length, arrayMaxElements, "injected value");
    }
  }
  return normalized;
}

function assertArrayLength(name: string, length: number, max: number, source: string): void {
  if (length <= max) return;
  throw new Error(
    `ArgumentError: array variable @${name} has ${length} elements (${source}) and exceeds `
    + `variableArrayMaxElements (${max}). kintone receives the elements as an IN list in the request URL, `
    + "so keep the element count small or raise the limit explicitly."
  );
}
