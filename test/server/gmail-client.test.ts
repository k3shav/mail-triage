import { describe, expect, it } from 'vitest';
import { GmailApiError, GmailClient, MAX_ERROR_BODY_BYTES, MAX_FULL_MESSAGE_BYTES, WriteSupersededError, type AccessTokenSource } from '../../src/server/gmail/client.js';
import { BodyTooLargeError, readBoundedText } from '../../src/server/http/bounded-body.js';
import { MAX_PARTS, extractBody, prunePartTree, type GmailPart } from '../../src/server/gmail/mime.js';
import { parseGmailMessage } from '../../src/server/services/sync.js';
import { connectedHarness } from '../helpers/harness.js';
import { plainMessage } from '../helpers/fake-google.js';

const CHUNK = 64 * 1024;

/** A response whose body is produced on demand, recording how much was pulled and whether it was cancelled. */
function streamedResponse(options: { totalBytes: number; status?: number; prefix?: string; contentLength?: number }) {
  const probe = { pulledBytes: 0, cancelled: false };
  const prefix = new TextEncoder().encode(options.prefix ?? '');
  let sentPrefix = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentPrefix && prefix.byteLength > 0) {
        sentPrefix = true;
        probe.pulledBytes += prefix.byteLength;
        controller.enqueue(prefix);
        return;
      }
      if (probe.pulledBytes >= options.totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, options.totalBytes - probe.pulledBytes);
      probe.pulledBytes += size;
      controller.enqueue(new Uint8Array(size).fill(0x41));
    },
    cancel() {
      probe.cancelled = true;
    },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength);
  return { response: new Response(body, { status: options.status ?? 200, headers }), probe };
}

const tokens = { get: async () => 'ya29.test', invalidate: () => {} };

describe('bounded response reads', () => {
  it('stops pulling and cancels the stream once the limit is passed', async () => {
    const { response, probe } = streamedResponse({ totalBytes: 50 * 1024 * 1024 });
    await expect(readBoundedText(response, 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(probe.cancelled).toBe(true);
    // At most one chunk past the limit, plus the stream's small read-ahead, was ever produced.
    expect(probe.pulledBytes).toBeLessThanOrEqual(1024 * 1024 + 3 * CHUNK);
  });

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const { response, probe } = streamedResponse({ totalBytes: 10 * 1024 * 1024, contentLength: 10 * 1024 * 1024 });
    await expect(readBoundedText(response, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(probe.cancelled).toBe(true);
    expect(probe.pulledBytes).toBeLessThanOrEqual(CHUNK);
  });

  it('returns bodies within the limit, including multi-byte text split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"x":"héllo ✓"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await readBoundedText(new Response(body), 1024)).toBe('{"x":"héllo ✓"}');
    expect(await readBoundedText(new Response(null), 1024)).toBe('');
  });

  it('fails an oversized format=full message with a safe error after bounded consumption', async () => {
    const { response, probe } = streamedResponse({ totalBytes: 64 * 1024 * 1024, prefix: '{"id":"m1","threadId":"t1","payload":{"body":{"data":"' });
    const client = new GmailClient({ tokens, fetch: async () => response, maxRetries: 0 });
    const error = await client.getMessageFull('m1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailApiError);
    expect(error).toMatchObject({ status: 502, reason: 'too_large' });
    expect(probe.cancelled).toBe(true);
    expect(probe.pulledBytes).toBeLessThanOrEqual(MAX_FULL_MESSAGE_BYTES + 3 * CHUNK);
  });

  it('bounds error bodies too', async () => {
    const { response, probe } = streamedResponse({ status: 500, totalBytes: 64 * 1024 * 1024, prefix: '{"error":{"status":"' });
    const client = new GmailClient({ tokens, fetch: async () => response, maxRetries: 0 });
    const error = await client.getProfile().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500, reason: undefined });
    expect(probe.cancelled).toBe(true);
    expect(probe.pulledBytes).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES + 3 * CHUNK);
  });

  it('reads an oversized message by headers only during sync, without buffering it', async () => {
    const h = await connectedHarness();
    h.google.addMessages(
      plainMessage('m1', 'Deploy failed on main', 'Build 412 failed.'),
      plainMessage('m2', 'Huge newsletter', 'Body that is never read', { snippet: 'Gmail snippet' }),
      plainMessage('m3', 'Weekly digest', 'Top stories.'),
    );
    const probes: Array<{ pulledBytes: number; cancelled: boolean }> = [];
    h.google.respond = (url) => {
      if (!url.pathname.endsWith('/messages/m2') || url.searchParams.get('format') !== 'full') return undefined;
      const { response, probe } = streamedResponse({ totalBytes: 32 * 1024 * 1024, prefix: '{"id":"m2","threadId":"tm2","payload":{"body":{"data":"' });
      probes.push(probe);
      return response;
    };
    const result = await h.context.pipeline.runCycle({ mode: 'dry-run' });
    expect(result.sync).toEqual({ listed: 3, added: 3, known: 0, failed: 0 });
    expect(probes).toHaveLength(1);
    expect(probes[0]!.cancelled).toBe(true);
    expect(probes[0]!.pulledBytes).toBeLessThan(MAX_FULL_MESSAGE_BYTES + 3 * CHUNK);
    const huge = h.model.calls.find((call) => call.email.subject === 'Huge newsletter')!;
    expect(huge.email.body).toBe('Gmail snippet');
  });
});

