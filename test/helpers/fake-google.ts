import type { FetchLike } from '../../src/providers/http.js';
import { GMAIL_SCOPES } from '../../src/server/config.js';
import type { GmailPart } from '../../src/server/gmail/mime.js';

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  snippet: string;
  payload: GmailPart;
}

export interface FakeCall {
  method: string;
  url: string;
  body: string | undefined;
  authorization: string | undefined;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

export function plainMessage(id: string, subject: string, body: string, extra: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    threadId: `t${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(Date.parse('2026-11-16T10:00:00Z') - Number.parseInt(id.replace(/\D/g, '') || '0', 10) * 60_000),
    snippet: body.slice(0, 50),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Ops <ops@service.example>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Sun, 16 Nov 2026 10:00:00 +0000' },
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
      ],
      body: { size: body.length, data: b64(body) },
    },
    ...extra,
  };
}

/**
 * In-memory stand-in for accounts.google.com token/revoke endpoints and the
 * Gmail REST API. No network is used.
 */
export class FakeGoogle {
  email = 'me@example.com';
  grantedScopes = [GMAIL_SCOPES.readonly, GMAIL_SCOPES.labels, GMAIL_SCOPES.modify];
  issueRefreshToken = true;
  refreshInvalidGrant = false;
  validCodes = new Set<string>(['good-code']);
  accessTokenCounter = 0;
  validAccessTokens = new Set<string>();
  revoked: string[] = [];
  calls: FakeCall[] = [];
  messages = new Map<string, FakeMessage>();
  labels: Array<{ id: string; name: string; type: string }> = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  ];
  /** Fail the next N Gmail calls with this status. */
  failNext: { status: number; count: number } | null = null;
  private labelCounter = 0;

  addMessages(...messages: FakeMessage[]) {
    for (const message of messages) this.messages.set(message.id, structuredClone(message));
  }

  addLabel(name: string): string {
    this.labelCounter += 1;
    const id = `Label_${this.labelCounter}`;
    this.labels.push({ id, name, type: 'user' });
    return id;
  }

  labelNamesOf(messageId: string): string[] {
    const names = new Map(this.labels.map((label) => [label.id, label.name]));
    return (this.messages.get(messageId)?.labelIds ?? []).map((id) => names.get(id) ?? id);
  }

  modifyCalls(): FakeCall[] {
    return this.calls.filter((call) => call.url.includes('/modify'));
  }

  private issueAccess(): string {
    this.accessTokenCounter += 1;
    const token = `ya29.access-${this.accessTokenCounter}`;
    this.validAccessTokens.add(token);
    return token;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.calls.push({ method, url: url.toString(), body, authorization: headers.get('authorization') ?? undefined });

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('client_id') !== 'client-id.apps.googleusercontent.com' || params.get('client_secret') !== 'client-secret') {
        return this.json({ error: 'invalid_client' }, 401);
      }
      if (params.get('grant_type') === 'authorization_code') {
        const code = params.get('code')!;
        if (!this.validCodes.has(code) || params.get('redirect_uri') !== 'http://localhost:8787/api/gmail/oauth/callback') {
          return this.json({ error: 'invalid_grant' }, 400);
        }
        this.validCodes.delete(code);
        return this.json({
          access_token: this.issueAccess(),
          expires_in: 3599,
          token_type: 'Bearer',
          scope: this.grantedScopes.join(' '),
          ...(this.issueRefreshToken ? { refresh_token: `1//refresh-${this.accessTokenCounter}` } : {}),
        });
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (this.refreshInvalidGrant) return this.json({ error: 'invalid_grant' }, 400);
        return this.json({ access_token: this.issueAccess(), expires_in: 3599, token_type: 'Bearer', scope: this.grantedScopes.join(' ') });
      }
      return this.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return new Response('', { status: 200 });
    }

    if (url.origin !== 'https://gmail.googleapis.com') throw new Error(`Unexpected network call to ${url.origin}`);
    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    if (!token || !this.validAccessTokens.has(token)) return this.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401);
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1;
      return this.json({ error: { code: this.failNext.status, status: 'UNAVAILABLE' } }, this.failNext.status);
    }

    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (method === 'GET' && path === '/profile') return this.json({ emailAddress: this.email, messagesTotal: this.messages.size });
    if (method === 'GET' && path === '/messages') {
      expect(url.searchParams.get('labelIds')).toBe('INBOX');
      const max = Number(url.searchParams.get('maxResults'));
      const sorted = [...this.messages.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = sorted.slice(start, start + max);
      return this.json({
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(start + max < sorted.length ? { nextPageToken: String(start + max) } : {}),
      });
    }
    const messageMatch = /^\/messages\/([^/]+)(\/modify)?$/.exec(path);
    if (messageMatch) {
      const message = this.messages.get(decodeURIComponent(messageMatch[1]!));
      if (!message) return this.json({ error: { code: 404, status: 'NOT_FOUND' } }, 404);
      if (messageMatch[2] && method === 'POST') {
        if (!this.grantedScopes.includes(GMAIL_SCOPES.modify)) return this.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403);
        const request = JSON.parse(body ?? '{}') as { addLabelIds?: string[]; removeLabelIds?: string[] };
        for (const id of request.addLabelIds ?? []) if (!message.labelIds.includes(id)) message.labelIds.push(id);
        for (const id of request.removeLabelIds ?? []) message.labelIds = message.labelIds.filter((l) => l !== id);
        return this.json({ id: message.id, threadId: message.threadId, labelIds: message.labelIds });
      }
      const format = url.searchParams.get('format');
      if (format === 'minimal') return this.json({ id: message.id, threadId: message.threadId, labelIds: message.labelIds });
      return this.json(message);
    }
    if (method === 'GET' && path === '/labels') return this.json({ labels: this.labels });
    if (method === 'POST' && path === '/labels') {
      const { name } = JSON.parse(body ?? '{}') as { name: string };
      if (this.labels.some((label) => label.name === name)) return this.json({ error: { code: 409, status: 'ALREADY_EXISTS' } }, 409);
      const id = this.addLabel(name);
      return this.json({ id, name, type: 'user' });
    }
    return this.json({ error: { code: 404 } }, 404);
  };
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
    },
  };
}
