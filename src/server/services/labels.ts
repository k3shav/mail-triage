import { FIELD_LABELS, FIELD_NAMES, optionName, type FieldName, type Taxonomy } from '../../core/taxonomy.js';
import type { AppConfig } from '../config.js';
import { randomToken } from '../crypto.js';
import type { Account, LabelApplyRow, Store, StoredMessage } from '../db/store.js';
import { AppError, notFound } from '../errors.js';
import { GmailApiError, type GmailClient } from '../gmail/client.js';
import { canApply, effectiveDecision, type EffectiveDecision } from './decisions.js';
import { capabilities, type GmailConnection } from './gmail-connection.js';

export const PREVIEW_TTL_MS = 10 * 60_000;

export interface PlannedLabel {
  field: FieldName;
  name: string;
}

/** `<prefix>/Category/Receipt`, `<prefix>/Action/Needs Action`, `<prefix>/Priority/High`. */
export function plannedLabels(prefix: string, taxonomy: Taxonomy, decision: EffectiveDecision): PlannedLabel[] {
  return FIELD_NAMES.map((field) => {
    const id = decision[field];
    const name = id ? optionName(taxonomy, field, id) : undefined;
    if (!name) throw new AppError(409, 'decision_incomplete', `The ${field} decision is missing or no longer valid`);
    return { field, name: `${prefix}/${FIELD_LABELS[field]}/${name}` };
  });
}

export interface ExistingNamespacedLabel {
  name: string;
  field: FieldName | null;
  /** True when it is a different value for a field this preview also labels. */
  conflicts: boolean;
}

export interface LabelPreview {
  previewId: string | null;
  expiresAt: number | null;
  simulated: boolean;
  canApply: boolean;
  blockedReason: string | null;
  decision: EffectiveDecision;
  labels: PlannedLabel[];
  toAdd: string[];
  alreadyPresent: string[];
  existingNamespaced: ExistingNamespacedLabel[];
  notes: string[];
}

export interface ApplyResult {
  status: 'applied' | 'noop';
  simulated: boolean;
  replayed: boolean;
  added: string[];
  labels: string[];
}

const ADDITIVE_NOTE =
  'Labels are only added. Mail Triage never removes labels, so earlier Mail Triage labels stay on the message until you remove them in Gmail.';

