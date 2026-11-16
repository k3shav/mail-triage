import type { FieldDecision } from '../core/decision.js';
import { optionIdForValue, type QuestionSpec } from '../core/prompt.js';

/** Allowed drift of a probability distribution's sum from 1. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;
const TIE_TOLERANCE = 1e-6;

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export interface RawChoiceAnswer {
  choice: unknown;
  confidence: unknown;
  /** Probabilities keyed by model-visible value, or null when malformed. */
  probabilities: Map<string, unknown> | null;
  probabilityError?: string;
}

/**
 * Validate a provider choice answer against the question we asked. Any
 * contract violation makes the field invalid rather than clamping or
 * guessing; invalid fields always go to human review.
 */
export function validateChoiceAnswer(question: QuestionSpec, raw: RawChoiceAnswer): FieldDecision {
  if (typeof raw.choice !== 'string') {
    return { status: 'invalid', reason: 'choice is not a string' };
  }
  const id = optionIdForValue(question, raw.choice);
  if (!id) return { status: 'invalid', reason: 'choice is not one of the requested options' };

  if (raw.confidence === undefined || raw.confidence === null) {
    return { status: 'invalid', reason: 'confidence is missing' };
  }
  if (!isUnitInterval(raw.confidence)) {
    return { status: 'invalid', reason: 'confidence is not a number between 0 and 1' };
  }

  if (!raw.probabilities) {
    return { status: 'invalid', reason: raw.probabilityError ?? 'probabilities are missing' };
  }
  const probabilities: Record<string, number> = {};
  let sum = 0;
  let max = 0;
  for (const [value, probability] of raw.probabilities) {
    const optionId = optionIdForValue(question, value);
    if (!optionId) return { status: 'invalid', reason: 'probabilities include an option that was not requested' };
    if (!isUnitInterval(probability)) {
      return { status: 'invalid', reason: 'a probability is not a number between 0 and 1' };
    }
    probabilities[optionId] = probability;
    sum += probability;
    max = Math.max(max, probability);
  }
  if (Object.keys(probabilities).length !== question.options.length) {
    return { status: 'invalid', reason: 'probabilities do not cover every requested option' };
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    return { status: 'invalid', reason: `probabilities sum to ${sum.toFixed(3)}, not 1` };
  }
  const selectedProbability = probabilities[id] ?? 0;
  if (selectedProbability < max - TIE_TOLERANCE) {
    return { status: 'invalid', reason: 'choice is not the most probable option' };
  }
  return {
    status: 'answered',
    value: id,
    confidence: raw.confidence,
    selectedProbability,
    probabilities,
  };
}
