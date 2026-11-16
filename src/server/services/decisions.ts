import { reviewReasons, type ReviewPolicy, type ReviewReason } from '../../core/decision.js';
import { isValidOptionId, type Taxonomy } from '../../core/taxonomy.js';
import type { StoredClassification, StoredCorrection, StoredMessage } from '../db/store.js';

export type DecisionState = 'unclassified' | 'error' | 'stale' | 'needs_review' | 'ready' | 'confirmed';

export interface EffectiveDecision {
  state: DecisionState;
  /** Which record the values come from. */
  source: 'model' | 'human' | null;
  sourceId: number | null;
  category: string | null;
  action: string | null;
  priority: string | null;
  reviewReasons: ReviewReason[];
  provider: string | null;
  model: string | null;
  /** The message's decision counter when this was computed; previews bind to it. */
  decisionSeq: number;
  /** Set when a decision exists for an older configuration revision. */
  staleRevision: number | null;
}

/**
 * Combine the latest model classification and the latest human correction
 * for the current configuration revision. Records from earlier revisions
 * never authorize applying labels; they are reported as stale. Between two
 * current records, the later one (higher seq) wins.
 */
export function effectiveDecision(options: {
  message: Pick<StoredMessage, 'decisionSeq' | 'lastError'>;
  classification: StoredClassification | undefined;
  correction: StoredCorrection | undefined;
  revision: number;
  taxonomy: Taxonomy;
  policy: ReviewPolicy;
}): EffectiveDecision {
  const { message, classification, correction, revision, taxonomy, policy } = options;
  const base = {
    reviewReasons: [] as ReviewReason[],
    decisionSeq: message.decisionSeq,
    staleRevision: null as number | null,
  };
  const currentClassification = classification?.taxonomyRevision === revision ? classification : undefined;
  const currentCorrection = correction?.taxonomyRevision === revision ? correction : undefined;

  const useCorrection =
    currentCorrection && (!currentClassification || currentCorrection.seq > currentClassification.seq) ? currentCorrection : undefined;

  if (useCorrection) {
    const valid =
      isValidOptionId(taxonomy, 'category', useCorrection.category) &&
      isValidOptionId(taxonomy, 'action', useCorrection.action) &&
      isValidOptionId(taxonomy, 'priority', useCorrection.priority);
    return {
      ...base,
      state: valid ? 'confirmed' : 'needs_review',
      source: 'human',
      sourceId: useCorrection.id,
      category: useCorrection.category,
      action: useCorrection.action,
      priority: useCorrection.priority,
      provider: 'human',
      model: useCorrection.kind,
    };
  }

  if (currentClassification) {
    const reasons = reviewReasons(currentClassification, policy);
    const value = (field: 'category' | 'action' | 'priority') => {
      const result = currentClassification.fields[field];
      return result.status === 'answered' ? result.value : null;
    };
    return {
      ...base,
      state: reasons.length > 0 ? 'needs_review' : 'ready',
      source: 'model',
      sourceId: currentClassification.id,
      category: value('category'),
      action: value('action'),
      priority: value('priority'),
      reviewReasons: reasons,
      provider: currentClassification.provider,
      model: currentClassification.model,
    };
  }

  const latestOld = [classification, correction]
    .filter((record): record is StoredClassification | StoredCorrection => record !== undefined)
    .sort((a, b) => b.seq - a.seq)[0];
  const empty = { source: null, sourceId: null, category: null, action: null, priority: null, provider: null, model: null };
  if (latestOld) {
    return { ...base, ...empty, state: 'stale', staleRevision: latestOld.taxonomyRevision };
  }
  return { ...base, ...empty, state: message.lastError ? 'error' : 'unclassified' };
}

export function canApply(decision: EffectiveDecision): boolean {
  return (
    (decision.state === 'ready' || decision.state === 'confirmed') &&
    decision.category !== null &&
    decision.action !== null &&
    decision.priority !== null
  );
}
