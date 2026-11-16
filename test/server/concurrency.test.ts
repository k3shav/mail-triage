import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import { LOCK_TTL_MS, LeaseLostError, withLock } from '../../src/server/services/concurrency.js';
import { Client, ScriptedModel, createHarness } from '../helpers/harness.js';
import { plainMessage } from '../helpers/fake-google.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two Stores on separate connections to one SQLite file stand in for the server and a cron CLI. */
function twoProcesses() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-triage-lock-'));
  dirs.push(dir);
  const file = path.join(dir, 'db.sqlite');
  const clock = { now: 1_000_000 };
  const a = new Store(openDatabase(file), () => clock.now);
  const b = new Store(openDatabase(file), () => clock.now);
  return { a, b, clock };
}

describe('job leases', () => {
  it('keeps a healthy long job exclusive by renewing past the lease length', async () => {
    const { a, b, clock } = twoProcesses();
    const result = await withLock(
      a,
      'classify:x',
      async (lease) => {
        for (let i = 0; i < 6; i += 1) {
          clock.now += 600;
          await sleep(25);
          expect(b.acquireLock('classify:x', 'cron', 1000)).toBe(false);
        }
        // 3.6s of a 1s lease have passed; the job can still commit.
        return lease.commit(() => 'done');
      },
      { ttlMs: 1000, renewMs: 5 },
    );
    expect(result).toBe('done');
    expect(b.acquireLock('classify:x', 'cron', 1000)).toBe(true);
  });

  it('lets a successor take over a lease abandoned by a crashed owner', async () => {
    const { a, b, clock } = twoProcesses();
    expect(a.acquireLock('sync:x', 'crashed', 1000)).toBe(true);
    await expect(withLock(b, 'sync:x', async () => 'blocked', { ttlMs: 1000 })).rejects.toMatchObject({ code: 'busy' });
    clock.now += 1001;
    expect(await withLock(b, 'sync:x', async () => 'took over', { ttlMs: 1000 })).toBe('took over');
  });

  it('stops an owner that lost its lease and never lets it release the successor', async () => {
    const { a, b, clock } = twoProcesses();
    let commitError: unknown;
    let aborted = false;
    await expect(
      withLock(
        a,
        'classify:x',
        async (lease) => {
          // The process is frozen (no renewals) long enough for a successor to take over.
          clock.now += 5000;
          expect(b.acquireLock('classify:x', 'successor', 1000)).toBe(true);
          // Even before a renewal notices, writes are refused.
          try {
            lease.commit(() => 'stale write');
          } catch (error) {
            commitError = error;
          }
          aborted = lease.signal.aborted;
          lease.assertHeld();
          return 'unreachable';
        },
        { ttlMs: 1000, renewMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(commitError).toBeInstanceOf(LeaseLostError);
    expect(aborted).toBe(true);
    // withLock released only its own row; the successor still holds the lease.
    expect(b.holdsLock('classify:x', 'successor')).toBe(true);
    expect(a.acquireLock('classify:x', 'third', 1000)).toBe(false);
    a.releaseLock('classify:x', 'someone-else');
    expect(b.holdsLock('classify:x', 'successor')).toBe(true);
  });

  it('aborts in-flight work when a renewal finds another owner', async () => {
    const { a, b, clock } = twoProcesses();
    const job = withLock(
      a,
      'classify:x',
      async (lease) => {
        clock.now += 5000;
        b.acquireLock('classify:x', 'successor', 1000);
        await new Promise((resolve) => lease.signal.addEventListener('abort', resolve, { once: true }));
        return lease.signal.reason;
      },
      { ttlMs: 1000, renewMs: 5 },
    );
    expect(await job).toBeInstanceOf(LeaseLostError);
    expect(b.holdsLock('classify:x', 'successor')).toBe(true);
  });

  it('discards a classification run whose lease was taken over while the model was answering', async () => {
    const model = new ScriptedModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const original = model.classify.bind(model);
    model.classify = async (request) => {
      started += 1;
      await gate;
      return original(request);
    };
    const h = createHarness({ model });
    h.google.addMessages(plainMessage('m1', 'Deploy failed', 'Build failed.'), plainMessage('m2', 'Receipt', 'Thanks.'));
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    await client.post('/api/mailboxes/gmail/sync');
    const accountId = h.store.getGmailAccount()!.id;

    const run = client.post('/api/mailboxes/gmail/classify', {}).then((r) => r);
    for (let i = 0; i < 200 && started < 2; i += 1) await sleep(5);
    expect(started).toBe(2);
    // The web process stalls past the lease; a cron run takes the mailbox over.
    h.clock.now += LOCK_TTL_MS + 1;
    expect(h.store.acquireLock(`classify:${accountId}`, 'cron', LOCK_TTL_MS)).toBe(true);
    release();

    const response = await run;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('lease_lost');
    const ids = h.store.listMessages(accountId, 10).map((m) => m.id);
    expect(h.store.latestClassifications(ids).size).toBe(0);
    expect(h.store.lastRun(accountId, 'classify')!.status).toBe('failed');
    expect(h.store.holdsLock(`classify:${accountId}`, 'cron')).toBe(true);

    h.store.releaseLock(`classify:${accountId}`, 'cron');
    expect((await client.post('/api/mailboxes/gmail/classify', {})).body).toMatchObject({ classified: 2 });
  });
});
