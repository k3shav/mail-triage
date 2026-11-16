import { classifyEmail } from '../../core/classify.js';
import type { EmailForModel } from '../../core/email.js';
import { ProviderError, describeError } from '../../providers/errors.js';
import { FixtureProvider } from '../../providers/fixture.js';
import type { ClassifierProvider } from '../../providers/types.js';
import type { Account, StoredMessage, Store, TaxonomyRevision } from '../db/store.js';
import { AppError } from '../errors.js';
import { LeaseLostError, mapLimit, withLock, type Lease } from './concurrency.js';

export interface ClassifyStats {
  /** Messages taken up by this run: classified + failed + superseded. */
  attempted: number;
  classified: number;
  needsReview: number;
  failed: number;
  /**
   * Results discarded because the message was corrected or reclassified, or
   * the configuration changed, while the model was running. Nothing is stored
   * for them; the newer decision stays in effect.
   */
  superseded: number;
  remaining: number;
  stoppedEarly: boolean;
}

export type ClassifyOneOutcome = 'classified' | 'superseded';

/** Errors that will repeat for every message; stop the run instead of retrying each. */
const FATAL_KINDS = new Set(['auth', 'not_configured', 'rate_limited']);

export function emailFromMessage(message: StoredMessage): EmailForModel {
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.sentAt,
    body: message.bodyText || message.snippet,
    signals: message.signals,
  };
}

export class Classifier {
  private readonly fixture = new FixtureProvider();

  constructor(
    private readonly store: Store,
    private readonly modelProvider: ClassifierProvider | null,
    private readonly concurrency: number,
  ) {}

  /** Demo mail only ever uses fixtures; real mail only ever uses the configured model. */
  providerFor(account: Account): ClassifierProvider {
    if (account.kind === 'demo') return this.fixture;
    if (!this.modelProvider) {
      throw new AppError(409, 'model_not_configured', 'No model provider is configured. Set MODEL_PROVIDER and its key on the server.');
    }
    return this.modelProvider;
  }

  /**
   * Classify `messages` as they were read (their `decisionSeq` is the
   * snapshot). Each result is committed only if that snapshot and the
   * configuration revision still hold, and only while this run holds its lease.
   */
  private async classifyMessages(account: Account, messages: StoredMessage[], config: TaxonomyRevision, lease: Lease) {
    const provider = this.providerFor(account);
    const { revision, taxonomy } = config;
    const policy = this.store.getReviewPolicy();
    const stats = { attempted: 0, classified: 0, needsReview: 0, failed: 0, superseded: 0, stoppedEarly: false };
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lease.signal]);
    let fatal: ProviderError | null = null;

    await mapLimit(messages, this.concurrency, async (message) => {
      if (signal.aborted) return;
      stats.attempted += 1;
      const expectedDecisionSeq = message.decisionSeq;
      // Skip work that is already moot, such as a correction made while this message waited its turn.
      const fresh = this.store.getMessage(account.id, message.id);
      if (!fresh || fresh.decisionSeq !== expectedDecisionSeq || this.store.currentTaxonomy().revision !== revision) {
        stats.superseded += 1;
        return;
      }
      try {
        const outcome = await classifyEmail({
          provider,
          email: emailFromMessage(message),
          taxonomy,
          policy,
          messageKey: account.kind === 'demo' ? message.externalId : undefined,
          signal,
        });
        const stored = lease.commit(() =>
          this.store.insertClassification({
            accountId: account.id,
            messageId: message.id,
            taxonomyRevision: revision,
            taxonomyHash: outcome.taxonomyHash,
            promptVersion: outcome.promptVersion,
            decision: outcome.decision,
            expectedDecisionSeq,
          }),
        );
        if (!stored) {
          stats.superseded += 1;
          return;
        }
        stats.classified += 1;
        if (outcome.needsReview) stats.needsReview += 1;
      } catch (error) {
        if (error instanceof LeaseLostError || lease.signal.aborted) throw new LeaseLostError();
        if (abort.signal.aborted && fatal) return;
        stats.failed += 1;
        lease.commit(() => this.store.setMessageError(message.id, describeError(error).slice(0, 300)));
        if (error instanceof ProviderError && FATAL_KINDS.has(error.kind)) {
          fatal = error;
          stats.stoppedEarly = true;
          abort.abort();
        }
      }
    });
    return { stats, fatal: fatal as ProviderError | null };
  }

  async classifyPending(account: Account, limit: number): Promise<ClassifyStats> {
    this.providerFor(account);
    return withLock(this.store, `classify:${account.id}`, async (lease) => {
      const runId = this.store.startRun(account.id, 'classify');
      const config = this.store.currentTaxonomy();
      try {
        const pending = this.store.messagesNeedingClassification(account.id, config.revision, limit, true);
        const { stats, fatal } = await this.classifyMessages(account, pending, config, lease);
        const current = this.store.currentTaxonomy().revision;
        const remaining = this.store.messagesNeedingClassification(account.id, current, 1000, true).length;
        const result: ClassifyStats = { ...stats, remaining };
        const status = fatal ? 'failed' : stats.failed > 0 ? 'partial' : 'ok';
        this.store.finishRun(runId, status, { ...result, stoppedEarly: stats.stoppedEarly ? 1 : 0 }, fatal ? describeError(fatal) : null);
        return result;
      } catch (error) {
        this.store.finishRun(runId, 'failed', {}, error instanceof Error ? error.message.slice(0, 300) : 'Classification failed');
        throw error;
      }
    });
  }

  /**
   * Classify one message as the caller read it. Returns 'superseded' when a
   * correction, another classification, or a configuration edit landed while
   * the model was running; the newer decision is kept and nothing is stored.
   */
  async classifyOne(account: Account, message: StoredMessage): Promise<ClassifyOneOutcome> {
    this.providerFor(account);
    return withLock(this.store, `classify:${account.id}`, async (lease) => {
      const { stats, fatal } = await this.classifyMessages(account, [message], this.store.currentTaxonomy(), lease);
      if (stats.failed > 0) {
        const error = fatal ?? null;
        throw new AppError(502, 'classification_failed', error ? describeError(error) : this.store.getMessage(account.id, message.id)?.lastError ?? 'Classification failed');
      }
      return stats.superseded > 0 ? 'superseded' : 'classified';
    });
  }
}
