import type {
  ApplyResult,
  ClassifyStats,
  CorrectionRequest,
  Filters,
  LabelPreview,
  MailboxName,
  MessageDetail,
  MessageList,
  ReviewPolicy,
  Session,
  Status,
  SyncStats,
  Taxonomy,
  TaxonomyRevision,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the Mail Triage server');
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(response.status, 'bad_response', `Unexpected response (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? `Request failed (HTTP ${response.status})`, error?.details);
  }
  return json as T;
}

const mailboxPath = (mailbox: MailboxName) => `/mailboxes/${mailbox}`;

export const api = {
  session: () => call<Session>('GET', '/session'),
  localSession: () => call<Session>('POST', '/session/local'),
  login: (password: string) => call<Session>('POST', '/session/login', { password }),
  logout: () => call<{ authenticated: false }>('POST', '/session/logout'),

  status: () => call<Status>('GET', '/status'),
  taxonomy: () => call<TaxonomyRevision>('GET', '/taxonomy'),
  saveTaxonomy: (expectedRevision: number, taxonomy: Taxonomy) =>
    call<TaxonomyRevision & { changed: boolean }>('PUT', '/taxonomy', { expectedRevision, taxonomy }),
  reviewPolicy: () => call<ReviewPolicy>('GET', '/review-policy'),
  saveReviewPolicy: (policy: ReviewPolicy) => call<ReviewPolicy>('PUT', '/review-policy', policy),

  connectGmail: () => call<{ url: string }>('POST', '/gmail/connect'),
  disconnectGmail: () => call<{ revoked: boolean }>('POST', '/gmail/disconnect'),

  messages: (mailbox: MailboxName, filters: Filters, limit: number) => {
    const params = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return call<MessageList>('GET', `${mailboxPath(mailbox)}/messages?${params}`);
  },
  message: (mailbox: MailboxName, id: number) => call<MessageDetail>('GET', `${mailboxPath(mailbox)}/messages/${id}`),
  sync: (mailbox: MailboxName) => call<SyncStats>('POST', `${mailboxPath(mailbox)}/sync`),
  classify: (mailbox: MailboxName) => call<ClassifyStats>('POST', `${mailboxPath(mailbox)}/classify`, {}),
  resetDemo: () => call<{ ok: true }>('POST', '/mailboxes/demo/reset'),
  reclassify: (mailbox: MailboxName, id: number) =>
    call<MessageDetail & { outcome: 'classified' | 'superseded' }>('POST', `${mailboxPath(mailbox)}/messages/${id}/classify`),
  correct: (mailbox: MailboxName, id: number, body: CorrectionRequest) =>
    call<MessageDetail>('POST', `${mailboxPath(mailbox)}/messages/${id}/corrections`, body),
  preview: (mailbox: MailboxName, id: number) => call<LabelPreview>('POST', `${mailboxPath(mailbox)}/messages/${id}/label-preview`),
  apply: (mailbox: MailboxName, previewId: string) => call<ApplyResult>('POST', `${mailboxPath(mailbox)}/apply`, { previewId }),
};
