import type { SelectStatement } from "../types/ast";
import { whereToKintone } from "./whereToKintone";

/** Create Cursorへ渡すquery。SQL側のLIMIT/OFFSETや暗黙tieは含めない。 */
export function buildKorderCursorQuery(stmt: SelectStatement): string {
  const parts: string[] = [];
  if (stmt.where) parts.push(whereToKintone(stmt.where));
  const order = stmt.orderBy.map((item) => {
    if (item.key.type !== "FIELD_NAME") {
      throw new Error("ArgumentError: KORDER cursor key must be a direct field.");
    }
    return `${item.key.name} ${item.direction === "ASC" ? "asc" : "desc"}`;
  });
  parts.push(`order by ${order.join(", ")}`);
  return parts.join(" ");
}
