import { randomUUID } from 'node:crypto';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Lease length. Short, so a crashed process frees its mailbox quickly; a live
 * holder renews it every LOCK_RENEW_MS for as long as its job runs.
 */
export const LOCK_TTL_MS = 2 * 60_000;
export const LOCK_RENEW_MS = 20_000;

export class LeaseLostError extends AppError {
  constructor() {
    super(409, 'lease_lost', 'Another process took over this mailbox job; results from this run were discarded');
  }
}

/** A held job lease, passed to the job so it can stop and guard its writes. */
export interface Lease {
  /** Aborted as soon as a renewal finds another owner. */
  readonly signal: AbortSignal;
  /** Throws LeaseLostError if the lease is gone. */
  assertHeld(): void;
  /**
   * Run `write` in one IMMEDIATE transaction that first checks this owner
   * still holds the lease. Timers cannot renew a frozen process, so every
   * job result goes through here.
   */
  commit<T>(write: () => T): T;
}

export interface LockOptions {
  ttlMs?: number;
  renewMs?: number;
}

/**
 * Hold a SQLite-backed lease for the duration of `fn`, so the server's
 * background cycle and a CLI run never work on the same account at once.
 * The lease is renewed while `fn` runs; if another owner takes it over, the
 * lease's signal aborts and its commits are refused. Release only removes
 * this owner's row.
 */
export async function withLock<T>(store: Store, name: string, fn: (lease: Lease) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  const renewMs = options.renewMs ?? LOCK_RENEW_MS;
  const owner = `${process.pid}:${randomUUID()}`;
  if (!store.acquireLock(name, owner, ttlMs)) {
    throw new AppError(409, 'busy', 'Another tagging cycle is running for this mailbox (another process or the server)');
  }
  const controller = new AbortController();
  const lost = () => {
    if (!controller.signal.aborted) controller.abort(new LeaseLostError());
  };
  const timer = setInterval(() => {
    try {
      if (!store.renewLock(name, owner, ttlMs)) lost();
    } catch {
      // A busy database is retried on the next tick; commits still check ownership.
    }
  }, renewMs);
  timer.unref?.();
  const lease: Lease = {
    signal: controller.signal,
    assertHeld() {
      if (controller.signal.aborted) throw new LeaseLostError();
    },
    commit(write) {
      return store.db
        .transaction(() => {
          if (controller.signal.aborted || !store.holdsLock(name, owner)) {
            lost();
            throw new LeaseLostError();
          }
          return write();
        })
        .immediate();
    },
  };
  try {
    return await fn(lease);
  } finally {
    clearInterval(timer);
    store.releaseLock(name, owner);
  }
}
