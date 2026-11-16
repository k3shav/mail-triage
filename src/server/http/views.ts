import { z } from 'zod';
import type { Account, Store, StoredMessage } from '../db/store.js';
import { effectiveDecision, type DecisionState, type EffectiveDecision } from '../services/decisions.js';

/** Messages scanned for one list request; lists are newest-first. */
export const LIST_SCAN_LIMIT = 5000;

export const ListQuerySchema = z.object({
  state: z.enum(['unclassified', 'error', 'stale', 'needs_review', 'ready', 'confirmed', 'pending']).optional(),
  category: z.string().max(40).optional(),
  action: z.string().max(40).optional(),
  priority: z.string().max(40).optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(LIST_SCAN_LIMIT).default(0),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export interface DecisionView {
  state: DecisionState;
  source: EffectiveDecision['source'];
  /** Classification or correction id the values come from; `basedOnClassificationId` for an accept. */
  sourceId: number | null;
  /** Send back as `expectedDecisionSeq` with a correction. */
  decisionSeq: number;
  /** Configuration revision this view was computed for; send back as `expectedTaxonomyRevision`. */
  taxonomyRevision: number;
  category: string | null;
  action: string | null;
  priority: string | null;
  provider: string | null;
  model: string | null;
  reviewReasons: string[];
  staleRevision: number | null;
}

function decisionView(decision: EffectiveDecision, taxonomyRevision: number): DecisionView {
  return {
    state: decision.state,
    source: decision.source,
    sourceId: decision.sourceId,
    decisionSeq: decision.decisionSeq,
    taxonomyRevision,
    category: decision.category,
    action: decision.action,
    priority: decision.priority,
    provider: decision.provider,
    model: decision.model,
    reviewReasons: decision.reviewReasons.map((reason) => reason.message),
    staleRevision: decision.staleRevision,
  };
}

function labelNames(message: StoredMessage, cache: Map<string, string>): string[] {
  return message.labelIds.map((id) => cache.get(id) ?? id);
}

function decisionsFor(store: Store, messages: StoredMessage[]) {
  const { revision, taxonomy } = store.currentTaxonomy();
  const policy = store.getReviewPolicy();
  const ids = messages.map((message) => message.id);
  const classifications = store.latestClassifications(ids);
  const corrections = store.latestCorrections(ids);
  const decisions = new Map(
    messages.map((message) => [
      message.id,
      effectiveDecision({
        message,
        classification: classifications.get(message.id),
        correction: corrections.get(message.id),
        revision,
        taxonomy,
        policy,
      }),
    ]),
  );
  return { revision, decisions };
}

export function listMessages(store: Store, account: Account, query: ListQuery) {
  const all = store.listMessages(account.id, LIST_SCAN_LIMIT);
  const { revision, decisions } = decisionsFor(store, all);
  const cache = store.labelCache(account.id);
  const needle = query.q?.toLowerCase();

  const counts = {
    total: all.length,
    unread: 0,
    byState: {} as Record<string, number>,
    byCategory: {} as Record<string, number>,
    byAction: {} as Record<string, number>,
  };
  const filtered: StoredMessage[] = [];
  for (const message of all) {
    const decision = decisions.get(message.id)!;
    if (message.unread) counts.unread += 1;
    counts.byState[decision.state] = (counts.byState[decision.state] ?? 0) + 1;
    if (decision.category) counts.byCategory[decision.category] = (counts.byCategory[decision.category] ?? 0) + 1;
    if (decision.action) counts.byAction[decision.action] = (counts.byAction[decision.action] ?? 0) + 1;

    if (query.state === 'pending') {
      if (!['unclassified', 'error', 'stale'].includes(decision.state)) continue;
    } else if (query.state && decision.state !== query.state) continue;
    if (query.category && decision.category !== query.category) continue;
    if (query.action && decision.action !== query.action) continue;
    if (query.priority && decision.priority !== query.priority) continue;
    if (query.unread && message.unread !== (query.unread === 'true')) continue;
    if (needle && ![message.subject, message.from, message.snippet].some((text) => text.toLowerCase().includes(needle))) continue;
    filtered.push(message);
  }

  return {
    counts,
    total: filtered.length,
    messages: filtered.slice(query.offset, query.offset + query.limit).map((message) => ({
      id: message.id,
      from: message.from,
      subject: message.subject,
      snippet: message.snippet,
      sentAt: message.sentAt,
      unread: message.unread,
      labels: labelNames(message, cache),
      lastError: message.lastError,
      decision: decisionView(decisions.get(message.id)!, revision),
    })),
  };
}

export function messageDetail(store: Store, account: Account, message: StoredMessage) {
  const { revision, decisions } = decisionsFor(store, [message]);
  const decision = decisions.get(message.id)!;
  const history = store.history(message.id);
  const cache = store.labelCache(account.id);
  return {
    id: message.id,
    externalId: message.externalId,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    sentAt: message.sentAt,
    unread: message.unread,
    snippet: message.snippet,
    body: { text: message.bodyText, source: message.bodySource, truncated: message.bodyTruncated },
    signals: message.signals,
    labels: labelNames(message, cache),
    lastError: message.lastError,
    decision: decisionView(decision, revision),
    history: {
      classifications: history.classifications.map((c) => ({
        id: c.id,
        seq: c.seq,
        taxonomyRevision: c.taxonomyRevision,
        provider: c.provider,
        requestedModel: c.requestedModel,
        model: c.model,
        confidenceKind: c.confidenceKind,
        fields: c.fields,
        createdAt: c.createdAt,
      })),
      corrections: history.corrections,
      applies: store.lastApplies(message.id).map((a) => ({
        status: a.status,
        addedLabels: a.addedLabels,
        error: a.error,
        createdAt: a.createdAt,
      })),
    },
  };
}
