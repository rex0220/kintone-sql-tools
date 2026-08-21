import type { Statement, UpsertSelectStatement, UpsertStatement, WhereExpr } from "../types/ast";
import type { KintoneFieldInfo } from "../execute";
import { isRelativeDateFunctionName } from "./relativeDateFunction";
import { serverOnlyFunctionOccurrencesInWhere } from "./optimization/relativeDateFullScanExactPlan";
import type { ScriptHeaderMeta } from "./scriptHeader";
import { DiagnosticCodes, type Diagnostic, type DiagnosticCode } from "./diagnostics";

export type Dialect1SchemaResolver = (
  appId: number
) => readonly KintoneFieldInfo[] | Promise<readonly KintoneFieldInfo[]>;

export interface ValidateScriptCoreOptions {
  strict?: boolean;
}

export const DIALECT1_SERVER_TIME_FUNCTION_WARNING =
  "bare の時刻依存関数は kintone サーバー評価のため as-of の対象外です。再現性が必要なら @ 付き関数を使用してください。";

interface UpdateKeyIssue {
  code: Extract<DiagnosticCode,
    | typeof DiagnosticCodes.UPDATE_KEY_COMPOSITE
    | typeof DiagnosticCodes.UPDATE_KEY_FIELD_TYPE
    | typeof DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE>;
  severity: "error" | "warning";
  message: string;
}

/**
 * Dialect 1 の内部検証面。位置情報は Stage 6 の source-aware adapter が補完するため、
 * AST 単体の本 API では各文の先頭を 1:1 として返す。
 */
export async function validateScriptCore(
  statements: readonly Statement[],
  meta: ScriptHeaderMeta,
  schema?: Dialect1SchemaResolver,
  opts: ValidateScriptCoreOptions = {}
): Promise<Diagnostic[]> {
  if (meta.dialect !== 1) return [];

  const diagnostics: Diagnostic[] = [];
  for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
    const statement = statements[statementIndex];
    const add = (
      severity: Diagnostic["severity"],
      code: DiagnosticCode,
      message: string
    ): void => {
      diagnostics.push({ severity, code, message, line: 1, column: 1, statementIndex });
    };

    if (isUpsert(statement)) {
      for (const issue of validateDialect1UpdateKey(statement)) {
        add(issue.severity, issue.code, issue.message);
      }
      if (schema !== undefined && statement.keyFields.length === 1) {
        const fields = await schema(statement.appId);
        for (const issue of validateDialect1UpdateKey(statement, fields)) {
          add(issue.severity, issue.code, issue.message);
        }
      }
    }

    if (
      (statement.type === "INSERT" || statement.type === "UPDATE" || statement.type === "DELETE")
      && statement.subtableCode
    ) {
      add(
        "error",
        DiagnosticCodes.SUBTABLE_DML_FORBIDDEN,
        "dialect 1 ではサブテーブル仮想テーブルへの DML はできません。SELECT は可能です。親アプリを対象にするか dialect 0 のサブテーブル DML を使用してください。"
      );
    }

    if (statement.type === "INSERT" || statement.type === "INSERT_SELECT") {
      add(
        opts.strict === true ? "error" : "warning",
        DiagnosticCodes.BARE_INSERT_NOT_IDEMPOTENT,
        "dialect 1 の素の INSERT は再実行で重複する可能性があります。冪等性のため UPSERT / MERGE を推奨します。"
      );
    }

    if (statementHasBareServerTimeFunctionInWhere(statement)) {
      add("warning", DiagnosticCodes.SERVER_TIME_FUNCTION_NOT_AS_OF, DIALECT1_SERVER_TIME_FUNCTION_WARNING);
    }
  }
  return diagnostics;
}

/** updateKey の三条件を静的検証と実行前 prepare で共有する。 */
export function validateDialect1UpdateKey(
  statement: UpsertStatement | UpsertSelectStatement,
  fieldInfos?: readonly KintoneFieldInfo[]
): UpdateKeyIssue[] {
  if (fieldInfos === undefined) {
    return statement.keyFields.length === 1 ? [] : [{
      code: DiagnosticCodes.UPDATE_KEY_COMPOSITE,
      severity: "error",
      message: "dialect 1 の UPSERT / MERGE のキーは単一フィールドである必要があります。複合キーの代わりに、連結キーフィールド（例: 顧客コード_年月）をアプリ側に用意してください。",
    }];
  }
  if (statement.keyFields.length !== 1) return [];

  const key = statement.keyFields[0];
  const field = fieldInfos.find((candidate) => candidate.code === key);
  const issues: UpdateKeyIssue[] = [];
  if (field === undefined || (field.fieldType !== "SINGLE_LINE_TEXT" && field.fieldType !== "NUMBER")) {
    issues.push({
      code: DiagnosticCodes.UPDATE_KEY_FIELD_TYPE,
      severity: "error",
      message: field === undefined
        ? `UPSERT / MERGE のキー「${key}」が APP${statement.appId} のフォームに存在しません。重複禁止を設定した文字列（1行）または数値フィールドをキーにしてください。`
        : `UPSERT / MERGE のキー「${key}」の型 ${field.fieldType} は使用できません。重複禁止を設定した文字列（1行）または数値フィールドをキーにしてください。`,
    });
  }
  if (field?.isUnique === false) {
    issues.push({
      code: DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE,
      severity: "error",
      message: `UPSERT / MERGE のキー「${key}」は重複禁止ではありません。アプリのフィールド設定で「値の重複を禁止する」を有効にしてください。`,
    });
  } else if (field !== undefined && field.isUnique === undefined) {
    issues.push({
      code: DiagnosticCodes.UPDATE_KEY_NOT_UNIQUE,
      severity: "warning",
      message: `UPSERT / MERGE のキー「${key}」の重複禁止設定を schema resolver から確認できません。isUnique を返す resolver を使用し、アプリ側で「値の重複を禁止する」が有効か確認してください。`,
    });
  }
  return issues;
}

export function statementHasBareServerTimeFunctionInWhere(statement: Statement): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const value = node as Record<string, unknown>;
    const where = value["where"];
    if (where !== null && typeof where === "object") {
      const names = serverOnlyFunctionOccurrencesInWhere(where as WhereExpr);
      if (names.some((name) => name === "TODAY" || name === "NOW" || isRelativeDateFunctionName(name))) {
        found = true;
        return;
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(statement);
  return found;
}

function isUpsert(statement: Statement): statement is UpsertStatement | UpsertSelectStatement {
  return statement.type === "UPSERT" || statement.type === "UPSERT_SELECT";
}
