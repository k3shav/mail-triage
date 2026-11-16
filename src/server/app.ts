import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { FIELD_LABELS, TaxonomySchema } from '../core/taxonomy.js';
import type { FetchLike } from '../providers/http.js';
import type { ModelSetup } from '../providers/registry.js';
import { requestedScopes, type AppConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { StaleRevisionError, type Store } from './db/store.js';
import { AppError, notFound } from './errors.js';
import { GmailApiError } from './gmail/client.js';
import {
  LoginLimiter,
  Sessions,
  hostGuard,
  noStore,
  requireCsrf,
  requireSameOrigin,
  requireSession,
  securityHeaders,
} from './http/security.js';
import { reviewLabelName } from './services/decisions.js';
import { capabilities, GmailConnection } from './services/gmail-connection.js';
import { Pipeline } from './services/pipeline.js';
import type { PipelineScheduler } from './services/scheduler.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  model: ModelSetup;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
}

export interface AppContext {
  config: AppConfig;
  store: Store;
  model: ModelSetup;
  connection: GmailConnection;
  pipeline: Pipeline;
  /** Set by the server when background cycles run in this process. */
  scheduler: PipelineScheduler | null;
}

export function createContext(deps: AppDeps): AppContext {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
  const connection = new GmailConnection(deps.config, deps.store, fetchImpl, deps.now);
  return {
    config: deps.config,
    store: deps.store,
    model: deps.model,
    connection,
    pipeline: new Pipeline({ config: deps.config, store: deps.store, model: deps.model, connection, now: deps.now }),
    scheduler: null,
  };
}

/** Static files for the setup page, next to this module in both src/ and dist/. */
export const SETUP_ROOT = fileURLToPath(new URL('./setup/public/', import.meta.url));

const TaxonomyUpdateSchema = z.object({ expectedRevision: z.number().int().positive(), taxonomy: TaxonomySchema });

