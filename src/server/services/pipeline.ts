import { describeError, type ProviderError } from '../../providers/errors.js';
import type { ModelSetup } from '../../providers/registry.js';
import type { AppConfig, TaggingMode } from '../config.js';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';
import { GmailApiError } from '../gmail/client.js';
import { syncCategoriesFile } from './categories.js';
import { Classifier, type ClassifyStats } from './classify.js';
import { LeaseLostError, withLock } from './concurrency.js';
import { capabilities, type GmailConnection } from './gmail-connection.js';
import { Tagger, type TagStats } from './labels.js';
import { syncGmail, type SyncStats } from './sync.js';

/**
 * - ok / partial: the cycle finished; partial means some messages failed and will be retried.
 * - failed: a critical error (credentials, permissions, categories file) stopped it.
 * - not_ready: setup is incomplete; nothing was attempted.
 * - busy: another process or cycle holds the mailbox lease; nothing was attempted.
 * - aborted: shutdown interrupted it; nothing further was written.
 */
export type CycleOutcome = 'ok' | 'partial' | 'failed' | 'not_ready' | 'busy' | 'aborted';

/** Counts and status only: no subjects, senders, or bodies. */
export interface CycleResult {
  status: CycleOutcome;
  mode: TaggingMode;
  error: string | null;
  categories: { revision: number; changed: boolean; error: string | null };
  sync: SyncStats | null;
  classify: ClassifyStats | null;
  tag: TagStats | null;
  startedAt: number;
  durationMs: number;
}

export interface PipelineDeps {
  config: AppConfig;
  store: Store;
  model: ModelSetup;
  connection: GmailConnection;
  now?: () => number;
}

/** Why a cycle in `mode` cannot run, in the order a person would fix them. */
export function readinessProblems(deps: PipelineDeps, mode: TaggingMode): string[] {
  const problems: string[] = [];
  const { model, connection, config } = deps;
  if (!model.provider) problems.push(`Model not configured: ${model.status.configured ? 'unavailable' : model.status.reason}`);
  const gmailProblem = connection.configurationProblem();
  if (gmailProblem) {
    problems.push(`Gmail not configured: ${gmailProblem}`);
    return problems;
  }
  const account = connection.account();
  if (!account) {
    problems.push(`Gmail is not connected. Open ${config.publicUrl.origin} and choose Connect Gmail.`);
    return problems;
  }
  if (connection.keyMismatch(account)) {
    problems.push('The encryption key changed since Gmail was connected. Reconnect Gmail.');
    return problems;
  }
  const caps = capabilities(account, config);
  if (!caps.canRead) problems.push('Gmail access expired, was revoked, or read access was not granted. Reconnect Gmail.');
  else if (mode === 'apply' && caps.applyBlockedReason) {
    problems.push(
      config.labelWrites
        ? `Apply mode cannot write labels: ${caps.applyBlockedReason}`
        : 'Apply mode needs GMAIL_LABEL_WRITES=true, then reconnect Gmail to grant gmail.modify. Use dry-run until then.',
    );
  }
  return problems;
}

function safeMessage(error: unknown): string {
  if (error instanceof AppError || error instanceof GmailApiError) return error.message;
  return describeError(error).slice(0, 300);
}

/**
 * One tagging cycle: reload categories, sync the newest inbox messages,
 * classify a bounded batch of pending ones, then label a bounded batch in
 * Gmail. The whole cycle runs under one renewable, owner-checked SQLite
 * lease per mailbox, so the server and any CLI run never overlap.
 */
