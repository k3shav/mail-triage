import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FieldDecision } from '../../src/core/decision.js';
import { DEFAULT_TAXONOMY } from '../../src/core/taxonomy.js';
import { ProviderError } from '../../src/providers/errors.js';
import { GMAIL_SCOPES } from '../../src/server/config.js';
import { PROMPT_VERSION } from '../../src/core/prompt.js';
import { MAX_CLASSIFY_FAILURES } from '../../src/server/db/store.js';
import { LOCK_TTL_MS } from '../../src/server/services/concurrency.js';
import { formatCycle } from '../../src/server/services/pipeline.js';
import { PipelineScheduler } from '../../src/server/services/scheduler.js';
import { plainMessage } from '../helpers/fake-google.js';
import { ScriptedModel, connectedHarness, createHarness, type Harness } from '../helpers/harness.js';

const L = {
  notification: 'Mail Triage/Category/Notification',
  receipt: 'Mail Triage/Category/Receipt',
  deploys: 'Mail Triage/Category/Deploys',
  needsAction: 'Mail Triage/Action/Needs Action',
  noAction: 'Mail Triage/Action/No Action',
  high: 'Mail Triage/Priority/High',
  low: 'Mail Triage/Priority/Low',
  review: 'Mail Triage/Needs Review',
};

const confident = (value: string, confidence = 0.95): FieldDecision => ({ status: 'answered', value, confidence, selectedProbability: 0.97, probabilities: null });
const unscored = (value: string): FieldDecision => ({ status: 'answered', value, confidence: null, selectedProbability: null, probabilities: null });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two inbox messages; the receipt is already read and has a user label. */
async function mailbox(options: Parameters<typeof connectedHarness>[0] = {}) {
  const h = await connectedHarness(options);
  const userLabel = h.google.addLabel('Receipts');
  h.google.addMessages(
    plainMessage('m1', 'Deploy failed on main', 'Build 412 failed. Please fix the failing test.'),
    plainMessage('m2', 'Your receipt', 'Thanks for your order.', { labelIds: ['INBOX', userLabel] }),
  );
  h.model.next = (request) =>
    request.email.subject === 'Your receipt' ? { category: confident('receipt'), action: confident('no_action'), priority: confident('low') } : {};
  return h;
}

