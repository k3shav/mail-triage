import { z } from 'zod';
import {
  DEFAULT_REVIEW_POLICY,
  FieldDecisionSchema,
  ReviewPolicySchema,
  type ConfidenceKind,
  type ProviderDecision,
  type ReviewPolicy,
} from '../../core/decision.js';
import { PROMPT_VERSION } from '../../core/prompt.js';
import { DEFAULT_TAXONOMY, TaxonomySchema, taxonomyHash, type Taxonomy } from '../../core/taxonomy.js';
import type { Db } from './database.js';

export type AccountKind = 'gmail' | 'demo';
export const DEMO_ACCOUNT_ID = 'demo';

export interface Account {
  id: string;
  kind: AccountKind;
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

export interface StoredCorrection {
  id: number;
  accountId: string;
  messageId: number;
  seq: number;
  taxonomyRevision: number;
  kind: 'accept' | 'edit';
  category: string;
  action: string;
  priority: string;
  basedOnClassificationId: number | null;
  createdAt: number;
}

export interface LabelPreviewRow {
  id: string;
  accountId: string;
  messageId: number;
  externalId: string;
  taxonomyRevision: number;
  decisionSeq: number;
  decisionSource: 'model' | 'human';
  decisionRef: number;
  provider: string;
  model: string;
  labels: string[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface LabelApplyRow {
  id: number;
  previewId: string;
  accountId: string;
  messageId: number;
  status: 'pending' | 'applied' | 'noop' | 'failed';
  addedLabels: string[];
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface RunRow {
  id: number;
  accountId: string;
  kind: 'sync' | 'classify';
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'ok' | 'partial' | 'failed';
  stats: Record<string, number>;
  error: string | null;
}

const FieldsSchema = z.object({ category: FieldDecisionSchema, action: FieldDecisionSchema, priority: FieldDecisionSchema });
const json = <T>(text: string | null): T => (text === null ? null : JSON.parse(text)) as T;

type Row = Record<string, unknown>;

function toAccount(row: Row): Account {
  return {
    id: row.id as string,
    kind: row.kind as AccountKind,
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

function toCorrection(row: Row): StoredCorrection {
  return {
    id: row.id as number,
    accountId: row.account_id as string,
    messageId: row.message_id as number,
    seq: row.seq as number,
    taxonomyRevision: row.taxonomy_revision as number,
    kind: row.kind as StoredCorrection['kind'],
    category: row.category as string,
    action: row.action as string,
    priority: row.priority as string,
    basedOnClassificationId: (row.based_on_classification_id as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

function toPreview(row: Row): LabelPreviewRow {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    messageId: row.message_id as number,
    externalId: row.external_id as string,
    taxonomyRevision: row.taxonomy_revision as number,
    decisionSeq: row.decision_seq as number,
    decisionSource: row.decision_source as LabelPreviewRow['decisionSource'],
    decisionRef: row.decision_ref as number,
    provider: row.provider as string,
    model: row.model as string,
    labels: json<string[]>(row.labels as string),
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    consumedAt: (row.consumed_at as number | null) ?? null,
  };
}

function toApply(row: Row): LabelApplyRow {
  return {
    id: row.id as number,
    previewId: row.preview_id as string,
    accountId: row.account_id as string,
    messageId: row.message_id as number,
    status: row.status as LabelApplyRow['status'],
    addedLabels: json<string[]>(row.added_labels as string),
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
  };
}

function toRun(row: Row): RunRow {
  return {
    id: row.id as number,
    accountId: row.account_id as string,
    kind: row.kind as RunRow['kind'],
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
    status: row.status as RunRow['status'],
    stats: json<Record<string, number>>(row.stats as string),
    error: (row.error as string | null) ?? null,
  };
}

export class StaleRevisionError extends Error {
  override name = 'StaleRevisionError';
  constructor(readonly current: number) {
    super(`Configuration changed (now revision ${current}); reload and try again`);
  }
}

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
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  getGmailAccount(): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE kind = 'gmail'").get() as Row | undefined;
    return row ? toAccount(row) : null;
  }

  ensureDemoAccount(): Account {
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO accounts (id, kind, email, created_at, updated_at) VALUES (?, 'demo', 'sam@example.com', ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(DEMO_ACCOUNT_ID, now, now);
    return this.getAccount(DEMO_ACCOUNT_ID)!;
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
  }

  // ---- messages -----------------------------------------------------------

  insertMessage(message: NewMessage): number | null {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO messages (account_id, external_id, thread_id, from_addr, to_addr, cc_addr, subject, sent_at, internal_date,
           snippet, body_text, body_source, body_truncated, signals, label_ids, unread, fetched_at, labels_checked_at)
         VALUES (@accountId, @externalId, @threadId, @from, @to, @cc, @subject, @sentAt, @internalDate,
           @snippet, @bodyText, @bodySource, @bodyTruncated, @signals, @labelIds, @unread, @now, @now)
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

  /** Newest first, bounded. */
  listMessages(accountId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE account_id = ? ORDER BY internal_date DESC, id DESC LIMIT ?')
      .all(accountId, limit) as Row[];
    return rows.map(toMessage);
  }

  /** Messages with neither a classification nor a correction at `revision`. */
  messagesNeedingClassification(accountId: string, revision: number, limit: number, includeErrored: boolean): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.account_id = ?
           AND NOT EXISTS (SELECT 1 FROM classifications c WHERE c.message_id = m.id AND c.taxonomy_revision = ?)
           AND NOT EXISTS (SELECT 1 FROM corrections k WHERE k.message_id = m.id AND k.taxonomy_revision = ?)
           AND (? OR m.last_error IS NULL)
         ORDER BY m.internal_date DESC, m.id DESC LIMIT ?`,
      )
      .all(accountId, revision, revision, includeErrored ? 1 : 0, limit) as Row[];
    return rows.map(toMessage);
  }

  setMessageError(messageId: number, error: string | null): void {
    this.db.prepare('UPDATE messages SET last_error = ? WHERE id = ?').run(error, messageId);
  }

  // ---- taxonomy and settings ---------------------------------------------

  private ensureTaxonomy(): void {
    const existing = this.db.prepare('SELECT COUNT(*) AS n FROM taxonomy_revisions').get() as Row;
    if ((existing.n as number) === 0) this.insertTaxonomy(DEFAULT_TAXONOMY);
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

  getReviewPolicy(): ReviewPolicy {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'review_policy'").get() as Row | undefined;
    if (!row) return DEFAULT_REVIEW_POLICY;
    const parsed = ReviewPolicySchema.safeParse(JSON.parse(row.value as string));
    return parsed.success ? parsed.data : DEFAULT_REVIEW_POLICY;
  }

  setReviewPolicy(policy: ReviewPolicy): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('review_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(policy));
  }

  // ---- decisions ----------------------------------------------------------

  insertClassification(input: {
    accountId: string;
    messageId: number;
    taxonomyRevision: number;
    taxonomyHash: string;
    promptVersion: string;
    decision: ProviderDecision;
  }): StoredClassification {
    return this.db
      .transaction(() => {
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
        this.db.prepare('UPDATE messages SET last_error = NULL WHERE id = ?').run(input.messageId);
        return this.getClassification(Number(result.lastInsertRowid))!;
      })
      .immediate();
  }

  insertCorrection(input: {
    accountId: string;
    messageId: number;
    taxonomyRevision: number;
    kind: StoredCorrection['kind'];
    category: string;
    action: string;
    priority: string;
    basedOnClassificationId: number | null;
  }): StoredCorrection {
    return this.db
      .transaction(() => {
        const seq = this.bumpDecisionSeq(input.messageId);
        const result = this.db
          .prepare(
            `INSERT INTO corrections (account_id, message_id, seq, taxonomy_revision, kind, category, action, priority, based_on_classification_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.accountId,
            input.messageId,
            seq,
            input.taxonomyRevision,
            input.kind,
            input.category,
            input.action,
            input.priority,
            input.basedOnClassificationId,
            this.now(),
          );
        const row = this.db.prepare('SELECT * FROM corrections WHERE id = ?').get(Number(result.lastInsertRowid)) as Row;
        return toCorrection(row);
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

  latestClassifications(messageIds: number[]): Map<number, StoredClassification> {
    return this.latestBy('classifications', messageIds, toClassification);
  }

  latestCorrections(messageIds: number[]): Map<number, StoredCorrection> {
    return this.latestBy('corrections', messageIds, toCorrection);
  }

  private latestBy<T>(table: 'classifications' | 'corrections', messageIds: number[], map: (row: Row) => T): Map<number, T> {
    const result = new Map<number, T>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT t.* FROM ${table} t
           JOIN (SELECT message_id, MAX(seq) AS seq FROM ${table} WHERE message_id IN (${placeholders}) GROUP BY message_id) latest
             ON latest.message_id = t.message_id AND latest.seq = t.seq`,
        )
        .all(...chunk) as Row[];
      for (const row of rows) result.set(row.message_id as number, map(row));
    }
    return result;
  }

  history(messageId: number): { classifications: StoredClassification[]; corrections: StoredCorrection[] } {
    const classifications = (this.db.prepare('SELECT * FROM classifications WHERE message_id = ? ORDER BY seq DESC LIMIT 20').all(messageId) as Row[]).map(toClassification);
    const corrections = (this.db.prepare('SELECT * FROM corrections WHERE message_id = ? ORDER BY seq DESC LIMIT 20').all(messageId) as Row[]).map(toCorrection);
    return { classifications, corrections };
  }

  // ---- label previews and applies ----------------------------------------

  insertPreview(preview: Omit<LabelPreviewRow, 'consumedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO label_previews (id, account_id, message_id, external_id, taxonomy_revision, decision_seq, decision_source, decision_ref,
           provider, model, labels, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        preview.id,
        preview.accountId,
        preview.messageId,
        preview.externalId,
        preview.taxonomyRevision,
        preview.decisionSeq,
        preview.decisionSource,
        preview.decisionRef,
        preview.provider,
        preview.model,
        JSON.stringify(preview.labels),
        preview.createdAt,
        preview.expiresAt,
      );
    this.db.prepare('DELETE FROM label_previews WHERE expires_at < ? AND consumed_at IS NULL').run(this.now() - 86_400_000);
  }

  getPreview(id: string): LabelPreviewRow | null {
    const row = this.db.prepare('SELECT * FROM label_previews WHERE id = ?').get(id) as Row | undefined;
    return row ? toPreview(row) : null;
  }

  /**
   * Atomically consume a preview and create its pending apply row. Returns
   * false if another request already consumed it.
   */
  claimPreview(previewId: string): boolean {
    return this.db
      .transaction(() => {
        const now = this.now();
        const claimed = this.db
          .prepare('UPDATE label_previews SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?')
          .run(now, previewId, now);
        if (claimed.changes !== 1) return false;
        const preview = this.getPreview(previewId)!;
        this.db
          .prepare("INSERT INTO label_applies (preview_id, account_id, message_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
          .run(previewId, preview.accountId, preview.messageId, now);
        return true;
      })
      .immediate();
  }

  finishApply(previewId: string, status: 'applied' | 'noop' | 'failed', addedLabels: string[], error: string | null): void {
    this.db
      .prepare('UPDATE label_applies SET status = ?, added_labels = ?, error = ?, finished_at = ? WHERE preview_id = ?')
      .run(status, JSON.stringify(addedLabels), error, this.now(), previewId);
  }

  getApply(previewId: string): LabelApplyRow | null {
    const row = this.db.prepare('SELECT * FROM label_applies WHERE preview_id = ?').get(previewId) as Row | undefined;
    return row ? toApply(row) : null;
  }

  lastApplies(messageId: number, limit = 5): LabelApplyRow[] {
    return (this.db.prepare('SELECT * FROM label_applies WHERE message_id = ? ORDER BY id DESC LIMIT ?').all(messageId, limit) as Row[]).map(toApply);
  }

  replaceLabelCache(accountId: string, labels: Array<{ id: string; name: string }>): void {
    this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM gmail_labels WHERE account_id = ?').run(accountId);
        const insert = this.db.prepare('INSERT OR REPLACE INTO gmail_labels (account_id, label_id, name) VALUES (?, ?, ?)');
        for (const label of labels) insert.run(accountId, label.id, label.name);
      })
      .immediate();
  }

  labelCache(accountId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT label_id, name FROM gmail_labels WHERE account_id = ?').all(accountId) as Row[];
    return new Map(rows.map((row) => [row.label_id as string, row.name as string]));
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

  // ---- locks and runs -----------------------------------------------------

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

  releaseLock(name: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner);
  }

  startRun(accountId: string, kind: RunRow['kind']): number {
    const result = this.db
      .prepare("INSERT INTO runs (account_id, kind, started_at, status) VALUES (?, ?, ?, 'running')")
      .run(accountId, kind, this.now());
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, status: RunRow['status'], stats: Record<string, number>, error: string | null): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, status = ?, stats = ?, error = ? WHERE id = ?').run(this.now(), status, JSON.stringify(stats), error, id);
  }

  lastRun(accountId: string, kind: RunRow['kind']): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE account_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(accountId, kind) as Row | undefined;
    return row ? toRun(row) : null;
  }
}
