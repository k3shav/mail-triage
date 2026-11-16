/** Shapes returned by the Mail Triage API (see src/server/app.ts). */

export type MailboxName = 'demo' | 'gmail';
export type FieldName = 'category' | 'action' | 'priority';
export type DecisionState = 'unclassified' | 'error' | 'stale' | 'needs_review' | 'ready' | 'confirmed';

export interface Session {
  authenticated: boolean;
  mode: 'password' | 'local';
  csrfToken: string | null;
}

export interface Category {
  id: string;
  name: string;
  description: string;
}

export interface Taxonomy {
  categories: Category[];
  userContext: string;
}

export interface TaxonomyRevision {
  revision: number;
  hash: string;
  taxonomy: Taxonomy;
  createdAt: number;
}

export interface ReviewPolicy {
  confidenceThreshold: number;
  reviewWhenNoConfidence: boolean;
}

export interface Run {
  status: 'running' | 'ok' | 'partial' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  stats: Record<string, number>;
  error: string | null;
}

export interface ProviderInfo {
  provider: 'jev' | 'openai-decisions' | 'openai-compatible' | 'fixture';
  model: string;
  confidenceKind: 'provider' | 'none';
  endpointHost: string | null;
  sendsEmailOffDevice: boolean;
}

export interface Capabilities {
  canRead: boolean;
  hasModifyScope: boolean;
  labelWritesEnabled: boolean;
  canApply: boolean;
  applyBlockedReason: string | null;
}

export interface Status {
  auth: { mode: 'password' | 'local' };
  publicUrl: string;
  model: { configured: true; info: ProviderInfo } | { configured: false; reason: string; requested: string | null };
  gmail: {
    configured: boolean;
    problem: string | null;
    redirectUri: string | null;
    requestedScopes: string[];
    labelWritesEnabled: boolean;
    account: null | {
      email: string;
      grantedScopes: string[];
      tokenStatus: 'ok' | 'reauth_required';
      keyMismatch: boolean;
      capabilities: Capabilities;
      messageCount: number;
      lastSync: Run | null;
      lastClassify: Run | null;
    };
  };
  demo: { enabled: true; messageCount: number; lastClassify: Run | null } | { enabled: false };
  taxonomy: { revision: number; hash: string };
  labelPrefix: string;
  limits: { syncMaxMessages: number; classifyBatchSize: number };
}

export interface DecisionView {
  state: DecisionState;
  source: 'model' | 'human' | null;
  /** Classification or correction id; an accept sends it as basedOnClassificationId. */
  sourceId: number | null;
  /** Echo back as expectedDecisionSeq with a correction. */
  decisionSeq: number;
  /** Echo back as expectedTaxonomyRevision with a correction. */
  taxonomyRevision: number;
  category: string | null;
  action: string | null;
  priority: string | null;
  provider: string | null;
  model: string | null;
  reviewReasons: string[];
  staleRevision: number | null;
}

export interface MessageSummary {
  id: number;
  from: string;
  subject: string;
  snippet: string;
  sentAt: string;
  unread: boolean;
  labels: string[];
  lastError: string | null;
  decision: DecisionView;
}

export interface MessageList {
  counts: {
    total: number;
    unread: number;
    byState: Record<string, number>;
    byCategory: Record<string, number>;
    byAction: Record<string, number>;
  };
  total: number;
  messages: MessageSummary[];
}

export type FieldDecision =
  | { status: 'answered'; value: string; confidence: number | null; selectedProbability: number | null; probabilities: Record<string, number> | null }
  | { status: 'refused' }
  | { status: 'invalid'; reason: string };

export interface ClassificationRecord {
  id: number;
  seq: number;
  taxonomyRevision: number;
  provider: string;
  requestedModel: string;
  model: string;
  confidenceKind: 'provider' | 'none';
  fields: Record<FieldName, FieldDecision>;
  createdAt: number;
}

export interface CorrectionRecord {
  id: number;
  seq: number;
  taxonomyRevision: number;
  kind: 'accept' | 'edit';
  category: string;
  action: string;
  priority: string;
  createdAt: number;
}

export interface MessageDetail {
  id: number;
  externalId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  sentAt: string;
  unread: boolean;
  snippet: string;
  body: { text: string; source: 'plain' | 'html' | 'none'; truncated: boolean };
  signals: { hasListUnsubscribe: boolean; listId: string | null; autoSubmitted: string | null; precedence: string | null };
  labels: string[];
  lastError: string | null;
  decision: DecisionView;
  history: {
    classifications: ClassificationRecord[];
    corrections: CorrectionRecord[];
    applies: Array<{ status: string; addedLabels: string[]; error: string | null; createdAt: number }>;
  };
}

export interface LabelPreview {
  previewId: string | null;
  expiresAt: number | null;
  simulated: boolean;
  canApply: boolean;
  blockedReason: string | null;
  labels: Array<{ field: FieldName; name: string }>;
  toAdd: string[];
  alreadyPresent: string[];
  existingNamespaced: Array<{ name: string; field: FieldName | null; conflicts: boolean }>;
  notes: string[];
}

export interface ApplyResult {
  status: 'applied' | 'noop';
  simulated: boolean;
  replayed: boolean;
  added: string[];
  labels: string[];
}

export interface SyncStats {
  listed: number;
  added: number;
  refreshed: number;
  failed: number;
}

export interface ClassifyStats {
  attempted: number;
  classified: number;
  needsReview: number;
  failed: number;
  superseded: number;
  remaining: number;
  stoppedEarly: boolean;
}

export type CorrectionRequest =
  | { kind: 'accept'; expectedTaxonomyRevision: number; expectedDecisionSeq: number; basedOnClassificationId: number }
  | {
      kind: 'edit';
      expectedTaxonomyRevision: number;
      expectedDecisionSeq: number;
      category: string;
      action: string;
      priority: string;
      basedOnClassificationId: number | null;
    };

export interface Filters {
  state: '' | DecisionState | 'pending';
  category: string;
  action: string;
  unread: '' | 'true';
  q: string;
}

/** Which message a request or result belongs to; results for a non-current origin are dropped. */
export interface DetailOrigin {
  mailbox: MailboxName;
  id: number;
  /** Session generation; bumps on sign-in, sign-out, and expired sessions. */
  generation: number;
}
