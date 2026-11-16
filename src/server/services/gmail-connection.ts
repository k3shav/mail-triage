import type { FetchLike } from '../../providers/http.js';
import { GMAIL_SCOPES, requestedScopes, type AppConfig } from '../config.js';
import { SecretBox, keyFingerprint, parseEncryptionKey, randomToken, sha256 } from '../crypto.js';
import type { Account, Store } from '../db/store.js';
import { AppError } from '../errors.js';
import { GmailClient, type AccessTokenSource } from '../gmail/client.js';
import {
  OAuthError,
  buildAuthorizationUrl,
  exchangeCode,
  parseScopes,
  refreshAccessToken,
  revokeToken,
  type OAuthClientConfig,
} from '../gmail/oauth.js';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const FULL_MAIL_SCOPE = 'https://mail.google.com/';

export interface GmailCapabilities {
  canRead: boolean;
  hasModifyScope: boolean;
  labelWritesEnabled: boolean;
  canApply: boolean;
  applyBlockedReason: string | null;
}

export function capabilities(account: Pick<Account, 'grantedScopes' | 'tokenStatus'>, config: Pick<AppConfig, 'labelWrites'>): GmailCapabilities {
  const scopes = new Set(account.grantedScopes);
  const hasModifyScope = scopes.has(GMAIL_SCOPES.modify) || scopes.has(FULL_MAIL_SCOPE);
  const canRead = scopes.has(GMAIL_SCOPES.readonly) || hasModifyScope;
  let applyBlockedReason: string | null = null;
  if (!config.labelWrites) applyBlockedReason = 'Label writes are disabled on this server (GMAIL_LABEL_WRITES is not true).';
  else if (!hasModifyScope) applyBlockedReason = 'The gmail.modify permission was not granted. Reconnect Gmail and allow label changes.';
  else if (account.tokenStatus !== 'ok') applyBlockedReason = 'Gmail access expired or was revoked. Reconnect Gmail.';
  return {
    canRead: canRead && account.tokenStatus === 'ok',
    hasModifyScope,
    labelWritesEnabled: config.labelWrites,
    canApply: applyBlockedReason === null,
    applyBlockedReason,
  };
}

/** Error codes the callback may put in the redirect URL; nothing else is reflected. */
export type CallbackErrorCode =
  | 'access_denied'
  | 'oauth_error'
  | 'invalid_request'
  | 'invalid_state'
  | 'state_used'
  | 'state_expired'
  | 'session_mismatch'
  | 'token_exchange_failed'
  | 'missing_read_scope'
  | 'no_refresh_token'
  | 'different_account'
  | 'profile_failed'
  | 'not_configured';

export type CallbackResult = { ok: true; email: string } | { ok: false; code: CallbackErrorCode };

/**
 * Owns the Gmail OAuth lifecycle: state, code exchange, encrypted refresh
 * token storage, access token refresh, and disconnect. Tokens never leave
 * this class except as Authorization headers to Google.
 */
export class GmailConnection {
  private readonly box: SecretBox | null;
  private readonly fingerprint: string | null;
  private readonly keyError: string | null;
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {
    let box: SecretBox | null = null;
    let fingerprint: string | null = null;
    let keyError: string | null = null;
    if (config.encryptionKey) {
      try {
        const key = parseEncryptionKey(config.encryptionKey);
        box = new SecretBox(key);
        fingerprint = keyFingerprint(key);
      } catch (error) {
        keyError = (error as Error).message;
      }
    }
    this.box = box;
    this.fingerprint = fingerprint;
    this.keyError = keyError;
  }

  /** Why Gmail cannot be used on this server, or null when it can. */
  configurationProblem(): string | null {
    if (this.keyError) return this.keyError;
    if (this.config.googleMissing.length > 0) return `Set ${this.config.googleMissing.join(', ')} to enable Gmail.`;
    return null;
  }

  private oauthClient(): OAuthClientConfig {
    const problem = this.configurationProblem();
    if (problem || !this.config.google || !this.box) throw new AppError(409, 'gmail_not_configured', problem ?? 'Gmail is not configured');
    return this.config.google;
  }

  account(): Account | null {
    return this.store.getGmailAccount();
  }

  /** True when the stored token was encrypted with a different key than the current one. */
  keyMismatch(account: Account): boolean {
    return Boolean(account.keyFingerprint && this.fingerprint && account.keyFingerprint !== this.fingerprint);
  }

  startAuthorization(sessionHash: string): string {
    const client = this.oauthClient();
    const state = randomToken(32);
    this.store.insertOAuthState(sha256(state), sessionHash, OAUTH_STATE_TTL_MS);
    return buildAuthorizationUrl(client, state, requestedScopes(this.config));
  }

