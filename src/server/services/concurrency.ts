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

export const LOCK_TTL_MS = 15 * 60_000;

/**
 * Hold a SQLite-backed lease for the duration of `fn`, so the web server and
 * a cron-driven CLI never run the same job for the same account at once.
 */
export async function withLock<T>(store: Store, name: string, fn: () => Promise<T>): Promise<T> {
  const owner = `${process.pid}:${randomUUID()}`;
  if (!store.acquireLock(name, owner, LOCK_TTL_MS)) {
    throw new AppError(409, 'busy', 'Another sync or classification run is in progress for this mailbox');
  }
  try {
    return await fn();
  } finally {
    store.releaseLock(name, owner);
  }
}