const run = (h: Harness, mode: 'dry-run' | 'apply' = 'apply') => h.context.pipeline.runCycle({ mode });
const namespaced = (h: Harness, id: string) => h.google.labelNamesOf(id).filter((name) => name.startsWith('Mail Triage/')).sort();
const count = (h: Harness, sql: string) => (h.store.db.prepare(sql).get() as { n: number }).n;
const until = async (condition: () => boolean, ms = 2000) => {
  for (let waited = 0; !condition() && waited < ms; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe('apply mode', () => {
  it('adds namespaced labels to confident results and leaves read state and other labels alone', async () => {
    const h = await mailbox();
    const result = await run(h);
    expect(result).toMatchObject({
      status: 'ok',
      sync: { listed: 2, added: 2, known: 0, failed: 0 },
      classify: { classified: 2, failed: 0 },
      tag: { labeled: 2, reviewOnly: 0, labelsAdded: 6, labelsCreated: 6, failed: 0 },
    });

    expect(namespaced(h, 'm1')).toEqual([L.needsAction, L.notification, L.high].sort());
    expect(namespaced(h, 'm2')).toEqual([L.noAction, L.receipt, L.low].sort());
    expect(h.google.labelNamesOf('m1')).toEqual(expect.arrayContaining(['INBOX', 'UNREAD']));
    expect(h.google.labelNamesOf('m2')).toEqual(expect.arrayContaining(['INBOX', 'Receipts']));
    expect(h.google.labelNamesOf('m2')).not.toContain('UNREAD');

    // The only writes are label creation inside the namespace and additive modify calls.
    for (const call of h.google.gmailWrites()) {
      const body = JSON.parse(call.body!);
      if (call.url.endsWith('/labels')) expect(body.name).toMatch(/^Mail Triage\//);
      else {
        expect(call.url).toMatch(/\/messages\/m[12]\/modify$/);
        expect(Object.keys(body)).toEqual(['addLabelIds']);
      }
    }
    expect(h.google.modifyCalls()).toHaveLength(2);
    expect(h.google.labels.map((label) => label.name)).not.toContain(L.review);
  });

  it('makes no Gmail writes or model calls when nothing changed, and does not re-add labels the user removed', async () => {
    const h = await mailbox();
    await run(h);
    const writes = h.google.gmailWrites().length;
    const modelCalls = h.model.calls.length;
    const fullFetches = h.google.calls.filter((call) => call.url.includes('format=full')).length;

    const again = await run(h);
    expect(again).toMatchObject({ status: 'ok', sync: { listed: 2, added: 0, known: 2 }, classify: { attempted: 0 }, tag: { considered: 0 } });
    expect(h.google.gmailWrites()).toHaveLength(writes);
    expect(h.model.calls).toHaveLength(modelCalls);
    expect(h.google.calls.filter((call) => call.url.includes('format=full'))).toHaveLength(fullFetches);

    const high = h.google.labels.find((label) => label.name === L.high)!.id;
    const m1 = h.google.messages.get('m1')!;
    m1.labelIds = m1.labelIds.filter((id) => id !== high);
    await run(h);
    expect(h.google.labelNamesOf('m1')).not.toContain(L.high);
    expect(h.google.gmailWrites()).toHaveLength(writes);
  });

  it('marks low-confidence, refused, and invalid results with Needs Review only', async () => {
    const h = await connectedHarness();
    h.google.addMessages(plainMessage('m1', 'Low', 'a'), plainMessage('m2', 'Refused', 'b'), plainMessage('m3', 'Invalid', 'c'));
    h.model.next = (request) =>
      ({
        Low: { category: confident('marketing', 0.3) },
        Refused: { action: { status: 'refused' } },
        Invalid: { priority: { status: 'invalid', reason: 'choice was not offered' } },
      })[request.email.subject] as Partial<Record<'category' | 'action' | 'priority', FieldDecision>>;

    const result = await run(h);
    expect(result.tag).toMatchObject({ labeled: 0, reviewOnly: 3, labelsAdded: 3, labelsCreated: 1 });
    for (const id of ['m1', 'm2', 'm3']) expect(namespaced(h, id)).toEqual([L.review]);
    // No category is guessed for uncertain results.
    expect(h.google.labels.filter((label) => label.name.startsWith('Mail Triage/Category/'))).toHaveLength(0);
  });

  it('labels unscored answers only when AUTO_LABEL_UNSCORED is set, always with Needs Review, and never invents confidence', async () => {
    const answer = () => ({ category: unscored('notification'), action: unscored('needs_action'), priority: unscored('high') });

    const off = await connectedHarness();
    off.google.addMessages(plainMessage('m1', 'Local model', 'a'));
    off.model.next = answer;
    expect((await run(off)).tag).toMatchObject({ reviewOnly: 1, labeled: 0, labeledForReview: 0 });
    expect(namespaced(off, 'm1')).toEqual([L.review]);

    const on = await connectedHarness({ env: { AUTO_LABEL_UNSCORED: 'true' } });
    on.google.addMessages(plainMessage('m1', 'Local model', 'a'), plainMessage('m2', 'Refused', 'b'));
    on.model.next = (request) => (request.email.subject === 'Refused' ? { ...answer(), action: { status: 'refused' } } : answer());
    expect((await run(on)).tag).toMatchObject({ labeledForReview: 1, reviewOnly: 1 });
    expect(namespaced(on, 'm1')).toEqual([L.needsAction, L.notification, L.high, L.review].sort());
    expect(namespaced(on, 'm2')).toEqual([L.review]);

    const stored = on.store.db.prepare('SELECT fields FROM classifications').all() as Array<{ fields: string }>;
    for (const row of stored) for (const field of Object.values(JSON.parse(row.fields)) as FieldDecision[]) if (field.status === 'answered') expect(field.confidence).toBeNull();
    expect(count(on, 'SELECT COUNT(*) AS n FROM corrections')).toBe(0);
  });

  it('skips a message whose Gmail thread no longer matches', async () => {
    const h = await mailbox();
    await run(h, 'dry-run');
    h.google.messages.get('m1')!.threadId = 'tother';
    const result = await run(h);
    expect(result.tag).toMatchObject({ skipped: 1, labeled: 1 });
    expect(h.google.modifyCalls().map((call) => call.url)).toEqual([expect.stringMatching(/m2\/modify$/)]);
  });
});

describe('dry-run mode', () => {
  it('never writes to Gmail, stores predictions, and reports what would change', async () => {
    const h = await mailbox();
    const result = await run(h, 'dry-run');
    expect(result).toMatchObject({ status: 'ok', classify: { classified: 2 }, tag: { labeled: 2, labelsAdded: 6, labelsCreated: 6 } });
    expect(formatCycle(result)).toMatch(/would label 2.*6 labels would be added, 6 would be created; Gmail was not changed/);
    expect(h.google.gmailWrites()).toHaveLength(0);
    expect(h.google.labels.map((label) => label.name)).toEqual(['INBOX', 'UNREAD', 'Receipts']);
    expect(h.google.labelNamesOf('m1')).toEqual(['INBOX', 'UNREAD']);
    expect(count(h, 'SELECT COUNT(*) AS n FROM classifications')).toBe(2);

    expect((await run(h, 'dry-run')).tag).toMatchObject({ considered: 0 });
    expect(h.google.gmailWrites()).toHaveLength(0);

    // Switching to apply labels the stored predictions without asking the model again.
    const modelCalls = h.model.calls.length;
    expect((await run(h, 'apply')).tag).toMatchObject({ labeled: 2, labelsAdded: 6 });
    expect(h.model.calls).toHaveLength(modelCalls);
    expect(namespaced(h, 'm1')).toEqual([L.needsAction, L.notification, L.high].sort());
  });
});

describe('categories file', () => {
  function categoriesFile(content: unknown) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-triage-categories-'));
    dirs.push(dir);
    const file = path.join(dir, 'categories.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  }

  it('reclassifies after a change, adds the new labels alongside the old ones, and ignores a malformed edit', async () => {
    const file = categoriesFile(DEFAULT_TAXONOMY);
    const h = await mailbox({ env: { CATEGORIES_FILE: file } });
    const first = await run(h);
    expect(first.categories).toEqual({ revision: 1, changed: false, error: null });
    expect(h.model.calls).toHaveLength(2);

    const edited = structuredClone(DEFAULT_TAXONOMY);
    edited.categories.push({ id: 'deploys', name: 'Deploys', description: 'CI and deployment results.' });
    writeFileSync(file, JSON.stringify(edited, null, 2));
    h.model.next = (request) => (request.email.subject === 'Deploy failed on main' ? { category: confident('deploys') } : {});
    const second = await run(h);
    expect(second.categories).toEqual({ revision: 2, changed: true, error: null });
    expect(h.model.calls).toHaveLength(4);
    expect(h.model.calls[2]!.taxonomy.categories.map((c) => c.id)).toContain('deploys');
    expect(namespaced(h, 'm1')).toEqual(expect.arrayContaining([L.deploys, L.notification]));

    writeFileSync(file, '{ "categories": [ { "id": "fyi", ');
    const calls = h.google.calls.length;
    const broken = await run(h);
    expect(broken.status).toBe('failed');
    expect(broken.error).toMatch(/CATEGORIES_FILE not valid JSON.*left unchanged/);
    expect(h.store.currentTaxonomy()).toMatchObject({ revision: 2, taxonomy: edited });
    expect(h.google.calls).toHaveLength(calls);
    expect(h.model.calls).toHaveLength(4);

    writeFileSync(file, JSON.stringify({ ...edited, categories: [...edited.categories, edited.categories[0]] }));
    expect((await run(h)).error).toMatch(/Duplicate category id "fyi"/);
    expect(h.store.currentTaxonomy().revision).toBe(2);
  });
});

describe('changes while Gmail calls are in flight', () => {
  it('drops the write when the categories change during the Gmail read', async () => {
    const h = await mailbox();
    await run(h, 'dry-run');
    let changed = false;
    h.google.before = (url) => {
      if (!changed && url.searchParams.get('format') === 'minimal') {
        changed = true;
        h.store.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: 'I moved teams.' });
      }
    };
    const result = await run(h);
    expect(result.tag).toMatchObject({ superseded: 2, labeled: 0 });
    expect(h.google.gmailWrites()).toHaveLength(0);

    h.google.before = null;
    const next = await run(h);
    expect(next.classify).toMatchObject({ classified: 2 });
    expect(next.tag).toMatchObject({ labeled: 2 });
  });

  it('drops the write when the categories change while a label is being created', async () => {
    const h = await mailbox();
    let changed = false;
    h.google.before = (url, method) => {
      if (!changed && method === 'POST' && url.pathname.endsWith('/labels')) {
        changed = true;
        h.store.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: 'Changed mid-write.' });
      }
    };
    const result = await run(h);
    expect(result.tag!.superseded).toBeGreaterThanOrEqual(1);
    // Only the request already in flight reached Gmail; no further label for the old plan was created.
    expect(h.google.labelCreates()).toHaveLength(1);
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('records a write that landed even if the categories changed during it, then labels the new result', async () => {
    const h = await mailbox();
    let changed = false;
    h.google.before = (url) => {
      if (!changed && url.pathname.endsWith('/modify')) {
        changed = true;
        h.store.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: 'Changed during modify.' });
      }
    };
    const result = await run(h);
    expect(result.tag).toMatchObject({ labeled: 1, superseded: 1 });
    h.google.before = null;
    h.model.next = () => ({ category: confident('fyi') });
    const next = await run(h);
    expect(next.classify).toMatchObject({ classified: 2 });
    expect(namespaced(h, 'm1')).toContain('Mail Triage/Category/FYI');
  });
});

