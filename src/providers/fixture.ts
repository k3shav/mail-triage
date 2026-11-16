import type { FieldDecision, ProviderDecision } from '../core/decision.js';
import { FIELD_NAMES, isValidOptionId, type FieldName } from '../core/taxonomy.js';
import { findDemoMessage } from '../demo/fixtures.js';
import { ProviderError } from './errors.js';
import type { ClassifierProvider, ClassifyRequest, ProviderInfo } from './types.js';

export const FIXTURE_MODEL = 'demo-fixtures-v1';

/**
 * Returns hand-written fixture answers for the bundled sample emails. It never
 * classifies arbitrary mail and reports no confidence.
 */
export class FixtureProvider implements ClassifierProvider {
  readonly info: ProviderInfo = {
    provider: 'fixture',
    model: FIXTURE_MODEL,
    confidenceKind: 'none',
    endpointHost: null,
    sendsEmailOffDevice: false,
  };

  async classify(request: ClassifyRequest): Promise<ProviderDecision> {
    const demo = request.messageKey ? findDemoMessage(request.messageKey) : undefined;
    if (!demo) {
      throw new ProviderError({
        provider: 'fixture',
        kind: 'not_configured',
        message: 'Demo fixtures only cover the bundled sample emails; configure a model provider for real mail',
      });
    }
    const fields = Object.fromEntries(
      FIELD_NAMES.map((field): [FieldName, FieldDecision] => {
        const value = demo.fixture[field];
        return [
          field,
          isValidOptionId(request.taxonomy, field, value)
            ? { status: 'answered', value, confidence: null, selectedProbability: null, probabilities: null }
            : { status: 'invalid', reason: `fixture value "${value}" is not in the current ${field} options` },
        ];
      }),
    ) as Record<FieldName, FieldDecision>;
    return {
      provider: 'fixture',
      requestedModel: FIXTURE_MODEL,
      model: FIXTURE_MODEL,
      confidenceKind: 'none',
      fields,
      usage: null,
    };
  }
}
