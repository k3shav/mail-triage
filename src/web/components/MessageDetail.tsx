import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import {
  ACTIONS,
  PRIORITIES,
  PROVIDER_LABELS,
  STATE_HINTS,
  actionName,
  categoryName,
  initials,
  longDate,
  parseAddress,
  percent,
  priorityName,
  categoryTone,
  toneOf,
} from '../format';
import type { ApplyResult, DetailOrigin, ClassificationRecord, FieldDecision, FieldName, LabelPreview, MailboxName, MessageDetail, Status, Taxonomy } from '../types';
import type { Toast } from './Toasts';
import { IconAlert, IconBack, IconCheck, IconEdit, IconInfo, IconSparkle, IconTag } from './Icons';
import { StateBadge } from './MessageList';

interface Props {
  mailbox: MailboxName;
  /** Identity of `detail`; mutation results are reported against it. */
  origin: DetailOrigin | null;
  detail: MessageDetail | null;
  selectedId: number | null;
  taxonomy: Taxonomy | null;
  status: Status | null;
  notify: (kind: Toast['kind'], text: string) => void;
  onError: (error: unknown) => void;
  /** The parent applies `detail` only if `origin` is still the selected message. */
  onChanged: (origin?: DetailOrigin, detail?: MessageDetail) => Promise<void>;
  onBack: () => void;
}

const FIELDS: FieldName[] = ['category', 'action', 'priority'];
const FIELD_TITLES: Record<FieldName, string> = { category: 'Category', action: 'Action', priority: 'Priority' };

function valueName(taxonomy: Taxonomy | null, field: FieldName, id: string | null) {
  return field === 'category' ? categoryName(taxonomy, id) : field === 'action' ? actionName(id) : priorityName(id);
}

function Meter({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="meter-row" title={hint}>
      <span className="meter-label">{label}</span>
      <meter min={0} max={1} low={0.5} high={0.8} optimum={1} value={value} />
      <span className="meter-value">{percent(value)}</span>
    </div>
  );
}

function FieldCard({ field, result, taxonomy, humanValue }: { field: FieldName; result: FieldDecision | null; taxonomy: Taxonomy | null; humanValue: string | null }) {
  if (humanValue !== null) {
    return (
      <div className="field-card">
        <span className="field-title">{FIELD_TITLES[field]}</span>
        <span className={`field-value ${field === 'category' ? `tone-text-${categoryTone(taxonomy, humanValue)}` : ''}`}>{valueName(taxonomy, field, humanValue)}</span>
        <span className="field-note">Set by you</span>
      </div>
    );
  }
  if (!result) return null;
  if (result.status === 'refused') {
    return (
      <div className="field-card field-problem">
        <span className="field-title">{FIELD_TITLES[field]}</span>
        <span className="field-value">Declined</span>
        <span className="field-note">The provider refused to answer.</span>
      </div>
    );
  }
  if (result.status === 'invalid') {
    return (
      <div className="field-card field-problem">
        <span className="field-title">{FIELD_TITLES[field]}</span>
        <span className="field-value">Unusable</span>
        <span className="field-note">{result.reason}</span>
      </div>
    );
  }
  return (
    <div className="field-card">
      <span className="field-title">{FIELD_TITLES[field]}</span>
      <span className={`field-value ${field === 'category' ? `tone-text-${categoryTone(taxonomy, result.value)}` : ''}`}>{valueName(taxonomy, field, result.value)}</span>
      {result.confidence !== null ? (
        <Meter label="Confidence" value={result.confidence} hint="The provider's own certainty statistic for this answer" />
      ) : (
        <span className="field-note">No confidence reported</span>
      )}
      {result.selectedProbability !== null ? (
        <Meter label="Probability" value={result.selectedProbability} hint="Probability the provider assigned to this option" />
      ) : null}
    </div>
  );
}

