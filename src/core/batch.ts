// ============================================================
// バッチ静的検証（フェーズ1 S3）
//
// parseStatements() の結果に対して実行前に行う検証:
//   - 一時テーブルの静的解決
//     （未定義参照 / 再定義 / DROP 後参照 / 同時個数上限）
//   - 依存グラフ（文 index → 依存する CREATE 文の index）
//   - 文ごとの分類（statementType / isDml / isReadOnly など）
//   - 単文入力での CREATE / DROP TEMP TABLE の拒否（仕様 §4.3）
//
// ここは「1文でも不正ならバッチ全体を拒否する」validate-all-first の
// 静的検証部分であり、kintone へのアクセスは一切行わない。
// ============================================================

import type { Statement } from "../types/ast";
import {
  getInsertValuesCount,
  getStatementType,
  hasWhereClause,
  isDmlType,
  isReadOnlyType,
  isReadOnlyStatement,
  requiresCompleteInput,
  writesKintone,
} from "./dmlGuard";
import { KlikeValidationError, validateKlikeStatement } from "./klikeValidation";

/** バッチ内で同時に存在できる一時テーブル数の上限（仕様 §5.6） */
export const MAX_TEMP_TABLES = 16;
/** バッチ内で定義できる変数の総数上限。現行の文数上限20では実質的な将来予約。 */
export const MAX_BATCH_VARIABLES = 64;

// ------------------------------------------------------------
// エラー
// ------------------------------------------------------------

/**
 * バッチ静的検証エラー。
 * message は既存の MCP エラー規約（"ParseError: ..." / "ArgumentError: ..." の
 * 接頭辞をコードとして抽出する）に合わせるため、name はあえて "Error" のまま。
 */
export class BatchAnalysisError extends Error {
  constructor(
    message: string,
    /** 違反が検出された文の index（0-indexed） */
    public readonly statementIndex: number
  ) {
    super(message);
  }
}

// ------------------------------------------------------------
// 解析結果の型
// ------------------------------------------------------------

/** 文ごとの静的解析結果（仕様 §7.1 の statements[] に対応する core 部分）。
 *  appIds も AST から収集してここで埋める。@profile の正規化自体は呼び出し側
 *  （node/MCP 層）がパース前の SQL 文字列に対して行う前提 */
export interface StatementAnalysis {
  index: number;
  statementType: string;
  isDml: boolean;
  isReadOnly: boolean;
  hasWhere: boolean;
  insertValuesCount: number | null;
  /** この文が参照するアプリ ID（FROM / JOIN / サブクエリ / DML 対象を含む、昇順）。
   *  @profile 正規化後の SQL をパースした場合はマップ済み擬似 ID を含む */
  appIds: number[];
  /** この文が CREATE する一時テーブル名（CREATE_TEMP_TABLE のみ、それ以外は空） */
  tempTablesCreated: string[];
  /** この文が参照する一時テーブル名（FROM / JOIN / サブクエリ / WITH 内 / DML の SELECT ソースを含む） */
  tempTablesReferenced: string[];
  /** この文が DROP する一時テーブル名（DROP_TEMP_TABLE のみ、それ以外は空） */
  tempTablesDropped: string[];
  /** 依存する先行文の index（参照・DROP する一時テーブルを CREATE した文）。
   *  S4 の continue-on-error 時の依存スキップに使う */
  dependsOn: number[];
  /** INSERT_SELECT / UPSERT_SELECT の SELECT ソースが一時テーブルのみか
   *  （kintone アプリを一切読まない）。M4 の解禁判定に使う。他の文タイプでは false */
  tempOnlySource: boolean;
  /** DML の書き込み対象アプリ ID（DML 以外は null）。
   *  appIds は SELECT ソースやサブクエリの参照先も含むため、
   *  確認プロンプト等で「変更されるアプリ」を示す用途にはこちらを使う */
  targetAppId: number | null;
  /** UPDATE ... FROM。ソース読み取り上限を影響行数から分離するために使う。 */
  isUpdateFrom: boolean;
  isValidationOnly: boolean;
  isOnErrorSkip: boolean;
  requiresCompleteInput: boolean;
}

