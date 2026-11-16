import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { Client, ORIGIN, createHarness } from '../helpers/harness.js';

describe('startup configuration', () => {
  it('refuses a non-loopback bind without an app password', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/APP_PASSWORD/);
    expect(() => loadConfig({ HOST: '192.168.1.20', PUBLIC_URL: 'https://mail.example.com' })).toThrow(/APP_PASSWORD/);
    expect(loadConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'correct horse battery', PUBLIC_URL: 'https://mail.example.com' }).auth.mode).toBe('password');
  });

  it('requires a password when a public URL or proxy puts a loopback bind on the network', () => {
    // A reverse proxy forwarding https://mail.example.com to 127.0.0.1 makes the app public.
    expect(() => loadConfig({ HOST: '127.0.0.1', PUBLIC_URL: 'https://mail.example.com', DEMO_INBOX: 'false' })).toThrow(/APP_PASSWORD/);
    expect(() => loadConfig({ HOST: '::1', PUBLIC_URL: 'https://mail.example.com' })).toThrow(/APP_PASSWORD/);
    expect(() => loadConfig({ HOST: '127.0.0.1', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY requires APP_PASSWORD/);
    expect(() => loadConfig({ PUBLIC_URL: 'http://localhost:8787', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);

    const proxied = loadConfig({
      HOST: '127.0.0.1',
      PUBLIC_URL: 'https://mail.example.com',
      APP_PASSWORD: 'correct horse battery',
      TRUST_PROXY: 'true',
    });
    expect(proxied).toMatchObject({ auth: { mode: 'password' }, trustProxy: true, secureCookies: true });
    expect(proxied.allowedHosts.has('mail.example.com')).toBe(true);

    for (const local of [{}, { PUBLIC_URL: 'http://localhost:8787' }, { PUBLIC_URL: 'http://127.0.0.1:8787' }, { PUBLIC_URL: 'http://[::1]:8787' }]) {
      expect(loadConfig(local).auth.mode).toBe('local');
    }
  });

  it('rejects short passwords, plain-http public URLs, and cross-origin redirect URIs', () => {
    expect(() => loadConfig({ APP_PASSWORD: 'short' })).toThrow(/12 characters/);
    expect(() => loadConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'correct horse battery', PUBLIC_URL: 'http://mail.example.com' })).toThrow(/https/);
    expect(() => loadConfig({ GOOGLE_REDIRECT_URI: 'https://elsewhere.example/cb' })).toThrow(/same origin/);
  });

  it('defaults to loopback with local sessions and read-only Gmail scope', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.auth.mode).toBe('local');
    expect(config.labelWrites).toBe(false);
    expect(config.google).toBeNull();
    expect(config.googleMissing).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MAIL_TRIAGE_ENCRYPTION_KEY']);
  });
});

describe('HTTP protections', () => {
  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const { app } = createHarness();
    const response = await request(app).get('/api/health').set('Host', 'attacker.example:8787');
    expect(response.status).toBe(421);
  });

  it('requires a session for every API operation', async () => {
    const { app } = createHarness();
    const client = new Client(app);
    for (const path of ['/api/status', '/api/taxonomy', '/api/mailboxes/demo/messages']) {
      expect((await client.get(path)).status).toBe(401);
    }
    expect((await client.post('/api/mailboxes/demo/classify', {})).status).toBe(401);
  });

  it('requires same origin and a CSRF token for state changes', async () => {
    const { app } = createHarness();
    const client = await new Client(app).signIn();
    const crossSite = await client.agent
      .post('/api/mailboxes/demo/classify')
      .set('Host', 'localhost:8787')
      .set('Origin', 'https://attacker.example')
      .set('x-csrf-token', client.csrf)
      .send({});
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe('bad_origin');

    const noToken = await client.agent.post('/api/mailboxes/demo/classify').set('Host', 'localhost:8787').set('Origin', ORIGIN).send({});
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('bad_csrf');

    const noOrigin = await client.agent.post('/api/mailboxes/demo/classify').set('Host', 'localhost:8787').set('x-csrf-token', client.csrf).send({});
    expect(noOrigin.status).toBe(403);

    expect((await client.post('/api/mailboxes/demo/classify', {})).status).toBe(200);
  });

  it('issues HttpOnly SameSite=Lax session cookies and strict security headers', async () => {
    const { app } = createHarness();
    const response = await new Client(app).post('/api/session/local');
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/mail_triage_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses __Host- Secure cookies behind HTTPS and password sign-in with rate limiting', async () => {
    const { app } = createHarness({
      env: { HOST: '0.0.0.0', APP_PASSWORD: 'correct horse battery', PUBLIC_URL: 'https://mail.example.com' },
    });
    const post = (body: unknown) =>
      request(app).post('/api/session/login').set('Host', 'mail.example.com').set('Origin', 'https://mail.example.com').send(body as object);
    expect((await request(app).post('/api/session/local').set('Host', 'mail.example.com').set('Origin', 'https://mail.example.com')).status).toBe(403);
    const ok = await post({ password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/__Host-mail_triage_session=.*Secure/);
    for (let i = 0; i < 10; i += 1) expect((await post({ password: 'wrong' })).status).toBe(401);
    expect((await post({ password: 'correct horse battery' })).status).toBe(429);
  });

  it('gives proxied visitors no local session; they sign in with the password', async () => {
    const { app } = createHarness({
      env: { HOST: '127.0.0.1', PUBLIC_URL: 'https://mail.example.com', APP_PASSWORD: 'correct horse battery', TRUST_PROXY: 'true' },
    });
    // What the proxy forwards for a browser visiting the public origin.
    const proxied = (req: request.Test) =>
      req.set('Host', 'mail.example.com').set('Origin', 'https://mail.example.com').set('X-Forwarded-For', '203.0.113.9');
    const local = await proxied(request(app).post('/api/session/local'));
    expect(local.status).toBe(403);
    expect(local.body.error.code).toBe('password_required');
    expect(local.headers['set-cookie']).toBeUndefined();
    expect((await proxied(request(app).get('/api/status'))).status).toBe(401);

    const login = await proxied(request(app).post('/api/session/login')).send({ password: 'correct horse battery' });
    expect(login.status).toBe(200);
    // Sign-in clears any earlier cookie first; the last Set-Cookie is the new session.
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).at(-1)!.split(';')[0]!;
    expect(cookie).toMatch(/^__Host-mail_triage_session=/);
    const status = await proxied(request(app).get('/api/status')).set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.body.auth.mode).toBe('password');
  });

  it('bounds request bodies', async () => {
    const { app } = createHarness();
    const client = await new Client(app).signIn();
    const response = await client.put('/api/taxonomy', { expectedRevision: 1, taxonomy: { categories: [], userContext: 'x'.repeat(70_000) } });
    expect(response.status).toBe(413);
  });

  it('never exposes secrets in status responses', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    const status = await client.get('/api/status');
    const text = JSON.stringify(status.body);
    expect(text).not.toMatch(/refresh|ya29|client-secret|1\/\//);
    expect(status.body.gmail.account.email).toBe('me@example.com');
  });
});
