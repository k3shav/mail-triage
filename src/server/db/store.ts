import { z } from 'zod';
import { FieldDecisionSchema, type ConfidenceKind, type ProviderDecision } from '../../core/decision.js';
import { PROMPT_VERSION } from '../../core/prompt.js';
import { DEFAULT_TAXONOMY, TaxonomySchema, taxonomyHash, type Taxonomy } from '../../core/taxonomy.js';
import type { TaggingMode } from '../config.js';
import type { Db } from './database.js';

export interface Account {
  id: string;
  kind: 'gmail';
  email: string;
  grantedScopes: string[];
  refreshTokenEnc: string | null;
  keyFingerprint: string | null;
  tokenStatus: 'ok' | 'reauth_required';
  createdAt: number;
  updatedAt: number;
}

export interface MessageSignals {
  hasListUnsubscribe: boolean;
  listId: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}

export interface NewMessage {
  accountId: string;
  externalId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  sentAt: string;
  internalDate: number;
  snippet: string;
  bodyText: string;
  bodySource: 'plain' | 'html' | 'none';
  bodyTruncated: boolean;
  signals: MessageSignals;
  labelIds: string[];
  unread: boolean;
}

export interface StoredMessage extends NewMessage {
  id: number;
  decisionSeq: number;
  lastError: string | null;
  fetchedAt: number;
  labelsCheckedAt: number;
  /** Listed by the most recent sync (the newest SYNC_MAX_MESSAGES inbox messages). */
  inWindow: boolean;
  classifyFailures: number;
  classifyFailedRevision: number | null;
}

export interface TaxonomyRevision {
  revision: number;
  hash: string;
  taxonomy: Taxonomy;
  createdAt: number;
}

export interface StoredClassification {
  id: number;
  accountId: string;
  messageId: number;
  seq: number;
  taxonomyRevision: number;
  taxonomyHash: string;
  promptVersion: string;
  provider: ProviderDecision['provider'];
  requestedModel: string;
  model: string;
  confidenceKind: ConfidenceKind;
  fields: ProviderDecision['fields'];
  usage: ProviderDecision['usage'];
  createdAt: number;
}

export type TagOutcome = 'labeled' | 'review' | 'labeled_review';
export type TagStatus = 'planned' | 'applied' | 'failed' | 'skipped';

/** What the tagger last did for one message, and for which plan. */
export interface TagRow {
  messageId: number;
  accountId: string;
  /** Null when the plan comes from a message that could not be classified. */
  classificationId: number | null;
  taxonomyRevision: number;
  planKey: string;
  outcome: TagOutcome;
  labels: string[];
  status: TagStatus;
  added: string[];
  failures: number;
  nextAttemptAt: number | null;
  error: string | null;
  updatedAt: number;
}

export interface TagCandidate {
  message: StoredMessage;
  classification: StoredClassification | null;
}

export type CycleStatus = 'running' | 'ok' | 'partial' | 'failed' | 'aborted' | 'not_ready';

export interface CycleRow {
  id: number;
  accountId: string | null;
  mode: TaggingMode;
  startedAt: number;
  finishedAt: number | null;
  status: CycleStatus;
  summary: Record<string, unknown>;
  error: string | null;
}

/** A message whose classification failed this many times at one revision is marked for review instead. */
export const MAX_CLASSIFY_FAILURES = 5;
/** Label writes for one plan are retried this many times, then left alone until the plan changes. */
export const MAX_TAG_FAILURES = 6;
const MAX_RETRY_DELAY_MS = 6 * 3600_000;

/** 1, 2, 4, ... minutes, capped at six hours. */
export function retryDelayMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), MAX_RETRY_DELAY_MS);
}

const FieldsSchema = z.object({ category: FieldDecisionSchema, action: FieldDecisionSchema, priority: FieldDecisionSchema });
const json = <T>(text: string | null): T => (text === null ? null : JSON.parse(text)) as T;

type Row = Record<string, unknown>;

