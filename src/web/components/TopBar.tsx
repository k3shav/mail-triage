import { PROVIDER_LABELS } from '../format';
import type { MailboxName, Status } from '../types';
import { IconRefresh, IconSettings, IconSparkle, LogoMark } from './Icons';

interface Props {
  status: Status | null;
  mailbox: MailboxName;
  view: 'inbox' | 'settings';
  busy: 'sync' | 'classify' | null;
  onMailbox: (mailbox: MailboxName) => void;
  onSync: () => void;
  onClassify: () => void;
  onSettings: () => void;
  onSignOut: (() => void) | null;
}

export function TopBar({ status, mailbox, view, busy, onMailbox, onSync, onClassify, onSettings, onSignOut }: Props) {
  const account = status?.gmail.account ?? null;
  const modelReady = status?.model.configured ?? false;
  const canClassify = mailbox === 'demo' ? Boolean(status?.demo.enabled) : Boolean(account) && modelReady;
  const classifyTitle =
    mailbox === 'gmail' && !modelReady
      ? 'No model provider is configured on the server'
      : mailbox === 'demo'
        ? 'Apply the bundled fixture labels (no model call)'
        : `Classify up to ${status?.limits.classifyBatchSize ?? ''} pending messages`;

  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark />
        <span className="brand-name">Mail Triage</span>
      </div>

      <div className="segmented" role="tablist" aria-label="Mailbox">
        {status?.demo.enabled ? (
          <button role="tab" aria-selected={mailbox === 'demo'} className={mailbox === 'demo' ? 'active' : ''} onClick={() => onMailbox('demo')}>
            Demo inbox
          </button>
        ) : null}
        <button role="tab" aria-selected={mailbox === 'gmail'} className={mailbox === 'gmail' ? 'active' : ''} onClick={() => onMailbox('gmail')}>
          {account ? <span className="truncate">{account.email}</span> : 'Gmail'}
          {account?.tokenStatus === 'reauth_required' ? <span className="dot dot-warn" title="Reconnect required" /> : null}
        </button>
      </div>

      <div className="topbar-status">
        <span className={`pill ${modelReady ? 'pill-ok' : 'pill-muted'}`} title={status ? (status.model.configured ? status.model.info.model : status.model.reason) : undefined}>
          <span className={`dot ${modelReady ? 'dot-ok' : ''}`} />
          {status?.model.configured ? PROVIDER_LABELS[status.model.info.provider] : 'No model'}
        </span>
      </div>

      <div className="topbar-actions">
        {mailbox === 'gmail' && account ? (
          <button className="btn" aria-label="Sync Gmail" onClick={onSync} disabled={busy !== null || !account.capabilities.canRead} title={`Fetch up to ${status?.limits.syncMaxMessages} newest inbox messages`}>
            <IconRefresh /> <span className="btn-label">{busy === 'sync' ? 'Syncing…' : 'Sync'}</span>
          </button>
        ) : null}
        <button className="btn btn-primary" aria-label="Classify pending" onClick={onClassify} disabled={busy !== null || !canClassify} title={classifyTitle}>
          <IconSparkle /> <span className="btn-label">{busy === 'classify' ? 'Classifying…' : 'Classify pending'}</span>
        </button>
        <button className={`icon-btn ${view === 'settings' ? 'active' : ''}`} onClick={onSettings} aria-label="Settings" title="Settings">
          <IconSettings />
        </button>
        {onSignOut ? (
          <button className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
      </div>
    </header>
  );
}
