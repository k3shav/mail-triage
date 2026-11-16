import { ProviderError } from './errors.js';
import type { FetchLike, HttpPolicy } from './http.js';
import { JEV_DEFAULT_MODEL, JevProvider } from './jev.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OPENAI_DEFAULT_MODEL, OpenAIDecisionsProvider } from './openai-decisions.js';
import type { ClassifierProvider, ProviderInfo } from './types.js';

export const MODEL_PROVIDER_VALUES = ['jev', 'openai', 'openai-compatible'] as const;

export type ModelStatus =
  | { configured: true; info: ProviderInfo }
  | { configured: false; reason: string; requested: string | null };

export interface ModelSetup {
  status: ModelStatus;
  provider: ClassifierProvider | null;
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Build the configured model provider from server-side environment
 * variables. Keys never leave the server; the returned status is safe to
 * show in the UI.
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv, deps: { fetch?: FetchLike } = {}): ModelSetup {
  const requested = env.MODEL_PROVIDER?.trim().toLowerCase() || null;
  const policy: Partial<HttpPolicy> = {
    timeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, 20_000, 120_000),
    maxRetries: positiveInt(env.MODEL_MAX_RETRIES, 2, 5),
  };
  const model = env.MODEL_NAME?.trim() || undefined;
  try {
    let provider: ClassifierProvider;
    switch (requested) {
      case null:
        return {
          provider: null,
          status: { configured: false, requested, reason: 'MODEL_PROVIDER is not set. Choose jev, openai, or openai-compatible.' },
        };
      case 'jev':
        provider = new JevProvider({
          apiKey: env.JEV_API_KEY ?? '',
          model: model ?? JEV_DEFAULT_MODEL,
          baseUrl: env.JEV_BASE_URL || undefined,
          policy,
          deps,
        });
        break;
      case 'openai':
        provider = new OpenAIDecisionsProvider({
          apiKey: env.OPENAI_API_KEY ?? '',
          model: model ?? OPENAI_DEFAULT_MODEL,
          baseUrl: env.OPENAI_BASE_URL || undefined,
          organization: env.OPENAI_ORGANIZATION || undefined,
          project: env.OPENAI_PROJECT || undefined,
          policy,
          deps,
        });
        break;
      case 'openai-compatible':
        provider = new OpenAICompatibleProvider({
          baseUrl: env.OPENAI_COMPATIBLE_BASE_URL ?? '',
          model: model ?? '',
          apiKey: env.OPENAI_COMPATIBLE_API_KEY || undefined,
          structuredOutputs: env.OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS !== 'false',
          timeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, 60_000, 300_000),
          maxRetries: policy.maxRetries,
          fetch: deps.fetch,
        });
        break;
      default:
        return {
          provider: null,
          status: { configured: false, requested, reason: `Unknown MODEL_PROVIDER "${requested}". Use jev, openai, or openai-compatible.` },
        };
    }
    return { provider, status: { configured: true, info: provider.info } };
  } catch (error) {
    if (error instanceof ProviderError) {
      return { provider: null, status: { configured: false, requested, reason: error.message } };
    }
    throw error;
  }
}