describe('every Gmail write attempt is checked right before it is sent', () => {
  type Mutation = 'categories changed' | 'message reclassified' | 'Gmail disconnected' | 'lease taken over';

  function mutate(h: Harness, mutation: Mutation, accountId: string) {
    if (mutation === 'categories changed') h.store.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: 'Changed while waiting.' });
    else if (mutation === 'Gmail disconnected') h.store.deleteAccount(accountId);
    else if (mutation === 'lease taken over') expect(h.store.acquireLock(`pipeline:${accountId}`, 'cron', LOCK_TTL_MS)).toBe(true);
    else {
      const m1 = h.store.db.prepare("SELECT id, decision_seq AS seq FROM messages WHERE external_id = 'm1'").get() as { id: number; seq: number };
      const { revision, hash } = h.store.currentTaxonomy();
      const stored = h.store.insertClassification({
        accountId,
        messageId: m1.id,
        taxonomyRevision: revision,
        taxonomyHash: hash,
        promptVersion: PROMPT_VERSION,
        decision: {
          provider: 'jev',
          requestedModel: 'jev-latest',
          model: 'jev-1.13.0',
          confidenceKind: 'provider',
          fields: { category: confident('fyi'), action: confident('no_action'), priority: confident('low') },
          usage: null,
        },
        expectedDecisionSeq: m1.seq,
      });
      expect(stored).not.toBeNull();
    }
  }

  const mutations: Mutation[] = ['categories changed', 'message reclassified', 'Gmail disconnected', 'lease taken over'];
  const cases = (['create label', 'add labels'] as const).flatMap((write) => mutations.map((mutation) => [write, mutation] as const));

  it.each(cases)('%s: no request is sent when the plan goes stale during the token refresh (%s)', async (write, mutation) => {
    const h = await mailbox();
    await run(h, 'dry-run');
    const accountId = h.store.getGmailAccount()!.id;
    if (write === 'add labels') for (const name of Object.values(L)) h.google.addLabel(name);
    // After the last read before the first write, the cached access token expires, so the write's token.get() refreshes.
    h.google.before = (url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/labels')) h.clock.now += 2 * 3600_000;
    };
    let mutated = false;
    h.google.beforeRefresh = () => {
      if (mutated) return;
      mutated = true;
      mutate(h, mutation, accountId);
    };

    const result = await run(h);
    expect(mutated).toBe(true);
    if (mutation === 'message reclassified') {
      // Only m1's plan went stale: nothing for it is sent, while m2's unchanged plan proceeds.
      const created = h.google.labelCreates().map((call) => JSON.parse(call.body!).name);
      expect(created).not.toEqual(expect.arrayContaining([L.notification]));
      expect(created.filter((name: string) => [L.notification, L.needsAction, L.high].includes(name))).toEqual([]);
      expect(h.google.modifyCalls().map((call) => call.url)).toEqual([expect.stringMatching(/\/messages\/m2\/modify$/)]);
      expect(result.tag).toMatchObject({ superseded: 1, labeled: 1, failed: 0 });
      expect(namespaced(h, 'm1')).toEqual([]);
      return;
    }
    expect(h.google.gmailWrites()).toHaveLength(0);
    if (mutation === 'lease taken over') {
      expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/Another process took over/) });
    } else {
      expect(result.status).toBe('ok');
      expect(result.tag).toMatchObject({ labeled: 0, failed: 0, labelsCreated: 0, labelsAdded: 0 });
      expect(result.tag!.superseded).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    ['429 then a retry', 429],
    ['401 then a token refresh', 401],
  ] as const)('does not resend a stale label creation after %s', async (_name, status) => {
    const h = await mailbox();
    await run(h, 'dry-run');
    h.google.respond = (url, method) => {
      if (method !== 'POST' || h.google.labelCreates().length !== 1) return undefined;
      h.store.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: `Changed after ${status}.` });
      return new Response(JSON.stringify({ error: { code: status } }), { status, headers: { 'retry-after': '0' } });
    };
    const result = await run(h);
    expect(result.status).toBe('ok');
    expect(result.tag).toMatchObject({ labeled: 0, failed: 0 });
    expect(h.google.labelCreates()).toHaveLength(1);
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('still retries writes for an unchanged plan', async () => {
    const h = await mailbox();
    let failedCreate = false;
    let failedModify = false;
    h.google.respond = (url, method) => {
      if (method !== 'POST') return undefined;
      if (!failedCreate && url.pathname.endsWith('/labels')) {
        failedCreate = true;
        return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      }
      if (!failedModify && url.pathname.endsWith('/modify')) {
        failedModify = true;
        return new Response('{}', { status: 401 });
      }
      return undefined;
    };
    const result = await run(h);
    expect(result).toMatchObject({ status: 'ok', tag: { labeled: 2, labelsCreated: 6, superseded: 0 } });
    expect(h.google.labelCreates()).toHaveLength(7);
    expect(h.google.modifyCalls()).toHaveLength(3);
    expect(namespaced(h, 'm1')).toEqual([L.needsAction, L.notification, L.high].sort());
  });
});

