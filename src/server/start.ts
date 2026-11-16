import { createApp } from './app.js';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { PipelineScheduler } from './services/scheduler.js';
import { createProviderFromEnv } from '../providers/registry.js';

/** How long shutdown waits for a running cycle to stop before exiting anyway. */
export const SHUTDOWN_GRACE_MS = 10_000;

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const store = new Store(openDatabase(config.databasePath));
  const model = createProviderFromEnv(env);
  const { app, context } = createApp({ config, store, model });
  if (config.pollIntervalMs > 0) {
    context.scheduler = new PipelineScheduler(context.pipeline, {
      mode: config.taggingMode,
      intervalMs: config.pollIntervalMs,
      log: (message) => console.log(message),
    });
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`Mail Triage listening on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`);
    console.log(config.setupPage ? `Setup page: ${config.publicUrl.origin}` : 'Setup page disabled (SETUP_PAGE=false)');
    console.log(`Auth: ${config.auth.mode === 'password' ? 'app password required' : 'local session (loopback only)'}`);
    console.log(`Model: ${model.status.configured ? `${model.status.info.provider} / ${model.status.info.model}` : `not configured (${model.status.reason})`}`);
    const gmailProblem = context.connection.configurationProblem();
    console.log(`Gmail: ${gmailProblem ? `not configured (${gmailProblem})` : `configured, label writes ${config.labelWrites ? 'enabled' : 'disabled'}`}`);
    console.log(
      `Tagging: ${config.taggingMode}${config.taggingMode === 'dry-run' ? ' (nothing is written to Gmail)' : ''}, ` +
        (context.scheduler ? `every ${config.pollIntervalMs / 1000} s` : 'background cycles off (POLL_INTERVAL_SECONDS=0)'),
    );
    if (!isLoopbackHost(config.host)) console.log('Listening beyond loopback: serve behind HTTPS.');
    context.scheduler?.start();
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS + 5000);
    force.unref();
    server.close();
    server.closeIdleConnections?.();
    const clean = context.scheduler ? await context.scheduler.stop(SHUTDOWN_GRACE_MS) : true;
    if (!clean) console.error('A tagging cycle did not stop in time; exiting. Its lease expires on its own.');
    else store.db.close();
    process.exit(clean ? 0 : 1);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
