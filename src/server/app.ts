import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { ReviewPolicySchema } from '../core/decision.js';
import { ACTIONS, PRIORITIES, TaxonomySchema } from '../core/taxonomy.js';
import type { FetchLike } from '../providers/http.js';
import type { ModelSetup } from '../providers/registry.js';
import { requestedScopes, type AppConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { DEMO_ACCOUNT_ID, StaleRevisionError, type Account, type Store } from './db/store.js';
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
import { ListQuerySchema, listMessages, messageDetail } from './http/views.js';
import { Classifier } from './services/classify.js';
import { capabilities, GmailConnection } from './services/gmail-connection.js';
import { LabelService } from './services/labels.js';
import { resetDemoInbox, seedDemoInbox, syncGmail } from './services/sync.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  model: ModelSetup;
  fetch?: FetchLike;
  now?: () => number;
  webRoot?: string;
  log?: (message: string) => void;
}

export interface AppContext {
  config: AppConfig;
  store: Store;
  model: ModelSetup;
  connection: GmailConnection;
  classifier: Classifier;
  labels: LabelService;
}

export function createContext(deps: AppDeps): AppContext {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
  const connection = new GmailConnection(deps.config, deps.store, fetchImpl, deps.now);
  return {
    config: deps.config,
    store: deps.store,
    model: deps.model,
    connection,
    classifier: new Classifier(deps.store, deps.model.provider, deps.config.classifyConcurrency),
    labels: new LabelService(deps.config, deps.store, connection, deps.now),
  };
}

const MailboxSchema = z.enum(['demo', 'gmail']);
const IdSchema = z.coerce.number().int().positive();
const ActionSchema = z.enum(ACTIONS.map((a) => a.id) as [string, ...string[]]);
const PrioritySchema = z.enum(PRIORITIES.map((p) => p.id) as [string, ...string[]]);
/**
 * Corrections state what the reviewer saw: `expectedTaxonomyRevision` and
 * `expectedDecisionSeq` come from the message's `decision` view. An accept
 * names the reviewed classification and takes its values from it; values
 * sent with an accept must match. An edit sends all three values.
 */
const ReviewedSchema = {
  expectedTaxonomyRevision: z.number().int().positive(),
  expectedDecisionSeq: z.number().int().min(0),
};
const CorrectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accept'),
    ...ReviewedSchema,
    basedOnClassificationId: z.number().int().positive(),
    category: z.string().max(40).optional(),
    action: ActionSchema.optional(),
    priority: PrioritySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('edit'),
    ...ReviewedSchema,
    basedOnClassificationId: z.number().int().positive().nullable().default(null),
    category: z.string().max(40),
    action: ActionSchema,
    priority: PrioritySchema,
  }),
]);
const TaxonomyUpdateSchema = z.object({ expectedRevision: z.number().int().positive(), taxonomy: TaxonomySchema });
const ClassifyBodySchema = z.object({ limit: z.number().int().min(1).max(100).optional() });
const ApplySchema = z.object({ previewId: z.string().regex(/^pv_[A-Za-z0-9_-]{10,64}$/) });