describe('leases and shutdown', () => {
  it('refuses a second concurrent cycle for the same mailbox', async () => {
    const h = await mailbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.model.classify.bind(h.model);
    h.model.classify = async (request) => {
      await gate;
      return original(request);
    };
    const first = run(h);
    await until(() => count(h, "SELECT COUNT(*) AS n FROM cycles WHERE status = 'running'") === 1);
    const second = await run(h);
    expect(second.status).toBe('busy');
    release();
    expect((await first).status).toBe('ok');
  });

  it('never writes after another process takes over the lease mid-cycle', async () => {
    const h = await mailbox();
    const accountId = h.store.getGmailAccount()!.id;
    h.google.before = (url) => {
      if (url.searchParams.get('format') === 'minimal') {
        // This process stalls past the lease; a cron run takes the mailbox over.
        h.clock.now += LOCK_TTL_MS + 1;
        h.store.acquireLock(`pipeline:${accountId}`, 'cron', LOCK_TTL_MS);
      }
    };
    const result = await run(h);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Another process took over/);
    expect(h.google.gmailWrites()).toHaveLength(0);
    expect(h.store.holdsLock(`pipeline:${accountId}`, 'cron')).toBe(true);
  });

  it('stops a cycle stalled on Gmail at shutdown without writing, and frees the lease', async () => {
    const h = await mailbox();
    await run(h, 'dry-run');
    let stalled = false;
    h.google.before = (url) => {
      if (url.searchParams.get('format') !== 'minimal') return;
      stalled = true;
      return new Promise<void>(() => {});
    };
    const logs: string[] = [];
    const scheduler = new PipelineScheduler(h.context.pipeline, { mode: 'apply', intervalMs: 60_000, log: (line) => logs.push(line) });
    scheduler.start();
    await until(() => stalled);
    expect(await scheduler.stop(2000)).toBe(true);
    expect(scheduler.last?.status).toBe('aborted');
    expect(h.google.gmailWrites()).toHaveLength(0);
    expect(h.store.acquireLock(`pipeline:${h.store.getGmailAccount()!.id}`, 'next', 1000)).toBe(true);
  });

  it('stops a cycle stalled on the model at shutdown without charging the message', async () => {
    const model = new ScriptedModel();
    let started = false;
    model.classify = (request) =>
      new Promise((_resolve, reject) => {
        started = true;
        request.signal?.addEventListener('abort', () => reject(new ProviderError({ provider: 'jev', kind: 'timeout', message: 'aborted' })));
      });
    const h = await mailbox({ model });
    const scheduler = new PipelineScheduler(h.context.pipeline, { mode: 'apply', intervalMs: 60_000, log: () => {} });
    scheduler.start();
    await until(() => started);
    expect(await scheduler.stop(2000)).toBe(true);
    expect(scheduler.last?.status).toBe('aborted');
    expect(count(h, 'SELECT COUNT(*) AS n FROM classifications')).toBe(0);
    expect(count(h, 'SELECT SUM(classify_failures) AS n FROM messages')).toBe(0);
  });
});

