import type { ConfidenceKind, ProviderDecision, ProviderId } from '../core/decision.js';
import type { EmailForModel } from '../core/email.js';
import type { Taxonomy } from '../core/taxonomy.js';

export interface ClassifyRequest {
  email: EmailForModel;
  taxonomy: Taxonomy;
  /** Opaque local key for the message; only the fixture provider reads it. */
  messageKey?: string;
  signal?: AbortSignal;
}

export interface ProviderInfo {
  provider: ProviderId;
  model: string;
  confidenceKind: ConfidenceKind;
  /** Host the adapter talks to, for status display. Never includes credentials. */
  endpointHost: string | null;
  /** True when email content leaves this machine. */
  sendsEmailOffDevice: boolean;
}

export interface ClassifierProvider {
  readonly info: ProviderInfo;
  /**
   * Resolve to a decision whose fields may individually be refused or
   * invalid. Reject with ProviderError for transport or contract failures.
   */
  classify(request: ClassifyRequest): Promise<ProviderDecision>;
}