export interface BatchVariableAnalysis {
  name: string;
  referencedBy: number[];
}

/** バッチ全体の静的解析結果 */
export interface BatchAnalysis {
  statementCount: number;
  /** DML を1文も含まないか（一時テーブルの CREATE / DROP は read-only 扱い） */
  isReadOnlyBatch: boolean;
  containsDml: boolean;
  containsValidationOnly: boolean;
  requiresCompleteInput: boolean;
  /** バッチ内で CREATE される一時テーブル名（出現順。DROP 後の再 CREATE も含む） */
  tempTables: string[];
  variables: BatchVariableAnalysis[];
  /** 現在は未使用変数のみ。実行可否には影響しない。 */
  warnings: string[];
  statements: StatementAnalysis[];
}

// ------------------------------------------------------------
// 一時テーブル参照の収集
// ------------------------------------------------------------

/**
 * AST を深さ優先で走査し、一時テーブル参照とアプリ ID を集める。
 *
 * - 一時テーブル参照: `cteName` が "#" で始まるノード。参照はテーブル参照位置
 *   （parseTableRef）でのみ生成され常に cteName フィールドに格納されるため、
 *   埋め込み位置（サブクエリ / JOIN / WITH 内 / UNION の枝 / INSERT_SELECT の
 *   ソース等）を列挙せずに拾える。CTE 名は "#" で始められない（パーサで拒否）
 *   ため誤検出しない。
 * - アプリ ID: `appId` が正の数値のノード（0 は CTE / 一時テーブル / FROM なし
 *   SELECT のプレースホルダのため除外）
 */
function collectRefs(node: unknown, tempRefs: Set<string>, appIds: Set<number>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, tempRefs, appIds);
    return;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const cte = obj["cteName"];
    if (typeof cte === "string" && cte.startsWith("#")) tempRefs.add(cte);
    const appId = obj["appId"];
    if (typeof appId === "number" && appId > 0) appIds.add(appId);
    for (const v of Object.values(obj)) collectRefs(v, tempRefs, appIds);
  }
}

function collectVariableRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectVariableRefs(v, refs);
    return;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["type"] === "VARIABLE" && typeof obj["name"] === "string") {
      refs.add(obj["name"]);
      return;
    }
    for (const v of Object.values(obj)) collectVariableRefs(v, refs);
  }
}

// ------------------------------------------------------------
// 本体
// ------------------------------------------------------------

/**
 * バッチを静的検証し、文ごとの解析結果を返す。違反があれば BatchAnalysisError を投げる。
 * 実行順に一時テーブルの定義状態（live セット）を追跡する:
 *   - 未定義（または DROP 済み）の参照 → エラー
 *   - live な同名の再 CREATE → エラー（DROP 後の再 CREATE は許容）
 *   - live 数が MAX_TEMP_TABLES を超過 → エラー
 */
