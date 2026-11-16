import { createApp } from './app.js';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { createProviderFromEnv } from '../providers/registry.js';

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

  const server = app.listen(config.port, config.host, () => {
    console.log(`Mail Triage listening on http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`);
    console.log(`Open ${config.publicUrl.origin}`);
    console.log(`Auth: ${config.auth.mode === 'password' ? 'app password required' : 'local session (loopback only)'}`);
    console.log(`Model: ${model.status.configured ? `${model.status.info.provider} / ${model.status.info.model}` : `not configured (${model.status.reason})`}`);
    const gmailProblem = context.connection.configurationProblem();
    console.log(`Gmail: ${gmailProblem ? `not configured (${gmailProblem})` : `configured, label writes ${config.labelWrites ? 'enabled' : 'disabled'}`}`);
    if (!isLoopbackHost(config.host)) console.log('Listening beyond loopback: serve behind HTTPS.');
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  const shutdown = () => {
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
