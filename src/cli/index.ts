import { parseArgs } from 'node:util';
import { createContext } from '../server/app.js';
import { ConfigError, loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';
import { DEMO_ACCOUNT_ID, Store } from '../server/db/store.js';
import { AppError } from '../server/errors.js';
import { resetDemoInbox, seedDemoInbox, syncGmail } from '../server/services/sync.js';
import { startServer } from '../server/start.js';
import { createProviderFromEnv } from '../providers/registry.js';

const USAGE = `mail-triage <command> [options]

Commands:
  serve                       Start the web server (same as npm start)
  status                      Show model, Gmail, and mailbox status
  sync                        Fetch the newest Gmail inbox messages (bounded by SYNC_MAX_MESSAGES)
  classify [--demo] [--limit N]
                              Classify messages that have no decision for the current configuration
  demo-reset                  Restore the demo inbox and delete its decisions and simulated labels

sync and classify never change Gmail. Labels are applied only from the web UI,
one previewed message at a time. To poll, schedule sync and classify with cron
or launchd, for example every 15 minutes:
  */15 * * * * cd /path/to/mail-triage && npm run --silent cli -- sync && npm run --silent cli -- classify`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'serve') {
    await startServer();
    return -1;
  }

  const { values } = parseArgs({
    args: rest,
    options: { demo: { type: 'boolean', default: false }, limit: { type: 'string' } },
  });
  const config = loadConfig(process.env);
  const store = new Store(openDatabase(config.databasePath));
  const context = createContext({ config, store, model: createProviderFromEnv(process.env) });
  if (config.demoInbox) seedDemoInbox(store);

  try {
    switch (command) {
      case 'status': {
        const gmail = context.connection.account();
        const model = context.model.status;
        console.log(`Database: ${config.databasePath}`);
        console.log(`Model: ${model.configured ? `${model.info.provider} / ${model.info.model}` : `not configured: ${model.reason}`}`);
        console.log(`Gmail: ${context.connection.configurationProblem() ?? (gmail ? `${gmail.email} (${gmail.tokenStatus}), ${store.countMessages(gmail.id)} messages` : 'configured, not connected')}`);
        console.log(`Configuration revision: ${store.currentTaxonomy().revision}`);
        return 0;
      }
      case 'sync': {
        const stats = await syncGmail({ store, connection: context.connection, maxMessages: config.syncMaxMessages });
        console.log(`Listed ${stats.listed}, added ${stats.added}, refreshed ${stats.refreshed}, failed ${stats.failed}`);
        return stats.failed > 0 ? 1 : 0;
      }
      case 'classify': {
        const account = values.demo ? store.getAccount(DEMO_ACCOUNT_ID) : context.connection.account();
        if (!account) throw new AppError(409, 'gmail_not_connected', values.demo ? 'Demo inbox is disabled' : 'Gmail is not connected');
        const limit = values.limit ? Number(values.limit) : config.classifyBatchSize;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'bad_limit', '--limit must be 1-100');
        const stats = await context.classifier.classifyPending(account, limit);
        console.log(
          `Classified ${stats.classified} of ${stats.attempted} (${stats.needsReview} need review, ${stats.failed} failed, ${stats.superseded} superseded${stats.stoppedEarly ? ', stopped early' : ''}); ${stats.remaining} remaining`,
        );
        return stats.failed > 0 ? 1 : 0;
      }
      case 'demo-reset':
        resetDemoInbox(store);
        console.log('Demo inbox restored');
        return 0;
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    store.db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    if (error instanceof ConfigError || error instanceof AppError) console.error(error.message);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Failed');
    process.exit(1);
  },
);
