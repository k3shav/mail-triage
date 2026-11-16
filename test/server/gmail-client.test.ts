import { describe, expect, it } from 'vitest';
import { GmailApiError, GmailClient, MAX_ERROR_BODY_BYTES, MAX_FULL_MESSAGE_BYTES } from '../../src/server/gmail/client.js';
import { BodyTooLargeError, readBoundedText } from '../../src/server/http/bounded-body.js';
import { MAX_PARTS, extractBody, prunePartTree, type GmailPart } from '../../src/server/gmail/mime.js';
import { parseGmailMessage } from '../../src/server/services/sync.js';
import { Client, createHarness } from '../helpers/harness.js';
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

  it('skips only the oversized message during sync', async () => {
    const h = createHarness();
    h.google.addMessages(
      plainMessage('m1', 'Deploy failed on main', 'Build 412 failed.'),
      plainMessage('m2', 'Huge newsletter', 'placeholder'),
      plainMessage('m3', 'Weekly digest', 'Top stories.'),
    );
    const probes: Array<{ pulledBytes: number; cancelled: boolean }> = [];
    h.google.respond = (url) => {
      if (!url.pathname.endsWith('/messages/m2') || url.searchParams.get('format') !== 'full') return undefined;
      const { response, probe } = streamedResponse({ totalBytes: 32 * 1024 * 1024, prefix: '{"id":"m2","threadId":"tm2","payload":{"body":{"data":"' });
      probes.push(probe);
      return response;
    };
    const client = await new Client(h.app).signIn();
    await client.connectGmail();
    const sync = await client.post('/api/mailboxes/gmail/sync');
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ listed: 3, added: 2, refreshed: 0, failed: 1 });
    expect(probes).toHaveLength(1);
    expect(probes[0]!.cancelled).toBe(true);
    expect(h.store.lastRun(h.store.getGmailAccount()!.id, 'sync')!.status).toBe('partial');
    const subjects = (await client.get('/api/mailboxes/gmail/messages')).body.messages.map((m: { subject: string }) => m.subject);
    expect(subjects.sort()).toEqual(['Deploy failed on main', 'Weekly digest']);
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