export class LabelService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly connection: GmailConnection,
    private readonly now: () => number = Date.now,
    private readonly clientFor: (account: Account) => GmailClient = (account) => connection.client(account.id),
  ) {}

  private decisionFor(message: StoredMessage) {
    const { revision, taxonomy } = this.store.currentTaxonomy();
    const classification = this.store.latestClassifications([message.id]).get(message.id);
    const correction = this.store.latestCorrections([message.id]).get(message.id);
    const decision = effectiveDecision({ message, classification, correction, revision, taxonomy, policy: this.store.getReviewPolicy() });
    return { revision, taxonomy, decision };
  }

  /** Current label names on the message. Gmail is asked fresh; demo uses local state. */
  private async currentLabelNames(account: Account, message: StoredMessage, client: GmailClient | null): Promise<string[]> {
    if (!client) return message.labelIds;
    const fresh = await client.getMessageMinimal(message.externalId);
    if (fresh.threadId !== message.threadId) throw new AppError(409, 'message_mismatch', 'Gmail message no longer matches the stored message');
    this.store.updateMessageLabels(account.id, message.externalId, fresh.labelIds);
    const labels = await client.listLabels();
    this.store.replaceLabelCache(account.id, labels);
    const names = new Map(labels.map((label) => [label.id, label.name]));
    return fresh.labelIds.map((id) => names.get(id) ?? id);
  }

  private gmailBlockedReason(account: Account): string | null {
    if (account.kind === 'demo') return null;
    if (this.connection.keyMismatch(account)) return 'The encryption key changed since Gmail was connected. Reconnect Gmail.';
    return capabilities(account, this.config).applyBlockedReason;
  }

  async preview(account: Account, messageId: number): Promise<LabelPreview> {
    const message = this.store.getMessage(account.id, messageId);
    if (!message) throw notFound('Message');
    const { revision, taxonomy, decision } = this.decisionFor(message);
    const simulated = account.kind === 'demo';
    const notes = [ADDITIVE_NOTE];
    if (simulated) notes.push('Demo inbox: applying records the labels locally. Nothing is sent to Gmail.');

    const base = { simulated, decision, notes, toAdd: [], alreadyPresent: [], existingNamespaced: [], labels: [] };
    if (!canApply(decision)) {
      const reason =
        decision.state === 'needs_review'
          ? 'Review this classification first: accept it or correct it.'
          : decision.state === 'stale'
            ? 'Categories or reader context changed since this was classified. Reclassify or confirm it again.'
            : 'Classify this message first.';
      return { ...base, previewId: null, expiresAt: null, canApply: false, blockedReason: reason };
    }

    const labels = plannedLabels(this.config.labelPrefix, taxonomy, decision);
    const blockedReason = this.gmailBlockedReason(account);
    const client = simulated ? null : this.clientFor(account);
    let existing: string[] = message.labelIds;
    if (client && capabilities(account, this.config).canRead) existing = await this.currentLabelNames(account, message, client);

    const targetNames = labels.map((label) => label.name);
    const existingSet = new Set(existing);
    const prefix = `${this.config.labelPrefix}/`;
    const existingNamespaced = existing
      .filter((name) => name.startsWith(prefix) && !targetNames.includes(name))
      .map((name): ExistingNamespacedLabel => {
        const segment = name.slice(prefix.length).split('/')[0];
        const field = FIELD_NAMES.find((f) => FIELD_LABELS[f] === segment) ?? null;
        return { name, field, conflicts: field !== null };
      });
    if (existingNamespaced.some((label) => label.conflicts)) {
      notes.push('This message already has other Mail Triage labels for the same fields. They will remain alongside the new ones.');
    }

    let previewId: string | null = null;
    let expiresAt: number | null = null;
    if (!blockedReason) {
      previewId = `pv_${randomToken(18)}`;
      const createdAt = this.now();
      expiresAt = createdAt + PREVIEW_TTL_MS;
      this.store.insertPreview({
        id: previewId,
        accountId: account.id,
        messageId: message.id,
        externalId: message.externalId,
        taxonomyRevision: revision,
        decisionSeq: decision.decisionSeq,
        decisionSource: decision.source!,
        decisionRef: decision.sourceId!,
        provider: decision.provider!,
        model: decision.model!,
        labels: targetNames,
        createdAt,
        expiresAt,
      });
    }
    return {
      ...base,
      previewId,
      expiresAt,
      canApply: blockedReason === null,
      blockedReason,
      labels,
      toAdd: targetNames.filter((name) => !existingSet.has(name)),
      alreadyPresent: targetNames.filter((name) => existingSet.has(name)),
      existingNamespaced,
    };
  }

  private replay(row: LabelApplyRow, simulated: boolean, labels: string[]): ApplyResult {
    if (row.status === 'applied' || row.status === 'noop') {
      return { status: row.status, simulated, replayed: true, added: row.addedLabels, labels };
    }
    if (row.status === 'pending') throw new AppError(409, 'apply_in_progress', 'This preview is already being applied');
    throw new AppError(409, 'preview_used', 'This preview was already used and failed. Create a new preview.');
  }

  /**
   * Apply one previewed set of labels to one message. Every binding recorded
   * in the preview is re-checked; any change rejects the apply.
   */
  async apply(account: Account, previewId: string): Promise<ApplyResult> {
    const preview = this.store.getPreview(previewId);
    if (!preview) throw notFound('Preview');
    if (preview.accountId !== account.id) throw new AppError(409, 'account_mismatch', 'This preview belongs to a different mailbox');
    const simulated = account.kind === 'demo';

    const prior = this.store.getApply(previewId);
    if (prior) return this.replay(prior, simulated, preview.labels);
    if (preview.consumedAt !== null) throw new AppError(409, 'preview_used', 'This preview was already used');
    if (preview.expiresAt < this.now()) throw new AppError(410, 'preview_expired', 'This preview expired. Create a new preview.');

    const message = this.store.getMessage(account.id, preview.messageId);
    if (!message || message.externalId !== preview.externalId) {
      throw new AppError(409, 'message_mismatch', 'The message for this preview no longer matches');
    }
    const { revision, taxonomy, decision } = this.decisionFor(message);
    if (revision !== preview.taxonomyRevision) {
      throw new AppError(409, 'stale_config', 'Categories or reader context changed after this preview. Create a new preview.');
    }
    if (message.decisionSeq !== preview.decisionSeq || decision.sourceId !== preview.decisionRef || decision.source !== preview.decisionSource) {
      throw new AppError(409, 'stale_decision', 'The classification or correction changed after this preview. Create a new preview.');
    }
    if (decision.provider !== preview.provider || decision.model !== preview.model) {
      throw new AppError(409, 'stale_decision', 'The provider or model changed after this preview. Create a new preview.');
    }
    if (!canApply(decision)) throw new AppError(409, 'needs_review', 'This message needs review before labels can be applied');
    const targetNames = plannedLabels(this.config.labelPrefix, taxonomy, decision).map((label) => label.name);
    if (JSON.stringify(targetNames) !== JSON.stringify(preview.labels)) {
      throw new AppError(409, 'stale_decision', 'The planned labels changed after this preview. Create a new preview.');
    }
    const blockedReason = this.gmailBlockedReason(account);
    if (blockedReason) throw new AppError(403, 'apply_not_permitted', blockedReason);

    if (!this.store.claimPreview(previewId)) {
      const raced = this.store.getApply(previewId);
      if (raced) return this.replay(raced, simulated, preview.labels);
      throw new AppError(410, 'preview_expired', 'This preview expired. Create a new preview.');
    }

    try {
      const result = simulated ? this.applyDemo(account, message, targetNames) : await this.applyGmail(account, message, targetNames);
      this.store.finishApply(previewId, result.status, result.added, null);
      return { ...result, simulated, replayed: false, labels: targetNames };
    } catch (error) {
      const safe = error instanceof AppError || error instanceof GmailApiError ? error.message : 'Applying labels failed';
      this.store.finishApply(previewId, 'failed', [], safe);
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'apply_failed', safe);
    }
  }

  private applyDemo(account: Account, message: StoredMessage, names: string[]): { status: 'applied' | 'noop'; added: string[] } {
    const added = names.filter((name) => !message.labelIds.includes(name));
    if (added.length === 0) return { status: 'noop', added };
    this.store.updateMessageLabels(account.id, message.externalId, [...message.labelIds, ...added]);
    return { status: 'applied', added };
  }

  private async applyGmail(account: Account, message: StoredMessage, names: string[]): Promise<{ status: 'applied' | 'noop'; added: string[] }> {
    const client = this.clientFor(account);
    const fresh = await client.getMessageMinimal(message.externalId);
    if (fresh.threadId !== message.threadId) throw new AppError(409, 'message_mismatch', 'Gmail message no longer matches the stored message');

    const labelIds = await this.ensureLabels(account, client, names);
    const missing = names.filter((name) => !fresh.labelIds.includes(labelIds.get(name)!));
    if (missing.length === 0) {
      this.store.updateMessageLabels(account.id, message.externalId, fresh.labelIds);
      return { status: 'noop', added: [] };
    }
    const updated = await client.addLabels(
      message.externalId,
      missing.map((name) => labelIds.get(name)!),
    );
    const notApplied = missing.filter((name) => !updated.labelIds.includes(labelIds.get(name)!));
    if (notApplied.length > 0) throw new AppError(502, 'apply_unverified', 'Gmail did not confirm every label');
    this.store.updateMessageLabels(account.id, message.externalId, updated.labelIds);
    return { status: 'applied', added: missing };
  }

  /** Find or create each namespaced label by exact name. */
  private async ensureLabels(account: Account, client: GmailClient, names: string[]): Promise<Map<string, string>> {
    let labels = await client.listLabels();
    const byName = () => new Map(labels.map((label) => [label.name, label.id]));
    let map = byName();
    for (const name of names) {
      if (map.has(name)) continue;
      try {
        const created = await client.createLabel(name);
        labels = [...labels, created];
      } catch (error) {
        // 409: created concurrently (or by an earlier partial run); re-read.
        if (!(error instanceof GmailApiError && error.status === 409)) throw error;
        labels = await client.listLabels();
      }
      map = byName();
      if (!map.has(name)) throw new AppError(502, 'label_create_failed', 'Gmail did not create a required label');
    }
    this.store.replaceLabelCache(account.id, labels);
    return map;
  }
}
