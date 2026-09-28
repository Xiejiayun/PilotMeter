import type { UsageSnapshot } from '../shared/types.js';

export interface RefreshSchedulerOptions {
  now?: () => number; activeIntervalMs?: number; idleIntervalMs?: number; minimumIntervalMs?: number;
}

/** Small scheduling gate; the daemon owns its timer and reads credentials only when a refresh is due. */
export class RefreshScheduler {
  readonly #now: () => number;
  readonly #active: number;
  readonly #idle: number;
  readonly #minimum: number;
  #next = 0;
  #lastAttempt = -Infinity;
  #inFlight: Promise<UsageSnapshot> | null = null;
  #stopped = false;

  constructor(options: RefreshSchedulerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#active = options.activeIntervalMs ?? 5 * 60_000;
    this.#idle = options.idleIntervalMs ?? 15 * 60_000;
    this.#minimum = options.minimumIntervalMs ?? 30_000;
  }

  get nextRefreshAt(): number | null { return this.#stopped ? null : this.#next; }
  resume(): void { this.#stopped = false; this.#next = 0; this.#lastAttempt = -Infinity; }

  /** Returns null when throttled. Concurrent callers share the same network operation. */
  refresh(fetchSnapshot: () => Promise<UsageSnapshot>, options: { manual?: boolean; idle?: boolean; retryAt?: () => string | null } = {}): Promise<UsageSnapshot | null> {
    if (this.#inFlight) return this.#inFlight;
    const now = this.#now();
    if (this.#stopped || now - this.#lastAttempt < this.#minimum || !options.manual && now < this.#next) return Promise.resolve(null);
    this.#lastAttempt = now;
    const pending = Promise.resolve().then(fetchSnapshot).then(snapshot => {
      const code = snapshot.lastError?.code;
      if (code === 'PERMISSION_DENIED' || code === 'AUTHENTICATION_FAILED') this.#stopped = true;
      const retry = options.retryAt?.(); const retryMs = retry ? Date.parse(retry) : NaN;
      this.#next = Math.max(this.#now() + (options.idle ? this.#idle : this.#active), Number.isFinite(retryMs) ? retryMs : 0);
      return snapshot;
    }).catch(error => {
      this.#next = this.#now() + this.#active;
      throw error;
    }).finally(() => { this.#inFlight = null; });
    this.#inFlight = pending;
    return pending;
  }
}
