import path from 'node:path';
import { z } from 'zod';

export const GMAIL_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  labels: 'https://www.googleapis.com/auth/gmail.labels',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
} as const;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : ['true', '1', 'yes'].includes(value)));

const intInRange = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer from ${min} to ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: intInRange(8787, 1, 65535),
  PUBLIC_URL: z.string().url().optional(),
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: z.string().optional(),
  APP_PASSWORD: z.string().optional(),
  SESSION_TTL_HOURS: intInRange(168, 1, 24 * 90),
  TRUST_PROXY: bool(false),
  MAIL_TRIAGE_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GMAIL_LABEL_WRITES: bool(false),
  LABEL_PREFIX: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((value) => !/[/\\]/.test(value), 'LABEL_PREFIX cannot contain slashes')
    .default('Mail Triage'),
  SYNC_MAX_MESSAGES: intInRange(50, 1, 200),
  CLASSIFY_BATCH_SIZE: intInRange(20, 1, 100),
  CLASSIFY_CONCURRENCY: intInRange(3, 1, 8),
  DEMO_INBOX: bool(true),
  WEB_DEV_URL: z.string().url().optional(),
});

export interface AppConfig {
  host: string;
  port: number;
  publicUrl: URL;
  /** Hosts accepted in the Host header (DNS-rebinding guard). */
  allowedHosts: Set<string>;
  /** Origins accepted on state-changing requests. */
  allowedOrigins: Set<string>;
  /** Where the browser app lives when it differs from PUBLIC_URL (Vite dev server). */
  appUrl: URL;
  databasePath: string;
  auth: { mode: 'password'; password: string } | { mode: 'local' };
  sessionTtlMs: number;
  trustProxy: boolean;
  secureCookies: boolean;
  encryptionKey: string | null;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  googleMissing: string[];
  labelWrites: boolean;
  labelPrefix: string;
  syncMaxMessages: number;
  classifyBatchSize: number;
  classifyConcurrency: number;
  demoInbox: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const MIN_APP_PASSWORD_LENGTH = 12;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // An empty assignment in .env (KEY=) means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const loopback = isLoopbackHost(e.HOST);
  const password = e.APP_PASSWORD?.length ? e.APP_PASSWORD : undefined;
  if (password !== undefined && password.length < MIN_APP_PASSWORD_LENGTH) {
    throw new ConfigError(`APP_PASSWORD must be at least ${MIN_APP_PASSWORD_LENGTH} characters`);
  }
  // Loopback defaults to "localhost" so the session cookie and Google's localhost redirect share a host.
  const displayHost = e.HOST === '0.0.0.0' || e.HOST === '::' || loopback ? 'localhost' : e.HOST.includes(':') ? `[${e.HOST}]` : e.HOST;
  const publicUrl = new URL(e.PUBLIC_URL ?? `http://${displayHost}:${e.PORT}`);
  if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new ConfigError('PUBLIC_URL must be http or https');
  if (!isLoopbackHost(publicUrl.hostname.replace(/^\[|\]$/g, '')) && publicUrl.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_URL must use https when it is not a loopback address');
  }
  // Local sessions are only safe when nothing but this machine can reach the
  // app. A public PUBLIC_URL means a reverse proxy forwards outside requests
  // to the loopback bind, so Origin and socket address prove nothing.
  if (!password) {
    if (!loopback) {
      throw new ConfigError(
        `Refusing to listen on ${e.HOST} without APP_PASSWORD. Non-loopback binds require authentication; set APP_PASSWORD and serve over HTTPS.`,
      );
    }
    if (!isLoopbackHost(publicUrl.hostname.replace(/^\[|\]$/g, ''))) {
      throw new ConfigError(
        `PUBLIC_URL ${publicUrl.origin} is not a loopback address. Servers reachable through a reverse proxy require APP_PASSWORD.`,
      );
    }
    if (e.TRUST_PROXY) {
      throw new ConfigError('TRUST_PROXY requires APP_PASSWORD. Local sessions without a password are only for loopback-only servers.');
    }
  }

  const allowedHosts = new Set<string>([publicUrl.host]);
  if (loopback || e.HOST === '0.0.0.0' || e.HOST === '::') {
    for (const name of ['localhost', '127.0.0.1', '[::1]']) allowedHosts.add(`${name}:${e.PORT}`);
  }

  const allowedOrigins = new Set([...allowedHosts].map((host) => `${publicUrl.protocol}//${host}`));
  let appUrl = publicUrl;
  if (e.WEB_DEV_URL) {
    const dev = new URL(e.WEB_DEV_URL);
    if (dev.protocol !== 'http:' || !isLoopbackHost(dev.hostname.replace(/^\[|\]$/g, '')) || !loopback) {
      throw new ConfigError('WEB_DEV_URL is for local development only: it must be an http loopback URL on a loopback server');
    }
    appUrl = dev;
    allowedOrigins.add(dev.origin);
  }

  const googleMissing: string[] = [];
  if (!e.GOOGLE_CLIENT_ID) googleMissing.push('GOOGLE_CLIENT_ID');
  if (!e.GOOGLE_CLIENT_SECRET) googleMissing.push('GOOGLE_CLIENT_SECRET');
  if (!e.MAIL_TRIAGE_ENCRYPTION_KEY) googleMissing.push('MAIL_TRIAGE_ENCRYPTION_KEY');
  const redirectUri = e.GOOGLE_REDIRECT_URI ?? new URL('/api/gmail/oauth/callback', publicUrl).toString();
  if (new URL(redirectUri).origin !== publicUrl.origin) {
    throw new ConfigError('GOOGLE_REDIRECT_URI must be on the same origin as PUBLIC_URL so the session cookie reaches the callback');
  }

  const dataDir = path.resolve(e.DATA_DIR);
  return {
    host: e.HOST,
    port: e.PORT,
    publicUrl,
    allowedHosts,
    allowedOrigins,
    appUrl,
    databasePath: e.DATABASE_PATH ? path.resolve(e.DATABASE_PATH) : path.join(dataDir, 'mail-triage.sqlite'),
    auth: password ? { mode: 'password', password } : { mode: 'local' },
    sessionTtlMs: e.SESSION_TTL_HOURS * 3600_000,
    trustProxy: e.TRUST_PROXY,
    secureCookies: publicUrl.protocol === 'https:',
    encryptionKey: e.MAIL_TRIAGE_ENCRYPTION_KEY ?? null,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri }
        : null,
    googleMissing,
    labelWrites: e.GMAIL_LABEL_WRITES,
    labelPrefix: e.LABEL_PREFIX,
    syncMaxMessages: e.SYNC_MAX_MESSAGES,
    classifyBatchSize: e.CLASSIFY_BATCH_SIZE,
    classifyConcurrency: e.CLASSIFY_CONCURRENCY,
    demoInbox: e.DEMO_INBOX,
  };
}

/** Scopes requested at consent. gmail.modify is only requested when label writes are enabled. */
export function requestedScopes(config: Pick<AppConfig, 'labelWrites'>): string[] {
  return config.labelWrites
    ? [GMAIL_SCOPES.readonly, GMAIL_SCOPES.labels, GMAIL_SCOPES.modify]
    : [GMAIL_SCOPES.readonly];
}