export function createApp(deps: AppDeps): { app: express.Express; context: AppContext } {
  const context = createContext(deps);
  const { config, store, connection, classifier, labels } = context;
  const log = deps.log ?? ((message: string) => console.log(message));
  const sessions = new Sessions(config, store);
  const limiter = new LoginLimiter();
  if (config.demoInbox) seedDemoInbox(store);

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
    const redirect = (params: Record<string, string>) => res.redirect(303, `/?${new URLSearchParams(params)}`);
    if (!req.session) return redirect({ gmail: 'error', reason: 'session_missing' });
    const result = await connection.handleCallback(
      { code: req.query.code, state: req.query.state, error: req.query.error },
      req.session.idHash,
    );
    if (result.ok) {
      log('Gmail connected');
      return redirect({ gmail: 'connected' });
    }
    log(`Gmail connection failed: ${result.code}`);
    return redirect({ gmail: 'error', reason: result.code });
  });

  // Everything below requires a session; state changes also need same-origin + CSRF.
  api.use(requireSession(), requireSameOrigin(config), requireCsrf());

  const mailbox = (value: unknown): Account => {
    const name = MailboxSchema.parse(value);
    if (name === 'demo') {
      if (!config.demoInbox) throw new AppError(404, 'demo_disabled', 'The demo inbox is disabled on this server');
      return store.getAccount(DEMO_ACCOUNT_ID) ?? store.ensureDemoAccount();
    }
    const account = connection.account();
    if (!account) throw new AppError(409, 'gmail_not_connected', 'Gmail is not connected');
    return account;
  };

  api.get('/status', (_req, res) => {
    const gmail = connection.account();
    const demo = config.demoInbox ? store.getAccount(DEMO_ACCOUNT_ID) : null;
    const { revision, hash } = store.currentTaxonomy();
    res.json({
      auth: { mode: config.auth.mode },
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
              lastSync: store.lastRun(gmail.id, 'sync'),
              lastClassify: store.lastRun(gmail.id, 'classify'),
            }
          : null,
      },
      demo: demo
        ? { enabled: true, messageCount: store.countMessages(demo.id), lastClassify: store.lastRun(demo.id, 'classify') }
        : { enabled: false },
      taxonomy: { revision, hash },
      labelPrefix: config.labelPrefix,
      limits: { syncMaxMessages: config.syncMaxMessages, classifyBatchSize: config.classifyBatchSize },
    });
  });

  // ---- configuration ------------------------------------------------------

  api.get('/taxonomy', (_req, res) => {
    res.json(store.currentTaxonomy());
  });

  api.put('/taxonomy', (req, res) => {
    const body = TaxonomyUpdateSchema.parse(req.body);
    const result = store.updateTaxonomy(body.taxonomy, body.expectedRevision);
    if (result.changed) log(`Configuration revision ${result.revision.revision}; earlier classifications are now stale`);
    res.json({ ...result.revision, changed: result.changed });
  });

  api.get('/review-policy', (_req, res) => {
    res.json(store.getReviewPolicy());
  });

  api.put('/review-policy', (req, res) => {
    const policy = ReviewPolicySchema.parse(req.body);
    store.setReviewPolicy(policy);
    res.json(policy);
  });

  // ---- Gmail connection ---------------------------------------------------

  api.post('/gmail/connect', (req, res) => {
    res.json({ url: connection.startAuthorization(req.session!.idHash) });
  });

  api.post('/gmail/disconnect', async (_req, res) => {
    const result = await connection.disconnect();
    log('Gmail disconnected; local Gmail data deleted');
    res.json(result);
  });

  // ---- mailboxes ----------------------------------------------------------

  api.get('/mailboxes/:mailbox/messages', (req, res) => {
    res.json(listMessages(store, mailbox(req.params.mailbox), ListQuerySchema.parse(req.query)));
  });

  api.get('/mailboxes/:mailbox/messages/:id', (req, res) => {
    const account = mailbox(req.params.mailbox);
    const message = store.getMessage(account.id, IdSchema.parse(req.params.id));
    if (!message) throw notFound('Message');
    res.json(messageDetail(store, account, message));
  });

  api.post('/mailboxes/:mailbox/sync', async (req, res) => {
    const name = MailboxSchema.parse(req.params.mailbox);
    if (name === 'demo') throw new AppError(400, 'demo_no_sync', 'The demo inbox is bundled; there is nothing to sync');
    res.json(await syncGmail({ store, connection, maxMessages: config.syncMaxMessages }));
  });

  api.post('/mailboxes/:mailbox/classify', async (req, res) => {
    const account = mailbox(req.params.mailbox);
    const { limit } = ClassifyBodySchema.parse(req.body ?? {});
    res.json(await classifier.classifyPending(account, Math.min(limit ?? config.classifyBatchSize, config.classifyBatchSize)));
  });

  api.post('/mailboxes/demo/reset', (_req, res) => {
    if (!config.demoInbox) throw new AppError(404, 'demo_disabled', 'The demo inbox is disabled on this server');
    resetDemoInbox(store);
    res.json({ ok: true });
  });

  api.post('/mailboxes/:mailbox/messages/:id/classify', async (req, res) => {
    const account = mailbox(req.params.mailbox);
    const message = store.getMessage(account.id, IdSchema.parse(req.params.id));
    if (!message) throw notFound('Message');
    const outcome = await classifier.classifyOne(account, message);
    res.json({ ...messageDetail(store, account, store.getMessage(account.id, message.id)!), outcome });
  });

  api.post('/mailboxes/:mailbox/messages/:id/corrections', (req, res) => {
    const account = mailbox(req.params.mailbox);
    const message = store.getMessage(account.id, IdSchema.parse(req.params.id));
    if (!message) throw notFound('Message');
    const body = CorrectionSchema.parse(req.body);
    store.insertCorrection({ accountId: account.id, messageId: message.id, ...body });
    res.json(messageDetail(store, account, store.getMessage(account.id, message.id)!));
  });

  api.post('/mailboxes/:mailbox/messages/:id/label-preview', async (req, res) => {
    const account = mailbox(req.params.mailbox);
    res.json(await labels.preview(account, IdSchema.parse(req.params.id)));
  });

  api.post('/mailboxes/:mailbox/apply', async (req, res) => {
    const account = mailbox(req.params.mailbox);
    const { previewId } = ApplySchema.parse(req.body);
    res.json(await labels.apply(account, previewId));
  });

  api.use((_req, _res, next) => next(notFound('Endpoint')));

  app.use('/api', api);

  const webRoot = deps.webRoot ?? path.resolve(process.env.WEB_ROOT ?? 'dist/web');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h', setHeaders: (res, file) => {
      if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
    } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('Mail Triage API is running. Build the web UI with "npm run build" to serve it here.');
    });
  }

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