export function analyzeBatch(statements: Statement[]): BatchAnalysis {
  // 空バッチ（空入力・セミコロンのみ）は拒否する。
  // parseStatements() は空配列を返す設計のため、ここで止めないと
  // 「有効なバッチ」として下流（S4 実行器 / S5 validate）に流れてしまう
  if (statements.length === 0) {
    throw new BatchAnalysisError("ArgumentError: SQL is empty.", 0);
  }

  statements.forEach((stmt, index) => {
    try {
      validateKlikeStatement(stmt);
    } catch (error) {
      if (error instanceof KlikeValidationError) {
        throw new BatchAnalysisError(error.message, index);
      }
      throw error;
    }
  });

  // 単文入力の CREATE / DROP TEMP TABLE は無意味なため拒否（仕様 §4.3）
  if (statements.length === 1) {
    const t = statements[0].type;
    if (t === "SET_VARIABLE" || t === "DECLARE_VARIABLE") {
      const verb = t === "SET_VARIABLE" ? "SET" : "DECLARE";
      throw new BatchAnalysisError(`ArgumentError: ${verb} variable requires a batch.`, 0);
    }
    if (t === "CREATE_TEMP_TABLE" || t === "DROP_TEMP_TABLE") {
      const verb = t === "CREATE_TEMP_TABLE" ? "CREATE TEMP TABLE" : "DROP TEMP TABLE";
      throw new BatchAnalysisError(
        `ArgumentError: ${verb} requires a batch (temp tables are batch-scoped).`,
        0
      );
    }
  }

  /** live な一時テーブル名 → CREATE した文の index */
  const defined = new Map<string, number>();
  const validationSchemas = new Map<string, string>();
  const createdOrder: string[] = [];
  const results: StatementAnalysis[] = [];
  const variableDefs = new Map<string, { index: number; referencedBy: number[] }>();
  const variableOrder: string[] = [];

  statements.forEach((stmt, index) => {
    const validationTable = "validationErrorTable" in stmt && stmt.validationErrorTable
      ? stmt.validationErrorTable
      : ("onErrorSkip" in stmt && stmt.onErrorSkip ? stmt.errorTable ?? null : null);
    if (statements.length === 1 && validationTable) {
      const message = "onErrorSkip" in stmt && stmt.onErrorSkip
        ? "ArgumentError: ON ERROR SKIP requires a batch."
        : "ArgumentError: VALIDATE ONLY INTO requires a batch.";
      throw new BatchAnalysisError(message, index);
    }
    const statementType = getStatementType(stmt);
    const created: string[] = [];
    const dropped: string[] = [];
    const refs = new Set<string>();
    const stmtAppIds = new Set<number>();
    const dependsOn = new Set<number>();
    const variableRefs = new Set<string>();
    collectVariableRefs(stmt, variableRefs);

    for (const name of variableRefs) {
      const def = variableDefs.get(name);
      if (def === undefined) {
        throw new BatchAnalysisError(
          `ParseError: variable @${name} is not defined before statement ${index + 1}.`,
          index
        );
      }
      def.referencedBy.push(index);
    }

    if (stmt.type === "SET_VARIABLE" || stmt.type === "DECLARE_VARIABLE") {
      if (variableDefs.has(stmt.name)) {
        throw new BatchAnalysisError(`ParseError: variable @${stmt.name} is already defined.`, index);
      }
      variableDefs.set(stmt.name, { index, referencedBy: [] });
      variableOrder.push(stmt.name);
      if (variableOrder.length > MAX_BATCH_VARIABLES) {
        throw new BatchAnalysisError(
          `ParseError: batch exceeds ${MAX_BATCH_VARIABLES} variables.`,
          index
        );
      }
    }

    if (stmt.type === "CREATE_TEMP_TABLE") {
      // AS 句の SELECT が他の一時テーブルを参照し得る（name は cteName ではないので拾われない）
      collectRefs(stmt.query, refs, stmtAppIds);
    } else if (stmt.type === "DROP_TEMP_TABLE") {
      // DROP は参照ではないが、対象の CREATE に依存する
    } else {
      collectRefs(stmt, refs, stmtAppIds);
    }

    // INSERT_SELECT / UPSERT_SELECT: SELECT ソースが一時テーブルのみか
    //（書き込み先アプリは含めず、SELECT 側だけを走査する）
    let tempOnlySource = false;
    if (stmt.type === "INSERT_SELECT" || stmt.type === "UPSERT_SELECT") {
      const srcTemp = new Set<string>();
      const srcApps = new Set<number>();
      collectRefs(stmt.select, srcTemp, srcApps);
      tempOnlySource = srcTemp.size > 0 && srcApps.size === 0;
    }

    // 参照の解決（DROP 済みは defined から消えているため「DROP 後参照」もここで落ちる）
    for (const name of refs) {
      const at = defined.get(name);
      if (at === undefined) {
        throw new BatchAnalysisError(
          `ParseError: temp table ${name} is not defined in this batch.`,
          index
        );
      }
      dependsOn.add(at);
    }

    if (validationTable) {
      const payloadFields = stmt.type === "UPDATE"
        ? ["$id", ...stmt.assignments.map((a) => a.field)]
        : ("fields" in stmt ? stmt.fields : []);
      const signature = JSON.stringify(payloadFields);
      const at = defined.get(validationTable);
      if (at === undefined) {
        defined.set(validationTable, index);
        validationSchemas.set(validationTable, signature);
        createdOrder.push(validationTable);
        created.push(validationTable);
        if (defined.size > MAX_TEMP_TABLES) {
          throw new BatchAnalysisError(`ParseError: batch exceeds ${MAX_TEMP_TABLES} temp tables.`, index);
        }
      } else {
        if (validationSchemas.get(validationTable) !== signature) {
          throw new BatchAnalysisError(
            `ParseError: validation error table ${validationTable} has a different payload schema.`,
            index
          );
        }
        dependsOn.add(at);
      }
    }

    if (stmt.type === "CREATE_TEMP_TABLE") {
      if (defined.has(stmt.name)) {
        throw new BatchAnalysisError(
          `ParseError: temp table ${stmt.name} is already defined.`,
          index
        );
      }
      defined.set(stmt.name, index);
      createdOrder.push(stmt.name);
      created.push(stmt.name);
      if (defined.size > MAX_TEMP_TABLES) {
        throw new BatchAnalysisError(
          `ParseError: batch exceeds ${MAX_TEMP_TABLES} temp tables.`,
          index
        );
      }
    }

    if (stmt.type === "DROP_TEMP_TABLE") {
      const at = defined.get(stmt.name);
      if (at === undefined) {
        throw new BatchAnalysisError(
          `ParseError: temp table ${stmt.name} is not defined in this batch.`,
          index
        );
      }
      dependsOn.add(at);
      dropped.push(stmt.name);
      defined.delete(stmt.name);
    }

    results.push({
      index,
      statementType,
      isDml: writesKintone(stmt),
      isReadOnly: isReadOnlyStatement(stmt),
      hasWhere: hasWhereClause(stmt),
      insertValuesCount: getInsertValuesCount(stmt),
      appIds: [...stmtAppIds].sort((a, b) => a - b),
      tempTablesCreated: created,
      tempTablesReferenced: [...refs],
      tempTablesDropped: dropped,
      dependsOn: [...dependsOn].sort((a, b) => a - b),
      tempOnlySource,
      targetAppId:
        isDmlType(statementType) && typeof (stmt as { appId?: unknown }).appId === "number"
          ? (stmt as { appId: number }).appId
          : null,
      isUpdateFrom: stmt.type === "UPDATE" && stmt.from != null,
      isValidationOnly: "validateOnly" in stmt && stmt.validateOnly === true,
      isOnErrorSkip: "onErrorSkip" in stmt && stmt.onErrorSkip === true,
      requiresCompleteInput: requiresCompleteInput(stmt),
    });
  });

  const containsDml = results.some((r) => r.isDml);
  const containsValidationOnly = results.some((r) => r.isValidationOnly);
  const needsCompleteInput = results.some((r) => r.requiresCompleteInput);
  const variables = variableOrder.map((name) => ({
    name,
    referencedBy: [...variableDefs.get(name)!.referencedBy],
  }));
  return {
    statementCount: statements.length,
    isReadOnlyBatch: !containsDml && results.every((r) => r.isReadOnly),
    containsDml,
    containsValidationOnly,
    requiresCompleteInput: needsCompleteInput,
    tempTables: createdOrder,
    variables,
    warnings: variables
      .filter((v) => v.referencedBy.length === 0)
      .map((v) => `variable @${v.name} is never used.`),
    statements: results,
  };
}