function CorrectionForm({
  taxonomy,
  initial,
  onCancel,
  onSave,
  saving,
}: {
  taxonomy: Taxonomy | null;
  initial: Record<FieldName, string>;
  onCancel: () => void;
  onSave: (values: Record<FieldName, string>) => void;
  saving: boolean;
}) {
  const [values, setValues] = useState(initial);
  const options: Record<FieldName, Array<{ id: string; name: string }>> = {
    category: taxonomy?.categories ?? [],
    action: [...ACTIONS],
    priority: [...PRIORITIES],
  };
  return (
    <form
      className="correction-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(values);
      }}
    >
      {FIELDS.map((field) => (
        <label key={field} className="field">
          <span>{FIELD_TITLES[field]}</span>
          <select value={values[field]} onChange={(event) => setValues({ ...values, [field]: event.target.value })} required>
            <option value="" disabled>
              Choose…
            </option>
            {options[field].map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || FIELDS.some((f) => !values[f])}>
          <IconCheck /> Save correction
        </button>
      </div>
    </form>
  );
}

/** A preview belongs to one message and one decision; it is never shown or applied for anything else. */
interface PreviewOrigin extends DetailOrigin {
  decisionSeq: number;
  taxonomyRevision: number;
}

function sameOrigin(a: PreviewOrigin, b: PreviewOrigin) {
  return (
    a.mailbox === b.mailbox &&
    a.id === b.id &&
    a.generation === b.generation &&
    a.selection === b.selection &&
    a.decisionSeq === b.decisionSeq &&
    a.taxonomyRevision === b.taxonomyRevision
  );
}

function LabelPanel({
  mailbox,
  origin: detailOrigin,
  detail,
  notify,
  onError,
  onChanged,
}: Pick<Props, 'mailbox' | 'notify' | 'onError' | 'onChanged'> & { origin: DetailOrigin; detail: MessageDetail }) {
  const origin: PreviewOrigin = {
    ...detailOrigin,
    decisionSeq: detail.decision.decisionSeq,
    taxonomyRevision: detail.decision.taxonomyRevision,
  };
  const [stored, setStored] = useState<{ origin: PreviewOrigin; preview: LabelPreview } | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [pending, setPending] = useState<'preview' | 'apply' | null>(null);
  // Bumped on every request and on unmount; only the latest request may write state.
  const requestId = useRef(0);
  useEffect(() => () => void (requestId.current += 1), []);

  const preview = stored && sameOrigin(stored.origin, origin) && stored.origin.id === detail.id ? stored.preview : null;

  const loadPreview = async () => {
    const id = ++requestId.current;
    const requested = origin;
    setPending('preview');
    setResult(null);
    setStored(null);
    try {
      const next = await api.preview(requested.mailbox, requested.id);
      if (id === requestId.current) setStored({ origin: requested, preview: next });
    } catch (error) {
      if (id === requestId.current) onError(error);
    } finally {
      if (id === requestId.current) setPending(null);
    }
  };

  const apply = async () => {
    // Re-check identity at click time: the preview must belong to the message on screen.
    if (!stored || !preview?.previewId || !sameOrigin(stored.origin, origin)) return;
    const id = ++requestId.current;
    const target = stored.origin;
    setPending('apply');
    try {
      const applied = await api.apply(target.mailbox, preview.previewId);
      notify('success', applied.status === 'noop' ? 'Those labels were already on the message.' : `Added ${applied.added.length} label${applied.added.length === 1 ? '' : 's'}${applied.simulated ? ' (simulated)' : ''}.`);
      if (id === requestId.current) {
        setResult(applied);
        setStored(null);
      }
      await onChanged(target, await api.message(target.mailbox, target.id));
    } catch (error) {
      onError(error);
      if (id === requestId.current) setStored(null);
    } finally {
      if (id === requestId.current) setPending(null);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <IconTag /> Labels {mailbox === 'demo' ? <span className="tag-sim">simulated</span> : null}
        </h3>
        <button className="btn btn-small" onClick={loadPreview} disabled={pending !== null}>
          {pending === 'preview' ? 'Checking…' : preview ? 'Refresh preview' : 'Preview labels'}
        </button>
      </div>
      {!preview && !result ? (
        <p className="muted small">
          Preview shows exactly which labels would be added to this one message. Nothing changes until you apply. Labels are only added, never
          removed.
        </p>
      ) : null}
      {result ? (
        <div className="apply-result">
          <IconCheck />
          <span>
            {result.status === 'noop' ? 'No change needed; all labels were present.' : `Added: ${result.added.join(', ')}`}
            {result.replayed ? ' (already applied earlier)' : ''}
          </span>
        </div>
      ) : null}
      {preview && !result ? (
        <div className="preview">
          {preview.labels.length > 0 ? (
            <ul className="label-plan">
              {preview.labels.map((label) => (
                <li key={label.name} className={preview.toAdd.includes(label.name) ? 'add' : 'present'}>
                  <span className="plan-mark">{preview.toAdd.includes(label.name) ? '+' : '✓'}</span>
                  <code>{label.name}</code>
                  <span className="muted small">{preview.toAdd.includes(label.name) ? 'will be added' : 'already on message'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {preview.existingNamespaced.length > 0 ? (
            <div className="notice notice-warn">
              <IconAlert />
              <div>
                <strong>Existing Mail Triage labels stay on this message:</strong>
                <ul>
                  {preview.existingNamespaced.map((label) => (
                    <li key={label.name}>
                      <code>{label.name}</code>
                      {label.conflicts ? ' — differs from this decision' : ''}
                    </li>
                  ))}
                </ul>
                <span className="small">Remove them in Gmail if they are out of date; Mail Triage never removes labels.</span>
              </div>
            </div>
          ) : null}
          {preview.notes.map((note) => (
            <p key={note} className="muted small">
              {note}
            </p>
          ))}
          {preview.blockedReason ? (
            <div className="notice notice-info">
              <IconInfo />
              <span>{preview.blockedReason}</span>
            </div>
          ) : null}
          {preview.canApply && preview.previewId ? (
            <button className="btn btn-primary" onClick={apply} disabled={pending !== null}>
              <IconTag />
              {pending === 'apply'
                ? 'Applying…'
                : preview.toAdd.length === 0
                  ? 'Confirm (no change)'
                  : `Add ${preview.toAdd.length} label${preview.toAdd.length === 1 ? '' : 's'} to this message`}
            </button>
          ) : null}
          {preview.expiresAt ? <p className="muted tiny">Preview valid until {new Date(preview.expiresAt).toLocaleTimeString()}.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function History({ detail, taxonomy }: { detail: MessageDetail; taxonomy: Taxonomy | null }) {
  const entries = [
    ...detail.history.classifications.map((c) => ({
      seq: c.seq,
      at: c.createdAt,
      text: `${PROVIDER_LABELS[c.provider] ?? c.provider} (${c.model}), configuration r${c.taxonomyRevision}: ${FIELDS.map((f) => {
        const r = c.fields[f];
        return r.status === 'answered' ? valueName(taxonomy, f, r.value) : r.status;
      }).join(' · ')}`,
    })),
    ...detail.history.corrections.map((k) => ({
      seq: k.seq,
      at: k.createdAt,
      text: `${k.kind === 'accept' ? 'You accepted' : 'You corrected'} (r${k.taxonomyRevision}): ${categoryName(taxonomy, k.category)} · ${actionName(k.action)} · ${priorityName(k.priority)}`,
    })),
  ].sort((a, b) => b.seq - a.seq);
  if (entries.length === 0 && detail.history.applies.length === 0) return null;
  return (
    <details className="card history">
      <summary>History</summary>
      <ol>
        {entries.map((entry) => (
          <li key={`d${entry.seq}`}>
            <time>{longDate(entry.at)}</time> {entry.text}
          </li>
        ))}
        {detail.history.applies.map((apply) => (
          <li key={`a${apply.createdAt}${apply.status}`}>
            <time>{longDate(apply.createdAt)}</time> Labels {apply.status}
            {apply.addedLabels.length ? `: ${apply.addedLabels.join(', ')}` : ''}
            {apply.error ? ` — ${apply.error}` : ''}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function MessageDetailView(props: Props) {
  const { mailbox, origin, detail, selectedId, taxonomy, status } = props;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<'correct' | 'reclassify' | null>(null);

  useEffect(() => setEditing(false), [detail?.id]);

  if (selectedId === null) {
    return (
      <section className="detail-pane detail-empty">
        <div>
          <IconSparkle />
          <p>Select a message to review its classification.</p>
        </div>
      </section>
    );
  }
  if (!detail || !origin || detail.id !== selectedId) {
    return (
      <section className="detail-pane detail-empty">
        <span className="spinner" aria-label="Loading" />
      </section>
    );
  }

  const decision = detail.decision;
  const latest: ClassificationRecord | undefined = detail.history.classifications[0];
  const modelFields = decision.source === 'model' && latest ? latest.fields : null;
  const sender = parseAddress(detail.from);
  const modelReady = mailbox === 'demo' || Boolean(status?.model.configured);
  const allAnswered = modelFields ? FIELDS.every((f) => modelFields[f].status === 'answered') : false;

  // Corrections echo the revision and decision sequence the reviewer saw, so
  // a decision that changed in the meantime is never silently overwritten.
  const reviewed = { expectedTaxonomyRevision: decision.taxonomyRevision, expectedDecisionSeq: decision.decisionSeq };
  const modelSourceId = decision.source === 'model' ? decision.sourceId : null;

  const saveCorrection = async (kind: 'accept' | 'edit', values: Record<FieldName, string>) => {
    setSaving('correct');
    try {
      const next =
        kind === 'accept' && modelSourceId !== null
          ? await api.correct(origin.mailbox, origin.id, { kind: 'accept', ...reviewed, basedOnClassificationId: modelSourceId })
          : await api.correct(origin.mailbox, origin.id, { kind: 'edit', ...reviewed, ...values, basedOnClassificationId: modelSourceId });
      setEditing(false);
      props.notify('success', kind === 'accept' ? 'Classification accepted.' : 'Correction saved.');
      await props.onChanged(origin, next);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'stale_decision' || error.code === 'stale_revision')) {
        props.notify('error', `${error.message} Showing the latest decision; review it again.`);
        setEditing(false);
        await props.onChanged(origin, await api.message(origin.mailbox, origin.id));
      } else props.onError(error);
    } finally {
      setSaving(null);
    }
  };

  const reclassify = async () => {
    setSaving('reclassify');
    try {
      const { outcome, ...next } = await api.reclassify(origin.mailbox, origin.id);
      if (outcome === 'superseded') props.notify('info', 'The decision changed while the model was working, so its answer was discarded.');
      else props.notify('success', origin.mailbox === 'demo' ? 'Fixture labels applied.' : 'Message reclassified.');
      await props.onChanged(origin, next);
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(null);
    }
  };

  const initial: Record<FieldName, string> = {
    category: decision.category ?? '',
    action: decision.action ?? '',
    priority: decision.priority ?? '',
  };

  return (
    <section className="detail-pane" aria-label="Message">
      <div className="detail-scroll">
        <button className="btn btn-ghost back-btn" onClick={props.onBack}>
          <IconBack /> Back
        </button>
        <header className="detail-header">
          <h2>{detail.subject}</h2>
          <div className="sender">
            <span className={`avatar avatar-lg tone-${toneOf(sender.address)}`} aria-hidden="true">
              {initials(sender.name)}
            </span>
            <div className="sender-text">
              <span className="sender-name">{sender.name}</span>
              <span className="muted small truncate">{sender.address}</span>
              <span className="muted small truncate">To: {detail.to || '—'}{detail.cc ? ` · Cc: ${detail.cc}` : ''}</span>
            </div>
            <time className="muted small">{longDate(detail.sentAt)}</time>
          </div>
          <div className="label-strip">
            {detail.unread ? <span className="chip chip-outline">Unread</span> : null}
            {detail.labels
              .filter((label) => !['INBOX', 'UNREAD'].includes(label) && !/^CATEGORY_/.test(label))
              .map((label) => (
                <span key={label} className={`chip chip-outline ${status && label.startsWith(`${status.labelPrefix}/`) ? 'chip-ns' : ''}`}>
                  {label}
                </span>
              ))}
            {detail.signals.hasListUnsubscribe ? <span className="chip chip-outline" title="The message has a List-Unsubscribe header">Bulk sender</span> : null}
          </div>
        </header>

        <section className="card decision-card">
          <div className="card-head">
            <h3>Classification</h3>
            <StateBadge state={decision.state} />
          </div>
          <p className="muted small">
            {STATE_HINTS[decision.state]}
            {decision.source ? ` Source: ${PROVIDER_LABELS[decision.provider ?? ''] ?? decision.provider}${decision.source === 'model' && decision.model ? ` (${decision.model})` : ''}.` : ''}
          </p>

          {detail.lastError && (decision.state === 'error' || decision.state === 'unclassified' || decision.state === 'stale') ? (
            <div className="notice notice-error">
              <IconAlert />
              <span>Last attempt failed: {detail.lastError}</span>
            </div>
          ) : null}

          {decision.source ? (
            <div className="field-grid">
              {FIELDS.map((field) => (
                <FieldCard
                  key={field}
                  field={field}
                  taxonomy={taxonomy}
                  result={modelFields ? modelFields[field] : null}
                  humanValue={decision.source === 'human' ? decision[field] : null}
                />
              ))}
            </div>
          ) : null}

          {decision.reviewReasons.length > 0 ? (
            <ul className="review-reasons">
              {decision.reviewReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}

          {editing ? (
            <CorrectionForm
              taxonomy={taxonomy}
              initial={initial}
              saving={saving !== null}
              onCancel={() => setEditing(false)}
              onSave={(values) => void saveCorrection('edit', values)}
            />
          ) : (
            <div className="decision-actions">
              {modelSourceId !== null && decision.state === 'needs_review' && allAnswered ? (
                <button className="btn btn-primary" disabled={saving !== null} onClick={() => void saveCorrection('accept', initial)}>
                  <IconCheck /> Accept
                </button>
              ) : null}
              <button className="btn" disabled={saving !== null || !taxonomy} onClick={() => setEditing(true)}>
                <IconEdit /> {decision.source ? 'Correct' : 'Set manually'}
              </button>
              <button
                className="btn btn-ghost"
                disabled={saving !== null || !modelReady}
                title={modelReady ? undefined : 'No model provider is configured on the server'}
                onClick={() => void reclassify()}
              >
                <IconSparkle /> {saving === 'reclassify' ? 'Working…' : decision.source || decision.state === 'stale' ? 'Reclassify' : 'Classify'}
              </button>
            </div>
          )}
        </section>

        <LabelPanel
          key={`${origin.generation}:${origin.selection}:${origin.mailbox}:${origin.id}:${decision.taxonomyRevision}:${decision.decisionSeq}`}
          mailbox={mailbox}
          origin={origin}
          detail={detail}
          notify={props.notify} onError={props.onError} onChanged={props.onChanged} />

        <section className="card body-card">
          <div className="card-head">
            <h3>Message</h3>
            <span className="muted tiny">
              {detail.body.source === 'html' ? 'Converted from HTML to plain text; images and links are not loaded.' : detail.body.source === 'none' ? 'No text body' : 'Plain text'}
              {detail.body.truncated ? ' · truncated' : ''}
            </span>
          </div>
          <pre className="body-text">{detail.body.text || detail.snippet || '(empty)'}</pre>
        </section>

        <History detail={detail} taxonomy={taxonomy} />
      </div>
    </section>
  );
}
