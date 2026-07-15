import type { Statement } from "../types/ast";

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 外部注入キーを DECLARE/SET と同じ名前規則へ正規化する。 */
export function normalizeBatchVariableName(name: string): string {
  if (!VARIABLE_NAME_RE.test(name)) {
    throw new Error(
      `ArgumentError: invalid variable name "${name}". Use a name without @ matching [A-Za-z_][A-Za-z0-9_]{0,63}.`
    );
  }
  return name.toLowerCase();
}

/** MCP/CLI の注入オブジェクトを正規化し、大文字小文字違いの重複を拒否する。 */
export function normalizeBatchVariables(
  input: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  // `__proto__` も変数名として有効なため、prototype setter を持たない辞書を使う。
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = normalizeBatchVariableName(rawName);
    if (Object.prototype.hasOwnProperty.call(normalized, name)) {
      throw new Error(`ArgumentError: variable "${rawName}" is specified more than once.`);
    }
    normalized[name] = value;
  }
  return normalized;
}

/** 注入先を DECLARE 文だけに限定し、実行開始前にタイポを拒否する。 */
export function validateDeclaredBatchVariables(
  statements: readonly Statement[],
  input: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  const normalized = normalizeBatchVariables(input);
  const declared = new Set(
    statements
      .filter((stmt) => stmt.type === "DECLARE_VARIABLE")
      .map((stmt) => stmt.name)
  );
  for (const name of Object.keys(normalized)) {
    if (!declared.has(name)) {
      throw new Error(`ArgumentError: injected variable @${name} is not declared.`);
    }
  }
  return normalized;
}
