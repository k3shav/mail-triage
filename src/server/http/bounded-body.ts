export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
  constructor(readonly maxBytes: number) {
    super(`Response body is larger than ${maxBytes} bytes`);
  }
}

/**
 * Read a fetch response body as UTF-8 text, never holding more than
 * `maxBytes`. A larger declared Content-Length is refused before reading;
 * otherwise the stream is consumed chunk by chunk and cancelled as soon as
 * the limit is passed, so the rest is never downloaded.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks, total));
}
