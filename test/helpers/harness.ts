import request from 'supertest';
import type { Express } from 'express';
import type { ProviderDecision } from '../../src/core/decision.js';
import type { ClassifierProvider, ClassifyRequest } from '../../src/providers/types.js';
import type { ModelSetup } from '../../src/providers/registry.js';
import { createApp, type AppContext } from '../../src/server/app.js';
import { loadConfig, type AppConfig } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import { FakeGoogle } from './fake-google.js';

export const ORIGIN = 'http://localhost:8787';
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '8787',
    PUBLIC_URL: ORIGIN,
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    MAIL_TRIAGE_ENCRYPTION_KEY: TEST_KEY,
    GMAIL_LABEL_WRITES: 'true',
    ...env,
  });
}

/** A model provider double that answers every field confidently, or per a script. */
export class ScriptedModel implements ClassifierProvider {
  readonly info = {
    provider: 'jev' as const,
    model: 'jev-latest',
    confidenceKind: 'provider' as const,
    endpointHost: 'api.typesafe.ai',
    sendsEmailOffDevice: true,
  };
  calls: ClassifyRequest[] = [];
  next: (request: ClassifyRequest) => Partial<ProviderDecision['fields']> = () => ({});
  model = 'jev-1.13.0';

  async classify(request: ClassifyRequest): Promise<ProviderDecision> {
    this.calls.push(request);
    const answered = (value: string, confidence = 0.95) => ({
      status: 'answered' as const,
      value,
      confidence,
      selectedProbability: 0.97,
      probabilities: null,
    });
    return {
      provider: 'jev',
      requestedModel: 'jev-latest',
      model: this.model,
      confidenceKind: 'provider',
      fields: {
        category: answered('notification'),
        action: answered('needs_action'),
        priority: answered('high'),
        ...this.next(request),
      },
      usage: null,
    };
  }
}

export interface Harness {
  app: Express;
  context: AppContext;
  store: Store;
  google: FakeGoogle;
  model: ScriptedModel;
  logs: string[];
  clock: { now: number };
}

export function createHarness(options: { env?: Record<string, string>; model?: ScriptedModel | null } = {}): Harness {
  const google = new FakeGoogle();
  const model = options.model === undefined ? new ScriptedModel() : options.model;
  const clock = { now: Date.parse('2026-11-16T12:00:00Z') };
  const now = () => clock.now;
  const store = new Store(openDatabase(':memory:'), now);
  const setup: ModelSetup = model
    ? { provider: model, status: { configured: true, info: model.info } }
    : { provider: null, status: { configured: false, requested: null, reason: 'MODEL_PROVIDER is not set.' } };
  const logs: string[] = [];
  const { app, context } = createApp({
    config: testConfig(options.env),
    store,
    model: setup,
    fetch: google.fetch,
    now,
    log: (message) => logs.push(message),
  });
  return { app, context, store, google, model: model ?? new ScriptedModel(), logs, clock };
}

/** Browser-like client: keeps cookies, sends Host/Origin, and the CSRF header after sign-in. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';

  constructor(app: Express) {
    this.agent = request.agent(app);
  }

  get(path: string) {
    return this.agent.get(path).set('Host', 'localhost:8787');
  }

  post(path: string, body?: unknown) {
    const req = this.agent.post(path).set('Host', 'localhost:8787').set('Origin', ORIGIN).set('x-csrf-token', this.csrf);
    return body === undefined ? req : req.send(body as object);
  }

  put(path: string, body: unknown) {
    return this.agent.put(path).set('Host', 'localhost:8787').set('Origin', ORIGIN).set('x-csrf-token', this.csrf).send(body as object);
  }

  delete(path: string) {
    return this.agent.delete(path).set('Host', 'localhost:8787').set('Origin', ORIGIN).set('x-csrf-token', this.csrf);
  }

  async signIn(): Promise<this> {
    const response = await this.post('/api/session/local');
    if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${JSON.stringify(response.body)}`);
    this.csrf = response.body.csrfToken;
    return this;
  }

  /** Run the OAuth round trip against the fake Google. */
  async connectGmail(code = 'good-code'): Promise<request.Response> {
    const start = await this.post('/api/gmail/connect');
    if (start.status !== 200) throw new Error(`connect failed: ${JSON.stringify(start.body)}`);
    const state = new URL(start.body.url).searchParams.get('state')!;
    return this.get(`/api/gmail/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }
}

/** A harness with Gmail connected through the fake OAuth round trip. */
export async function connectedHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness & { client: Client }> {
  const h = createHarness(options);
  const client = await new Client(h.app).signIn();
  const response = await client.connectGmail();
  if (!String(response.headers.location).endsWith('?gmail=connected')) throw new Error(`connect failed: ${String(response.headers.location)}`);
  return { ...h, client };
}
