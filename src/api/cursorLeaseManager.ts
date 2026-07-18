import { CursorCapacityError } from "../core/errors/cursorErrors";

export interface CursorLease {
  release(): void;
  quarantine(durationMs?: number): void;
}

export interface CursorLeaseSnapshot {
  active: number;
  peak: number;
  quarantined: number;
  waiting: number;
  limit: number;
}

export interface CursorLeaseManagerOptions {
  maxActive?: number;
  waitTimeoutMs?: number;
  quarantineMs?: number;
}

interface Waiter {
  resolve: (lease: CursorLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_ACTIVE = 2;
const MAX_ACTIVE = 5;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_QUARANTINE_MS = 10 * 60_000 + 30_000;

/** host単位のactive permitとAdd Cursor mutex。 */
export class CursorLeaseManager {
  private maxActive: number;
  private readonly waitTimeoutMs: number;
  private readonly quarantineMs: number;
  private active = 0;
  private peak = 0;
  private quarantined = 0;
  private readonly waiters: Waiter[] = [];
  private createTail: Promise<void> = Promise.resolve();

  constructor(readonly host: string, options: CursorLeaseManagerOptions = {}) {
    const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > MAX_ACTIVE) {
      throw new Error(`ArgumentError: cursorMaxActive must be an integer from 1 to ${MAX_ACTIVE}.`);
    }
    this.maxActive = maxActive;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    this.quarantineMs = options.quarantineMs ?? DEFAULT_QUARANTINE_MS;
  }

  acquire(): Promise<CursorLease> {
    if (this.active < this.maxActive) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve(this.makeLease());
    }
    return new Promise<CursorLease>((resolve, reject) => {
      const waiter = {} as Waiter;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new CursorCapacityError(this.host, this.maxActive, this.waitTimeoutMs));
      }, this.waitTimeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * 同一hostを共有する後続surfaceの設定を反映する。
   * 縮小時は既存leaseを強制終了せず、activeが新上限を下回るまで新規取得だけを止める。
   */
  setMaxActive(maxActive: number): void {
    this.validateMaxActive(maxActive);
    if (this.maxActive === maxActive) return;
    this.maxActive = maxActive;
    this.dispatchWaiters();
  }

  async runCreate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.createTail;
    let unlock!: () => void;
    this.createTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      unlock();
    }
  }

  snapshot(): CursorLeaseSnapshot {
    return {
      active: this.active,
      peak: this.peak,
      quarantined: this.quarantined,
      waiting: this.waiters.length,
      limit: this.maxActive,
    };
  }

  private makeLease(): CursorLease {
    let done = false;
    return {
      release: () => {
        if (done) return;
        done = true;
        this.returnPermit();
      },
      quarantine: (durationMs = this.quarantineMs) => {
        if (done) return;
        done = true;
        this.quarantined += 1;
        const timer = setTimeout(() => {
          this.quarantined -= 1;
          this.returnPermit();
        }, durationMs);
        timer.unref?.();
      },
    };
  }

  private returnPermit(): void {
    this.active -= 1;
    this.dispatchWaiters();
  }

  private dispatchWaiters(): void {
    while (this.active < this.maxActive) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      waiter.resolve(this.makeLease());
    }
  }

  private validateMaxActive(maxActive: number): void {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > MAX_ACTIVE) {
      throw new Error(`ArgumentError: cursorMaxActive must be an integer from 1 to ${MAX_ACTIVE}.`);
    }
  }
}

const managers = new Map<string, CursorLeaseManager>();

export function getCursorLeaseManager(host: string, maxActive = DEFAULT_MAX_ACTIVE): CursorLeaseManager {
  const key = host.toLowerCase();
  let manager = managers.get(key);
  if (!manager) {
    manager = new CursorLeaseManager(key, { maxActive });
    managers.set(key, manager);
  } else {
    manager.setMaxActive(maxActive);
  }
  return manager;
}

export function resetCursorLeaseManagers(): void {
  managers.clear();
}