describe('setup problems and credential failures', () => {
  it('reports a missing model, connection, or write permission and touches nothing', async () => {
    const noModel = await connectedHarness({ model: null });
    const calls = noModel.google.calls.length;
    const result = await run(noModel, 'dry-run');
    expect(result).toMatchObject({ status: 'not_ready', sync: null });
    expect(result.error).toMatch(/Model not configured: MODEL_PROVIDER is not set/);
    expect(noModel.google.calls).toHaveLength(calls);
    expect(formatCycle(noModel.store.lastCycle()!.summary as unknown as typeof result)).toBe(formatCycle(result));

    const notConnected = createHarness();
    expect((await run(notConnected)).error).toMatch(/Gmail is not connected/);
    expect(notConnected.google.calls).toHaveLength(0);

    const writesOff = await mailbox({ env: { GMAIL_LABEL_WRITES: 'false' } });
    expect((await run(writesOff, 'apply')).error).toMatch(/GMAIL_LABEL_WRITES=true/);
    expect((await run(writesOff, 'dry-run')).status).toBe('ok');
    expect(writesOff.google.gmailWrites()).toHaveLength(0);

    const h = createHarness();
    h.google.grantedScopes = [GMAIL_SCOPES.readonly];
    const { Client } = await import('../helpers/harness.js');
    await (await new Client(h.app).signIn()).connectGmail();
    h.google.addMessages(plainMessage('m1', 'Hi', 'Hello'));
    const readOnly = await run(h, 'apply');
    expect(readOnly.status).toBe('not_ready');
    expect(readOnly.error).toMatch(/gmail\.modify/);
    expect(h.google.gmailCalls()).toHaveLength(1); // the profile read during connect
  });

  it('stops on a revoked Gmail grant after one token request and does not retry it every cycle', async () => {
    const h = await mailbox();
    await run(h);
    h.google.addMessages(plainMessage('m3', 'Later', 'c'));
    h.clock.now += 2 * 3600_000;
    h.google.refreshInvalidGrant = true;
    const tokenCalls = () => h.google.calls.filter((call) => call.url.includes('oauth2.googleapis.com/token')).length;
    const before = tokenCalls();
    const result = await run(h);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/revoked or expired/) });
    expect(tokenCalls()).toBe(before + 1);
    expect(h.store.getGmailAccount()!.tokenStatus).toBe('reauth_required');

    expect((await run(h)).status).toBe('not_ready');
    expect(tokenCalls()).toBe(before + 1);
  });

  it('stops labeling at the first permission error instead of trying every message', async () => {
    const h = await mailbox();
    await run(h, 'dry-run');
    h.google.respond = (url) =>
      url.pathname.endsWith('/modify')
        ? new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }), { status: 403 })
        : undefined;
    const result = await run(h);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/HTTP 403 \(insufficientPermissions\)/);
    expect(h.google.modifyCalls()).toHaveLength(1);
  });

  it('stops classification on a provider auth error after one request, without charging messages', async () => {
    const model = new ScriptedModel();
    let calls = 0;
    model.classify = async () => {
      calls += 1;
      throw new ProviderError({ provider: 'jev', kind: 'auth', message: 'Provider returned HTTP 401', status: 401 });
    };
    const h = await mailbox({ model });
    const result = await run(h);
    expect(result).toMatchObject({ status: 'failed', classify: { classified: 0, failed: 0, stoppedEarly: true } });
    expect(result.error).toBe('Classification stopped: jev: Provider returned HTTP 401');
    expect(calls).toBe(1);
    expect(count(h, 'SELECT SUM(classify_failures) AS n FROM messages')).toBe(0);
  });
});

