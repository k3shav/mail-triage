import type { TaggingMode } from '../config.js';
import { MAX_CLASSIFY_FAILURES, type Account, type Store, type TagCandidate, type TagOutcome, type TaxonomyRevision } from '../db/store.js';
import { AppError } from '../errors.js';
import { GmailApiError, WriteSupersededError, type GmailClient, type GmailLabel, type WriteGuard } from '../gmail/client.js';
import { LeaseLostError, type Lease } from './concurrency.js';
import { planTags, tagPolicyKey, type TagPolicy } from './decisions.js';
import { isFatalGmailError } from './sync.js';

export interface TagStats {
  /** Candidates examined this run. */
  considered: number;
  /** Messages that got (or, in dry-run, would get) category, action, and priority labels. */
  labeled: number;
  /** Messages that got (or would get) only the Needs Review label. */
  reviewOnly: number;
  /** Unscored answers labeled with AUTO_LABEL_UNSCORED, plus Needs Review. */
  labeledForReview: number;
  /** Messages that already carried every planned label. */
  unchanged: number;
  /** Individual label additions made (or that would be made). */
  labelsAdded: number;
  /** Gmail labels created (or that would be created). */
  labelsCreated: number;
  failed: number;
  /** Plans dropped because the configuration or the classification changed mid-run. */
  superseded: number;
  /** Messages no longer in Gmail, or whose thread no longer matches. */
  skipped: number;
  remaining: number;
}

function emptyStats(): TagStats {
  return { considered: 0, labeled: 0, reviewOnly: 0, labeledForReview: 0, unchanged: 0, labelsAdded: 0, labelsCreated: 0, failed: 0, superseded: 0, skipped: 0, remaining: 0 };
}

const OUTCOME_STAT: Record<TagOutcome, 'labeled' | 'reviewOnly' | 'labeledForReview'> = {
  labeled: 'labeled',
  review: 'reviewOnly',
  labeled_review: 'labeledForReview',
};

/**
 * Adds planned labels to Gmail messages. Gmail is only ever asked to create
 * a label under the configured prefix or to add label ids to one message;
 * nothing is removed, archived, sent, or marked read. Dry-run reads Gmail to
 * count what would change and records the plan locally, but never writes.
 */
export class Tagger {
  constructor(
    private readonly store: Store,
    private readonly policy: TagPolicy,
    private readonly batchSize: number,
  ) {}

  get planKey(): string {
    return tagPolicyKey(this.policy);
  }

  /**
   * True while everything a plan was built from still holds: this owner's
   * lease (checked inside the transaction by `lease.commit`), the account,
   * the configuration revision and hash, the message and its thread, and the
   * classification (or the recorded classification failure).
   */
  private isCurrent(account: Account, config: TaxonomyRevision, candidate: TagCandidate): boolean {
    const current = this.store.currentTaxonomy();
    if (current.revision !== config.revision || current.hash !== config.hash) return false;
    const live = this.store.getAccount(account.id);
    if (!live || live.tokenStatus !== 'ok') return false;
    const message = this.store.getMessage(account.id, candidate.message.id);
    if (!message || message.externalId !== candidate.message.externalId || message.threadId !== candidate.message.threadId) return false;
    if (message.decisionSeq !== candidate.message.decisionSeq) return false;
    const latest = this.store.latestClassificationId(message.id, config.revision);
    if (candidate.classification) return latest === candidate.classification.id;
    return latest === null && message.classifyFailedRevision === config.revision && message.classifyFailures >= MAX_CLASSIFY_FAILURES;
  }

