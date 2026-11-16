import { z } from 'zod';
import type { FetchLike } from '../../providers/http.js';

/**
 * Google OAuth 2.0 for web server applications:
 * https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * This uses a "Web application" OAuth client (client id + secret, exact
 * registered redirect URI). It is not the Desktop/installed-app loopback
 * flow with PKCE; the client secret stays on this server.
 */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export class OAuthError extends Error {
  override name = 'OAuthError';
  constructor(
    /** Short, safe code shown to the user. */
    readonly code: 'invalid_grant' | 'token_exchange_failed' | 'network' | 'malformed_response',
    message: string,
  ) {
    super(message);
  }
}

export function buildAuthorizationUrl(client: OAuthClientConfig, state: string, scopes: string[]): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  // Consent is needed for Google to issue a refresh token on reconnects.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(fetchImpl: FetchLike, params: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new OAuthError('network', 'Could not reach Google');
  }
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OAuthError('malformed_response', `Google token endpoint returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = (body as Record<string, unknown>)?.error;
    if (error === 'invalid_grant') throw new OAuthError('invalid_grant', 'Google rejected the grant; reconnect Gmail');
    throw new OAuthError('token_exchange_failed', `Google token endpoint returned HTTP ${response.status}`);
  }
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new OAuthError('malformed_response', 'Google token response was not in the expected format');
  return parsed.data;
}

export function exchangeCode(fetchImpl: FetchLike, client: OAuthClientConfig, code: string): Promise<TokenResponse> {
  return tokenRequest(fetchImpl, {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });
}

export function refreshAccessToken(fetchImpl: FetchLike, client: OAuthClientConfig, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(fetchImpl, {
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
  });
}

/** Best effort; local tokens are deleted regardless of the outcome. */
export async function revokeToken(fetchImpl: FetchLike, token: string): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function parseScopes(scope: string | undefined): string[] {
  return [...new Set((scope ?? '').split(/\s+/).filter(Boolean))].sort();
}
