export class CursorCapacityError extends Error {
  constructor(host: string, limit: number, waitMs: number) {
    super(`CursorCapacityError: host=${host} の active cursor 上限 ${limit} に ${waitMs}ms 以内で空きができませんでした。`);
    this.name = "CursorCapacityError";
  }
}

export class CursorCreateOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("CursorCreateOutcomeUnknownError: Create Cursor の成否を確認できません。自動再試行せず、最大10分+安全余裕の間は枠を隔離します。");
    this.name = "CursorCreateOutcomeUnknownError";
    this.cause = cause;
  }
}

export class CursorCleanupWarning extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`CursorCleanupWarning: Cursor の解放を確認できません。結果は有効ですが、最大10分+安全余裕の間は枠を隔離します。詳細: ${detail}`);
    this.name = "CursorCleanupWarning";
    this.cause = cause;
  }
}
