import type { KintoneClient } from "../../execute";
import type { KintoneRecord } from "../../converter/dmlToKintone";
import { CursorCleanupWarning } from "../errors/cursorErrors";

export interface KorderCursorExecutionInput {
  client: KintoneClient;
  app: number;
  fields: string[];
  query: string;
  offset: number;
  limit: number;
}

export interface KorderCursorExecutionResult {
  records: KintoneRecord[];
  cleanupWarning?: string;
}

/** Cursor順を変えず、offsetを読み飛ばしてlimit件だけを収集する。 */
export async function executeKorderCursor(
  input: KorderCursorExecutionInput
): Promise<KorderCursorExecutionResult> {
  const handle = await input.client.openCursor({
    app: input.app,
    fields: input.fields.length > 0 ? input.fields : undefined,
    query: input.query,
    size: 500,
  });
  const records: KintoneRecord[] = [];
  let seen = 0;
  let primaryError: unknown;
  let cleanupWarning: string | undefined;

  try {
    if (handle.totalCount > input.offset) {
      while (records.length < input.limit) {
        const page = await handle.nextPage();
        for (const record of page.records) {
          if (seen < input.offset) seen += 1;
          else if (records.length < input.limit) records.push(record);
          else break;
        }
        if (!page.next) break;
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (cleanupError) {
      if (primaryError && primaryError instanceof Error) {
        Object.defineProperty(primaryError, "cursorCleanupError", {
          value: cleanupError,
          configurable: true,
        });
      } else {
        cleanupWarning = new CursorCleanupWarning(cleanupError).message;
      }
    }
  }
  return { records, cleanupWarning };
}
