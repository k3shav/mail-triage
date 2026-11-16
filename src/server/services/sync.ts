import type { Account, NewMessage, Store } from '../db/store.js';
import { AppError } from '../errors.js';
import { GmailApiError, type GmailClient, type GmailFullMessage } from '../gmail/client.js';
import { decodeEntities, decodeHeaderValue, extractBody, extractSignals, header } from '../gmail/mime.js';
import { mapLimit, type Lease } from './concurrency.js';

export interface SyncStats {
  listed: number;
  added: number;
  /** Listed messages already stored; they are not downloaded again. */
  known: number;
  failed: number;
}

const FETCH_CONCURRENCY = 4;

/**
 * Gmail errors that will repeat for every message: credentials, permission,
 * or cancellation. They stop the run instead of being counted per message.
 */
export function isFatalGmailError(error: unknown): boolean {
  if (error instanceof AppError) return true;
  if (!(error instanceof GmailApiError)) return false;
  if (error.reason === 'aborted') return true;
  return error.status === 401 || (error.status === 403 && error.reason !== 'rateLimitExceeded' && error.reason !== 'userRateLimitExceeded');
}

export function parseGmailMessage(accountId: string, message: GmailFullMessage): NewMessage {
  const headers = message.payload.headers;
  const internalDate = message.internalDate ? Number(message.internalDate) : Date.now();
  const dateHeader = Date.parse(header(headers, 'date'));
  const body = extractBody(message.payload);
  const snippet = decodeEntities(message.snippet).replace(/\s+/g, ' ').trim();
  return {
    accountId,
    externalId: message.id,
    threadId: message.threadId,
    from: decodeHeaderValue(header(headers, 'from')).slice(0, 1000),
    to: decodeHeaderValue(header(headers, 'to')).slice(0, 4000),
    cc: decodeHeaderValue(header(headers, 'cc')).slice(0, 4000),
    subject: decodeHeaderValue(header(headers, 'subject')).slice(0, 2000) || '(no subject)',
    sentAt: new Date(Number.isFinite(dateHeader) ? dateHeader : internalDate).toISOString(),
    internalDate,
    snippet: (snippet || body.text.replace(/\s+/g, ' ').trim()).slice(0, 300),
    bodyText: body.text,
    bodySource: body.source,
    bodyTruncated: body.truncated,
    signals: extractSignals(headers),
    labelIds: message.labelIds,
    unread: message.labelIds.includes('UNREAD'),
  };
}

/**
 * Pull the newest inbox message ids (bounded) and download only the ones not
 * stored yet. Runs inside the caller's lease. Reads never change unread
 * state: Gmail's messages.get does not mark mail as read.
 */
export async function syncGmail(options: {
  store: Store;
  account: Account;
  client: GmailClient;
  maxMessages: number;
  lease: Lease;
}): Promise<SyncStats> {
  const { store, account, client, lease } = options;
  const stats: SyncStats = { listed: 0, added: 0, known: 0, failed: 0 };
  lease.assertHeld();
  const refs = await client.listInboxMessageIds(options.maxMessages);
  stats.listed = refs.length;
  const known = store.existingExternalIds(account.id, refs.map((ref) => ref.id));
  const fresh = refs.filter((ref) => !known.has(ref.id));
  stats.known = refs.length - fresh.length;

  let fatal: unknown = null;
  await mapLimit(fresh, FETCH_CONCURRENCY, async (ref) => {
    if (fatal || lease.signal.aborted) return;
    try {
      let full: GmailFullMessage;
      try {
        full = await client.getMessageFull(ref.id);
      } catch (error) {
        // Too large to read in full: classify from headers and snippet instead.
        if (!(error instanceof GmailApiError && error.reason === 'too_large')) throw error;
        full = await client.getMessageMetadata(ref.id);
      }
      const parsed = parseGmailMessage(account.id, full);
      if (lease.commit(() => store.insertMessage(parsed)) !== null) stats.added += 1;
    } catch (error) {
      if (isFatalGmailError(error) || lease.signal.aborted) {
        fatal ??= error;
        return;
      }
      stats.failed += 1;
    }
  });
  if (fatal) throw fatal;
  lease.commit(() => store.markWindow(account.id, refs.map((ref) => ref.id)));
  return stats;
}
