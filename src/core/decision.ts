import { z } from 'zod';
import { FIELD_LABELS, FIELD_NAMES, type FieldName } from './taxonomy.js';

export const PROVIDER_IDS = ['jev', 'openai-decisions', 'openai-compatible', 'fixture'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * - `confidence` is the provider's own certainty statistic for the selection.
 * - `selectedProbability` is the probability the provider assigned to the
 *   selected option. They are different numbers and are stored separately.
 * Both are null when the provider does not report them (language models via
 * the OpenAI-compatible adapter, and demo fixtures). Nothing here estimates
 * or back-fills a value.
 */
export const AnsweredFieldSchema = z.object({
  status: z.literal('answered'),
  value: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  selectedProbability: z.number().min(0).max(1).nullable(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
});

export const FieldDecisionSchema = z.discriminatedUnion('status', [
  AnsweredFieldSchema,
  z.object({ status: z.literal('refused') }),
  z.object({ status: z.literal('invalid'), reason: z.string().max(300) }),
]);
export type FieldDecision = z.infer<typeof FieldDecisionSchema>;
export type AnsweredField = z.infer<typeof AnsweredFieldSchema>;

export const ConfidenceKindSchema = z.enum(['provider', 'none']);
export type ConfidenceKind = z.infer<typeof ConfidenceKindSchema>;

export const ProviderDecisionSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  requestedModel: z.string(),
  /** Model reported by the provider; may differ from an alias such as jev-latest. */
  model: z.string(),
  confidenceKind: ConfidenceKindSchema,
  fields: z.object({
    category: FieldDecisionSchema,
    action: FieldDecisionSchema,
    priority: FieldDecisionSchema,
  }),
  usage: z
    .object({ inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable() })
    .nullable(),
});
export type ProviderDecision = z.infer<typeof ProviderDecisionSchema>;

export const ReviewPolicySchema = z.object({
  /** Answers with provider confidence below this need review. */
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  /** When a provider reports no confidence at all, require review. */
  reviewWhenNoConfidence: z.boolean().default(true),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = { confidenceThreshold: 0.7, reviewWhenNoConfidence: true };

export interface ReviewReason {
  field: FieldName;
  code: 'refused' | 'invalid' | 'no_confidence' | 'low_confidence';
  message: string;
}

export function reviewReasons(decision: Pick<ProviderDecision, 'fields'>, policy: ReviewPolicy): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  for (const field of FIELD_NAMES) {
    const label = FIELD_LABELS[field];
    const result = decision.fields[field];
    if (result.status === 'refused') {
      reasons.push({ field, code: 'refused', message: `${label}: the provider declined to answer` });
    } else if (result.status === 'invalid') {
      reasons.push({ field, code: 'invalid', message: `${label}: unusable provider answer (${result.reason})` });
    } else if (result.confidence === null) {
      if (policy.reviewWhenNoConfidence) {
        reasons.push({ field, code: 'no_confidence', message: `${label}: no provider confidence available` });
      }
    } else if (result.confidence < policy.confidenceThreshold) {
      reasons.push({
        field,
        code: 'low_confidence',
        message: `${label}: confidence ${result.confidence.toFixed(2)} is below ${policy.confidenceThreshold.toFixed(2)}`,
      });
    }
  }
  return reasons;
}

export function answeredValue(result: FieldDecision): string | null {
  return result.status === 'answered' ? result.value : null;
}
