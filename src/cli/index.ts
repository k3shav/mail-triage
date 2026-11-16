#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createContext, type AppContext } from '../server/app.js';
import { ConfigError, loadConfig, requestedScopes, type AppConfig, type TaggingMode } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';
import { Store } from '../server/db/store.js';
import { AppError } from '../server/errors.js';
import { readCategoriesFile } from '../server/services/categories.js';
import { reviewLabelName } from '../server/services/decisions.js';
import { capabilities } from '../server/services/gmail-connection.js';
import { formatCycle, type CycleResult } from '../server/services/pipeline.js';
import { PipelineScheduler } from '../server/services/scheduler.js';
import { SHUTDOWN_GRACE_MS, startServer } from '../server/start.js';
import { createProviderFromEnv } from '../providers/registry.js';

const USAGE = `mail-triage <command> [options]

Mail Triage labels your Gmail in the background. Labels are only ever added,
under one namespace (LABEL_PREFIX, default "Mail Triage"). Nothing is sent,
archived, deleted, or marked read.

Commands:
  serve                     Setup page plus background tagging (same as npm start)
  status [--json]           Mode, model, Gmail, categories, and the last cycle (counts only)
  tag [--dry-run | --apply] [--json]
                            Run one cycle: sync, classify pending mail, label it
  watch [--dry-run | --apply] [--interval <seconds>]
                            Run cycles until Ctrl-C, one at a time
  categories show           Print the current categories as JSON
  categories check <file>   Validate a categories file without saving it
  categories import <file>  Validate and save a categories file
  setup                     Explain the remaining setup steps

--dry-run and --apply override TAGGING_MODE (default dry-run). Dry-run never
writes to Gmail; it reports what would change. --apply needs
GMAIL_LABEL_WRITES=true and a Gmail connection that granted gmail.modify.

Gmail is connected once in a browser (npm start, then open the setup page).
After that, tag and watch run headless.

Exit codes: 0 done (failed messages are retried later), 1 not ready or a
critical error, 2 usage error, 75 another cycle holds the mailbox.`;

const EXIT = { ok: 0, failed: 1, usage: 2, busy: 75 } as const;

class UsageError extends Error {}

function exitCodeFor(result: CycleResult): number {
  if (result.status === 'ok' || result.status === 'partial') return EXIT.ok;
  if (result.status === 'busy') return EXIT.busy;
  return EXIT.failed;
}

function modeFrom(values: { 'dry-run'?: boolean; apply?: boolean }, config: AppConfig): TaggingMode {
  if (values['dry-run'] && values.apply) throw new UsageError('--dry-run and --apply cannot be used together');
  if (values.apply) return 'apply';
  if (values['dry-run']) return 'dry-run';
  return config.taggingMode;
}

function open(config: AppConfig): { store: Store; context: AppContext } {
  const store = new Store(openDatabase(config.databasePath));
  const context = createContext({ config, store, model: createProviderFromEnv(process.env) });
  return { store, context };
}

