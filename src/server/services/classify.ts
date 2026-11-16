import { classifyEmail } from '../../core/classify.js';
import { DEFAULT_REVIEW_POLICY } from '../../core/decision.js';
import type { EmailForModel } from '../../core/email.js';
import { ProviderError, describeError } from '../../providers/errors.js';
import type { ClassifierProvider } from '../../providers/types.js';
import { MAX_CLASSIFY_FAILURES, type Account, type StoredMessage, type Store, type TaxonomyRevision } from '../db/store.js';
import { LeaseLostError, mapLimit, type Lease } from './concurrency.js';

export interface ClassifyStats {
  /** Messages taken up by this run: classified + failed + superseded. */
  attempted: number;
  classified: number;
  failed: number;
  /** Messages that reached MAX_CLASSIFY_FAILURES in this run; they get the Needs Review label. */
  gaveUp: number;
  /**
   * Results discarded because the configuration changed or the message was
   * classified elsewhere while the model was running. Nothing is stored.
   */
  superseded: number;
  remaining: number;
  stoppedEarly: boolean;
}

/** Errors that will repeat for every message; stop the run instead of charging each message. */
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
  constructor(
    private readonly store: Store,
    private readonly provider: ClassifierProvider,
    private readonly concurrency: number,
  ) {}

  /**
   * Classify up to `limit` pending messages under `lease`. Each result is
   * committed only if the message's decision sequence and the configuration
   * revision it was asked about still hold, and only while the lease is held.
   * A fatal provider error (bad key, missing configuration, rate limit) stops
   * the run and is returned; it does not count against any message.
   */
  async classifyPending(
    account: Account,
    limit: number,
    lease: Lease,
    /** Cycle cancellation (shutdown); work stopped by it is not charged to any message. */
    cancel: AbortSignal,
  ): Promise<{ stats: ClassifyStats; fatal: ProviderError | null }> {
    const config = this.store.currentTaxonomy();
    const pending = this.store.messagesNeedingClassification(account.id, config.revision, limit);
    const { stats, fatal } = await this.classifyMessages(account, pending, config, lease, cancel);
    const remaining = this.store.countNeedingClassification(account.id, this.store.currentTaxonomy().revision);
    return { stats: { ...stats, remaining }, fatal };
  }

  private async classifyMessages(account: Account, messages: StoredMessage[], config: TaxonomyRevision, lease: Lease, cancel: AbortSignal) {
    const { revision, taxonomy } = config;
    const stats = { attempted: 0, classified: 0, failed: 0, gaveUp: 0, superseded: 0, stoppedEarly: false };
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lease.signal, cancel]);
    let fatal: ProviderError | null = null;

    const one = async (message: StoredMessage) => {
      if (signal.aborted) return;
      stats.attempted += 1;
      const expectedDecisionSeq = message.decisionSeq;
      // Skip work that is already moot, such as a configuration edit made while this message waited its turn.
      const fresh = this.store.getMessage(account.id, message.id);
      if (!fresh || fresh.decisionSeq !== expectedDecisionSeq || this.store.currentTaxonomy().revision !== revision) {
        stats.superseded += 1;
        return;
      }
      try {
        const outcome = await classifyEmail({
          provider: this.provider,
          email: emailFromMessage(message),
          taxonomy,
          // Review routing happens when labels are planned; this only computes the stored decision.
          policy: DEFAULT_REVIEW_POLICY,
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
        if (stored) stats.classified += 1;
        else stats.superseded += 1;
      } catch (error) {
        if (error instanceof LeaseLostError || lease.signal.aborted) throw new LeaseLostError();
        if (cancel.aborted || (abort.signal.aborted && fatal)) {
          stats.attempted -= 1;
          return;
        }
        if (error instanceof ProviderError && FATAL_KINDS.has(error.kind)) {
          fatal = error;
          stats.attempted -= 1;
          stats.stoppedEarly = true;
          abort.abort();
          return;
        }
        stats.failed += 1;
        const failures = lease.commit(() => this.store.recordClassifyFailure(message.id, revision, describeError(error).slice(0, 300)));
        if (failures >= MAX_CLASSIFY_FAILURES) stats.gaveUp += 1;
      }
    };

    // One request first: a bad key or an unreachable provider fails once, not once per worker.
    const [first, ...rest] = messages;
    if (first) await one(first);
    await mapLimit(rest, this.concurrency, one);
    return { stats, fatal: fatal as ProviderError | null };
  }
}
