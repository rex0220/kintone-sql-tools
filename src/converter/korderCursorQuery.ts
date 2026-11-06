import type { SelectStatement } from "../types/ast";
import { serializeQueryForApp, type OptionQueryTranslatorSource } from "./queryForApp";

/** Create Cursorへ渡すquery。SQL側のLIMIT/OFFSETや暗黙tieは含めない。 */
export function buildKorderCursorQuery(
  stmt: SelectStatement,
  optionNames?: OptionQueryTranslatorSource
): string {
  const parts: string[] = [];
  // B205: 選択肢の値を表示名へ直すため、ここも 1 つの口を通す
  if (stmt.where) {
    parts.push(serializeQueryForApp({ appId: stmt.from.appId, where: stmt.where }, optionNames));
  }
  const order = stmt.orderBy.map((item) => {
    if (item.key.type !== "FIELD_NAME") {
      throw new Error("ArgumentError: KORDER cursor key must be a direct field.");
    }
    return `${item.key.name} ${item.direction === "ASC" ? "asc" : "desc"}`;
  });
  parts.push(`order by ${order.join(", ")}`);
  return parts.join(" ");
}
