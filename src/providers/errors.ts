import type { ProviderId } from '../core/decision.js';

export type ProviderErrorKind =
  | 'not_configured'
  | 'auth'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'invalid_output';

/**
 * Messages are built from status codes and short provider error codes only.
 * Provider error bodies can echo request input (email text), so they are
 * never copied into messages or logs.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(options: {
    provider: ProviderId;
    kind: ProviderErrorKind;
    message: string;
    status?: number;
    retryable?: boolean;
    attempts?: number;
  }) {
    super(options.message);
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.kind = options.kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
  }
}

/** Keep only short identifier-like tokens from provider error payloads. */
export function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

export function describeError(error: unknown): string {
  if (error instanceof ProviderError) return `${error.provider}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
