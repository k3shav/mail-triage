import { useState } from 'react';
import { api } from '../api';
import { SCOPE_LABELS } from '../format';
import type { Status } from '../types';
import { IconInbox, IconInfo, IconLock } from './Icons';

export function DemoBanner({ onReset }: { onReset: () => void }) {
  return (
    <div className="banner banner-demo" role="note">
      <IconInfo />
      <p>
        <strong>Demo inbox.</strong> Twelve fictional messages with hand-written fixture labels. No model is called, fixtures carry no
        confidence, and applying labels only records them locally.
      </p>
      <button className="btn btn-small" onClick={onReset}>
        Reset demo
      </button>
    </div>
  );
}

export function ConnectGmailButton({ onError, label = 'Connect Gmail' }: { onError: (error: unknown) => void; label?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      className="btn btn-primary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const { url } = await api.connectGmail();
          window.location.assign(url);
        } catch (error) {
          setPending(false);
          onError(error);
        }
      }}
    >
      <IconLock /> {pending ? 'Opening Google…' : label}
    </button>
  );
}

export function GmailOnboarding({ status, onOpenSettings, onError }: { status: Status; onOpenSettings: () => void; onError: (e: unknown) => void }) {
  return (
    <section className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-icon">
          <IconInbox />
        </div>
        <h2>Connect your Gmail inbox</h2>
        {status.gmail.configured ? (
          <>
            <p>
              Mail Triage reads your newest inbox messages, classifies them, and waits for you. Nothing in Gmail changes unless you preview
              and apply labels to a specific message.
            </p>
            <ul className="scope-list">
              {status.gmail.requestedScopes.map((scope) => (
                <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
              ))}
            </ul>
            {!status.gmail.labelWritesEnabled ? (
              <p className="muted small">Label writes are off on this server, so only read access is requested.</p>
            ) : (
              <p className="muted small">
                Google has no label-only scope for messages, so applying labels needs gmail.modify. Mail Triage only ever adds its own labels.
              </p>
            )}
            <ConnectGmailButton onError={onError} />
            {!status.model.configured ? <p className="muted small">No model is configured yet, so synced mail cannot be classified until one is set.</p> : null}
          </>
        ) : (
          <>
            <p>Gmail is not configured on this server yet.</p>
            <p className="code-note">{status.gmail.problem}</p>
            <p className="muted small">See the README section “Gmail OAuth setup”, then restart the server.</p>
            <button className="btn" onClick={onOpenSettings}>
              Open settings
            </button>
          </>
        )}
      </div>
    </section>
  );
}