function toAccount(row: Row): Account {
  return {
    id: row.id as string,
    kind: 'gmail',
    email: row.email as string,
    grantedScopes: (row.granted_scopes as string).split(' ').filter(Boolean),
    refreshTokenEnc: (row.refresh_token_enc as string | null) ?? null,
    keyFingerprint: (row.key_fingerprint as string | null) ?? null,
    tokenStatus: row.token_status as Account['tokenStatus'],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toMessage(row: Row): StoredMessage {
  return {
    id: row.id as number,
    accountId: row.account_id as string,
    externalId: row.external_id as string,
    threadId: row.thread_id as string,
    from: row.from_addr as string,
    to: row.to_addr as string,
    cc: row.cc_addr as string,
    subject: row.subject as string,
    sentAt: row.sent_at as string,
    internalDate: row.internal_date as number,
    snippet: row.snippet as string,
    bodyText: row.body_text as string,
    bodySource: row.body_source as StoredMessage['bodySource'],
    bodyTruncated: row.body_truncated === 1,
    signals: json<MessageSignals>(row.signals as string),
    labelIds: json<string[]>(row.label_ids as string),
    unread: row.unread === 1,
    decisionSeq: row.decision_seq as number,
    lastError: (row.last_error as string | null) ?? null,
    fetchedAt: row.fetched_at as number,
    labelsCheckedAt: row.labels_checked_at as number,
    inWindow: row.in_window === 1,
    classifyFailures: row.classify_failures as number,
    classifyFailedRevision: (row.classify_failed_revision as number | null) ?? null,
  };
}

function toClassification(row: Row): StoredClassification {
  return {
    id: row.id as number,
    accountId: row.account_id as string,
    messageId: row.message_id as number,
    seq: row.seq as number,
    taxonomyRevision: row.taxonomy_revision as number,
    taxonomyHash: row.taxonomy_hash as string,
    promptVersion: row.prompt_version as string,
    provider: row.provider as StoredClassification['provider'],
    requestedModel: row.requested_model as string,
    model: row.model as string,
    confidenceKind: row.confidence_kind as ConfidenceKind,
    fields: FieldsSchema.parse(JSON.parse(row.fields as string)),
    usage: json<StoredClassification['usage']>((row.usage as string | null) ?? null),
    createdAt: row.created_at as number,
  };
}

function toTag(row: Row): TagRow {
  return {
    messageId: row.message_id as number,
    accountId: row.account_id as string,
    classificationId: (row.classification_id as number | null) ?? null,
    taxonomyRevision: row.taxonomy_revision as number,
    planKey: row.plan_key as string,
    outcome: row.outcome as TagOutcome,
    labels: json<string[]>(row.labels as string),
    status: row.status as TagStatus,
    added: json<string[]>(row.added as string),
    failures: row.failures as number,
    nextAttemptAt: (row.next_attempt_at as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    updatedAt: row.updated_at as number,
  };
}

function toCycle(row: Row): CycleRow {
  return {
    id: row.id as number,
    accountId: (row.account_id as string | null) ?? null,
    mode: row.mode as TaggingMode,
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
    status: row.status as CycleStatus,
    summary: json<Record<string, unknown>>(row.summary as string),
    error: (row.error as string | null) ?? null,
  };
}

export class StaleRevisionError extends Error {
  override name = 'StaleRevisionError';
  constructor(readonly current: number) {
    super(`Configuration changed (now revision ${current}); reload and try again`);
  }
}

/**
 * A tag row is "done" for this plan when it was applied, skipped, is waiting
 * for its retry time, or gave up. In dry-run mode a recorded plan also counts,
 * so unchanged cycles stay quiet; apply mode picks dry-run plans up.
 */
const TAG_DONE = `t.taxonomy_revision = @revision AND t.plan_key = @planKey AND (
  t.status IN ('applied', 'skipped')
  OR (@dryRun = 1 AND t.status = 'planned')
  OR (t.status = 'failed' AND (t.next_attempt_at IS NULL OR t.next_attempt_at > @now)))`;

const LATEST_AT_REVISION = `SELECT id FROM classifications WHERE message_id = m.id AND taxonomy_revision = @revision ORDER BY seq DESC LIMIT 1`;

/** All SQL lives here. better-sqlite3 is synchronous, so each method is atomic within the process. */
export class Store {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.ensureTaxonomy();
  }

  // ---- accounts -----------------------------------------------------------

  getAccount(id: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? AND kind = 'gmail'").get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  getGmailAccount(): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE kind = 'gmail'").get() as Row | undefined;
    return row ? toAccount(row) : null;
  }

  insertGmailAccount(account: { id: string; email: string; grantedScopes: string[]; refreshTokenEnc: string; keyFingerprint: string }): Account {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, kind, email, granted_scopes, refresh_token_enc, key_fingerprint, token_status, created_at, updated_at)
         VALUES (?, 'gmail', ?, ?, ?, ?, 'ok', ?, ?)`,
      )
      .run(account.id, account.email, account.grantedScopes.join(' '), account.refreshTokenEnc, account.keyFingerprint, now, now);
    return this.getAccount(account.id)!;
  }

  updateAccountTokens(id: string, patch: { grantedScopes?: string[]; refreshTokenEnc?: string; keyFingerprint?: string; tokenStatus?: Account['tokenStatus'] }): void {
    const current = this.getAccount(id);
    if (!current) return;
    this.db
      .prepare(
        'UPDATE accounts SET granted_scopes = ?, refresh_token_enc = ?, key_fingerprint = ?, token_status = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        (patch.grantedScopes ?? current.grantedScopes).join(' '),
        patch.refreshTokenEnc ?? current.refreshTokenEnc,
        patch.keyFingerprint ?? current.keyFingerprint,
        patch.tokenStatus ?? current.tokenStatus,
        this.now(),
        id,
      );
  }

  /** Removes the account and, through cascades, all of its local mail data. */
  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM runs WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM cycles WHERE account_id = ?').run(id);
  }

  // ---- messages -----------------------------------------------------------

  insertMessage(message: NewMessage): number | null {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO messages (account_id, external_id, thread_id, from_addr, to_addr, cc_addr, subject, sent_at, internal_date,
           snippet, body_text, body_source, body_truncated, signals, label_ids, unread, fetched_at, labels_checked_at, in_window)
         VALUES (@accountId, @externalId, @threadId, @from, @to, @cc, @subject, @sentAt, @internalDate,
           @snippet, @bodyText, @bodySource, @bodyTruncated, @signals, @labelIds, @unread, @now, @now, 1)
         ON CONFLICT(account_id, external_id) DO NOTHING`,
      )
      .run({
        ...message,
        bodyTruncated: message.bodyTruncated ? 1 : 0,
        signals: JSON.stringify(message.signals),
        labelIds: JSON.stringify(message.labelIds),
        unread: message.unread ? 1 : 0,
        now,
      });
    return result.changes === 1 ? Number(result.lastInsertRowid) : null;
  }

  existingExternalIds(accountId: string, externalIds: string[]): Set<string> {
    if (externalIds.length === 0) return new Set();
    const placeholders = externalIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT external_id FROM messages WHERE account_id = ? AND external_id IN (${placeholders})`)
      .all(accountId, ...externalIds) as Row[];
    return new Set(rows.map((row) => row.external_id as string));
  }

  /**
   * Record which stored messages the latest sync listed. Only those are
   * classified, so a configuration change reclassifies the current inbox
   * window rather than every message ever stored.
   */
  markWindow(accountId: string, externalIds: string[]): void {
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE messages SET in_window = 0 WHERE account_id = ? AND in_window = 1').run(accountId);
        const mark = this.db.prepare('UPDATE messages SET in_window = 1 WHERE account_id = ? AND external_id = ?');
        for (const id of externalIds) mark.run(accountId, id);
      })
      .immediate();
  }

  updateMessageLabels(accountId: string, externalId: string, labelIds: string[]): void {
    this.db
      .prepare('UPDATE messages SET label_ids = ?, unread = ?, labels_checked_at = ? WHERE account_id = ? AND external_id = ?')
      .run(JSON.stringify(labelIds), labelIds.includes('UNREAD') ? 1 : 0, this.now(), accountId, externalId);
  }

  getMessage(accountId: string, id: number): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE account_id = ? AND id = ?').get(accountId, id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  countMessages(accountId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(accountId) as Row).n as number;
  }

  private pendingClassificationWhere = `m.account_id = @accountId AND m.in_window = 1
    AND NOT EXISTS (SELECT 1 FROM classifications c WHERE c.message_id = m.id AND c.taxonomy_revision = @revision)
    AND (m.classify_failed_revision IS NOT @revision
         OR (m.classify_failures < @maxFailures AND (m.next_classify_at IS NULL OR m.next_classify_at <= @now)))`;

  /**
   * Messages in the sync window with no classification at `revision` whose
   * retry time (after earlier failures) has come. Newest first.
   */
  messagesNeedingClassification(accountId: string, revision: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m WHERE ${this.pendingClassificationWhere} ORDER BY m.internal_date DESC, m.id DESC LIMIT @limit`)
      .all({ accountId, revision, maxFailures: MAX_CLASSIFY_FAILURES, now: this.now(), limit }) as Row[];
    return rows.map(toMessage);
  }

  countNeedingClassification(accountId: string, revision: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${this.pendingClassificationWhere}`)
      .get({ accountId, revision, maxFailures: MAX_CLASSIFY_FAILURES, now: this.now() }) as Row;
    return row.n as number;
  }

  /**
   * Count one failed classification of this message at `revision` and
   * schedule the retry. Returns the failure count; at MAX_CLASSIFY_FAILURES
   * the message is no longer retried at this revision.
   */
  recordClassifyFailure(messageId: number, revision: number, error: string): number {
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT classify_failures, classify_failed_revision FROM messages WHERE id = ?').get(messageId) as Row | undefined;
        if (!row) return 0;
        const failures = row.classify_failed_revision === revision ? (row.classify_failures as number) + 1 : 1;
        const next = failures >= MAX_CLASSIFY_FAILURES ? null : this.now() + retryDelayMs(failures);
        this.db
          .prepare('UPDATE messages SET last_error = ?, classify_failures = ?, classify_failed_revision = ?, next_classify_at = ? WHERE id = ?')
          .run(error, failures, revision, next, messageId);
        return failures;
      })
      .immediate();
  }

  // ---- taxonomy -----------------------------------------------------------

  private ensureTaxonomy(): void {
    this.db
      .transaction(() => {
        const existing = this.db.prepare('SELECT COUNT(*) AS n FROM taxonomy_revisions').get() as Row;
        if ((existing.n as number) === 0) this.insertTaxonomy(DEFAULT_TAXONOMY);
      })
      .immediate();
  }

  private insertTaxonomy(taxonomy: Taxonomy): TaxonomyRevision {
    const hash = taxonomyHash(taxonomy, PROMPT_VERSION);
    const createdAt = this.now();
    const result = this.db
      .prepare('INSERT INTO taxonomy_revisions (taxonomy, hash, created_at) VALUES (?, ?, ?)')
      .run(JSON.stringify(taxonomy), hash, createdAt);
    return { revision: Number(result.lastInsertRowid), hash, taxonomy, createdAt };
  }

  currentTaxonomy(): TaxonomyRevision {
    const row = this.db.prepare('SELECT * FROM taxonomy_revisions ORDER BY revision DESC LIMIT 1').get() as Row;
    return {
      revision: row.revision as number,
      hash: row.hash as string,
      taxonomy: TaxonomySchema.parse(JSON.parse(row.taxonomy as string)),
      createdAt: row.created_at as number,
    };
  }

  /** Optimistic concurrency: the caller states which revision it edited. */
  updateTaxonomy(taxonomy: Taxonomy, expectedRevision: number): { revision: TaxonomyRevision; changed: boolean } {
    return this.db
      .transaction(() => {
        const current = this.currentTaxonomy();
        if (current.revision !== expectedRevision) throw new StaleRevisionError(current.revision);
        if (taxonomyHash(taxonomy, PROMPT_VERSION) === current.hash) return { revision: current, changed: false };
        return { revision: this.insertTaxonomy(taxonomy), changed: true };
      })
      .immediate();
  }

  /** Make `taxonomy` current, creating a revision only when its content differs. */
  replaceTaxonomy(taxonomy: Taxonomy): { revision: TaxonomyRevision; changed: boolean } {
    return this.db
      .transaction(() => {
        const current = this.currentTaxonomy();
        if (taxonomyHash(taxonomy, PROMPT_VERSION) === current.hash) return { revision: current, changed: false };
        return { revision: this.insertTaxonomy(taxonomy), changed: true };
      })
      .immediate();
  }

  // ---- classifications ----------------------------------------------------

  /**
   * Store a model result only if nothing changed while the model ran: the
   * message's decision sequence and the configuration revision must still be
   * the ones read before inference. Otherwise the result is discarded and
   * `null` is returned, so a late answer never lands on a configuration it
   * was not asked about.
   */
  insertClassification(input: {
    accountId: string;
    messageId: number;
    taxonomyRevision: number;
    taxonomyHash: string;
    promptVersion: string;
    decision: ProviderDecision;
    /** `decisionSeq` of the message as read before inference started. */
    expectedDecisionSeq: number;
  }): StoredClassification | null {
    return this.db
      .transaction(() => {
        const current = this.currentTaxonomy();
        if (current.revision !== input.taxonomyRevision || current.hash !== input.taxonomyHash) return null;
        const message = this.getMessage(input.accountId, input.messageId);
        if (!message || message.decisionSeq !== input.expectedDecisionSeq) return null;
        const seq = this.bumpDecisionSeq(input.messageId);
        const result = this.db
          .prepare(
            `INSERT INTO classifications (account_id, message_id, seq, taxonomy_revision, taxonomy_hash, prompt_version, provider,
               requested_model, model, confidence_kind, fields, usage, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.accountId,
            input.messageId,
            seq,
            input.taxonomyRevision,
            input.taxonomyHash,
            input.promptVersion,
            input.decision.provider,
            input.decision.requestedModel,
            input.decision.model,
            input.decision.confidenceKind,
            JSON.stringify(input.decision.fields),
            input.decision.usage ? JSON.stringify(input.decision.usage) : null,
            this.now(),
          );
        this.db
          .prepare('UPDATE messages SET last_error = NULL, classify_failures = 0, classify_failed_revision = NULL, next_classify_at = NULL WHERE id = ?')
          .run(input.messageId);
        return this.getClassification(Number(result.lastInsertRowid))!;
      })
      .immediate();
  }

  private bumpDecisionSeq(messageId: number): number {
    const row = this.db
      .prepare('UPDATE messages SET decision_seq = decision_seq + 1 WHERE id = ? RETURNING decision_seq')
      .get(messageId) as Row | undefined;
    if (!row) throw new Error('Message not found');
    return row.decision_seq as number;
  }

  getClassification(id: number): StoredClassification | null {
    const row = this.db.prepare('SELECT * FROM classifications WHERE id = ?').get(id) as Row | undefined;
    return row ? toClassification(row) : null;
  }

  /** Id of the newest classification of a message at `revision`, or null. */
  latestClassificationId(messageId: number, revision: number): number | null {
    const row = this.db
      .prepare('SELECT id FROM classifications WHERE message_id = ? AND taxonomy_revision = ? ORDER BY seq DESC LIMIT 1')
      .get(messageId, revision) as Row | undefined;
    return row ? (row.id as number) : null;
  }

  // ---- tags ---------------------------------------------------------------

  /**
   * Messages whose current plan has not been carried out (or, in dry-run,
   * recorded) yet: first those with a classification at `revision`, then
   * those that could not be classified at all. Newest first, bounded.
   */
  tagCandidates(accountId: string, revision: number, planKey: string, mode: TaggingMode, limit: number): TagCandidate[] {
    const params = { accountId, revision, planKey, dryRun: mode === 'dry-run' ? 1 : 0, now: this.now(), limit };
    const classified = this.db
      .prepare(
        `SELECT m.*, (${LATEST_AT_REVISION}) AS cid FROM messages m
         WHERE m.account_id = @accountId AND (${LATEST_AT_REVISION}) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM message_tags t WHERE t.message_id = m.id AND t.classification_id = (${LATEST_AT_REVISION}) AND ${TAG_DONE})
         ORDER BY m.internal_date DESC, m.id DESC LIMIT @limit`,
      )
      .all(params) as Row[];
    const candidates: TagCandidate[] = classified.map((row) => ({ message: toMessage(row), classification: this.getClassification(row.cid as number) }));
    if (candidates.length >= limit) return candidates;
    const unclassifiable = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.account_id = @accountId AND m.classify_failed_revision = @revision AND m.classify_failures >= @maxFailures
           AND NOT EXISTS (SELECT 1 FROM classifications c WHERE c.message_id = m.id AND c.taxonomy_revision = @revision)
           AND NOT EXISTS (SELECT 1 FROM message_tags t WHERE t.message_id = m.id AND t.classification_id IS NULL AND ${TAG_DONE})
         ORDER BY m.internal_date DESC, m.id DESC LIMIT @limit`,
      )
      .all({ ...params, maxFailures: MAX_CLASSIFY_FAILURES, limit: limit - candidates.length }) as Row[];
    return [...candidates, ...unclassifiable.map((row) => ({ message: toMessage(row), classification: null }))];
  }

  getTag(messageId: number): TagRow | null {
    const row = this.db.prepare('SELECT * FROM message_tags WHERE message_id = ?').get(messageId) as Row | undefined;
    return row ? toTag(row) : null;
  }

  /**
   * Record the tagger's result for one message. A failure of the same plan
   * counts toward MAX_TAG_FAILURES and schedules a retry; a new plan starts
   * the count again.
   */
  recordTag(input: {
    accountId: string;
    messageId: number;
    classificationId: number | null;
    taxonomyRevision: number;
    planKey: string;
    outcome: TagOutcome;
    labels: string[];
    status: TagStatus;
    added: string[];
    error: string | null;
  }): TagRow {
    const now = this.now();
    const previous = this.getTag(input.messageId);
    const samePlan =
      previous !== null &&
      previous.classificationId === input.classificationId &&
      previous.taxonomyRevision === input.taxonomyRevision &&
      previous.planKey === input.planKey;
    const failures = input.status === 'failed' ? (samePlan && previous.status === 'failed' ? previous.failures + 1 : 1) : 0;
    const nextAttemptAt = input.status === 'failed' && failures < MAX_TAG_FAILURES ? now + retryDelayMs(failures) : null;
    this.db
      .prepare(
        `INSERT INTO message_tags (message_id, account_id, classification_id, taxonomy_revision, plan_key, outcome, labels, status, added,
           failures, next_attempt_at, error, updated_at)
         VALUES (@messageId, @accountId, @classificationId, @taxonomyRevision, @planKey, @outcome, @labels, @status, @added,
           @failures, @nextAttemptAt, @error, @now)
         ON CONFLICT(message_id) DO UPDATE SET account_id = excluded.account_id, classification_id = excluded.classification_id,
           taxonomy_revision = excluded.taxonomy_revision, plan_key = excluded.plan_key, outcome = excluded.outcome,
           labels = excluded.labels, status = excluded.status, added = excluded.added, failures = excluded.failures,
           next_attempt_at = excluded.next_attempt_at, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        ...input,
        labels: JSON.stringify(input.labels),
        added: JSON.stringify(input.added),
        failures,
        nextAttemptAt,
        now,
      });
    return this.getTag(input.messageId)!;
  }

  /** Counts of tag rows for the current revision, by status and outcome. Numbers only. */
  tagCounts(accountId: string, revision: number): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, outcome, COUNT(*) AS n FROM message_tags WHERE account_id = ? AND taxonomy_revision = ? GROUP BY status, outcome')
      .all(accountId, revision) as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const n = row.n as number;
      counts[row.status as string] = (counts[row.status as string] ?? 0) + n;
      if (row.status === 'applied' || row.status === 'planned') {
        const key = `${row.status}_${row.outcome as string}`;
        counts[key] = (counts[key] ?? 0) + n;
      }
    }
    return counts;
  }

  // ---- sessions and OAuth state ------------------------------------------

  insertSession(idHash: string, csrfToken: string, ttlMs: number): void {
    const now = this.now();
    this.db.prepare('INSERT INTO sessions (id_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)').run(idHash, csrfToken, now, now + ttlMs);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  getSession(idHash: string): { csrfToken: string; expiresAt: number } | null {
    const row = this.db.prepare('SELECT csrf_token, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?').get(idHash, this.now()) as Row | undefined;
    return row ? { csrfToken: row.csrf_token as string, expiresAt: row.expires_at as number } : null;
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  insertOAuthState(stateHash: string, sessionHash: string, ttlMs: number): void {
    const now = this.now();
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now - 3600_000);
    this.db
      .prepare('INSERT INTO oauth_states (state_hash, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(stateHash, sessionHash, now, now + ttlMs);
  }

  /** Single use: marks the state used and reports why it is unusable, if it is. */
  consumeOAuthState(stateHash: string, sessionHash: string): 'ok' | 'unknown' | 'used' | 'expired' | 'session_mismatch' {
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(stateHash) as Row | undefined;
        if (!row) return 'unknown' as const;
        if (row.used_at !== null) return 'used' as const;
        this.db.prepare('UPDATE oauth_states SET used_at = ? WHERE state_hash = ?').run(this.now(), stateHash);
        if ((row.expires_at as number) < this.now()) return 'expired' as const;
        if (row.session_hash !== sessionHash) return 'session_mismatch' as const;
        return 'ok' as const;
      })
      .immediate();
  }

  // ---- locks and cycles ---------------------------------------------------

  /** Cross-process lease. Returns true when acquired. */
  acquireLock(name: string, owner: string, ttlMs: number): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE locks.expires_at < ?`,
      )
      .run(name, owner, now + ttlMs, now);
    return result.changes === 1;
  }

  /**
   * Extend a lease this owner still holds. Returns false once another owner
   * has taken it over; an expired lease nobody else claimed is still ours.
   */
  renewLock(name: string, owner: string, ttlMs: number): boolean {
    const result = this.db.prepare('UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?').run(this.now() + ttlMs, name, owner);
    return result.changes === 1;
  }

  holdsLock(name: string, owner: string): boolean {
    return this.db.prepare('SELECT 1 FROM locks WHERE name = ? AND owner = ?').get(name, owner) !== undefined;
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner);
  }

  startCycle(accountId: string | null, mode: TaggingMode): number {
    const result = this.db
      .prepare("INSERT INTO cycles (account_id, mode, started_at, status) VALUES (?, ?, ?, 'running')")
      .run(accountId, mode, this.now());
    const id = Number(result.lastInsertRowid);
    this.db.prepare('DELETE FROM cycles WHERE id <= ?').run(id - 500);
    return id;
  }

  finishCycle(id: number, status: Exclude<CycleStatus, 'running'>, summary: Record<string, unknown>, error: string | null): void {
    this.db
      .prepare('UPDATE cycles SET finished_at = ?, status = ?, summary = ?, error = ? WHERE id = ?')
      .run(this.now(), status, JSON.stringify(summary), error, id);
  }

  lastCycle(): CycleRow | null {
    const row = this.db.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return row ? toCycle(row) : null;
  }
}
