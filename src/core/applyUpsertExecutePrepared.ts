import type { KintoneClient } from "../execute";
import type { PreparedApplyUpsert } from "./applyUpsertPrepare";
import {
  ApplyWritePartialFailureError,
  type ApplyWriteProgress,
} from "./applyPatchExecutePrepared";
import { assertApplyInternalWriteScope } from "./applyPatchScope";

export interface PreparedApplyUpsertResult extends ApplyWriteProgress {
  readonly type: "UPSERT";
  readonly createdIds: string[][];
  readonly insertedCount: number;
  readonly updatedCount: number;
  readonly successfulInsertChunks: number;
  readonly successfulUpdateChunks: number;
}

/**
 * Writes an already-completed UPSERT APPLY plan, strictly POST then PUT.
 * The narrowed client makes GET, planning, validation, retry, and rollback
 * unreachable from this boundary.
 */
export async function executePreparedApplyUpsert(
  prepared: PreparedApplyUpsert,
  client: Pick<KintoneClient, "postRecords" | "putRecords">
): Promise<PreparedApplyUpsertResult> {
  assertApplyInternalWriteScope("phase14c");
  const createdIds: string[][] = [];
  let successfulInsertChunks = 0;
  let successfulUpdateChunks = 0;
  let successfulInserts = 0;
  let successfulUpdates = 0;

  for (let failedChunkIndex = 0; failedChunkIndex < prepared.createBatches.length; failedChunkIndex += 1) {
    const batch = prepared.createBatches[failedChunkIndex];
    try {
      const response = await client.postRecords({ app: batch.app, records: [...batch.records] });
      createdIds.push(response.ids);
    } catch (cause) {
      throw new ApplyWritePartialFailureError({
        successfulChunks: successfulInsertChunks + successfulUpdateChunks,
        successfulParents: successfulInserts + successfulUpdates,
        successfulInserts,
        successfulUpdates,
        failedChunkIndex,
        failedBranch: "INSERT",
        failedStage: "POST_CHUNK",
        nonTransactional: true,
        retryAttempted: false,
      }, cause);
    }
    successfulInsertChunks += 1;
    successfulInserts += batch.records.length;
  }

  for (let failedChunkIndex = 0; failedChunkIndex < prepared.updateBatches.length; failedChunkIndex += 1) {
    const batch = prepared.updateBatches[failedChunkIndex];
    try {
      await client.putRecords({ app: batch.app, records: [...batch.records] });
    } catch (cause) {
      throw new ApplyWritePartialFailureError({
        successfulChunks: successfulInsertChunks + successfulUpdateChunks,
        successfulParents: successfulInserts + successfulUpdates,
        successfulInserts,
        successfulUpdates,
        failedChunkIndex,
        failedBranch: "UPDATE",
        failedStage: "PUT_CHUNK",
        nonTransactional: true,
        retryAttempted: false,
      }, cause);
    }
    successfulUpdateChunks += 1;
    successfulUpdates += batch.records.length;
  }

  return {
    type: "UPSERT",
    createdIds,
    insertedCount: successfulInserts,
    updatedCount: successfulUpdates,
    successfulChunks: successfulInsertChunks + successfulUpdateChunks,
    successfulParents: successfulInserts + successfulUpdates,
    successfulInsertChunks,
    successfulUpdateChunks,
    nonTransactional: true,
  };
}