  async run(options: { account: Account; client: GmailClient; lease: Lease; cancel: AbortSignal; mode: TaggingMode }): Promise<TagStats> {
    const { account, client, lease, cancel, mode } = options;
    const stats = emptyStats();
    const config = this.store.currentTaxonomy();
    const planKey = this.planKey;
    const candidates = this.store.tagCandidates(account.id, config.revision, planKey, mode, this.batchSize);
    // Nothing to do means no Gmail calls at all.
    if (candidates.length === 0) return stats;

    let labels: Map<string, string> | null = null;
    const labelIds = async () => {
      labels ??= new Map((await client.listLabels()).map((label: GmailLabel) => [label.name, label.id]));
      return labels;
    };
    const wouldCreate = new Set<string>();
    const stopped = () => cancel.aborted || lease.signal.aborted;

    for (const candidate of candidates) {
      if (stopped()) break;
      stats.considered += 1;
      const plan = planTags(candidate.classification, config.taxonomy, this.policy);
      const record = (status: 'planned' | 'applied' | 'failed' | 'skipped', added: string[], error: string | null) =>
        this.store.recordTag({
          accountId: account.id,
          messageId: candidate.message.id,
          classificationId: candidate.classification?.id ?? null,
          taxonomyRevision: config.revision,
          planKey,
          outcome: plan.outcome,
          labels: plan.labels,
          status,
          added,
          error,
        });
      const ifCurrent = (write?: () => void): boolean =>
        lease.commit(() => {
          if (!this.isCurrent(account, config, candidate)) return false;
          write?.();
          return true;
        });
      // Run by the Gmail client immediately before each write attempt is sent: after any token
      // refresh, 401 re-authorization, or retry wait. lease.commit throws LeaseLostError when another
      // owner holds the mailbox.
      const guard: WriteGuard = () => {
        if (cancel.aborted) throw new GmailApiError(0, 'aborted', 'Gmail request cancelled');
        if (!ifCurrent()) throw new WriteSupersededError();
      };

      try {
        if (!ifCurrent()) {
          stats.superseded += 1;
          continue;
        }
        const fresh = await client.getMessageMinimal(candidate.message.externalId);
        if (fresh.threadId !== candidate.message.threadId) {
          lease.commit(() => record('skipped', [], 'Gmail thread no longer matches the stored message'));
          stats.skipped += 1;
          continue;
        }
        const byName = await labelIds();
        const missing = plan.labels.filter((name) => {
          const id = byName.get(name);
          return id === undefined || !fresh.labelIds.includes(id);
        });

        if (missing.length === 0) {
          if (ifCurrent(() => record(mode === 'apply' ? 'applied' : 'planned', [], null))) stats.unchanged += 1;
          else stats.superseded += 1;
          continue;
        }

        if (mode === 'dry-run') {
          if (!ifCurrent(() => record('planned', missing, null))) {
            stats.superseded += 1;
            continue;
          }
          for (const name of missing) if (!byName.has(name)) wouldCreate.add(name);
          stats[OUTCOME_STAT[plan.outcome]] += 1;
          stats.labelsAdded += missing.length;
          continue;
        }

        // Every create and modify below passes `guard` right before it is sent.
        const ids: string[] = [];
        for (const name of missing) {
          if (stopped()) throw new GmailApiError(0, 'aborted', 'Gmail request cancelled');
          const { id, created } = await this.ensureLabel(client, byName, name, guard);
          if (created) stats.labelsCreated += 1;
          ids.push(id);
        }
        if (stopped()) break;
        const updated = await client.addLabels(candidate.message.externalId, ids, guard);
        const unconfirmed = ids.filter((id) => !updated.labelIds.includes(id));
        if (unconfirmed.length > 0) throw new GmailApiError(502, 'unverified', 'Gmail did not confirm every label');
        // The write happened; record it even if the configuration moved on meanwhile.
        lease.commit(() => {
          this.store.updateMessageLabels(account.id, candidate.message.externalId, updated.labelIds);
          record('applied', missing, null);
        });
        stats[OUTCOME_STAT[plan.outcome]] += 1;
        stats.labelsAdded += missing.length;
      } catch (error) {
        if (error instanceof LeaseLostError || lease.signal.aborted) throw new LeaseLostError();
        if (cancel.aborted) break;
        if (error instanceof WriteSupersededError) {
          // Nothing was sent for this plan; the next cycle works from the new state.
          stats.superseded += 1;
          continue;
        }
        if (isFatalGmailError(error)) throw error;
        if (error instanceof GmailApiError && error.status === 404) {
          lease.commit(() => record('skipped', [], 'Message is no longer in Gmail'));
          stats.skipped += 1;
          continue;
        }
        const message = error instanceof GmailApiError || error instanceof AppError ? error.message : 'Labeling failed';
        lease.commit(() => record('failed', [], message.slice(0, 300)));
        stats.failed += 1;
      }
    }
    if (mode === 'dry-run') stats.labelsCreated = wouldCreate.size;
    stats.remaining = this.store.tagCandidates(account.id, this.store.currentTaxonomy().revision, planKey, mode, 1000).length;
    return stats;
  }

  /** Find a label by exact name, or create it. A concurrent creation (409) is resolved by listing again. */
  private async ensureLabel(client: GmailClient, byName: Map<string, string>, name: string, guard: WriteGuard): Promise<{ id: string; created: boolean }> {
    const existing = byName.get(name);
    if (existing) return { id: existing, created: false };
    try {
      const created = await client.createLabel(name, guard);
      byName.set(created.name, created.id);
      return { id: created.id, created: true };
    } catch (error) {
      if (!(error instanceof GmailApiError && error.status === 409)) throw error;
      const labels = await client.listLabels();
      for (const label of labels) byName.set(label.name, label.id);
      // Gmail treats label names case-insensitively when checking for conflicts.
      const match = labels.find((label) => label.name === name) ?? labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
      if (!match) throw new GmailApiError(502, 'label_create_failed', 'Gmail did not create a required label');
      byName.set(name, match.id);
      return { id: match.id, created: false };
    }
  }
}
