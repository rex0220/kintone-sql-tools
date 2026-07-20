import type { KintoneClient } from "../execute";
import type { PreparedApplyInsert } from "./applyInsertPrepare";
import {
  ApplyWritePartialFailureError,
  type ApplyWriteProgress,
} from "./applyPatchExecutePrepared";
import { assertApplyInternalWriteScope } from "./applyPatchScope";
import { withApplyDiagnosticProgress, type ApplyDiagnostic } from "./applyDiagnostic";

export interface PreparedApplyInsertResult extends ApplyWriteProgress {
  readonly type: "INSERT";
  readonly createdIds: string[][];
  readonly insertedCount: number;
}

/**
 * Executes only completed prepareApplyInsert POST material, sequentially.
 * Planning, metadata, validation, GET, retry, rollback, and compensating writes
 * are intentionally unreachable through the narrowed client capability.
 */
export async function executePreparedApplyInsert(
  prepared: PreparedApplyInsert,
  client: Pick<KintoneClient, "postRecords">,
  diagnostic?: ApplyDiagnostic
): Promise<PreparedApplyInsertResult> {
  assertApplyInternalWriteScope("phase13c");
  const createdIds: string[][] = [];
  let successfulChunks = 0;
  let successfulParents = 0;

  for (let failedChunkIndex = 0; failedChunkIndex < prepared.batches.length; failedChunkIndex += 1) {
    const batch = prepared.batches[failedChunkIndex];
    try {
      const response = await client.postRecords({ app: batch.app, records: [...batch.records] });
      createdIds.push(response.ids);
    } catch (cause) {
      throw new ApplyWritePartialFailureError({
        successfulChunks,
        successfulParents,
        failedChunkIndex,
        failedStage: "POST_CHUNK",
        nonTransactional: true,
        retryAttempted: false,
        ...(diagnostic ? { diagnostic: withApplyDiagnosticProgress(diagnostic, {
          successfulChunks,
          successfulParents,
          failedChunkIndex,
          failedStage: "POST_CHUNK",
          failedBranch: "INSERT",
          retryAttempted: false,
        }) } : {}),
      }, cause);
    }
    successfulChunks += 1;
    successfulParents += batch.records.length;
  }

  return {
    type: "INSERT",
    createdIds,
    insertedCount: successfulParents,
    successfulChunks,
    successfulParents,
    nonTransactional: true,
  };
}
