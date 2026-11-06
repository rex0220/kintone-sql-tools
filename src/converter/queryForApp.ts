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
  /**
   * 送り先のアプリ（対応表の引き当てに使う）。
   *
   * **必須**。「アプリが分からないまま kintone へ送る」形を型で作れなくするため
   * （実装レビューの MINOR）。条件部を**送らない**経路（計画の確かめ・`EXPLAIN` の表示）は
   * この関数ではなく {@link serializeWhereForDisplay} を使う。
   */
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

/**
 * B205 段階 2: 選択肢とステータスの値を**既定名 → 表示名**に直す関数を、アプリごとに返す口。
 * `optionNames: "canonical"` のときだけ中身が入る（`"raw"` では `undefined` を返す）。
 */
export interface OptionQueryTranslatorSource {
  /** アプリに対応表があれば変換関数を返す。無ければ `undefined`（＝変換しない）。 */
  readonly optionQueryTranslate: (appId: number) => ((field: string, value: string) => string) | undefined;
  /** `"canonical"` が有効かどうか（`appId` を省いた入力を拒むかの判定に使う）。 */
  readonly canonicalOptionNames: boolean;
}

function translatorFor(
  input: SerializeQueryForAppInput,
  source?: OptionQueryTranslatorSource
): ((field: string, value: string) => string) | undefined {
  // 型で必須にしているが、JS からの呼び出しと将来の経路のために実行時も確かめる
  // （黙って変換しないのが最悪なので、モードにかかわらず fail-closed）。
  if (!Number.isSafeInteger(input.appId)) {
    throw new Error(
      "InternalError: every kintone query must name its target app "
      + `(got ${String(input.appId)}); use serializeWhereForDisplay for display-only strings.`
    );
  }
  if (source === undefined || !source.canonicalOptionNames) return undefined;
  return source.optionQueryTranslate(input.appId);
}

/** 押し下げる AST のリテラルだけを変換する（構造は変えない。変わらなければ同じ参照）。 */
function translateWhereLiterals(
  where: WhereExpr,
  translate: (field: string, value: string) => string
): WhereExpr {
  switch (where.type) {
    case "BINARY": {
      const field = where.left.type === "FIELD" ? where.left.field : undefined;
      if (field === undefined) return where;
      const right = where.right;
      if (right.type === "STRING") {
        const value = translate(field, right.value);
        return value === right.value ? where : { ...where, right: { ...right, value } };
      }
      if (right.type === "IN_LIST") {
        let changed = false;
        const values = right.values.map((item) => {
          if (item.type !== "STRING") return item;
          const value = translate(field, item.value);
          if (value === item.value) return item;
          changed = true;
          return { ...item, value };
        });
        return changed ? { ...where, right: { ...right, values } } : where;
      }
      return where;
    }
    case "LOGICAL": {
      const left = translateWhereLiterals(where.left, translate);
      const right = translateWhereLiterals(where.right, translate);
      return left === where.left && right === where.right ? where : { ...where, left, right };
    }
    case "NOT": {
      const expr = translateWhereLiterals(where.expr, translate);
      return expr === where.expr ? where : { ...where, expr };
    }
    case "GROUP": {
      const expr = translateWhereLiterals(where.expr, translate);
      return expr === where.expr ? where : { ...where, expr };
    }
    default:
      return where;
  }
}

function serializeGeneratedPredicate(
  predicate: GeneratedPredicate,
  translate?: (field: string, value: string) => string
): string {
  const { field, op } = predicate;
  const values = translate === undefined
    ? predicate.values
    : predicate.values.map((value) => translate(field, value));
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
 *
 * `source`（通常はクライアント）が `optionNames: "canonical"` の対応表を持っているときだけ、
 * **選択肢とステータスの値を既定名から表示名へ**直す。`"raw"`（既定）では段階 1 と同じ文字列を返す。
 */
/**
 * **kintone へ送らない**条件部の文字列（計画の確かめと `EXPLAIN` の表示だけ）。
 *
 * 送る経路は必ず {@link serializeQueryForApp} を通す（アプリが必須＝対応表を引ける）。
 * ここは「アプリが文脈から決まらない」「送らないので表示名に直す必要がない」場所の口で、
 * **`whereToKintone` を直に呼ぶ唯一の代わり**。`optionNames: "canonical"` のとき
 * `EXPLAIN` 自体を拒んでいるので、既定名が表示に残ることもない。
 *
 * 使っていい場所（2026-11-06 時点。増やすときは起票文書 §7.2 に理由を書く）:
 *
 * - `relativeDatePrefilterPlan` / `relativeDatePushdownGuard` の「関数が押し下がったか」の確かめ
 * - `relativeDateExplainLines` の表示行
 */
export function serializeWhereForDisplay(where: WhereExpr): string {
  return whereToKintone(where);
}

export function serializeQueryForApp(
  input: SerializeQueryForAppInput,
  source?: OptionQueryTranslatorSource
): string {
  const translate = translatorFor(input, source);
  const parts: string[] = [];
  if (input.where !== null && input.where !== undefined) {
    const where = translate === undefined ? input.where : translateWhereLiterals(input.where, translate);
    parts.push(whereToKintone(where));
  }
  for (const predicate of input.generated ?? []) {
    parts.push(serializeGeneratedPredicate(predicate, translate));
  }
  return parts.join(" and ");
}
