import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PipelineScheduler } from '../../src/server/services/scheduler.js';
import { plainMessage } from '../helpers/fake-google.js';
import { Client, connectedHarness, createHarness } from '../helpers/harness.js';

const asset = (name: string) => readFileSync(new URL(`../../src/server/setup/public/${name}`, import.meta.url), 'utf8');

describe('setup page', () => {
  it('serves static HTML with external script and styles only, under a strict CSP', async () => {
    const { app } = createHarness();
    const page = await request(app).get('/').set('Host', 'localhost:8787');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(page.text).toContain('<script src="/setup.js" defer></script>');
    expect(page.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page.text).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page.text).not.toMatch(/\sstyle\s*=/i);

    const script = await request(app).get('/setup.js').set('Host', 'localhost:8787');
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect((await request(app).get('/setup.css').set('Host', 'localhost:8787')).headers['content-type']).toMatch(/text\/css/);
  });

  it('only talks to setup endpoints and never renders HTML from responses', () => {
    const script = asset('setup.js');
    const paths = [...script.matchAll(/api\('(?:GET|POST|PUT)', '([^']+)'/g)].map((match) => match[1]);
    expect(new Set(paths)).toEqual(
      new Set(['/taxonomy', '/status', '/session', '/session/local', '/session/login', '/gmail/connect', '/pipeline/run', '/gmail/disconnect', '/session/logout']),
    );
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('has no message list, body, or review endpoints', async () => {
    const h = await connectedHarness();
    h.google.addMessages(plainMessage('m1', 'Deploy failed on main', 'Build failed.'));
    await h.context.pipeline.runCycle({ mode: 'dry-run' });
    const id = (h.store.db.prepare('SELECT id FROM messages').get() as { id: number }).id;
    for (const path of ['/api/mailboxes/gmail/messages', `/api/mailboxes/gmail/messages/${id}`, '/api/messages', '/api/review-policy']) {
      expect((await h.client.get(path)).status).toBe(404);
    }
    for (const path of ['/api/mailboxes/gmail/sync', '/api/mailboxes/gmail/classify', `/api/mailboxes/gmail/messages/${id}/label-preview`, '/api/mailboxes/gmail/apply']) {
      expect((await h.client.post(path, {})).status).toBe(404);
    }
    const status = await h.client.get('/api/status');
    expect(status.body).toMatchObject({ mode: 'dry-run', ready: { problems: [] }, pipeline: { polling: false, lastCycle: { status: 'ok', mode: 'dry-run' } } });
    expect(JSON.stringify(status.body)).not.toMatch(/Deploy failed|Build failed/);
  });

  it('can be turned off while health and OAuth stay available', async () => {
    const { app } = createHarness({ env: { SETUP_PAGE: 'false' } });
    const root = await request(app).get('/').set('Host', 'localhost:8787');
    expect(root.headers['content-type']).toMatch(/text\/plain/);
    expect(root.text).toMatch(/SETUP_PAGE=false/);
    expect((await request(app).get('/setup.js').set('Host', 'localhost:8787')).status).toBe(404);
    expect((await request(app).get('/api/health').set('Host', 'localhost:8787')).body).toEqual({ ok: true });
  });

  it('refuses database edits when categories come from a file', async () => {
    const h = createHarness({ env: { CATEGORIES_FILE: 'examples/categories.json' } });
    const client = await new Client(h.app).signIn();
    const current = (await client.get('/api/taxonomy')).body;
    expect(current.source).toBe('file');
    const response = await client.put('/api/taxonomy', { expectedRevision: current.revision, taxonomy: current.taxonomy });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('managed_by_file');
  });

  it('runs a cycle on request only when background tagging is on in this process', async () => {
    const h = await connectedHarness();
    expect((await h.client.post('/api/pipeline/run')).body.error.code).toBe('polling_disabled');

    h.context.scheduler = new PipelineScheduler(h.context.pipeline, { mode: 'dry-run', intervalMs: 60_000, log: () => {} });
    const response = await h.client.post('/api/pipeline/run');
    expect(response.status).toBe(202);
    for (let i = 0; i < 200 && !h.context.scheduler.last; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.context.scheduler.last?.status).toBe('ok');
    expect(await h.context.scheduler.stop()).toBe(true);
  });
});
