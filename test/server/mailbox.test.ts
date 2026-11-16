import { describe, expect, it } from 'vitest';
import { DEFAULT_TAXONOMY } from '../../src/core/taxonomy.js';
import { ProviderError } from '../../src/providers/errors.js';
import { GMAIL_SCOPES } from '../../src/server/config.js';
import { Client, ScriptedModel, createHarness, type Harness } from '../helpers/harness.js';
import { plainMessage } from '../helpers/fake-google.js';

async function connected(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  h.google.addMessages(
    plainMessage('m1', 'Deploy failed on main', 'Build 412 failed. Please fix the failing test.'),
    plainMessage('m2', 'Your receipt', 'Thanks for your order.', { labelIds: ['INBOX'] }),
    plainMessage('m3', 'Weekly digest', 'Top stories this week.'),
  );
  const client = await new Client(h.app).signIn();
  await client.connectGmail();
  return { h, client };
}

async function firstMessageId(client: Client, subject: string): Promise<number> {
  const list = await client.get('/api/mailboxes/gmail/messages');
  return list.body.messages.find((m: { subject: string }) => m.subject === subject).id;
}

async function readyMessage(h: Harness, client: Client) {
  await client.post('/api/mailboxes/gmail/sync');
  await client.post('/api/mailboxes/gmail/classify', {});
  return firstMessageId(client, 'Deploy failed on main');
}

describe('Gmail sync', () => {
  it('stores new inbox messages, dedupes on re-sync, and never writes to Gmail', async () => {
    const { h, client } = await connected();
    const first = await client.post('/api/mailboxes/gmail/sync');
    expect(first.body).toEqual({ listed: 3, added: 3, refreshed: 0, failed: 0 });
    h.google.messages.get('m1')!.labelIds = ['INBOX'];
    const second = await client.post('/api/mailboxes/gmail/sync');
    expect(second.body).toEqual({ listed: 3, added: 0, refreshed: 3, failed: 0 });

    const list = await client.get('/api/mailboxes/gmail/messages');
    expect(list.body.total).toBe(3);
    const m1 = list.body.messages.find((m: { subject: string }) => m.subject === 'Deploy failed on main');
    expect(m1.unread).toBe(false);
    expect(h.google.calls.filter((c) => c.method === 'POST' && c.url.includes('gmail.googleapis.com'))).toHaveLength(0);
    expect(h.google.messages.get('m3')!.labelIds).toContain('UNREAD');
  });

  it('bounds the number of messages per sync', async () => {
    const { h, client } = await connected({ env: { SYNC_MAX_MESSAGES: '2' } });
    for (let i = 4; i < 10; i += 1) h.google.addMessages(plainMessage(`m${i}`, `Message ${i}`, 'body'));
    const response = await client.post('/api/mailboxes/gmail/sync');
    expect(response.body.listed).toBe(2);
    expect(h.store.countMessages(h.store.getGmailAccount()!.id)).toBe(2);
  });

  it('keeps Gmail ids scoped to their account', async () => {
    const { h, client } = await connected();
    await client.post('/api/mailboxes/gmail/sync');
    const gmailId = h.store.getGmailAccount()!.id;
    h.store.ensureDemoAccount();
    expect(h.store.existingExternalIds('demo', ['m1']).size).toBe(0);
    expect(h.store.existingExternalIds(gmailId, ['m1']).size).toBe(1);
  });

  it('distinguishes a missing Gmail connection from a missing model', async () => {
    const h = createHarness({ model: null });
    const client = await new Client(h.app).signIn();
    const sync = await client.post('/api/mailboxes/gmail/sync');
    expect(sync.body.error.code).toBe('gmail_not_connected');
    await client.connectGmail();
    h.google.addMessages(plainMessage('m1', 'Hi', 'Hello'));
    expect((await client.post('/api/mailboxes/gmail/sync')).status).toBe(200);
    const classify = await client.post('/api/mailboxes/gmail/classify', {});
    expect(classify.status).toBe(409);
    expect(classify.body.error.code).toBe('model_not_configured');
    // The demo inbox still works without a model: it uses fixtures only.
    expect((await client.post('/api/mailboxes/demo/classify', {})).body.classified).toBe(12);
  });
});

