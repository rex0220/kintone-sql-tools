import { applyPatchPlansToKintoneBatches } from "../converter/applyPatchToKintone";
import type { KintoneClient } from "../execute";
import type { PreparedApplyWrite } from "./applyPatchPrepare";
import { assertApplyInternalWriteScope } from "./applyPatchScope";

/** Counts which remain committed when a later non-transactional chunk fails. */
export interface ApplyWriteProgress {
  readonly successfulChunks: number;
  readonly successfulParents: number;
  readonly nonTransactional: true;
}

export interface ApplyWriteFailureDetail extends ApplyWriteProgress {
  /** Zero-based index in the prepared PUT batch array. */
  readonly failedChunkIndex: number;
  /** The failure happened while issuing this chunk's PUT; no retry is attempted. */
  readonly failedStage: "PUT_CHUNK";
  readonly retryAttempted: false;
}

/** Internal Phase 10c result. Public UPDATE results remain unchanged until 10d. */
export interface PreparedApplyWriteResult extends ApplyWriteProgress {
  readonly type: "UPDATE";
  readonly updatedCount: number;
}

/**
 * Preserves the original kintone failure and the already-committed prefix.
 * Callers must not interpret this error as an all-or-nothing failure.
 */
export class ApplyWritePartialFailureError extends Error {
  readonly partialSuccess: ApplyWriteFailureDetail;
  readonly cause: unknown;

  constructor(partialSuccess: ApplyWriteFailureDetail, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `ApplyWritePartialFailureError: APPLY PUT chunk ${partialSuccess.failedChunkIndex + 1} failed `
      + `(index ${partialSuccess.failedChunkIndex}) after ${partialSuccess.successfulChunks} successful chunk(s) `
      + `and ${partialSuccess.successfulParents} successful parent(s); writes are non-transactional and were not retried. Cause: ${detail}`
    );
    this.name = "ApplyWritePartialFailureError";
    this.partialSuccess = partialSuccess;
    this.cause = cause;
  }
}

/**
 * Executes only a completed prepareApplyPatchWrite value, sequentially.
 * No planner, validator, GET, retry, rollback, or compensating write is reachable
 * from this function. Phase 10c intentionally exposes this boundary internally
 * only; public execute/executeBatch are connected in Phase 10d.
 */
export async function executePreparedApplyWrite(
  prepared: PreparedApplyWrite,
  client: Pick<KintoneClient, "putRecords">
): Promise<PreparedApplyWriteResult> {
  assertApplyInternalWriteScope("phase10c");
  const batches = applyPatchPlansToKintoneBatches(prepared);
  let successfulChunks = 0;
  let successfulParents = 0;

  for (let failedChunkIndex = 0; failedChunkIndex < batches.length; failedChunkIndex += 1) {
    const batch = batches[failedChunkIndex];
    try {
      await client.putRecords(batch);
    } catch (cause) {
      throw new ApplyWritePartialFailureError({
        successfulChunks,
        successfulParents,
        failedChunkIndex,
        failedStage: "PUT_CHUNK",
        nonTransactional: true,
        retryAttempted: false,
      }, cause);
    }
    successfulChunks += 1;
    successfulParents += batch.records.length;
  }

  return {
    type: "UPDATE",
    updatedCount: successfulParents,
    successfulChunks,
    successfulParents,
    nonTransactional: true,
  };
}