export function createApp(deps: AppDeps): { app: express.Express; context: AppContext } {
  const context = createContext(deps);
  const { config, store, connection } = context;
  const log = deps.log ?? ((message: string) => console.log(message));
  const sessions = new Sessions(config, store);
  const limiter = new LoginLimiter();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(hostGuard(config));
  app.use(securityHeaders());

  const api = express.Router();
  api.use(noStore);
  api.use(express.json({ limit: '64kb', strict: true }));
  api.use(sessions.load());

  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- session ------------------------------------------------------------

  api.get('/session', (req, res) => {
    res.json({
      authenticated: Boolean(req.session),
      mode: config.auth.mode,
      csrfToken: req.session?.csrfToken ?? null,
    });
  });

  api.post('/session/login', requireSameOrigin(config), (req, res) => {
    if (config.auth.mode !== 'password') throw new AppError(400, 'wrong_mode', 'This server does not use a password');
    const key = req.ip ?? 'unknown';
    limiter.check(key);
    const { password } = z.object({ password: z.string().max(1024) }).parse(req.body);
    if (!safeEqual(password, config.auth.password)) {
      limiter.fail(key);
      throw new AppError(401, 'bad_password', 'Incorrect password');
    }
    limiter.reset(key);
    sessions.destroy(req, res);
    const session = sessions.create(res);
    res.json({ authenticated: true, mode: config.auth.mode, csrfToken: session.csrfToken });
  });

  // Loopback-only servers without a password: the browser on this machine gets a session.
  api.post('/session/local', requireSameOrigin(config), (req, res) => {
    if (config.auth.mode !== 'local') throw new AppError(403, 'password_required', 'This server requires a password');
    if (req.session) {
      res.json({ authenticated: true, mode: config.auth.mode, csrfToken: req.session.csrfToken });
      return;
    }
    const session = sessions.create(res);
    res.json({ authenticated: true, mode: config.auth.mode, csrfToken: session.csrfToken });
  });

  api.post('/session/logout', requireSameOrigin(config), requireSession(), requireCsrf(), (req, res) => {
    sessions.destroy(req, res);
    res.json({ authenticated: false });
  });

  // OAuth callback is a top-level GET from Google; it is bound to the session through the state.
  api.get('/gmail/oauth/callback', async (req, res) => {
    const redirect = (params: Record<string, string>) => res.redirect(303, new URL(`/?${new URLSearchParams(params)}`, config.publicUrl).toString());
    if (!req.session) return redirect({ gmail: 'error', reason: 'session_missing' });
    const result = await connection.handleCallback(
      { code: req.query.code, state: req.query.state, error: req.query.error },
      req.session.idHash,
    );
    if (result.ok) {
      log('Gmail connected');
      // Start tagging now instead of waiting for the next interval.
      context.scheduler?.wake();
      return redirect({ gmail: 'connected' });
    }
    log(`Gmail connection failed: ${result.code}`);
    return redirect({ gmail: 'error', reason: result.code });
  });

  // Everything below requires a session; state changes also need same-origin + CSRF.
  api.use(requireSession(), requireSameOrigin(config), requireCsrf());

  /** Setup and health information only. Counts, never message content. */
  api.get('/status', (_req, res) => {
    const gmail = connection.account();
    const { revision, hash, taxonomy } = store.currentTaxonomy();
    const scheduler = context.scheduler;
    const last = store.lastCycle();
    res.json({
      auth: { mode: config.auth.mode },
      publicUrl: config.publicUrl.origin,
      mode: config.taggingMode,
      ready: { problems: context.pipeline.readiness(config.taggingMode) },
      model: deps.model.status,
      gmail: {
        configured: connection.configurationProblem() === null,
        problem: connection.configurationProblem(),
        redirectUri: config.google?.redirectUri ?? null,
        requestedScopes: requestedScopes(config),
        labelWritesEnabled: config.labelWrites,
        account: gmail
          ? {
              email: gmail.email,
              grantedScopes: gmail.grantedScopes,
              tokenStatus: gmail.tokenStatus,
              keyMismatch: connection.keyMismatch(gmail),
              capabilities: capabilities(gmail, config),
              messageCount: store.countMessages(gmail.id),
              tags: store.tagCounts(gmail.id, revision),
            }
          : null,
      },
      categories: {
        revision,
        hash,
        source: config.categoriesFile ? 'file' : 'database',
        file: config.categoriesFile,
        names: taxonomy.categories.map((category) => category.name),
      },
      labels: {
        prefix: config.labelPrefix,
        review: reviewLabelName(config.labelPrefix),
        fields: Object.values(FIELD_LABELS).map((field) => `${config.labelPrefix}/${field}/…`),
      },
      policy: { confidenceThreshold: config.confidenceThreshold, autoLabelUnscored: config.autoLabelUnscored },
      pipeline: {
        polling: scheduler !== null,
        intervalSeconds: config.pollIntervalMs / 1000,
        running: scheduler?.running ?? false,
        nextRunAt: scheduler?.nextRunAt ?? null,
        lastCycle: last
          ? { mode: last.mode, status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt, error: last.error, summary: last.summary }
          : null,
      },
      limits: {
        syncMaxMessages: config.syncMaxMessages,
        classifyBatchSize: config.classifyBatchSize,
        tagBatchSize: config.tagBatchSize,
      },
    });
  });

  // ---- categories ---------------------------------------------------------

  api.get('/taxonomy', (_req, res) => {
    res.json({ ...store.currentTaxonomy(), source: config.categoriesFile ? 'file' : 'database' });
  });

  api.put('/taxonomy', (req, res) => {
    if (config.categoriesFile) {
      throw new AppError(409, 'managed_by_file', 'Categories come from CATEGORIES_FILE on this server. Edit that file instead; it is reloaded before every cycle.');
    }
    const body = TaxonomyUpdateSchema.parse(req.body);
    const result = store.updateTaxonomy(body.taxonomy, body.expectedRevision);
    if (result.changed) log(`Categories revision ${result.revision.revision}; messages in the sync window will be reclassified`);
    res.json({ ...result.revision, changed: result.changed });
  });

  // ---- Gmail connection and background cycles ------------------------------

  api.post('/gmail/connect', (req, res) => {
    res.json({ url: connection.startAuthorization(req.session!.idHash) });
  });

  api.post('/gmail/disconnect', async (_req, res) => {
    const result = await connection.disconnect();
    log('Gmail disconnected; local Gmail data deleted');
    res.json(result);
  });

  api.post('/pipeline/run', (_req, res) => {
    if (!context.scheduler) throw new AppError(409, 'polling_disabled', 'Background tagging is off in this process (POLL_INTERVAL_SECONDS=0). Use the CLI: mail-triage tag');
    res.status(202).json({ scheduled: context.scheduler.wake() });
  });

  api.use((_req, _res, next) => next(notFound('Endpoint')));

  app.use('/api', api);

  if (config.setupPage) {
    const page = (file: string, type: string) => (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.type(type).sendFile(path.join(SETUP_ROOT, file));
    };
    app.get('/', page('index.html', 'html'));
    app.get('/setup.js', page('setup.js', 'text/javascript'));
    app.get('/setup.css', page('setup.css', 'text/css'));
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('Mail Triage is running. The setup page is disabled (SETUP_PAGE=false).');
    });
  }
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof StaleRevisionError) {
      res.status(409).json({ error: { code: 'stale_revision', message: error.message, details: { current: error.current } } });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'The request was not valid',
          details: { issues: error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
        },
      });
      return;
    }
    if (error instanceof GmailApiError) {
      const status = error.status === 403 ? 403 : error.status === 404 ? 404 : 502;
      res.status(status).json({ error: { code: 'gmail_error', message: error.message } });
      return;
    }
    const type = (error as { type?: string })?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
      return;
    }
    log(`Unhandled error: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  return { app, context };
}