describe('retries', () => {
  it('retries a failed classification later and marks it Needs Review after repeated failures', async () => {
    const h = await mailbox();
    const original = h.model.classify.bind(h.model);
    let m1Calls = 0;
    h.model.classify = async (request) => {
      if (request.email.subject === 'Deploy failed on main') {
        m1Calls += 1;
        throw new ProviderError({ provider: 'jev', kind: 'invalid_output', message: 'Provider response did not match the contract' });
      }
      return original(request);
    };
    const first = await run(h);
    expect(first).toMatchObject({ status: 'partial', classify: { classified: 1, failed: 1 }, tag: { labeled: 1 } });
    await run(h);
    expect(m1Calls).toBe(1);

    for (let i = 1; i < MAX_CLASSIFY_FAILURES; i += 1) {
      h.clock.now += 7 * 3600_000;
      await run(h);
    }
    expect(m1Calls).toBe(MAX_CLASSIFY_FAILURES);
    expect(namespaced(h, 'm1')).toEqual([L.review]);
    h.clock.now += 7 * 3600_000;
    await run(h);
    expect(m1Calls).toBe(MAX_CLASSIFY_FAILURES);
  });

  it('retries a failed label write after a backoff', async () => {
    const h = await mailbox();
    let fail = true;
    h.google.respond = (url) =>
      fail && url.pathname.endsWith('/messages/m1/modify') ? new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), { status: 400 }) : undefined;
    const first = await run(h);
    expect(first).toMatchObject({ status: 'partial', tag: { labeled: 1, failed: 1 } });
    fail = false;
    expect((await run(h)).tag).toMatchObject({ considered: 0 });
    h.clock.now += 61_000;
    expect((await run(h)).tag).toMatchObject({ labeled: 1 });
    expect(namespaced(h, 'm1')).toEqual([L.needsAction, L.notification, L.high].sort());
  });
});

