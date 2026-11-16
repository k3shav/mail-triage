import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { GmailClient } from '../../src/server/gmail/client.js';
import { Client, createHarness } from '../helpers/harness.js';

describe('loopback origins and dev server', () => {
  it('defaults PUBLIC_URL to localhost and accepts every loopback alias of this port', async () => {
    const config = loadConfig({});
    expect(config.publicUrl.origin).toBe('http://localhost:8787');
    expect([...config.allowedOrigins]).toEqual(
      expect.arrayContaining(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']),
    );

    const { app } = createHarness();
    const viaIp = await request(app).post('/api/session/local').set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787');
    expect(viaIp.status).toBe(200);
    const otherPort = await request(app).post('/api/session/local').set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:9999');
    expect(otherPort.status).toBe(403);
  });

  it('allows a loopback WEB_DEV_URL only on loopback servers and redirects OAuth results there', async () => {
    expect(() => loadConfig({ WEB_DEV_URL: 'http://evil.example:5173' })).toThrow(/loopback/);
    expect(() =>
      loadConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'correct horse battery', PUBLIC_URL: 'https://mail.example.com', WEB_DEV_URL: 'http://localhost:5173' }),
    ).toThrow(/loopback/);

    const h = createHarness({ env: { WEB_DEV_URL: 'http://localhost:5173' } });
    const client = await new Client(h.app).signIn();
    const response = await client.get('/api/gmail/oauth/callback?error=access_denied');
    expect(String(response.headers.location)).toBe('http://localhost:5173/?gmail=error&reason=access_denied');
    const dev = await request(h.app).post('/api/session/local').set('Host', 'localhost:8787').set('Origin', 'http://localhost:5173');
    expect(dev.status).toBe(200);
  });
});

describe('Gmail response bounds', () => {
  it('rejects oversized Gmail responses without buffering them fully', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pulled > 50) controller.close();
      },
    });
    const client = new GmailClient({
      tokens: { get: async () => 'token', invalidate: () => {} },
      fetch: async () => new Response(stream, { status: 200 }),
      maxRetries: 0,
    });
    await expect(client.listLabels()).rejects.toMatchObject({ reason: 'too_large' });
    expect(pulled).toBeLessThan(15);
  });
});
