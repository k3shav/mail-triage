import { z } from 'zod';
import type { FetchLike } from '../../providers/http.js';
import { parseRetryAfter } from '../../providers/http.js';
import { BodyTooLargeError, readBoundedText } from '../http/bounded-body.js';
import { prunePartTree, type GmailPart } from './mime.js';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/**
 * Largest format=full message response read, in bytes. Inline part data is
 * base64url inside JSON; attachments arrive as ids and do not count. Larger
 * messages fail individually; only the first MAX_PART_BYTES of a body is kept anyway.
 */
export const MAX_FULL_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Largest response read for every other Gmail call (profile, lists, labels, modify). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Error bodies are only read for their reason code. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class GmailApiError extends Error {
  override name = 'GmailApiError';
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface AccessTokenSource {
  /** Return a valid access token, refreshing if needed. */
  get(): Promise<string>;
  /** Drop a cached token that Gmail rejected. */
  invalidate(): void;
}

const MessageRefSchema = z.object({ id: z.string().regex(GMAIL_ID), threadId: z.string().regex(GMAIL_ID) });
const ListSchema = z.object({ messages: z.array(MessageRefSchema).optional(), nextPageToken: z.string().optional() });
const LabelSchema = z.object({ id: z.string(), name: z.string(), type: z.string().optional() });
const MinimalMessageSchema = z.object({
  id: z.string().regex(GMAIL_ID),
  threadId: z.string().regex(GMAIL_ID),
  labelIds: z.array(z.string()).default([]),
});
const PartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(PartSchema).optional(),
  }),
);
const FullMessageSchema = MinimalMessageSchema.extend({
  snippet: z.string().default(''),
  internalDate: z.string().regex(/^\d+$/).optional(),
  sizeEstimate: z.number().optional(),
  payload: PartSchema,
});
export type GmailMinimalMessage = z.infer<typeof MinimalMessageSchema>;
export type GmailFullMessage = z.infer<typeof FullMessageSchema>;
export type GmailLabel = z.infer<typeof LabelSchema>;

export function isGmailId(value: string): boolean {
  return GMAIL_ID.test(value);
}

export interface GmailClientOptions {
  tokens: AccessTokenSource;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Minimal Gmail REST client. The only write methods are label creation and
 * messages.modify with addLabelIds; there is no send, delete, trash, archive,
 * or label removal method.
 */
export class GmailClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: GmailClientOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async getProfile(): Promise<{ emailAddress: string }> {
    const body = await this.request('GET', '/profile');
    return z.object({ emailAddress: z.string().email() }).parse(body);
  }

  async listInboxMessageIds(max: number): Promise<Array<{ id: string; threadId: string }>> {
    const results: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    while (results.length < max) {
      const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(Math.min(100, max - results.length)) });
      if (pageToken) params.set('pageToken', pageToken);
      const page = ListSchema.parse(await this.request('GET', `/messages?${params}`));
      results.push(...(page.messages ?? []));
      pageToken = page.nextPageToken;
      if (!pageToken || !page.messages?.length) break;
    }
    return results.slice(0, max);
  }

  async getMessageFull(id: string): Promise<GmailFullMessage> {
    const raw = await this.request('GET', `/messages/${this.id(id)}?format=full`, undefined, MAX_FULL_MESSAGE_BYTES);
    if (raw && typeof raw === 'object' && 'payload' in raw) (raw as { payload: unknown }).payload = prunePartTree(raw.payload);
    const message = FullMessageSchema.parse(raw);
    this.assertSameId(id, message.id);
    return message;
  }

  async getMessageMinimal(id: string): Promise<GmailMinimalMessage> {
    const message = MinimalMessageSchema.parse(await this.request('GET', `/messages/${this.id(id)}?format=minimal`));
    this.assertSameId(id, message.id);
    return message;
  }

  async listLabels(): Promise<GmailLabel[]> {
    const body = z.object({ labels: z.array(LabelSchema).default([]) }).parse(await this.request('GET', '/labels'));
    return body.labels;
  }

  async createLabel(name: string): Promise<GmailLabel> {
    return LabelSchema.parse(
      await this.request('POST', '/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    );
  }

  /** Additive only: this method cannot send removeLabelIds. */
  async addLabels(id: string, labelIds: string[]): Promise<GmailMinimalMessage> {
    if (labelIds.length === 0) throw new Error('addLabels requires at least one label');
    const message = MinimalMessageSchema.parse(await this.request('POST', `/messages/${this.id(id)}/modify`, { addLabelIds: labelIds }));
    this.assertSameId(id, message.id);
    return message;
  }

  private id(id: string): string {
    if (!isGmailId(id)) throw new GmailApiError(400, 'invalid_id', 'Invalid Gmail message id');
    return encodeURIComponent(id);
  }

  private assertSameId(requested: string, returned: string) {
    if (requested !== returned) throw new GmailApiError(502, 'id_mismatch', 'Gmail returned a different message than requested');
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.options.tokens.get();
      let response: Response;
      try {
        response = await this.fetchImpl(`${GMAIL_API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new GmailApiError(0, 'network', 'Could not reach Gmail');
      }
      if (response.ok) {
        let text: string;
        try {
          text = await readBoundedText(response, maxBytes);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            throw new GmailApiError(502, 'too_large', `Gmail response is larger than ${Math.round(maxBytes / 1024)} KiB; skipped`);
          }
          throw new GmailApiError(0, 'network', 'Gmail response was interrupted');
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new GmailApiError(response.status, 'malformed', 'Gmail returned a non-JSON response');
        }
      }
      const reason = await this.reasonOf(response);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.options.tokens.invalidate();
        continue;
      }
      const transient = response.status === 429 || response.status >= 500 || (response.status === 403 && reason === 'rateLimitExceeded');
      if (transient && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await this.sleep(Math.min(retryAfter ?? 500 * 2 ** attempt, 8000));
        continue;
      }
      throw new GmailApiError(response.status, reason, `Gmail returned HTTP ${response.status}${reason ? ` (${reason})` : ''}`);
    }
  }

  private async reasonOf(response: Response): Promise<string | undefined> {
    try {
      const text = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
      const body = JSON.parse(text) as { error?: { status?: string; errors?: Array<{ reason?: string }> } };
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
      return typeof reason === 'string' && /^[A-Za-z_]{1,64}$/.test(reason) ? reason : undefined;
    } catch {
      return undefined;
    }
  }
}