describe('bounds and privacy', () => {
  it('bounds sync and tag batches and never re-downloads stored messages', async () => {
    const h = await connectedHarness({ env: { SYNC_MAX_MESSAGES: '3', TAG_BATCH_SIZE: '2' } });
    for (let i = 1; i <= 5; i += 1) h.google.addMessages(plainMessage(`m${i}`, `Message ${i}`, 'body'));
    const result = await run(h);
    expect(result).toMatchObject({ sync: { listed: 3, added: 3 }, tag: { considered: 2, remaining: 1 } });
    expect((await run(h)).tag).toMatchObject({ considered: 1, remaining: 0 });
    expect(h.google.calls.filter((call) => call.url.includes('format=full'))).toHaveLength(3);
  });

  it('classifies a message too large to download from its headers and snippet', async () => {
    const h = await connectedHarness();
    h.google.addMessages(plainMessage('m1', 'Huge newsletter', 'Short snippet text'));
    h.google.respond = (url) =>
      url.searchParams.get('format') === 'full' ? new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }) : undefined;
    const result = await run(h);
    expect(result).toMatchObject({ sync: { added: 1, failed: 0 }, classify: { classified: 1 } });
    expect(h.model.calls[0]!.email).toMatchObject({ subject: 'Huge newsletter', body: 'Short snippet text' });
  });

  it('keeps subjects and bodies out of cycle summaries and status', async () => {
    const h = await mailbox();
    const result = await run(h);
    const status = await h.client.get('/api/status');
    for (const text of [JSON.stringify(result), formatCycle(result), JSON.stringify(status.body), h.logs.join('\n')]) {
      expect(text).not.toMatch(/Deploy failed|Your receipt|Build 412|Thanks for your order|ops@service/i);
    }
    expect(status.body.gmail.account.tags).toMatchObject({ applied: 2, applied_labeled: 2 });
  });
});