describe('write guard', () => {
  const minimal = () => new Response(JSON.stringify({ id: 'm1', threadId: 't1', labelIds: ['INBOX', 'L1'] }), { status: 200 });
  const label = () => new Response(JSON.stringify({ id: 'L1', name: 'Mail Triage/Category/FYI' }), { status: 200 });

  /** Records the order of token reads, guard checks, and dispatched requests. */
  function harness(responses: Array<() => Response | Promise<Response>>, tokenSource?: AccessTokenSource) {
    const events: string[] = [];
    const state = { stale: false };
    const hooks: { onInvalidate?: () => void } = {};
    const guard = () => {
      events.push('guard');
      if (state.stale) throw new WriteSupersededError();
    };
    const tokens: AccessTokenSource = tokenSource ?? {
      get: async () => {
        events.push('token');
        return 'token';
      },
      invalidate: () => {
        events.push('invalidate');
        hooks.onInvalidate?.();
      },
    };
    let sleeps = 0;
    const onSleep: Array<() => void> = [];
    const client = new GmailClient({
      tokens,
      fetch: async (url, init) => {
        events.push(`${init.method} ${new URL(url).pathname.split('/').pop()}`);
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        return next();
      },
      sleep: async () => {
        onSleep[sleeps++]?.();
      },
      maxRetries: 2,
    });
    return { client, events, state, guard, onSleep, hooks };
  }

  it('checks after the awaited token and immediately before dispatch, with no request if it fails', async () => {
    let release!: (token: string) => void;
    const t = harness([minimal], {
      get: () => new Promise<string>((resolve) => (release = resolve)),
      invalidate: () => {},
    });
    const write = t.client.addLabels('m1', ['L1'], t.guard);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The plan changes while the token (possibly a refresh) is pending.
    t.state.stale = true;
    release('token');
    await expect(write).rejects.toBeInstanceOf(WriteSupersededError);
    expect(t.events).toEqual(['guard']);
  });

  it('rechecks before a retry after 429, a network error, and a 401 refresh', async () => {
    const tooMany = harness([() => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }), minimal]);
    tooMany.onSleep[0] = () => (tooMany.state.stale = true);
    await expect(tooMany.client.addLabels('m1', ['L1'], tooMany.guard)).rejects.toBeInstanceOf(WriteSupersededError);
    expect(tooMany.events).toEqual(['token', 'guard', 'POST modify', 'token', 'guard']);

    const network = harness([() => Promise.reject(new TypeError('socket hang up')), label]);
    network.onSleep[0] = () => (network.state.stale = true);
    await expect(network.client.createLabel('Mail Triage/Category/FYI', network.guard)).rejects.toBeInstanceOf(WriteSupersededError);
    expect(network.events).toEqual(['token', 'guard', 'POST labels', 'token', 'guard']);

    const unauthorized = harness([() => new Response('{}', { status: 401 }), label]);
    unauthorized.hooks.onInvalidate = () => (unauthorized.state.stale = true);
    await expect(unauthorized.client.createLabel('Mail Triage/Category/FYI', unauthorized.guard)).rejects.toBeInstanceOf(WriteSupersededError);
    expect(unauthorized.events).toEqual(['token', 'guard', 'POST labels', 'invalidate', 'token', 'guard']);
  });

  it('does not treat a stale plan as a network error or retry it', async () => {
    const t = harness([minimal]);
    t.state.stale = true;
    const error = await t.client.addLabels('m1', ['L1'], t.guard).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteSupersededError);
    expect(error).not.toBeInstanceOf(GmailApiError);
    expect(t.events).toEqual(['token', 'guard']);
  });

  it('retries normally while the plan is unchanged, checking before every attempt', async () => {
    const t = harness([() => new Response('{}', { status: 503 }), () => new Response('{}', { status: 401 }), minimal]);
    await expect(t.client.addLabels('m1', ['L1'], t.guard)).resolves.toMatchObject({ labelIds: ['INBOX', 'L1'] });
    expect(t.events).toEqual(['token', 'guard', 'POST modify', 'token', 'guard', 'POST modify', 'invalidate', 'token', 'guard', 'POST modify']);
  });
});

