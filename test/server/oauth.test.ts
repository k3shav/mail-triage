import { describe, expect, it } from 'vitest';
import { GMAIL_SCOPES } from '../../src/server/config.js';
import { SecretBox, parseEncryptionKey } from '../../src/server/crypto.js';
import { Client, TEST_KEY, createHarness } from '../helpers/harness.js';

const location = (response: { headers: Record<string, unknown> }) => new URL(String(response.headers.location), 'http://localhost:8787');

describe('Gmail OAuth flow', () => {
  it('builds an offline web-server authorization URL with the exact redirect URI', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    const response = await client.post('/api/gmail/connect');
    const url = new URL(response.body.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/gmail/oauth/callback');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([GMAIL_SCOPES.readonly, GMAIL_SCOPES.labels, GMAIL_SCOPES.modify]);
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });

  it('requests only gmail.readonly when label writes are disabled', async () => {
    const h = createHarness({ env: { GMAIL_LABEL_WRITES: 'false' } });
    const client = await new Client(h.app).signIn();
    const url = new URL((await client.post('/api/gmail/connect')).body.url);
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.readonly);
  });

  it('connects, stores granted scopes, and encrypts the refresh token at rest', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    const response = await client.connectGmail();
    expect(response.status).toBe(303);
    expect(location(response).search).toBe('?gmail=connected');

    const account = h.store.getGmailAccount()!;
    expect(account.email).toBe('me@example.com');
    expect(account.grantedScopes).toEqual([...h.google.grantedScopes].sort());
    const raw = h.store.db.prepare('SELECT refresh_token_enc FROM accounts WHERE id = ?').get(account.id) as { refresh_token_enc: string };
    expect(raw.refresh_token_enc).toMatch(/^v1\./);
    expect(raw.refresh_token_enc).not.toContain('refresh-');
    const box = new SecretBox(parseEncryptionKey(TEST_KEY));
    expect(box.decrypt(raw.refresh_token_enc, account.id)).toMatch(/^1\/\/refresh-/);
    expect(h.logs.join('\n')).not.toMatch(/ya29|1\/\/refresh|good-code/);
  });

  it('rejects replayed, unknown, expired, and other-session states', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    const start = await client.post('/api/gmail/connect');
    const state = new URL(start.body.url).searchParams.get('state')!;

    const other = await new Client(h.app).signIn();
    const stolen = await other.get(`/api/gmail/oauth/callback?code=good-code&state=${state}`);
    expect(location(stolen).searchParams.get('reason')).toBe('session_mismatch');
    // The state was burned by the failed attempt; the original session cannot reuse it either.
    const replay = await client.get(`/api/gmail/oauth/callback?code=good-code&state=${state}`);
    expect(location(replay).searchParams.get('reason')).toBe('state_used');
    expect(h.store.getGmailAccount()).toBeNull();

    const unknown = await client.get('/api/gmail/oauth/callback?code=good-code&state=made-up');
    expect(location(unknown).searchParams.get('reason')).toBe('invalid_state');

    const fresh = await client.post('/api/gmail/connect');
    const freshState = new URL(fresh.body.url).searchParams.get('state')!;
    h.clock.now += 11 * 60_000;
    const expired = await client.get(`/api/gmail/oauth/callback?code=good-code&state=${freshState}`);
    expect(location(expired).searchParams.get('reason')).toBe('state_expired');
    expect(h.google.calls.filter((call) => call.url.includes('/token'))).toHaveLength(0);
  });

  it('accepts a state only once even after success', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    const start = await client.post('/api/gmail/connect');
    const state = new URL(start.body.url).searchParams.get('state')!;
    expect(location(await client.get(`/api/gmail/oauth/callback?code=good-code&state=${state}`)).search).toBe('?gmail=connected');
    h.google.validCodes.add('second-code');
    const again = await client.get(`/api/gmail/oauth/callback?code=second-code&state=${state}`);
    expect(location(again).searchParams.get('reason')).toBe('state_used');
  });

  it('reports provider errors with fixed codes and never reflects input', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    const start = await client.post('/api/gmail/connect');
    const state = new URL(start.body.url).searchParams.get('state')!;
    const denied = await client.get(`/api/gmail/oauth/callback?error=access_denied&state=${state}&error_description=%3Cscript%3E`);
    expect(String(denied.headers.location)).toBe('/?gmail=error&reason=access_denied');
    const weird = await client.get('/api/gmail/oauth/callback?error=%3Cimg%20src%3Dx%3E');
    expect(String(weird.headers.location)).toBe('/?gmail=error&reason=oauth_error');
    const noSession = await new Client(h.app).get(`/api/gmail/oauth/callback?code=good-code&state=${state}`);
    expect(String(noSession.headers.location)).toBe('/?gmail=error&reason=session_missing');
    const badCode = await client.connectGmail('bad-code');
    expect(location(badCode).searchParams.get('reason')).toBe('token_exchange_failed');
  });

  it('handles partial consent: read-only grant disables apply; no read grant is refused and revoked', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    h.google.grantedScopes = [GMAIL_SCOPES.readonly];
    await client.connectGmail();
    const status = await client.get('/api/status');
    expect(status.body.gmail.account.capabilities).toMatchObject({ canRead: true, hasModifyScope: false, canApply: false });
    expect(status.body.gmail.account.capabilities.applyBlockedReason).toMatch(/gmail\.modify/);

    const h2 = createHarness();
    const client2 = await new Client(h2.app).signIn();
    h2.google.grantedScopes = [GMAIL_SCOPES.labels];
    const response = await client2.connectGmail();
    expect(location(response).searchParams.get('reason')).toBe('missing_read_scope');
    expect(h2.store.getGmailAccount()).toBeNull();
    expect(h2.google.revoked).toHaveLength(1);
  });

  it('preserves the existing encrypted refresh token when a reconnect omits it', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    const before = h.store.getGmailAccount()!;
    h.google.issueRefreshToken = false;
    h.google.grantedScopes = [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify];
    h.google.validCodes.add('code-2');
    const response = await client.connectGmail('code-2');
    expect(location(response).search).toBe('?gmail=connected');
    const after = h.store.getGmailAccount()!;
    expect(after.id).toBe(before.id);
    expect(after.refreshTokenEnc).toBe(before.refreshTokenEnc);
    expect(after.grantedScopes).toEqual([GMAIL_SCOPES.modify, GMAIL_SCOPES.readonly].sort());
  });

  it('refuses a first connection that returns no refresh token', async () => {
    const h = createHarness();
    h.google.issueRefreshToken = false;
    const client = await new Client(h.app).signIn();
    expect(location(await client.connectGmail()).searchParams.get('reason')).toBe('no_refresh_token');
  });

  it('refuses to bind a different Google account to existing local data', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    h.google.email = 'someone-else@example.com';
    h.google.validCodes.add('code-2');
    const response = await client.connectGmail('code-2');
    expect(location(response).searchParams.get('reason')).toBe('different_account');
    expect(h.store.getGmailAccount()!.email).toBe('me@example.com');
  });

  it('refreshes access tokens once under concurrency and marks revoked grants for reauth', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    const account = h.store.getGmailAccount()!;
    h.clock.now += 2 * 3600_000; // cached access token expired
    const source = h.context.connection.tokenSource(account.id);
    const tokens = await Promise.all([source.get(), source.get(), source.get()]);
    expect(new Set(tokens).size).toBe(1);
    expect(h.google.calls.filter((call) => call.body?.includes('grant_type=refresh_token'))).toHaveLength(1);

    h.clock.now += 2 * 3600_000;
    h.google.refreshInvalidGrant = true;
    await expect(source.get()).rejects.toMatchObject({ code: 'gmail_reauth_required' });
    expect(h.store.getGmailAccount()!.tokenStatus).toBe('reauth_required');
  });

  it('reports a changed encryption key instead of failing obscurely', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    h.store.db.prepare("UPDATE accounts SET key_fingerprint = 'different' WHERE kind = 'gmail'").run();
    const status = await client.get('/api/status');
    expect(status.body.gmail.account.keyMismatch).toBe(true);
  });

  it('disconnect revokes at Google and deletes local Gmail data', async () => {
    const h = createHarness();
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    const response = await client.post('/api/gmail/disconnect');
    expect(response.body).toEqual({ revoked: true });
    expect(h.google.revoked[0]).toMatch(/^1\/\/refresh-/);
    expect(h.store.getGmailAccount()).toBeNull();
  });

  it('fails cleanly when Gmail is not configured', async () => {
    const h = createHarness({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
    const client = await new Client(h.app).signIn();
    const response = await client.post('/api/gmail/connect');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('gmail_not_configured');
    const status = await client.get('/api/status');
    expect(status.body.gmail).toMatchObject({ configured: false, problem: expect.stringMatching(/GOOGLE_CLIENT_ID/) });
    expect(status.body.model.configured).toBe(true);
  });
});
