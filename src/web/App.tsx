import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, setCsrfToken } from './api';
import { DemoBanner, GmailOnboarding } from './components/Banners';
import { Login } from './components/Login';
import { MessageDetailView } from './components/MessageDetail';
import { MessageListView } from './components/MessageList';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { Toasts, type Toast } from './components/Toasts';
import { TopBar } from './components/TopBar';
import type { Filters, MailboxName, MessageDetail, MessageList, Session, Status, TaxonomyRevision } from './types';

const EMPTY_FILTERS: Filters = { state: '', category: '', action: '', unread: '', q: '' };
const PAGE_SIZE = 50;

const OAUTH_MESSAGES: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  invalid_state: 'That sign-in link is not valid. Start again from Settings.',
  state_used: 'That sign-in link was already used. Start again from Settings.',
  state_expired: 'The sign-in link expired. Start again from Settings.',
  session_mismatch: 'The sign-in was started in a different browser session.',
  session_missing: 'Your Mail Triage session was not found. Open the app at its configured URL and try again.',
  token_exchange_failed: 'Google did not accept the sign-in. Check the OAuth client settings and redirect URI.',
  missing_read_scope: 'Mail Triage needs permission to read Gmail. Allow it and try again.',
  no_refresh_token: 'Google did not return offline access. Remove Mail Triage from your Google account permissions and connect again.',
  different_account: 'A different Gmail account is already connected. Disconnect it first.',
  profile_failed: 'Connected, but the Gmail profile could not be read.',
  not_configured: 'Gmail is not configured on this server.',
};

/** Deep link: #demo/12 or #gmail/40. */
function readHash(): { mailbox: MailboxName; id: number | null } | null {
  const match = /^#(demo|gmail)(?:\/(\d+))?$/.exec(window.location.hash);
  if (!match) return null;
  return { mailbox: match[1] as MailboxName, id: match[2] ? Number(match[2]) : null };
}

type SessionState = { phase: 'loading' } | { phase: 'login'; mode: Session['mode'] } | { phase: 'ready'; mode: Session['mode'] } | { phase: 'error'; message: string };

