import { describe, expect, it, vi } from 'vitest';
import { MAX_RESPONSE_BYTES, postJson } from '../../src/providers/http.js';

function oversized(status: number) {
  let consumed = 0;
  let cancelled = false;
  const chunkSize = 64 * 1024;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      consumed += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize));
      if (consumed >= MAX_RESPONSE_BYTES * 3) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status });
  return { response, consumed: () => consumed, cancelled: () => cancelled };
}

describe('streaming response limits', () => {
  it.each([200, 400, 503])('cancels an oversized chunked HTTP %s body at the limit', async (status) => {
    const source = oversized(status);
    const request = postJson({
      provider: 'jev', url: 'https://example.invalid', headers: {}, body: {},
      policy: { timeoutMs: 1000, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      deps: { fetch: vi.fn(async () => source.response) },
    });
    await expect(request).rejects.toMatchObject({ kind: status === 200 ? 'malformed_response' : status === 503 ? 'server' : 'bad_request' });
    expect(source.cancelled()).toBe(true);
    expect(source.consumed()).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 64 * 1024);
  });
});
