import type { DecisionView, MessageDetail, MessageList, MessageSummary, Status, TaxonomyRevision } from '../../src/web/types';

/** A promise the test resolves by hand, to control response order. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const TAXONOMY: TaxonomyRevision = {
  revision: 1,
  hash: 'h1',
  createdAt: 0,
  taxonomy: {
    userContext: 'I lead the platform team.',
    categories: [
      { id: 'fyi', name: 'FYI', description: 'Updates for me to read.' },
      { id: 'receipt', name: 'Receipt', description: 'Receipts and invoices.' },
      { id: 'other', name: 'Other', description: 'Anything else.' },
    ],
  },
};

export function status(overrides: Partial<Status> = {}): Status {
  return {
    auth: { mode: 'local' },
    publicUrl: 'http://localhost:3000',
    model: { configured: true, info: { provider: 'jev', model: 'jev-latest', confidenceKind: 'provider', endpointHost: 'api.typesafe.ai', sendsEmailOffDevice: true } },
    gmail: {
      configured: true,
      problem: null,
      redirectUri: 'http://localhost:3000/api/gmail/oauth/callback',
      requestedScopes: [],
      labelWritesEnabled: true,
      account: {
        email: 'me@example.com',
        grantedScopes: [],
        tokenStatus: 'ok',
        keyMismatch: false,
        capabilities: { canRead: true, hasModifyScope: true, labelWritesEnabled: true, canApply: true, applyBlockedReason: null },
        messageCount: 0,
        lastSync: null,
        lastClassify: null,
      },
    },
    demo: { enabled: true, messageCount: 12, lastClassify: null },
    taxonomy: { revision: 1, hash: 'h1' },
    labelPrefix: 'Mail Triage',
    limits: { syncMaxMessages: 50, classifyBatchSize: 20 },
    ...overrides,
  };
}

export function decision(overrides: Partial<DecisionView> = {}): DecisionView {
  return {
    state: 'ready',
    source: 'model',
    sourceId: 10,
    decisionSeq: 1,
    taxonomyRevision: 1,
    category: 'fyi',
    action: 'no_action',
    priority: 'low',
    provider: 'jev',
    model: 'jev-1',
    reviewReasons: [],
    staleRevision: null,
    ...overrides,
  };
}

export function summary(id: number, overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    from: `Sender ${id} <s${id}@example.com>`,
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    sentAt: new Date(Date.UTC(2026, 10, 16) - id * 60_000).toISOString(),
    unread: false,
    labels: ['INBOX'],
    lastError: null,
    decision: decision({ sourceId: id * 10 }),
    ...overrides,
  };
}

export function detail(id: number, overrides: Partial<MessageDetail> = {}): MessageDetail {
  const base = summary(id);
  return {
    id,
    externalId: `m${id}`,
    from: base.from,
    to: 'me@example.com',
    cc: '',
    subject: base.subject,
    sentAt: base.sentAt,
    unread: false,
    snippet: base.snippet,
    body: { text: `Body of message ${id}`, source: 'plain', truncated: false },
    signals: { hasListUnsubscribe: false, listId: null, autoSubmitted: null, precedence: null },
    labels: ['INBOX'],
    lastError: null,
    decision: base.decision,
    history: {
      classifications: [
        {
          id: id * 10,
          seq: 1,
          taxonomyRevision: 1,
          provider: 'jev',
          requestedModel: 'jev-latest',
          model: 'jev-1',
          confidenceKind: 'provider',
          fields: {
            category: { status: 'answered', value: 'fyi', confidence: 0.9, selectedProbability: 0.95, probabilities: null },
            action: { status: 'answered', value: 'no_action', confidence: 0.9, selectedProbability: 0.95, probabilities: null },
            priority: { status: 'answered', value: 'low', confidence: 0.9, selectedProbability: 0.95, probabilities: null },
          },
          createdAt: 0,
        },
      ],
      corrections: [],
      applies: [],
    },
    ...overrides,
  };
}

/** Serve `total` synthetic messages with the server's offset/limit semantics and 100-row cap. */
export function pagedList(total: number, filter: (m: MessageSummary) => boolean = () => true) {
  const all = Array.from({ length: total }, (_, i) => summary(i + 1)).filter(filter);
  return (page: { limit: number; offset: number }): MessageList => {
    if (page.limit > 100) throw Object.assign(new Error('The request was not valid'), { status: 400 });
    return {
      counts: { total: all.length, unread: 0, byState: { ready: all.length }, byCategory: { fyi: all.length }, byAction: { no_action: all.length } },
      total: all.length,
      messages: all.slice(page.offset, page.offset + page.limit),
    };
  };
}