export function App() {
  const [session, setSession] = useState<SessionState>({ phase: 'loading' });
  const [status, setStatus] = useState<Status | null>(null);
  const [taxonomy, setTaxonomy] = useState<TaxonomyRevision | null>(null);
  const [mailbox, setMailbox] = useState<MailboxName>('demo');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [list, setList] = useState<MessageList | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [view, setView] = useState<'inbox' | 'settings'>('inbox');
  const [busy, setBusy] = useState<'sync' | 'classify' | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const listRequest = useRef(0);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken(null);
        setSession((current) => ({ phase: 'login', mode: current.phase === 'ready' ? current.mode : 'password' }));
        return;
      }
      notify('error', error instanceof Error ? error.message : 'Something went wrong');
    },
    [notify],
  );

  const establish = useCallback(async () => {
    try {
      let current = await api.session();
      if (!current.authenticated && current.mode === 'local') current = await api.localSession();
      if (current.authenticated) {
        setCsrfToken(current.csrfToken);
        setSession({ phase: 'ready', mode: current.mode });
      } else {
        setSession({ phase: 'login', mode: current.mode });
      }
    } catch (error) {
      setSession({ phase: 'error', message: error instanceof Error ? error.message : 'Could not reach the server' });
    }
  }, []);

  useEffect(() => {
    void establish();
  }, [establish]);

  const refreshStatus = useCallback(async () => {
    try {
      const [nextStatus, nextTaxonomy] = await Promise.all([api.status(), api.taxonomy()]);
      setStatus(nextStatus);
      setTaxonomy(nextTaxonomy);
      return nextStatus;
    } catch (error) {
      handleError(error);
      return null;
    }
  }, [handleError]);

  // First load after sign-in: pick the mailbox and surface OAuth results.
  useEffect(() => {
    if (session.phase !== 'ready') return;
    void (async () => {
      const loaded = await refreshStatus();
      if (!loaded) return;
      const linked = readHash();
      if (linked && (linked.mailbox === 'gmail' || loaded.demo.enabled)) {
        setMailbox(linked.mailbox);
        setSelectedId(linked.id);
      } else {
        setMailbox(loaded.gmail.account ? 'gmail' : loaded.demo.enabled ? 'demo' : 'gmail');
      }
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get('gmail');
      if (outcome) {
        if (outcome === 'connected') notify('success', 'Gmail connected. Sync to fetch your newest inbox messages.');
        else notify('error', OAUTH_MESSAGES[params.get('reason') ?? ''] ?? 'Gmail connection failed.');
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      }
    })();
  }, [session.phase, refreshStatus, notify]);

  const gmailConnected = Boolean(status?.gmail.account);
  const mailboxAvailable = mailbox === 'demo' ? Boolean(status?.demo.enabled) : gmailConnected;

  const loadList = useCallback(async () => {
    if (session.phase !== 'ready' || !mailboxAvailable) {
      setList(null);
      return;
    }
    const requestId = ++listRequest.current;
    setListLoading(true);
    try {
      const next = await api.messages(mailbox, filters, limit);
      if (requestId === listRequest.current) {
        setList(next);
        setListError(null);
      }
    } catch (error) {
      if (requestId === listRequest.current) setListError(error instanceof Error ? error.message : 'Could not load messages');
      if (error instanceof ApiError && error.status === 401) handleError(error);
    } finally {
      if (requestId === listRequest.current) setListLoading(false);
    }
  }, [session.phase, mailboxAvailable, mailbox, filters, limit, handleError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), filters.q ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [loadList, filters.q]);

  const loadDetail = useCallback(
    async (id: number) => {
      try {
        setDetail(await api.message(mailbox, id));
      } catch (error) {
        handleError(error);
      }
    },
    [mailbox, handleError],
  );

  useEffect(() => {
    setDetail(null);
    if (selectedId !== null) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (session.phase !== 'ready' || !status) return;
    const hash = `#${mailbox}${selectedId !== null ? `/${selectedId}` : ''}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [session.phase, status, mailbox, selectedId]);

  const switchMailbox = (next: MailboxName) => {
    setMailbox(next);
    setFilters(EMPTY_FILTERS);
    setSelectedId(null);
    setLimit(PAGE_SIZE);
    setView('inbox');
  };

  const afterChange = useCallback(
    async (next?: MessageDetail) => {
      if (next) setDetail(next);
      await Promise.all([loadList(), refreshStatus()]);
    },
    [loadList, refreshStatus],
  );

  const runSync = async () => {
    setBusy('sync');
    try {
      const stats = await api.sync(mailbox);
      notify(
        stats.failed > 0 ? 'error' : 'success',
        `Synced ${stats.listed} inbox messages: ${stats.added} new, ${stats.refreshed} refreshed${stats.failed ? `, ${stats.failed} failed` : ''}.`,
      );
      await afterChange();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  };

  const runClassify = async () => {
    setBusy('classify');
    try {
      const stats = await api.classify(mailbox);
      if (stats.attempted === 0) notify('info', 'Every message already has a decision for the current categories.');
      else
        notify(
          stats.failed > 0 ? 'error' : 'success',
          `Classified ${stats.classified} of ${stats.attempted}; ${stats.needsReview} need review${stats.failed ? `, ${stats.failed} failed` : ''}${stats.superseded ? `, ${stats.superseded} superseded by your edits` : ''}${stats.stoppedEarly ? ' (stopped early)' : ''}.${stats.remaining ? ` ${stats.remaining} still pending.` : ''}`,
        );
      await afterChange();
      if (selectedId !== null) await loadDetail(selectedId);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Session may already be gone.
    }
    setCsrfToken(null);
    setStatus(null);
    setList(null);
    setSelectedId(null);
    if (session.phase === 'ready' && session.mode === 'local') await establish();
    else setSession({ phase: 'login', mode: 'password' });
  };

  const originMismatch = useMemo(
    () => status !== null && status.gmail.configured && window.location.origin !== status.publicUrl && !import.meta.env.DEV,
    [status],
  );

  if (session.phase === 'loading') return <div className="splash">Loading Mail Triage…</div>;
  if (session.phase === 'error') {
    return (
      <div className="splash">
        <p>{session.message}</p>
        <button className="btn" onClick={() => void establish()}>
          Try again
        </button>
      </div>
    );
  }
  if (session.phase === 'login') {
    return (
      <Login
        onSignedIn={(next) => {
          setCsrfToken(next.csrfToken);
          setSession({ phase: 'ready', mode: next.mode });
        }}
      />
    );
  }

  return (
    <div className={`app ${selectedId !== null ? 'has-selection' : ''}`}>
      <TopBar
        status={status}
        mailbox={mailbox}
        view={view}
        busy={busy}
        onMailbox={switchMailbox}
        onSync={runSync}
        onClassify={runClassify}
        onSettings={() => setView(view === 'settings' ? 'inbox' : 'settings')}
        onSignOut={session.mode === 'password' ? signOut : null}
      />
      {originMismatch ? (
        <div className="banner banner-warn" role="status">
          You opened Mail Triage at {window.location.origin}, but Gmail sign-in returns to {status!.publicUrl}. Open{' '}
          <a href={status!.publicUrl}>{status!.publicUrl}</a> so your session survives the Google redirect.
        </div>
      ) : null}
      {view === 'inbox' && mailbox === 'demo' && status?.demo.enabled ? (
        <DemoBanner
          onReset={async () => {
            try {
              await api.resetDemo();
              setSelectedId(null);
              notify('info', 'Demo inbox restored.');
              await afterChange();
            } catch (error) {
              handleError(error);
            }
          }}
        />
      ) : null}

      {view === 'settings' && status && taxonomy ? (
        <Settings
          status={status}
          taxonomy={taxonomy}
          notify={notify}
          onError={handleError}
          onChanged={async () => {
            await afterChange();
          }}
          onClose={() => setView('inbox')}
        />
      ) : (
        <main className="workspace">
          {mailbox === 'gmail' && !gmailConnected && status ? (
            <GmailOnboarding status={status} onOpenSettings={() => setView('settings')} onError={handleError} />
          ) : (
            <>
              <Sidebar counts={list?.counts ?? null} filters={filters} taxonomy={taxonomy?.taxonomy ?? null} onFilters={(next) => { setFilters(next); setLimit(PAGE_SIZE); }} />
              <MessageListView
                list={list}
                loading={listLoading}
                error={listError}
                filters={filters}
                taxonomy={taxonomy?.taxonomy ?? null}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onSearch={(q) => setFilters({ ...filters, q })}
                onLoadMore={() => setLimit(limit + PAGE_SIZE)}
                onClassify={runClassify}
                classifying={busy === 'classify'}
                mailbox={mailbox}
              />
              <MessageDetailView
                mailbox={mailbox}
                detail={detail}
                selectedId={selectedId}
                taxonomy={taxonomy?.taxonomy ?? null}
                status={status}
                notify={notify}
                onError={handleError}
                onChanged={afterChange}
                onBack={() => setSelectedId(null)}
              />
            </>
          )}
        </main>
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))} />
    </div>
  );
}