export class Pipeline {
  private readonly now: () => number;
  readonly tagger: Tagger;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
    this.tagger = new Tagger(
      deps.store,
      { prefix: deps.config.labelPrefix, confidenceThreshold: deps.config.confidenceThreshold, autoLabelUnscored: deps.config.autoLabelUnscored },
      deps.config.tagBatchSize,
    );
  }

  readiness(mode: TaggingMode): string[] {
    return readinessProblems(this.deps, mode);
  }

  async runCycle(options: { mode: TaggingMode; signal?: AbortSignal }): Promise<CycleResult> {
    const { config, store, model, connection } = this.deps;
    const { mode } = options;
    const cancel = options.signal ?? new AbortController().signal;
    const startedAt = this.now();
    const result: CycleResult = {
      status: 'ok',
      mode,
      error: null,
      categories: { revision: store.currentTaxonomy().revision, changed: false, error: null },
      sync: null,
      classify: null,
      tag: null,
      startedAt,
      durationMs: 0,
    };
    const done = (status: CycleOutcome, error: string | null = null) => {
      result.status = status;
      result.error = error;
      result.durationMs = this.now() - startedAt;
      return result;
    };

    // A malformed file never replaces the stored categories, and nothing is labeled with categories the operator is changing.
    if (config.categoriesFile) {
      const loaded = await syncCategoriesFile(store, config.categoriesFile);
      result.categories = { revision: loaded.revision.revision, changed: loaded.ok && loaded.changed, error: loaded.ok ? null : loaded.error };
      if (!loaded.ok) {
        const id = store.startCycle(connection.account()?.id ?? null, mode);
        done('failed', `${loaded.error}. The saved categories were left unchanged; fix the file and the next cycle reloads it.`);
        store.finishCycle(id, 'failed', { ...result }, result.error);
        return result;
      }
    }

    const problems = this.readiness(mode);
    const account = connection.account();
    if (problems.length > 0 || !account || !model.provider) {
      const id = store.startCycle(account?.id ?? null, mode);
      done('not_ready', problems.join(' '));
      store.finishCycle(id, 'not_ready', { ...result }, result.error);
      return result;
    }
    if (cancel.aborted) return done('aborted');
    const provider = model.provider;

    try {
      return await withLock(store, `pipeline:${account.id}`, async (lease) => {
        const cycleId = store.startCycle(account.id, mode);
        const signal = AbortSignal.any([cancel, lease.signal]);
        const client = connection.client(account.id, signal);
        const finish = (status: CycleOutcome, error: string | null = null) => {
          done(status, error);
          store.finishCycle(cycleId, status as Exclude<CycleOutcome, 'busy'>, { ...result }, error);
          return result;
        };
        let providerFatal: ProviderError | null = null;
        try {
          result.sync = await syncGmail({ store, account, client, maxMessages: config.syncMaxMessages, lease });
          if (signal.aborted) return finish(lease.signal.aborted ? 'failed' : 'aborted', lease.signal.aborted ? new LeaseLostError().message : null);

          const classifier = new Classifier(store, provider, config.classifyConcurrency);
          const classified = await classifier.classifyPending(account, config.classifyBatchSize, lease, cancel);
          result.classify = classified.stats;
          providerFatal = classified.fatal;
          if (signal.aborted) return finish(lease.signal.aborted ? 'failed' : 'aborted', lease.signal.aborted ? new LeaseLostError().message : null);

          // Results classified earlier are still labeled when the provider fails now.
          result.tag = await this.tagger.run({ account, client, lease, cancel, mode });
          if (cancel.aborted) return finish('aborted');
        } catch (error) {
          if (cancel.aborted && !(error instanceof LeaseLostError)) return finish('aborted');
          return finish('failed', safeMessage(error));
        }
        if (providerFatal) return finish('failed', `Classification stopped: ${describeError(providerFatal)}`);
        const failures = (result.sync?.failed ?? 0) + (result.classify?.failed ?? 0) + (result.tag?.failed ?? 0);
        return finish(failures > 0 ? 'partial' : 'ok');
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'busy') return done('busy', error.message);
      throw error;
    }
  }
}

/** One line for logs and the CLI. Counts only. */
export function formatCycle(result: CycleResult): string {
  const head = `[${result.mode}] ${result.status}`;
  if (result.status === 'not_ready' || result.status === 'busy') return `${head}: ${result.error}`;
  const parts: string[] = [];
  if (result.categories.changed) parts.push(`categories revision ${result.categories.revision} loaded`);
  if (result.sync) parts.push(`synced ${result.sync.added} new of ${result.sync.listed} listed${result.sync.failed ? `, ${result.sync.failed} failed` : ''}`);
  if (result.classify) {
    const c = result.classify;
    parts.push(
      `classified ${c.classified}${c.failed ? `, ${c.failed} failed` : ''}${c.gaveUp ? ` (${c.gaveUp} given up)` : ''}${c.superseded ? `, ${c.superseded} superseded` : ''}${c.remaining ? `, ${c.remaining} pending` : ''}`,
    );
  }
  if (result.tag) {
    const t = result.tag;
    const would = result.mode === 'dry-run' ? 'would ' : '';
    parts.push(
      `${would}label ${t.labeled}, ${would}mark ${t.reviewOnly} Needs Review only${t.labeledForReview ? `, ${would}label ${t.labeledForReview} unscored + Needs Review` : ''}` +
        `${t.unchanged ? `, ${t.unchanged} already labeled` : ''}${t.failed ? `, ${t.failed} failed` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}${t.superseded ? `, ${t.superseded} superseded` : ''}`,
    );
    parts.push(`${t.labelsAdded} label${t.labelsAdded === 1 ? '' : 's'} ${result.mode === 'dry-run' ? 'would be added' : 'added'}, ${t.labelsCreated} ${result.mode === 'dry-run' ? 'would be created' : 'created'}`);
  }
  if (result.mode === 'dry-run' && result.status !== 'failed') parts.push('Gmail was not changed');
  const body = parts.join('; ');
  return result.error ? `${head}: ${result.error}${body ? ` (${body})` : ''}` : `${head}: ${body || 'nothing to do'}`;
}
