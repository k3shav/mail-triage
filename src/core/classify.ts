import { reviewReasons, type ProviderDecision, type ReviewPolicy, type ReviewReason } from './decision.js';
import type { EmailForModel } from './email.js';
import { PROMPT_VERSION } from './prompt.js';
import { taxonomyHash, type Taxonomy } from './taxonomy.js';
import type { ClassifierProvider } from '../providers/types.js';

export interface ClassificationOutcome {
  decision: ProviderDecision;
  taxonomyHash: string;
  promptVersion: string;
  reviewReasons: ReviewReason[];
  needsReview: boolean;
}

/** One provider call plus the review policy; no storage, no side effects. */
export async function classifyEmail(options: {
  provider: ClassifierProvider;
  email: EmailForModel;
  taxonomy: Taxonomy;
  policy: ReviewPolicy;
  messageKey?: string;
  signal?: AbortSignal;
}): Promise<ClassificationOutcome> {
  const decision = await options.provider.classify({
    email: options.email,
    taxonomy: options.taxonomy,
    messageKey: options.messageKey,
    signal: options.signal,
  });
  const reasons = reviewReasons(decision, options.policy);
  return {
    decision,
    taxonomyHash: taxonomyHash(options.taxonomy, PROMPT_VERSION),
    promptVersion: PROMPT_VERSION,
    reviewReasons: reasons,
    needsReview: reasons.length > 0,
  };
}
