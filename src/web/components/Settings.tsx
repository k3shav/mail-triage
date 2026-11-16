import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { PROVIDER_LABELS, SCOPE_LABELS, relativeTime } from '../format';
import type { Category, ReviewPolicy, Run, Status, Taxonomy, TaxonomyRevision } from '../types';
import { ConnectGmailButton } from './Banners';
import { IconAlert, IconClose, IconDown, IconInfo, IconPlus, IconTrash, IconUp } from './Icons';
import type { Toast } from './Toasts';

interface Props {
  status: Status;
  taxonomy: TaxonomyRevision;
  notify: (kind: Toast['kind'], text: string) => void;
  onError: (error: unknown) => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

type Tab = 'categories' | 'review' | 'connections' | 'privacy';

const MAX_CATEGORIES = 25;

function slugify(name: string, taken: Set<string>): string {
  let base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  if (!base || !/^[a-z]/.test(base)) base = `c_${base}`.replace(/_+$/, '').slice(0, 24) || 'category';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

interface DraftCategory extends Category {
  /** True until saved; only new categories get an id derived from their name. */
  isNew: boolean;
  key: string;
}

function validate(draft: DraftCategory[], context: string): string[] {
  const problems: string[] = [];
  if (draft.length < 2) problems.push('Keep at least two categories.');
  if (draft.length > MAX_CATEGORIES) problems.push(`Use at most ${MAX_CATEGORIES} categories.`);
  const names = new Set<string>();
  draft.forEach((category, index) => {
    const label = category.name.trim() || `Category ${index + 1}`;
    if (!category.name.trim()) problems.push(`Category ${index + 1} needs a name.`);
    if (/[/\\]/.test(category.name)) problems.push(`${label}: names cannot contain slashes (they become Gmail label paths).`);
    if (category.name.trim().length > 40) problems.push(`${label}: names must be 40 characters or fewer.`);
    if (!category.description.trim()) problems.push(`${label}: add a plain-English description.`);
    if (category.description.length > 500) problems.push(`${label}: descriptions must be 500 characters or fewer.`);
    const folded = category.name.trim().toLowerCase();
    if (folded && names.has(folded)) problems.push(`"${label}" is used twice.`);
    names.add(folded);
  });
  if (context.length > 2000) problems.push('Reader context must be 2000 characters or fewer.');
  return problems;
}

function CategoryEditor({ taxonomy, notify, onError, onChanged }: Pick<Props, 'taxonomy' | 'notify' | 'onError' | 'onChanged'>) {
  const toDraft = (t: Taxonomy): DraftCategory[] => t.categories.map((c) => ({ ...c, isNew: false, key: c.id }));
  // The revision the draft was started from. Saves send it as expectedRevision.
  const [base, setBase] = useState<TaxonomyRevision>(taxonomy);
  const [draft, setDraft] = useState<DraftCategory[]>(() => toDraft(taxonomy.taxonomy));
  const [context, setContext] = useState(taxonomy.taxonomy.userContext);
  const [saving, setSaving] = useState(false);
  // A newer server revision that arrived while the draft had unsaved edits.
  const [conflict, setConflict] = useState<TaxonomyRevision | null>(null);

  const dirty =
    context !== base.taxonomy.userContext ||
    JSON.stringify(draft.map(({ id, name, description }) => ({ id, name, description }))) !== JSON.stringify(base.taxonomy.categories);

  const reset = (next: TaxonomyRevision) => {
    setBase(next);
    setDraft(toDraft(next.taxonomy));
    setContext(next.taxonomy.userContext);
    setConflict(null);
  };

  // Status refreshes hand us a fresh object even when nothing changed. Only a
  // different revision matters, and it never silently replaces unsaved edits.
  useEffect(() => {
    if (taxonomy.revision === base.revision) return;
    if (dirty) setConflict(taxonomy);
    else reset(taxonomy);
  }, [taxonomy.revision]);

  const problems = useMemo(() => validate(draft, context), [draft, context]);

  const update = (key: string, patch: Partial<DraftCategory>) => setDraft(draft.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const move = (index: number, delta: number) => {
    const next = [...draft];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    setDraft(next);
  };

  const save = async () => {
    setSaving(true);
    const taken = new Set(draft.filter((c) => !c.isNew).map((c) => c.id));
    const categories = draft.map((c) => {
      if (!c.isNew) return { id: c.id, name: c.name.trim(), description: c.description.trim() };
      const id = slugify(c.name, taken);
      taken.add(id);
      return { id, name: c.name.trim(), description: c.description.trim() };
    });
    try {
      const saved = await api.saveTaxonomy(base.revision, { categories, userContext: context.trim() });
      reset(saved);
      notify(
        saved.changed ? 'success' : 'info',
        saved.changed ? `Saved as configuration revision ${saved.revision}. Earlier decisions are now stale; reclassify or confirm them.` : 'No changes to save.',
      );
      await onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_revision') {
        try {
          setConflict(await api.taxonomy());
        } catch (loadError) {
          onError(loadError);
        }
      } else onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h2>Categories</h2>
        <p className="muted">
          Each category&apos;s name and plain-English description are sent to the model. Action (Needs Response, Needs Action, No Action) and
          priority (Low, Normal, High) are asked separately and are not editable here.
        </p>
      </div>

      {conflict ? (
        <div className="notice notice-warn" role="alert">
          <IconAlert />
          <div>
            <strong>Categories were changed elsewhere (now revision {conflict.revision}).</strong>
            <span className="small"> Your unsaved edits are based on revision {base.revision}.</span>
            <div className="form-actions">
              <button className="btn btn-small" onClick={() => reset(conflict)}>
                Discard my edits and load revision {conflict.revision}
              </button>
              <button
                className="btn btn-small"
                onClick={() => {
                  setBase(conflict);
                  setConflict(null);
                }}
              >
                Keep my edits and save over it
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <label className="field">
        <span>About you (reader context)</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={context}
          placeholder="e.g. I lead the platform team at Northwind. Mail from my manager Dana is usually important."
          onChange={(event) => setContext(event.target.value)}
        />
        <span className="hint">Sent with every classification to help judge action and priority. {context.length}/2000</span>
      </label>

      <ol className="category-list">
        {draft.map((category, index) => (
          <li key={category.key} className="category-item">
            <span className={`swatch swatch-lg tone-${index % 8}`} />
            <div className="category-fields">
              <input
                className="category-name"
                value={category.name}
                maxLength={40}
                aria-label="Category name"
                placeholder="Name"
                onChange={(event) => update(category.key, { name: event.target.value })}
              />
              <textarea
                rows={2}
                maxLength={500}
                value={category.description}
                aria-label="Category description"
                placeholder="When does this category apply?"
                onChange={(event) => update(category.key, { description: event.target.value })}
              />
              {!category.isNew ? <span className="hint">id: {category.id} (stays the same when renamed)</span> : <span className="hint">new</span>}
            </div>
            <div className="category-tools">
              <button className="icon-btn" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                <IconUp />
              </button>
              <button className="icon-btn" disabled={index === draft.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                <IconDown />
              </button>
              <button className="icon-btn danger" disabled={draft.length <= 2} onClick={() => setDraft(draft.filter((c) => c.key !== category.key))} aria-label={`Remove ${category.name}`}>
                <IconTrash />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <button
        className="btn"
        disabled={draft.length >= MAX_CATEGORIES}
        onClick={() => setDraft([...draft, { id: '', key: `new-${Date.now()}-${draft.length}`, name: '', description: '', isNew: true }])}
      >
        <IconPlus /> Add category
      </button>

      {problems.length > 0 && dirty ? (
        <ul className="form-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      <div className="sticky-actions">
        <span className="muted small">
          Revision {base.revision}. Saving creates a new revision; existing decisions stop being applicable until reclassified or confirmed.
        </span>
        <button className="btn btn-ghost" disabled={!dirty || saving} onClick={() => reset(conflict ?? taxonomy)}>
          Discard
        </button>
        <button className="btn btn-primary" disabled={!dirty || problems.length > 0 || saving || conflict !== null} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save categories'}
        </button>
      </div>
    </div>
  );
}

function ReviewSettings({ notify, onError, onChanged }: Pick<Props, 'notify' | 'onError' | 'onChanged'>) {
  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [saved, setSaved] = useState<ReviewPolicy | null>(null);

  useEffect(() => {
    api.reviewPolicy().then((p) => {
      setPolicy(p);
      setSaved(p);
    }, onError);
  }, [onError]);

  if (!policy) return <div className="settings-section"><span className="spinner" /></div>;
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h2>Review policy</h2>
        <p className="muted">
          Refused and invalid answers always need review. These settings decide when a valid answer also needs you. Changing them does not
          invalidate decisions; it changes which ones wait for review.
        </p>
      </div>
      <label className="field">
        <span>Confidence threshold: {Math.round(policy.confidenceThreshold * 100)}%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={policy.confidenceThreshold}
          onChange={(event) => setPolicy({ ...policy, confidenceThreshold: Number(event.target.value) })}
        />
        <span className="hint">
          Applies to providers that report confidence (Jev, OpenAI Decisions). Choose it from labeled examples of your own mail; the default is
          not calibrated for you.
        </span>
      </label>
      <label className="toggle-row toggle-large">
        <input type="checkbox" checked={policy.reviewWhenNoConfidence} onChange={(event) => setPolicy({ ...policy, reviewWhenNoConfidence: event.target.checked })} />
        <span>
          Require review when no confidence is reported
          <span className="hint">Language models via the OpenAI-compatible adapter, and demo fixtures, report none.</span>
        </span>
      </label>
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={!dirty}
          onClick={async () => {
            try {
              const next = await api.saveReviewPolicy(policy);
              setSaved(next);
              notify('success', 'Review policy saved.');
              await onChanged();
            } catch (error) {
              onError(error);
            }
          }}
        >
          Save review policy
        </button>
      </div>
    </div>
  );
}

function RunLine({ label, run }: { label: string; run: Run | null }) {
  if (!run) return <li>{label}: never</li>;
  return (
    <li>
      {label}: {run.status} {relativeTime(run.startedAt)}
      {run.error ? <span className="error-text"> — {run.error}</span> : null}
    </li>
  );
}

function Connections({ status, notify, onError, onChanged }: Pick<Props, 'status' | 'notify' | 'onError' | 'onChanged'>) {
  const [confirming, setConfirming] = useState(false);
  const account = status.gmail.account;
  const model = status.model;

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h2>Connections</h2>
        <p className="muted">Credentials live in server environment variables. Nothing secret is stored in the browser.</p>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Model</h3>
          <span className={`pill ${model.configured ? 'pill-ok' : 'pill-muted'}`}>{model.configured ? 'Configured' : 'Not configured'}</span>
        </div>
        {model.configured ? (
          <dl className="kv">
            <dt>Provider</dt>
            <dd>{PROVIDER_LABELS[model.info.provider]}</dd>
            <dt>Model</dt>
            <dd><code>{model.info.model}</code></dd>
            <dt>Endpoint</dt>
            <dd>{model.info.endpointHost ?? '—'}</dd>
            <dt>Confidence</dt>
            <dd>{model.info.confidenceKind === 'provider' ? 'Reported by the provider' : 'Not reported (language model)'}</dd>
            <dt>Data</dt>
            <dd>{model.info.sendsEmailOffDevice ? 'Email text is sent to this provider for classification.' : 'Email text stays on this machine.'}</dd>
          </dl>
        ) : (
          <p className="code-note">{model.reason}</p>
        )}
        <p className="muted small">
          Set <code>MODEL_PROVIDER</code> to <code>jev</code>, <code>openai</code>, or <code>openai-compatible</code> with its key or base URL, then restart.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Gmail</h3>
          <span className={`pill ${account ? (account.tokenStatus === 'ok' ? 'pill-ok' : 'pill-warn') : 'pill-muted'}`}>
            {account ? (account.tokenStatus === 'ok' ? 'Connected' : 'Reconnect required') : status.gmail.configured ? 'Not connected' : 'Not configured'}
          </span>
        </div>
        {!status.gmail.configured ? (
          <>
            <p className="code-note">{status.gmail.problem}</p>
            <p className="muted small">Create a Google OAuth client of type “Web application” and register this exact redirect URI:</p>
            <p className="code-note">{status.gmail.redirectUri ?? `${status.publicUrl}/api/gmail/oauth/callback`}</p>
          </>
        ) : account ? (
          <>
            <dl className="kv">
              <dt>Account</dt>
              <dd>{account.email}</dd>
              <dt>Messages stored</dt>
              <dd>{account.messageCount}</dd>
              <dt>Granted</dt>
              <dd>
                <ul className="scope-list compact">
                  {account.grantedScopes.map((scope) => (
                    <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
                  ))}
                </ul>
              </dd>
              <dt>Applying labels</dt>
              <dd>{account.capabilities.canApply ? 'Allowed, one previewed message at a time' : account.capabilities.applyBlockedReason}</dd>
            </dl>
            <ul className="runs">
              <RunLine label="Last sync" run={account.lastSync} />
              <RunLine label="Last classification run" run={account.lastClassify} />
            </ul>
            {account.keyMismatch ? (
              <div className="notice notice-error">
                <IconAlert />
                <span>The encryption key changed since this account was connected. Reconnect Gmail.</span>
              </div>
            ) : null}
            <div className="form-actions">
              <ConnectGmailButton onError={onError} label={account.tokenStatus === 'ok' ? 'Reconnect / change permissions' : 'Reconnect Gmail'} />
              {confirming ? (
                <>
                  <span className="small">Revoke access and delete all local Gmail data?</span>
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      try {
                        const result = await api.disconnectGmail();
                        notify('info', result.revoked ? 'Gmail disconnected and access revoked.' : 'Gmail disconnected locally. Google did not confirm revocation; remove access in your Google Account.');
                        setConfirming(false);
                        await onChanged();
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn btn-ghost" onClick={() => setConfirming(true)}>
                  Disconnect…
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="muted small">Mail Triage will request:</p>
            <ul className="scope-list">
              {status.gmail.requestedScopes.map((scope) => (
                <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
              ))}
            </ul>
            <ConnectGmailButton onError={onError} />
          </>
        )}
        <div className="notice notice-info">
          <IconInfo />
          <span>
            {status.gmail.labelWritesEnabled
              ? 'Label writes are enabled. Applying labels needs gmail.modify, which Google defines broadly: it permits most mailbox read/write operations except permanent deletion. Mail Triage only ever adds its own labels, and only when you apply a preview.'
              : 'Label writes are disabled (GMAIL_LABEL_WRITES=false), so only read access is requested and labels can be previewed but not applied.'}
          </span>
        </div>
      </section>
    </div>
  );
}

function Privacy({ status }: { status: Status }) {
  return (
    <div className="settings-section prose">
      <div className="section-intro">
        <h2>Privacy and safety</h2>
      </div>
      <ul>
        <li>Mail is stored in a local SQLite database on this server. Disconnecting Gmail deletes it.</li>
        <li>Email bodies are shown as plain text. HTML is converted to text; images, scripts, and links are never loaded.</li>
        <li>Email text is treated as untrusted data. The model only picks from your categories; it has no tools and cannot act.</li>
        <li>Mail Triage never sends, deletes, archives, or marks mail as read, and never removes labels.</li>
        <li>
          Labels use the <code>{status.labelPrefix}/</code> prefix and are only added. If a decision changes, older Mail Triage labels stay until
          you remove them in Gmail.
        </li>
        <li>
          Sync and classification are manual here. Scheduled runs are possible with the CLI (<code>mail-triage sync</code>,{' '}
          <code>mail-triage classify</code>) from cron or launchd; they never apply labels.
        </li>
      </ul>
    </div>
  );
}

export function Settings(props: Props) {
  const [tab, setTab] = useState<Tab>('categories');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'categories', label: 'Categories' },
    { id: 'review', label: 'Review policy' },
    { id: 'connections', label: 'Connections' },
    { id: 'privacy', label: 'Privacy' },
  ];
  return (
    <main className="settings">
      <aside className="settings-nav">
        <div className="settings-nav-head">
          <h1>Settings</h1>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close settings">
            <IconClose />
          </button>
        </div>
        {tabs.map((t) => (
          <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </aside>
      <div className="settings-body">
        {tab === 'categories' ? <CategoryEditor {...props} /> : null}
        {tab === 'review' ? <ReviewSettings {...props} /> : null}
        {tab === 'connections' ? <Connections {...props} /> : null}
        {tab === 'privacy' ? <Privacy status={props.status} /> : null}
      </div>
    </main>
  );
}
