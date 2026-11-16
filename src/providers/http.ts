import type { ProviderId } from '../core/decision.js';
import { ProviderError, safeErrorCode } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpPolicy {
  timeoutMs: number;
  /** Retries after the first attempt, for 408/429/5xx and network failures. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_HTTP_POLICY: HttpPolicy = {
  timeoutMs: 20_000,
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface HttpDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function errorCodeFromBody(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body.error as Record<string, unknown> | undefined;
    if (error && typeof error === 'object') return safeErrorCode(error.code) ?? safeErrorCode(error.type);
    const detail = body.detail;
    if (Array.isArray(detail) && detail[0] && typeof detail[0] === 'object') {
      return safeErrorCode((detail[0] as Record<string, unknown>).type);
    }
  } catch {
    // Non-JSON error bodies carry no usable code.
  }
  return undefined;
}

/** Stop consuming before buffering more than the advertised byte limit. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/**
 * POST a JSON body and return the parsed JSON response. Retries are bounded
 * and only for transient statuses; validation of the response shape is the
 * caller's job.
 */
export async function postJson(options: {
  provider: ProviderId;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  policy: HttpPolicy;
  deps?: HttpDeps;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { provider, url, headers, body, policy } = options;
  const fetchImpl = options.deps?.fetch ?? (globalThis.fetch as FetchLike);
  const sleep = options.deps?.sleep ?? defaultSleep;
  const random = options.deps?.random ?? Math.random;
  const payload = JSON.stringify(body);
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    const attempts = attempt + 1;
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: payload,
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ProviderError({ provider, kind: 'timeout', message: 'Request was cancelled', attempts });
      }
      const timedOut = timeout.aborted || (error instanceof Error && error.name === 'TimeoutError');
      lastError = new ProviderError({
        provider,
        kind: timedOut ? 'timeout' : 'network',
        message: timedOut ? `Request timed out after ${policy.timeoutMs} ms` : 'Network error contacting provider',
        retryable: true,
        attempts,
      });
      if (attempt < policy.maxRetries) {
        await sleep(backoff(policy, attempt, undefined, random));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      let text: string;
      try {
        text = await readBounded(response);
      } catch {
        throw new ProviderError({ provider, kind: 'malformed_response', message: 'Provider response exceeded size limit', attempts });
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderError({ provider, kind: 'malformed_response', message: 'Provider returned non-JSON response', status: response.status, attempts });
      }
    }

    const errorText = await readBounded(response).catch(() => '');
    const code = errorCodeFromBody(errorText.slice(0, 64 * 1024));
    const suffix = code ? ` (${code})` : '';
    const status = response.status;
    const transient = status === 408 || status === 429 || status >= 500;
    if (transient) {
      lastError = new ProviderError({
        provider,
        kind: status === 429 ? 'rate_limited' : status === 408 ? 'timeout' : 'server',
        message: `Provider returned HTTP ${status}${suffix}`,
        status,
        retryable: true,
        attempts,
      });
      if (attempt < policy.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await sleep(backoff(policy, attempt, retryAfter, random));
        continue;
      }
      throw lastError;
    }
    throw new ProviderError({
      provider,
      kind: status === 401 || status === 403 ? 'auth' : 'bad_request',
      message: `Provider returned HTTP ${status}${suffix}`,
      status,
      attempts,
    });
  }
  // Unreachable: the loop either returns or throws.
  throw lastError ?? new ProviderError({ provider, kind: 'network', message: 'Request failed' });
}

function backoff(policy: HttpPolicy, attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
  const exponential = policy.baseDelayMs * 2 ** attempt;
  return Math.min(policy.maxDelayMs, exponential / 2 + random() * (exponential / 2));
}
