import type { WhereExpr } from "../types/ast";
import { whereToKintone } from "./whereToKintone";

/**
 * B205 段階 1: kintone へ送るクエリの**条件部を作る唯一の口**。
 *
 * なぜ 1 か所に集めるか:
 *
 * - 選択肢とステータスに「言語ごとの表示名」を設定したアプリでは、kintone が受け付ける値が
 *   利用者の表示言語の名称になる。B205（`optionNames: "canonical"`）は SQL を既定の名称で書けるように
 *   する機能で、**kintone との境目で値を変換する**。
 * - ところが kintone へ送る値は **WHERE の AST だけから出てこない**。JOIN キーの押し下げ
 *   （`buildJoinKeyPrefilterPredicates`）と、非ネイティブ `UPSERT` の既存照合は、**読んだ値から
 *   `選択肢 in ("…")` を直接組み立てている**。AST だけを変換すると「ローカルのキーは既定名・
 *   押し下げだけ既定名で送信」という**一部だけ canonical な中間状態**になる（設計レビューの BLOCKER）。
 * - そこで、**アプリを明示に受け取る口**をここに 1 つ置き、AST も生成述語も必ずここを通す。
 *   段階 2 ではこの関数に変換器（既定名 → 表示名）を足すだけで、全経路が同時に効く。
 *
 * 段階 1 では**文字列は今までとまったく同じ**（変換器がまだ無い）。`appId` は段階 2 のために受けている。
 */

/** B205: 文字列になる前の生成述語の演算子。 */
export type GeneratedPredicateOp = "in" | "not in" | "=" | ">=" | "<=";

/**
 * B205: 文字列になる前の生成述語（JOIN キーの押し下げ・`UPSERT` の既存照合が使う）。
 * `values` は `in` / `not in` のとき 1 件以上、ほかは 1 件。
 */
export interface GeneratedPredicate {
  readonly field: string;
  readonly op: GeneratedPredicateOp;
  readonly values: readonly string[];
}

export interface SerializeQueryForAppInput {
  /** 送り先のアプリ（段階 2 の対応表の引き当てに使う。段階 1 では使わない） */
  readonly appId: number;
  /** WHERE の AST（押し下げる部分）。無い場合は条件なし */
  readonly where?: WhereExpr | null;
  /** AST を持たない生成述語。`and` で結ぶ */
  readonly generated?: readonly GeneratedPredicate[];
}

/** kintone クエリの文字列リテラル（`\` と `"` を退避する）。 */
export function quoteKintoneValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeGeneratedPredicate(predicate: GeneratedPredicate): string {
  const { field, op, values } = predicate;
  if (op === "in" || op === "not in") {
    return `${field} ${op} (${values.map(quoteKintoneValue).join(",")})`;
  }
  if (values.length !== 1) {
    throw new Error(
      `InternalError: generated predicate "${field} ${op}" expects exactly 1 value (got ${values.length}).`
    );
  }
  return `${field} ${op} ${quoteKintoneValue(values[0])}`;
}

/**
 * kintone へ送るクエリの条件部を作る。
 * **段階 1 の時点で、出力は移行前の文字列と同一**（`whereToKintone` と同じ引用・同じ並び）。
 */
export function serializeQueryForApp(input: SerializeQueryForAppInput): string {
  const parts: string[] = [];
  if (input.where !== null && input.where !== undefined) {
    parts.push(whereToKintone(input.where));
  }
  for (const predicate of input.generated ?? []) {
    parts.push(serializeGeneratedPredicate(predicate));
  }
  return parts.join(" and ");
}
