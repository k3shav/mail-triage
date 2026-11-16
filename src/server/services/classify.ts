import { classifyEmail } from '../../core/classify.js';
import type { EmailForModel } from '../../core/email.js';
import { ProviderError, describeError } from '../../providers/errors.js';
import { FixtureProvider } from '../../providers/fixture.js';
import type { ClassifierProvider } from '../../providers/types.js';
import type { Account, StoredMessage, Store } from '../db/store.js';
import { AppError } from '../errors.js';
import { mapLimit, withLock } from './concurrency.js';

export interface ClassifyStats {
  attempted: number;
  classified: number;
  needsReview: number;
  failed: number;
  remaining: number;
  stoppedEarly: boolean;
}

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

  private async classifyMessages(account: Account, messages: StoredMessage[]) {
    const provider = this.providerFor(account);
    const { revision, taxonomy } = this.store.currentTaxonomy();
    const policy = this.store.getReviewPolicy();
    const stats = { attempted: 0, classified: 0, needsReview: 0, failed: 0, stoppedEarly: false };
    const abort = new AbortController();
    let fatal: ProviderError | null = null;

    await mapLimit(messages, this.concurrency, async (message) => {
      if (abort.signal.aborted) return;
      stats.attempted += 1;
      try {
        const outcome = await classifyEmail({
          provider,
          email: emailFromMessage(message),
          taxonomy,
          policy,
          messageKey: account.kind === 'demo' ? message.externalId : undefined,
          signal: abort.signal,
        });
        // Stored against the revision read at the start of the run; a config
        // edit during the run simply makes these results stale.
        this.store.insertClassification({
          accountId: account.id,
          messageId: message.id,
          taxonomyRevision: revision,
          taxonomyHash: outcome.taxonomyHash,
          promptVersion: outcome.promptVersion,
          decision: outcome.decision,
        });
        stats.classified += 1;
        if (outcome.needsReview) stats.needsReview += 1;
      } catch (error) {
        if (abort.signal.aborted && fatal) return;
        stats.failed += 1;
        this.store.setMessageError(message.id, describeError(error).slice(0, 300));
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
    return withLock(this.store, `classify:${account.id}`, async () => {
      const runId = this.store.startRun(account.id, 'classify');
      const { revision } = this.store.currentTaxonomy();
      try {
        const pending = this.store.messagesNeedingClassification(account.id, revision, limit, true);
        const { stats, fatal } = await this.classifyMessages(account, pending);
        const remaining = this.store.messagesNeedingClassification(account.id, revision, 1000, true).length;
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

  async classifyOne(account: Account, message: StoredMessage): Promise<void> {
    this.providerFor(account);
    await withLock(this.store, `classify:${account.id}`, async () => {
      const { stats, fatal } = await this.classifyMessages(account, [message]);
      if (stats.failed > 0) {
        const error = fatal ?? null;
        throw new AppError(502, 'classification_failed', error ? describeError(error) : this.store.getMessage(account.id, message.id)?.lastError ?? 'Classification failed');
      }
    });
  }
}
