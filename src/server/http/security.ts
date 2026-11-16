import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config.js';
import { randomToken, safeEqual, sha256 } from '../crypto.js';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';

export interface SessionInfo {
  idHash: string;
  csrfToken: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo;
  }
}

export function cookieName(config: Pick<AppConfig, 'secureCookies'>): string {
  // __Host- requires Secure, Path=/ and no Domain, which pins the cookie to this origin.
  return config.secureCookies ? '__Host-mail_triage_session' : 'mail_triage_session';
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        // Ignore malformed cookie values.
      }
    }
  }
  return cookies;
}

/** Reject requests whose Host is not this app (DNS-rebinding guard). */
export function hostGuard(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host?.toLowerCase();
    if (!host || !config.allowedHosts.has(host)) {
      res.status(421).type('text/plain').send('Misdirected request: unexpected Host header');
      return;
    }
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Keeps the OAuth callback URL (with its one-time code) out of Referer headers.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    next();
  };
}

export class Sessions {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {}

  load(): RequestHandler {
    return (req, _res, next) => {
      const raw = parseCookies(req.headers.cookie).get(cookieName(this.config));
      if (raw && raw.length <= 128) {
        const idHash = sha256(raw);
        const session = this.store.getSession(idHash);
        if (session) req.session = { idHash, csrfToken: session.csrfToken };
      }
      next();
    };
  }

  create(res: Response): SessionInfo {
    const id = randomToken(32);
    const csrfToken = randomToken(24);
    const idHash = sha256(id);
    this.store.insertSession(idHash, csrfToken, this.config.sessionTtlMs);
    res.cookie(cookieName(this.config), id, {
      httpOnly: true,
      // Lax (not Strict) so the cookie accompanies Google's top-level redirect to the OAuth callback.
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
      maxAge: this.config.sessionTtlMs,
    });
    return { idHash, csrfToken };
  }

  destroy(req: Request, res: Response): void {
    if (req.session) this.store.deleteSession(req.session.idHash);
    res.clearCookie(cookieName(this.config), { path: '/', httpOnly: true, sameSite: 'lax', secure: this.config.secureCookies });
  }
}

export function requireSession(): RequestHandler {
  return (req, _res, next) => {
    if (!req.session) return next(new AppError(401, 'unauthenticated', 'Sign in to continue'));
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * State-changing requests must come from this origin and carry the
 * session's CSRF token in a custom header.
 */
export function requireSameOrigin(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!config.allowedOrigins.has(origin)) return next(new AppError(403, 'bad_origin', 'Cross-origin request refused'));
    } else if (req.headers['sec-fetch-site'] !== 'same-origin') {
      return next(new AppError(403, 'bad_origin', 'Request origin could not be verified'));
    }
    next();
  };
}

export function requireCsrf(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const token = req.headers['x-csrf-token'];
    if (!req.session || typeof token !== 'string' || !safeEqual(token, req.session.csrfToken)) {
      return next(new AppError(403, 'bad_csrf', 'Missing or invalid CSRF token; reload the page'));
    }
    next();
  };
}

/** Fixed-window limiter for password attempts, keyed by client address. */
export class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): void {
    const entry = this.attempts.get(key);
    if (entry && entry.resetAt > this.now() && entry.count >= this.max) {
      throw new AppError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again later.');
    }
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
    if (this.attempts.size > 10_000) {
      for (const [k, v] of this.attempts) if (v.resetAt <= now) this.attempts.delete(k);
    }
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