describe('classification runs', () => {
  it('passes category descriptions and reader context to the model and bounds each run', async () => {
    const { h, client } = await connected({ env: { CLASSIFY_BATCH_SIZE: '2' } });
    await client.put('/api/taxonomy', { expectedRevision: 1, taxonomy: { ...DEFAULT_TAXONOMY, userContext: 'I am on call this week.' } });
    await client.post('/api/mailboxes/gmail/sync');
    const run = await client.post('/api/mailboxes/gmail/classify', {});
    expect(run.body).toMatchObject({ attempted: 2, classified: 2, remaining: 1 });
    expect(h.model.calls[0]!.taxonomy.userContext).toBe('I am on call this week.');
    expect(h.model.calls[0]!.taxonomy.categories.find((c) => c.id === 'receipt')!.description).toMatch(/Receipts/);
    expect((await client.post('/api/mailboxes/gmail/classify', {})).body).toMatchObject({ attempted: 1, remaining: 0 });
    expect((await client.post('/api/mailboxes/gmail/classify', {})).body).toMatchObject({ attempted: 0 });
  });

  it('records provider failures per message and stops early on fatal errors', async () => {
    const model = new ScriptedModel();
    model.classify = async () => {
      throw new ProviderError({ provider: 'jev', kind: 'auth', message: 'Provider returned HTTP 401', status: 401 });
    };
    const { h, client } = await connected({ model });
    await client.post('/api/mailboxes/gmail/sync');
    const run = await client.post('/api/mailboxes/gmail/classify', {});
    expect(run.body.stoppedEarly).toBe(true);
    expect(run.body.classified).toBe(0);
    const list = await client.get('/api/mailboxes/gmail/messages?state=error');
    expect(list.body.total).toBeGreaterThan(0);
    expect(list.body.messages[0].lastError).toBe('jev: Provider returned HTTP 401');
    expect(h.store.lastRun(h.store.getGmailAccount()!.id, 'classify')!.status).toBe('failed');
  });

  it('rejects overlapping runs for the same mailbox', async () => {
    const model = new ScriptedModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = model.classify.bind(model);
    model.classify = async (request) => {
      await gate;
      return original(request);
    };
    const { client } = await connected({ model });
    await client.post('/api/mailboxes/gmail/sync');
    const first = client.post('/api/mailboxes/gmail/classify', {}).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await client.post('/api/mailboxes/gmail/classify', {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('busy');
    release();
    expect((await first).status).toBe(200);
  });

  it('routes low confidence to review and lets corrections confirm it', async () => {
    const { h, client } = await connected();
    h.model.next = () => ({ category: { status: 'answered', value: 'marketing', confidence: 0.3, selectedProbability: 0.5, probabilities: null } });
    const id = await readyMessage(h, client);
    const detail = await client.get(`/api/mailboxes/gmail/messages/${id}`);
    expect(detail.body.decision.state).toBe('needs_review');
    expect(detail.body.decision.reviewReasons[0]).toMatch(/confidence 0\.30/);

    const corrected = await client.post(`/api/mailboxes/gmail/messages/${id}/corrections`, {
      kind: 'edit',
      category: 'notification',
      action: 'needs_action',
      priority: 'high',
    });
    expect(corrected.body.decision).toMatchObject({ state: 'confirmed', source: 'human', category: 'notification' });
    expect(corrected.body.history.corrections).toHaveLength(1);
    const bad = await client.post(`/api/mailboxes/gmail/messages/${id}/corrections`, { kind: 'edit', category: 'nope', action: 'needs_action', priority: 'high' });
    expect(bad.status).toBe(400);
  });

  it('marks decisions stale after a configuration change and reclassifies safely', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const taxonomy = (await client.get('/api/taxonomy')).body;
    const edited = structuredClone(taxonomy.taxonomy);
    edited.categories.push({ id: 'deploys', name: 'Deploys', description: 'CI and deployment results.' });
    const update = await client.put('/api/taxonomy', { expectedRevision: taxonomy.revision, taxonomy: edited });
    expect(update.body.revision).toBe(2);
    const conflict = await client.put('/api/taxonomy', { expectedRevision: taxonomy.revision, taxonomy: edited });
    expect(conflict.status).toBe(409);

    const detail = await client.get(`/api/mailboxes/gmail/messages/${id}`);
    expect(detail.body.decision).toMatchObject({ state: 'stale', staleRevision: 1, category: null });
    const pending = await client.get('/api/mailboxes/gmail/messages?state=pending');
    expect(pending.body.total).toBe(3);
    h.model.next = () => ({ category: { status: 'answered', value: 'deploys', confidence: 0.9, selectedProbability: 0.92, probabilities: null } });
    await client.post('/api/mailboxes/gmail/classify', {});
    const after = await client.get(`/api/mailboxes/gmail/messages/${id}`);
    expect(after.body.decision).toMatchObject({ state: 'ready', category: 'deploys' });
    expect(after.body.history.classifications).toHaveLength(2);
  });
});

describe('label preview and apply', () => {
  it('previews additive namespaced labels and applies them with addLabelIds only', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(preview.body).toMatchObject({
      canApply: true,
      simulated: false,
      toAdd: ['Mail Triage/Category/Notification', 'Mail Triage/Action/Needs Action', 'Mail Triage/Priority/High'],
      alreadyPresent: [],
    });
    expect(h.google.modifyCalls()).toHaveLength(0);

    const apply = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(apply.body).toMatchObject({ status: 'applied', replayed: false, simulated: false });
    const modify = h.google.modifyCalls();
    expect(modify).toHaveLength(1);
    const body = JSON.parse(modify[0]!.body!);
    expect(Object.keys(body)).toEqual(['addLabelIds']);
    expect(body.addLabelIds).toHaveLength(3);
    expect(h.google.labelNamesOf('m1')).toEqual(
      expect.arrayContaining(['INBOX', 'UNREAD', 'Mail Triage/Category/Notification', 'Mail Triage/Action/Needs Action', 'Mail Triage/Priority/High']),
    );
  });

  it('is idempotent: replaying a preview never calls Gmail again', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    const replay = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(replay.body).toMatchObject({ status: 'applied', replayed: true });
    expect(h.google.modifyCalls()).toHaveLength(1);

    const second = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(second.body.toAdd).toEqual([]);
    expect(second.body.alreadyPresent).toHaveLength(3);
    const noop = await client.post('/api/mailboxes/gmail/apply', { previewId: second.body.previewId });
    expect(noop.body.status).toBe('noop');
    expect(h.google.modifyCalls()).toHaveLength(1);
  });

  it('lets only one of several concurrent applies reach Gmail', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    const results = await Promise.all([1, 2, 3].map(() => client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId })));
    expect(h.google.modifyCalls()).toHaveLength(1);
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r.status !== 200)) expect(r.body.error.code).toBe('apply_in_progress');
  });

  it('rejects a preview after the configuration changes', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    await client.put('/api/taxonomy', { expectedRevision: 1, taxonomy: { ...DEFAULT_TAXONOMY, userContext: 'changed' } });
    const apply = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(apply.status).toBe(409);
    expect(apply.body.error.code).toBe('stale_config');
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('rejects a preview after a correction or a reclassification', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    await client.post(`/api/mailboxes/gmail/messages/${id}/corrections`, { kind: 'edit', category: 'fyi', action: 'no_action', priority: 'low' });
    const afterCorrection = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(afterCorrection.body.error.code).toBe('stale_decision');

    const preview2 = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(preview2.body.toAdd).toContain('Mail Triage/Category/FYI');
    h.model.model = 'jev-1.14.0';
    await client.post(`/api/mailboxes/gmail/messages/${id}/classify`);
    const afterReclassify = await client.post('/api/mailboxes/gmail/apply', { previewId: preview2.body.previewId });
    expect(afterReclassify.body.error.code).toBe('stale_decision');
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('rejects previews from another account, expired previews, and unknown ids', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    const viaDemo = await client.post('/api/mailboxes/demo/apply', { previewId: preview.body.previewId });
    expect(viaDemo.body.error.code).toBe('account_mismatch');

    h.clock.now += 11 * 60_000;
    const expired = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(expired.status).toBe(410);
    const unknown = await client.post('/api/mailboxes/gmail/apply', { previewId: 'pv_doesnotexist123' });
    expect(unknown.status).toBe(404);
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('invalidates previews when the account is disconnected and reconnected', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    await client.post('/api/gmail/disconnect');
    h.google.validCodes.add('code-2');
    await client.connectGmail('code-2');
    const apply = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(apply.status).toBe(404);
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('checks the exact Gmail message at apply time', async () => {
    const { h, client } = await connected();
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    h.google.messages.get('m1')!.threadId = 'tother';
    const apply = await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(apply.body.error.code).toBe('message_mismatch');
    expect(h.google.modifyCalls()).toHaveLength(0);
  });

  it('blocks apply when review is pending', async () => {
    const { h, client } = await connected();
    h.model.next = () => ({ action: { status: 'refused' } });
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(preview.body).toMatchObject({ canApply: false, previewId: null });
    expect(preview.body.blockedReason).toMatch(/Review/);
  });

  it('blocks apply without gmail.modify and when label writes are disabled', async () => {
    const { h, client } = await connected();
    h.google.grantedScopes = [GMAIL_SCOPES.readonly];
    h.google.validCodes.add('code-2');
    await client.connectGmail('code-2');
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(preview.body).toMatchObject({ canApply: false, previewId: null });
    expect(preview.body.blockedReason).toMatch(/gmail\.modify/);
    expect(preview.body.toAdd).toHaveLength(3);

    const off = await connected({ env: { GMAIL_LABEL_WRITES: 'false' } });
    const offId = await readyMessage(off.h, off.client);
    const offPreview = await off.client.post(`/api/mailboxes/gmail/messages/${offId}/label-preview`);
    expect(offPreview.body.blockedReason).toMatch(/GMAIL_LABEL_WRITES/);
  });

  it('shows existing conflicting Mail Triage labels and never removes them', async () => {
    const { h, client } = await connected();
    const old = h.google.addLabel('Mail Triage/Category/Marketing');
    h.google.addLabel('Mail Triage/Action/Needs Action');
    h.google.messages.get('m1')!.labelIds.push(old);
    const id = await readyMessage(h, client);
    const preview = await client.post(`/api/mailboxes/gmail/messages/${id}/label-preview`);
    expect(preview.body.existingNamespaced).toEqual([{ name: 'Mail Triage/Category/Marketing', field: 'category', conflicts: true }]);
    expect(preview.body.notes.join(' ')).toMatch(/remain/);
    await client.post('/api/mailboxes/gmail/apply', { previewId: preview.body.previewId });
    expect(h.google.labelNamesOf('m1')).toContain('Mail Triage/Category/Marketing');
    expect(h.google.labelNamesOf('m1')).toContain('Mail Triage/Category/Notification');
    // The existing label was reused, not duplicated.
    expect(h.google.labels.filter((l) => l.name === 'Mail Triage/Action/Needs Action')).toHaveLength(1);
  });

  it('simulates apply locally for the demo inbox', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.post('/api/mailboxes/demo/classify', {});
    const list = await client.get('/api/mailboxes/demo/messages');
    const id = list.body.messages[0].id;
    expect(list.body.messages[0].decision.state).toBe('needs_review');
    await client.post(`/api/mailboxes/demo/messages/${id}/corrections`, { kind: 'accept', category: 'fyi', action: 'needs_response', priority: 'high' });
    const preview = await client.post(`/api/mailboxes/demo/messages/${id}/label-preview`);
    expect(preview.body).toMatchObject({ canApply: true, simulated: true });
    const apply = await client.post('/api/mailboxes/demo/apply', { previewId: preview.body.previewId });
    expect(apply.body).toMatchObject({ status: 'applied', simulated: true });
    const detail = await client.get(`/api/mailboxes/demo/messages/${id}`);
    expect(detail.body.labels).toContain('Mail Triage/Category/FYI');
    expect(h.google.calls).toHaveLength(0);
  });
});