describe('hostile MIME structure', () => {
  const text = (body: string): GmailPart => ({
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    body: { data: Buffer.from(body).toString('base64url') },
  });

  /** JSON text for a payload nested `depth` levels, built without recursion. */
  function deepPayloadJson(depth: number): string {
    const open = '{"mimeType":"multipart/mixed","parts":['.repeat(depth);
    const close = ']}'.repeat(depth);
    return `{"mimeType":"multipart/mixed","parts":[${JSON.stringify(text('Visible body'))},${open}${JSON.stringify(text('buried'))}${close}]}`;
  }

  function deepPayload(depth: number): GmailPart {
    let node: GmailPart = text('buried');
    for (let i = 0; i < depth; i += 1) node = { mimeType: 'multipart/mixed', parts: [node] };
    return { mimeType: 'multipart/mixed', parts: [text('Visible body'), node] };
  }

  it('parses a very deeply nested message without overflowing and keeps the readable body', async () => {
    const raw = `{"id":"m9","threadId":"t9","labelIds":["INBOX"],"snippet":"","internalDate":"1","payload":${deepPayloadJson(100_000)}}`;
    expect(raw.length).toBeLessThan(MAX_FULL_MESSAGE_BYTES);
    const client = new GmailClient({ tokens, fetch: async () => new Response(raw, { status: 200 }), maxRetries: 0 });
    const message = await client.getMessageFull('m9');
    expect(parseGmailMessage('acct', message).bodyText).toBe('Visible body');
  });

  it('prunes to the parts body extraction can reach and leaves ordinary messages unchanged', () => {
    const wide: GmailPart = { mimeType: 'multipart/mixed', parts: Array.from({ length: 5000 }, (_, i) => text(`part ${i}`)) };
    const pruned = prunePartTree(wide) as GmailPart;
    expect(pruned.parts).toHaveLength(MAX_PARTS - 1);
    expect(extractBody(pruned)).toEqual(extractBody(wide));

    const deep = deepPayload(50);
    let depth = 0;
    for (let node = (prunePartTree(deep) as GmailPart).parts![1]; node?.parts?.length; node = node.parts[0]) depth += 1;
    expect(depth).toBe(11);
    expect(extractBody(prunePartTree(deep) as GmailPart)).toEqual(extractBody(deep));

    const normal: GmailPart = { mimeType: 'multipart/alternative', parts: [text('Plain'), { mimeType: 'text/html', body: { data: 'PGI-SGk8L2I-' } }] };
    expect(prunePartTree(normal)).toEqual(normal);
  });
});