  async handleCallback(query: { code?: unknown; state?: unknown; error?: unknown }, sessionHash: string): Promise<CallbackResult> {
    if (this.configurationProblem()) return { ok: false, code: 'not_configured' };
    const state = typeof query.state === 'string' && query.state.length <= 256 ? query.state : null;
    if (query.error !== undefined) {
      if (state) this.store.consumeOAuthState(sha256(state), sessionHash);
      return { ok: false, code: query.error === 'access_denied' ? 'access_denied' : 'oauth_error' };
    }
    const code = typeof query.code === 'string' && query.code.length > 0 && query.code.length <= 4096 ? query.code : null;
    if (!state || !code) return { ok: false, code: 'invalid_request' };

    const stateResult = this.store.consumeOAuthState(sha256(state), sessionHash);
    if (stateResult !== 'ok') {
      const map = { unknown: 'invalid_state', used: 'state_used', expired: 'state_expired', session_mismatch: 'session_mismatch' } as const;
      return { ok: false, code: map[stateResult] };
    }

    const client = this.oauthClient();
    let tokens;
    try {
      tokens = await exchangeCode(this.fetchImpl, client, code);
    } catch (error) {
      return { ok: false, code: error instanceof OAuthError ? 'token_exchange_failed' : 'oauth_error' };
    }

    const granted = parseScopes(tokens.scope);
    const discard = async () => {
      await revokeToken(this.fetchImpl, tokens.refresh_token ?? tokens.access_token);
    };
    if (!capabilities({ grantedScopes: granted, tokenStatus: 'ok' }, this.config).canRead) {
      await discard();
      return { ok: false, code: 'missing_read_scope' };
    }

    let email: string;
    try {
      const gmail = new GmailClient({ tokens: { get: async () => tokens.access_token, invalidate: () => {} }, fetch: this.fetchImpl, maxRetries: 1 });
      email = (await gmail.getProfile()).emailAddress;
    } catch {
      return { ok: false, code: 'profile_failed' };
    }

    const existing = this.store.getGmailAccount();
    if (existing && existing.email.toLowerCase() !== email.toLowerCase()) {
      await discard();
      return { ok: false, code: 'different_account' };
    }

    const box = this.box!;
    if (existing) {
      // Google may omit refresh_token on re-consent; keep the stored one then.
      const patch: Parameters<Store['updateAccountTokens']>[1] = { grantedScopes: granted, tokenStatus: 'ok' };
      if (tokens.refresh_token) {
        patch.refreshTokenEnc = box.encrypt(tokens.refresh_token, existing.id);
        patch.keyFingerprint = this.fingerprint!;
      } else if (!existing.refreshTokenEnc || this.keyMismatch(existing)) {
        return { ok: false, code: 'no_refresh_token' };
      }
      this.store.updateAccountTokens(existing.id, patch);
      this.cacheAccessToken(existing.id, tokens.access_token, tokens.expires_in);
    } else {
      if (!tokens.refresh_token) return { ok: false, code: 'no_refresh_token' };
      const id = `gmail_${randomToken(12)}`;
      this.store.insertGmailAccount({
        id,
        email,
        grantedScopes: granted,
        refreshTokenEnc: box.encrypt(tokens.refresh_token, id),
        keyFingerprint: this.fingerprint!,
      });
      this.cacheAccessToken(id, tokens.access_token, tokens.expires_in);
    }
    return { ok: true, email };
  }

  private cacheAccessToken(accountId: string, token: string, expiresIn: number) {
    this.accessTokens.set(accountId, { token, expiresAt: this.now() + expiresIn * 1000 });
  }

  /** Access tokens live only in memory and are refreshed on demand, one refresh at a time. */
  tokenSource(accountId: string): AccessTokenSource {
    return {
      get: async () => {
        const cached = this.accessTokens.get(accountId);
        if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
        let pending = this.inflight.get(accountId);
        if (!pending) {
          pending = this.refresh(accountId).finally(() => this.inflight.delete(accountId));
          this.inflight.set(accountId, pending);
        }
        return pending;
      },
      invalidate: () => {
        this.accessTokens.delete(accountId);
      },
    };
  }

  private async refresh(accountId: string): Promise<string> {
    const client = this.oauthClient();
    const account = this.store.getAccount(accountId);
    if (!account || account.kind !== 'gmail' || !account.refreshTokenEnc) {
      throw new AppError(409, 'gmail_not_connected', 'Gmail is not connected');
    }
    if (this.keyMismatch(account)) {
      throw new AppError(409, 'gmail_reauth_required', 'The encryption key changed since Gmail was connected. Reconnect Gmail.');
    }
    let refreshToken: string;
    try {
      refreshToken = this.box!.decrypt(account.refreshTokenEnc, account.id);
    } catch {
      this.store.updateAccountTokens(account.id, { tokenStatus: 'reauth_required' });
      throw new AppError(409, 'gmail_reauth_required', 'Stored Gmail credentials could not be decrypted. Reconnect Gmail.');
    }
    try {
      const tokens = await refreshAccessToken(this.fetchImpl, client, refreshToken);
      const patch: Parameters<Store['updateAccountTokens']>[1] = { tokenStatus: 'ok' };
      if (tokens.refresh_token) patch.refreshTokenEnc = this.box!.encrypt(tokens.refresh_token, account.id);
      if (tokens.scope) patch.grantedScopes = parseScopes(tokens.scope);
      this.store.updateAccountTokens(account.id, patch);
      this.cacheAccessToken(account.id, tokens.access_token, tokens.expires_in);
      return tokens.access_token;
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'invalid_grant') {
        this.store.updateAccountTokens(account.id, { tokenStatus: 'reauth_required' });
        throw new AppError(409, 'gmail_reauth_required', 'Gmail access was revoked or expired. Reconnect Gmail.');
      }
      throw new AppError(502, 'gmail_token_refresh_failed', 'Could not refresh Gmail access; try again later.');
    }
  }

  client(accountId: string): GmailClient {
    return new GmailClient({ tokens: this.tokenSource(accountId), fetch: this.fetchImpl });
  }

  /** Revoke at Google (best effort) and delete the account with all local mail data. */
  async disconnect(): Promise<{ revoked: boolean }> {
    const account = this.store.getGmailAccount();
    if (!account) return { revoked: false };
    let revoked = false;
    if (account.refreshTokenEnc && this.box && !this.keyMismatch(account)) {
      try {
        revoked = await revokeToken(this.fetchImpl, this.box.decrypt(account.refreshTokenEnc, account.id));
      } catch {
        revoked = false;
      }
    }
    this.accessTokens.delete(account.id);
    this.store.deleteAccount(account.id);
    return { revoked };
  }
}
