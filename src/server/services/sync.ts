import { DEMO_MESSAGES } from '../../demo/fixtures.js';
import { DEMO_ACCOUNT_ID, type NewMessage, type Store } from '../db/store.js';
import { AppError } from '../errors.js';
import type { GmailClient, GmailFullMessage } from '../gmail/client.js';
import { decodeEntities, decodeHeaderValue, extractBody, extractSignals, header } from '../gmail/mime.js';
import { capabilities, type GmailConnection } from './gmail-connection.js';
import { mapLimit, withLock } from './concurrency.js';

export interface SyncStats {
  listed: number;
  added: number;
  refreshed: number;
  failed: number;
}

const FETCH_CONCURRENCY = 4;

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
 * Pull the newest inbox messages (bounded) and store new ones. Existing
 * messages only get their label list refreshed. Reads never change unread
 * state: Gmail's messages.get does not mark mail as read.
 */
export async function syncGmail(options: {
  store: Store;
  connection: GmailConnection;
  maxMessages: number;
  client?: GmailClient;
}): Promise<SyncStats> {
  const { store, connection } = options;
  const account = connection.account();
  if (!account) throw new AppError(409, 'gmail_not_connected', 'Connect Gmail before syncing');
  if (!capabilities(account, { labelWrites: false }).canRead) {
    throw new AppError(409, 'gmail_reauth_required', 'Gmail read access is not available. Reconnect Gmail.');
  }
  const client = options.client ?? connection.client(account.id);

  return withLock(store, `sync:${account.id}`, async () => {
    const runId = store.startRun(account.id, 'sync');
    const stats: SyncStats = { listed: 0, added: 0, refreshed: 0, failed: 0 };
    try {
      const refs = await client.listInboxMessageIds(options.maxMessages);
      stats.listed = refs.length;
      const known = store.existingExternalIds(account.id, refs.map((ref) => ref.id));
      await mapLimit(refs, FETCH_CONCURRENCY, async (ref) => {
        try {
          if (known.has(ref.id)) {
            const minimal = await client.getMessageMinimal(ref.id);
            store.updateMessageLabels(account.id, ref.id, minimal.labelIds);
            stats.refreshed += 1;
          } else {
            const full = await client.getMessageFull(ref.id);
            if (store.insertMessage(parseGmailMessage(account.id, full)) !== null) stats.added += 1;
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          stats.failed += 1;
        }
      });
      store.finishRun(runId, stats.failed > 0 ? 'partial' : 'ok', { ...stats }, null);
      return stats;
    } catch (error) {
      store.finishRun(runId, 'failed', { ...stats }, error instanceof Error ? error.message.slice(0, 300) : 'Sync failed');
      throw error;
    }
  });
}

/** Insert the bundled fictional inbox once; idempotent. */
export function seedDemoInbox(store: Store): number {
  store.ensureDemoAccount();
  let added = 0;
  for (const demo of DEMO_MESSAGES) {
    const internalDate = Date.parse(demo.email.date);
    const inserted = store.insertMessage({
      accountId: DEMO_ACCOUNT_ID,
      externalId: demo.key,
      threadId: demo.threadKey,
      from: demo.email.from,
      to: demo.email.to,
      cc: demo.email.cc,
      subject: demo.email.subject,
      sentAt: new Date(internalDate).toISOString(),
      internalDate,
      snippet: demo.snippet,
      bodyText: demo.email.body,
      bodySource: 'plain',
      bodyTruncated: false,
      signals: demo.email.signals,
      labelIds: demo.unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
      unread: demo.unread,
    });
    if (inserted !== null) added += 1;
  }
  return added;
}

/** Remove demo decisions and simulated labels, then re-seed. */
export function resetDemoInbox(store: Store): void {
  store.deleteAccount(DEMO_ACCOUNT_ID);
  seedDemoInbox(store);
}
