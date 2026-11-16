import { createHash } from 'node:crypto';
import { reviewReasons, type ReviewReason } from '../../core/decision.js';
import { FIELD_LABELS, FIELD_NAMES, isValidOptionId, optionName, type Taxonomy } from '../../core/taxonomy.js';
import type { StoredClassification, TagOutcome } from '../db/store.js';

export interface TagPolicy {
  /** Gmail label namespace, e.g. "Mail Triage". */
  prefix: string;
  confidenceThreshold: number;
  /** Label schema-valid answers that have no confidence (local models), together with Needs Review. */
  autoLabelUnscored: boolean;
}

export type TagReasonCode = ReviewReason['code'] | 'classification_failed';

export interface TagPlan {
  /**
   * - labeled: every field confident; category, action, and priority labels.
   * - labeled_review: valid but unscored answers with AUTO_LABEL_UNSCORED; the
   *   three labels plus Needs Review.
   * - review: only the Needs Review label; no category is guessed.
   */
  outcome: TagOutcome;
  /** Exact Gmail label names to add, in a fixed order. */
  labels: string[];
  reasons: TagReasonCode[];
}

export const REVIEW_LABEL_SEGMENT = 'Needs Review';

export function reviewLabelName(prefix: string): string {
  return `${prefix}/${REVIEW_LABEL_SEGMENT}`;
}

/** Identifies everything besides the classification that shapes a plan; a change re-plans tagged messages. */
export function tagPolicyKey(policy: TagPolicy): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, prefix: policy.prefix, threshold: policy.confidenceThreshold, unscored: policy.autoLabelUnscored }))
    .digest('hex')
    .slice(0, 16);
}

const BLOCKING: ReadonlySet<TagReasonCode> = new Set(['refused', 'invalid', 'low_confidence']);

/**
 * Turn one stored classification into the labels to add. Refused, invalid,
 * and low-confidence answers only ever get Needs Review. Answers without any
 * confidence get Needs Review, plus their labels when the operator opted in;
 * no confidence is invented for them. `null` means the message could not be
 * classified at all.
 */
export function planTags(classification: Pick<StoredClassification, 'fields'> | null, taxonomy: Taxonomy, policy: TagPolicy): TagPlan {
  const review = reviewLabelName(policy.prefix);
  if (!classification) return { outcome: 'review', labels: [review], reasons: ['classification_failed'] };

  const reasons: TagReasonCode[] = reviewReasons(classification, {
    confidenceThreshold: policy.confidenceThreshold,
    reviewWhenNoConfidence: true,
  }).map((reason) => reason.code);
  const names = FIELD_NAMES.map((field) => {
    const result = classification.fields[field];
    if (result.status !== 'answered') return null;
    // Adapters validate answers against the options asked; this guards stored rows too.
    if (!isValidOptionId(taxonomy, field, result.value)) {
      reasons.push('invalid');
      return null;
    }
    return `${policy.prefix}/${FIELD_LABELS[field]}/${optionName(taxonomy, field, result.value)}`;
  });

  const unique = [...new Set(reasons)];
  if (unique.some((code) => BLOCKING.has(code)) || names.some((name) => name === null)) {
    return { outcome: 'review', labels: [review], reasons: unique };
  }
  const fieldLabels = names as string[];
  if (unique.length === 0) return { outcome: 'labeled', labels: fieldLabels, reasons: [] };
  // Only no_confidence remains.
  if (policy.autoLabelUnscored) return { outcome: 'labeled_review', labels: [...fieldLabels, review], reasons: unique };
  return { outcome: 'review', labels: [review], reasons: unique };
}