function status(context: AppContext, json: boolean): number {
  const { config, store, connection, model } = context;
  const account = connection.account();
  const taxonomy = store.currentTaxonomy();
  const problems = context.pipeline.readiness(config.taggingMode);
  const last = store.lastCycle();
  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: config.taggingMode,
          ready: problems.length === 0,
          problems,
          model: model.status,
          gmail: account
            ? { email: account.email, tokenStatus: account.tokenStatus, capabilities: capabilities(account, config), tags: store.tagCounts(account.id, taxonomy.revision) }
            : { connected: false, problem: connection.configurationProblem() },
          categories: { revision: taxonomy.revision, source: config.categoriesFile ? 'file' : 'database', names: taxonomy.taxonomy.categories.map((c) => c.name) },
          lastCycle: last,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  console.log(`Database: ${config.databasePath}`);
  console.log(`Mode: ${config.taggingMode}${config.taggingMode === 'dry-run' ? ' (nothing is written to Gmail)' : ' (labels are added in Gmail)'}`);
  console.log(
    `Model: ${model.status.configured ? `${model.status.info.provider} / ${model.status.info.model}${model.status.info.sendsEmailOffDevice ? ` (sends email text to ${model.status.info.endpointHost})` : ''}` : `not configured: ${model.status.reason}`}`,
  );
  const gmailProblem = connection.configurationProblem();
  let gmail = gmailProblem ? `not configured: ${gmailProblem}` : 'configured, not connected';
  if (!gmailProblem && account) {
    const caps = capabilities(account, config);
    gmail = `${account.email} (${account.tokenStatus}), ${store.countMessages(account.id)} messages stored, label writes ${caps.canApply ? 'allowed' : `blocked: ${caps.applyBlockedReason}`}`;
  }
  console.log(`Gmail: ${gmail}`);
  console.log(
    `Categories: revision ${taxonomy.revision} from ${config.categoriesFile ?? 'the database'}: ${taxonomy.taxonomy.categories.map((c) => c.name).join(', ')}`,
  );
  console.log(`Labels: ${config.labelPrefix}/Category|Action|Priority/…, uncertain results get ${reviewLabelName(config.labelPrefix)}`);
  console.log(`Policy: confidence threshold ${config.confidenceThreshold}, unscored answers ${config.autoLabelUnscored ? 'labeled + Needs Review' : 'Needs Review only'}`);
  if (account) {
    const counts = store.tagCounts(account.id, taxonomy.revision);
    console.log(`Tagged at this revision: ${counts.applied ?? 0} applied, ${counts.planned ?? 0} dry-run planned, ${counts.failed ?? 0} failed, ${counts.skipped ?? 0} skipped`);
  }
  const lastLine = !last
    ? 'none'
    : last.status === 'running'
      ? `running since ${new Date(last.startedAt).toISOString()}`
      : `${new Date(last.startedAt).toISOString()} ${formatCycle(last.summary as unknown as CycleResult)}`;
  console.log(`Last cycle: ${lastLine}`);
  console.log(problems.length === 0 ? 'Ready.' : `Not ready:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  return EXIT.ok;
}

function setup(config: AppConfig, context: AppContext): number {
  const envFile = path.resolve('.env');
  const lines = [
    'Mail Triage setup',
    '',
    `1. Configuration: ${existsSync(envFile) ? `${envFile} exists.` : 'copy .env.example to .env and fill it in.'}`,
    `2. Model: ${context.model.status.configured ? `ready (${context.model.status.info.provider} / ${context.model.status.info.model}).` : `${context.model.status.reason}`}`,
    '3. Google OAuth client (once):',
    '   - Google Cloud console: create a project, enable the Gmail API, configure the OAuth consent screen',
    '     (Testing, with your own address as a test user).',
    '   - Credentials -> OAuth client ID -> type "Web application" (not Desktop).',
    `   - Authorized redirect URI, exactly: ${config.google?.redirectUri ?? new URL('/api/gmail/oauth/callback', config.publicUrl).toString()}`,
    '   - Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, and MAIL_TRIAGE_ENCRYPTION_KEY=$(openssl rand -base64 32).',
    `   - Scopes requested now: ${requestedScopes(config).join(' ')}`,
    `     ${config.labelWrites ? 'GMAIL_LABEL_WRITES=true: gmail.modify is requested so labels can be added.' : 'GMAIL_LABEL_WRITES=false: read-only; set it to true before using apply mode.'}`,
    `   Status: ${context.connection.configurationProblem() ?? 'configured.'}`,
    `4. Connect Gmail (once): run "npm start" and open ${config.publicUrl.origin}, then choose Connect Gmail.`,
    `   Status: ${context.connection.account() ? `connected as ${context.connection.account()!.email}.` : 'not connected.'}`,
    '5. Try it: "npm run cli -- tag --dry-run" shows what would be labeled without changing Gmail.',
    '6. Turn it on: set TAGGING_MODE=apply and GMAIL_LABEL_WRITES=true (reconnect to grant gmail.modify), then keep',
    '   "npm start" running, or run "mail-triage watch".',
  ];
  console.log(lines.join('\n'));
  return EXIT.ok;
}

async function runTag(context: AppContext, mode: TaggingMode, json: boolean): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await context.pipeline.runCycle({ mode, signal: controller.signal });
    console.log(json ? JSON.stringify(result, null, 2) : formatCycle(result));
    return exitCodeFor(result);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function runWatch(context: AppContext, mode: TaggingMode, intervalMs: number): Promise<number> {
  const scheduler = new PipelineScheduler(context.pipeline, { mode, intervalMs, log: (message) => console.log(`${new Date().toISOString()} ${message}`) });
  console.log(`Watching every ${intervalMs / 1000} s in ${mode} mode. Press Ctrl-C to stop.`);
  scheduler.start();
  return new Promise<number>((resolve) => {
    const stop = async () => {
      const clean = await scheduler.stop(SHUTDOWN_GRACE_MS);
      if (!clean) console.error('The running cycle did not stop in time; exiting. Its lease expires on its own.');
      resolve(clean ? EXIT.ok : EXIT.failed);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  });
}

async function categories(context: AppContext, args: string[]): Promise<number> {
  const [sub, file, ...extra] = args;
  if (extra.length > 0) throw new UsageError('categories takes at most one file');
  const { store, config } = context;
  if (sub === 'show' && !file) {
    const current = store.currentTaxonomy();
    console.error(`# revision ${current.revision}, from ${config.categoriesFile ?? 'the database'}`);
    console.log(JSON.stringify(current.taxonomy, null, 2));
    return EXIT.ok;
  }
  if ((sub === 'check' || sub === 'import') && file) {
    const loaded = await readCategoriesFile(path.resolve(file));
    if (!loaded.ok) {
      console.error(`${file}: ${loaded.error}`);
      return EXIT.failed;
    }
    const summary = `${loaded.taxonomy.categories.length} categories (${loaded.taxonomy.categories.map((c) => c.name).join(', ')})`;
    if (sub === 'check') {
      console.log(`${file}: valid, ${summary}`);
      return EXIT.ok;
    }
    const { revision, changed } = store.replaceTaxonomy(loaded.taxonomy);
    console.log(changed ? `Saved revision ${revision.revision}: ${summary}. Messages in the sync window will be reclassified.` : `Unchanged (revision ${revision.revision}).`);
    if (config.categoriesFile && config.categoriesFile !== path.resolve(file)) {
      console.log(`Note: CATEGORIES_FILE=${config.categoriesFile} is set and replaces these categories at the next cycle.`);
    }
    return EXIT.ok;
  }
  throw new UsageError('usage: categories show | categories check <file> | categories import <file>');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === 'serve') {
    await startServer();
    return -1;
  }
  if (!['status', 'tag', 'watch', 'categories', 'setup'].includes(command)) throw new UsageError(`Unknown command "${command}"`);

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: command === 'categories',
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      json: { type: 'boolean' },
      interval: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const config = loadConfig(process.env);
  // Usage errors are reported before the database is opened.
  const mode = command === 'tag' || command === 'watch' ? modeFrom(values, config) : config.taggingMode;
  const seconds = values.interval === undefined ? (config.pollIntervalMs || 120_000) / 1000 : Number(values.interval);
  if (command === 'watch' && (!Number.isInteger(seconds) || seconds < 15 || seconds > 86_400)) throw new UsageError('--interval must be 15-86400 seconds');
  const { store, context } = open(config);
  try {
    switch (command) {
      case 'status':
        return status(context, Boolean(values.json));
      case 'setup':
        return setup(config, context);
      case 'categories':
        return await categories(context, positionals);
      case 'tag':
        return await runTag(context, mode, Boolean(values.json));
      case 'watch':
        return await runWatch(context, mode, seconds * 1000);
      default:
        throw new UsageError(`Unknown command "${command}"`);
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
    const usage = error instanceof UsageError || (error as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS');
    if (usage) {
      console.error(`${(error as Error).message}\n\nRun "mail-triage --help" for usage.`);
      process.exit(EXIT.usage);
    }
    if (error instanceof ConfigError || error instanceof AppError) console.error(error.message);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Failed');
    process.exit(EXIT.failed);
  },
);
