// ============================================================
// リクエストゲート（P0-1）
//
// kintone API 呼び出しに対する2つの保護を提供する:
//   1. セマフォ — プロセス内グローバルの同時リクエスト数上限。
//      サブクエリ・JOIN・UNION の Promise.all × fetchParallel の乗算で
//      同時リクエストが膨らみ、kintone の同時接続制限に当たるのを防ぐ
//   2. リトライ — GET 系のみ、408/429/502/503/504 とネットワーク層の
//      一時エラーを指数バックオフ + ジッタで再試行する
//
// 書き込み系（POST/PUT/DELETE）はリトライしない（応答喪失時の二重実行を
// 避けるため。セマフォのみ適用）。CB_IL02 のクエリ書き換えフォールバックは
// nodeKintoneClient 側の責務であり、ここでは扱わない。
//
// ゲートはプロセス内グローバル1個（profile / baseUrl 横断）。
// 複数 profile 同時利用でも合計で上限を掛ける安全側に倒す。
// ============================================================

import type { KintoneClient } from "../execute";

export interface RequestGateOptions {
  /** 同時リクエスト数の上限（既定 10、1〜50） */
  maxConcurrent?: number;
  /** GET 系のリトライ回数上限（既定 3。0 でリトライ無効） */
  maxRetries?: number;
  /** バックオフ初期値ミリ秒（既定 500） */
  baseDelayMs?: number;
  /** バックオフ上限ミリ秒（既定 8000） */
  maxDelayMs?: number;
  /** テスト用: sleep の注入（既定 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用: ジッタ乱数 [0,1) の注入（既定 Math.random） */
  random?: () => number;
}

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/** リトライ対象の HTTP ステータス（GET 系のみ） */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * エラーがリトライ対象（一時的とみなせる）か判定する。
 * - `kintone API error <status>: ...`（nodeKintoneClient の形式）からステータス抽出
 * - fetch のネットワーク層エラー（fetch failed）とタイムアウト中断
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = err.message.match(/^kintone API error (\d{3}):/);
  if (status) return RETRYABLE_STATUSES.has(Number(status[1]));
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (/fetch failed/i.test(err.message)) return true;
  return false;
}

export class RequestGate {
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: RequestGateOptions = {}) {
    this.maxConcurrent = clampInt(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 1, 50);
    this.maxRetries = clampInt(options.maxRetries ?? DEFAULT_MAX_RETRIES, 0, 10);
    // profile 設定（JSON）から無検証で流れてくるため、CLI フラグと同様にここで clamp する
    this.baseDelayMs = clampInt(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, 1, 60_000);
    this.maxDelayMs = Math.max(
      clampInt(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 1, 600_000),
      this.baseDelayMs
    );
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /** 現在の同時実行数（テスト・診断用） */
  get activeCount(): number {
    return this.active;
  }

  get limit(): number {
    return this.maxConcurrent;
  }

  /** 解決済みの GET リトライ回数（テスト・診断用） */
  get retries(): number {
    return this.maxRetries;
  }

  /** 解決済みのバックオフ初期値ミリ秒（テスト・診断用） */
  get retryBaseDelayMs(): number {
    return this.baseDelayMs;
  }

  /** 解決済みのバックオフ上限ミリ秒（テスト・診断用） */
  get retryMaxDelayMs(): number {
    return this.maxDelayMs;
  }

  /** GET 系: セマフォ + リトライ付きで実行する */
  async runReadOnly<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await this.withSlot(fn);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryableError(err)) throw err;
        // スロットは解放済みの状態で待つ（バックオフ中に他リクエストを塞がない）
        await this.sleep(this.backoffDelay(attempt));
        attempt += 1;
      }
    }
  }

  /** 書き込み系: セマフォのみ（リトライしない — 二重実行防止） */
  async runMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.withSlot(fn);
  }

  /** Cursor Create/Get/Delete: セマフォのみ。GETでも位置を進めるため再試行しない。 */
  async runCursorStep<T>(fn: () => Promise<T>): Promise<T> {
    return this.withSlot(fn);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 指数バックオフ + ジッタ（attempt: 0 始まり） */
  private backoffDelay(attempt: number): number {
    const base = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    // フルジッタではなく ±25% の揺らぎ（テストで範囲検証しやすい）
    const jitter = 1 + (this.random() - 0.5) * 0.5;
    return Math.round(base * jitter);
  }
}

/**
 * KintoneClient の全メソッドをゲート経由にする。
 * GET 系（getRecords / getApps / getFields / getProcessStatuses）はリトライ付き、
 * 書き込み系（postRecords / putRecords / deleteRecords）はセマフォのみ。
 */
export function withRequestGate(client: KintoneClient, gate: RequestGate): KintoneClient {
  return {
    getRecords: (params) => gate.runReadOnly(() => client.getRecords(params)),
    openCursor: async (params) => {
      const handle = await gate.runCursorStep(() => client.openCursor(params));
      return {
        totalCount: handle.totalCount,
        nextPage: () => gate.runCursorStep(() => handle.nextPage()),
        close: () => gate.runCursorStep(() => handle.close()),
      };
    },
    getApps: () => gate.runReadOnly(() => client.getApps()),
    getFields: (appId) => gate.runReadOnly(() => client.getFields(appId)),
    getProcessStatuses: (appId) => gate.runReadOnly(() => client.getProcessStatuses(appId)),
    postRecords: (params) => gate.runMutation(() => client.postRecords(params)),
    putRecords: (params) => gate.runMutation(() => client.putRecords(params)),
    deleteRecords: (params) => gate.runMutation(() => client.deleteRecords(params)),
  };
}

// ------------------------------------------------------------
// プロセス内グローバルゲート
// ------------------------------------------------------------

let globalGate: RequestGate | null = null;

/**
 * プロセス内グローバルのゲートを返す（初回呼び出し時に生成）。
 * 全設定は最初に解決された値で固定される。
 *
 * env（`KSQL_MAX_CONCURRENT` / `KSQL_RETRY`）の解決はこのモジュールでは行わない —
 * 呼び出し側（Node 層）が `resolveRequestGateOptions()`（node/config.ts）で
 * env > CLI > config を解決してから渡す。src/api は browser/plugin にも近い層の
 * ため、Node/fs 依存（node/config）をここに持ち込まない。
 *
 * 後方互換: 数値1個の渡し方（旧 limitHint = maxConcurrent）も受け付ける。
 */
export function getGlobalRequestGate(
  options?: number | Partial<RequestGateOptions>
): RequestGate {
  if (globalGate === null) {
    globalGate = new RequestGate(
      typeof options === "number" ? { maxConcurrent: options } : options ?? {}
    );
  }
  return globalGate;
}

/** テスト用: グローバルゲートを破棄する */
export function resetGlobalRequestGate(): void {
  globalGate = null;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}
