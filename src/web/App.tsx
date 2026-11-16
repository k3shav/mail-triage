import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, MAX_PAGE_SIZE, api, setCsrfToken } from './api';
import { DemoBanner, GmailOnboarding } from './components/Banners';
import { Login } from './components/Login';
import { MessageDetailView } from './components/MessageDetail';
import { MessageListView } from './components/MessageList';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { Toasts, type Toast } from './components/Toasts';
import { TopBar } from './components/TopBar';
import type { DetailOrigin, Filters, MailboxName, MessageDetail, MessageList, MessageSummary, Session, Status, TaxonomyRevision } from './types';

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
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ origin: DetailOrigin; data: MessageDetail } | null>(null);
  const [view, setView] = useState<'inbox' | 'settings'>('inbox');
  const [busy, setBusy] = useState<'sync' | 'classify' | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  // Async results are applied only if they still belong to what is on screen.
  // These refs change synchronously with user actions, before React re-renders.
  const sessionGeneration = useRef(0);
  const selection = useRef<{ mailbox: MailboxName; id: number | null; token: number }>({ mailbox: 'demo', id: null, token: 0 });
  // Detail writes are ordered: each read takes a token when it starts and each
  // mutation result takes one when it lands; only the newest token may write.
  const detailWrite = useRef(0);
  const listGeneration = useRef(0);
  const loadedCount = useRef(PAGE_SIZE);

  const isCurrent = useCallback(
    (origin: DetailOrigin) =>
      origin.generation === sessionGeneration.current &&
      origin.selection === selection.current.token &&
      selection.current.mailbox === origin.mailbox &&
      selection.current.id === origin.id,
    [],
  );

  const select = useCallback((nextMailbox: MailboxName, id: number | null) => {
    selection.current = { mailbox: nextMailbox, id, token: selection.current.token + 1 };
    setMailbox(nextMailbox);
    setSelectedId(id);
  }, []);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  const endSession = useCallback((next: SessionState) => {
    sessionGeneration.current += 1;
    listGeneration.current += 1;
    setCsrfToken(null);
    setDetail(null);
    setList(null);
    setSession(next);
  }, []);

  const startSession = useCallback((current: Session) => {
    sessionGeneration.current += 1;
    listGeneration.current += 1;
    setCsrfToken(current.csrfToken);
    setSession({ phase: 'ready', mode: current.mode });
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setSession((current) => {
          const mode = current.phase === 'ready' ? current.mode : 'password';
          return current.phase === 'login' ? current : { phase: 'login', mode };
        });
        sessionGeneration.current += 1;
        listGeneration.current += 1;
        setCsrfToken(null);
        setDetail(null);
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
      if (current.authenticated) startSession(current);
      else endSession({ phase: 'login', mode: current.mode });
    } catch (error) {
      endSession({ phase: 'error', message: error instanceof Error ? error.message : 'Could not reach the server' });
    }
  }, [startSession, endSession]);

  useEffect(() => {
    void establish();
  }, [establish]);

  const refreshStatus = useCallback(async () => {
    const generation = sessionGeneration.current;
    try {
      const [nextStatus, nextTaxonomy] = await Promise.all([api.status(), api.taxonomy()]);
      if (generation !== sessionGeneration.current) return null;
      setStatus(nextStatus);
      setTaxonomy(nextTaxonomy);
      return nextStatus;
    } catch (error) {
      if (generation === sessionGeneration.current) handleError(error);
      return null;
    }
  }, [handleError]);

  // First load after sign-in: pick the mailbox and surface OAuth results.
  useEffect(() => {
    if (session.phase !== 'ready') return;
    const generation = sessionGeneration.current;
    void (async () => {
      const loaded = await refreshStatus();
      if (!loaded || generation !== sessionGeneration.current) return;
      const linked = readHash();
      if (linked && (linked.mailbox === 'gmail' || loaded.demo.enabled)) select(linked.mailbox, linked.id);
      else select(loaded.gmail.account ? 'gmail' : loaded.demo.enabled ? 'demo' : 'gmail', null);
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get('gmail');
      if (outcome) {
        if (outcome === 'connected') notify('success', 'Gmail connected. Sync to fetch your newest inbox messages.');
        else notify('error', OAUTH_MESSAGES[params.get('reason') ?? ''] ?? 'Gmail connection failed.');
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      }
    })();
  }, [session.phase, refreshStatus, notify, select]);

  const gmailConnected = Boolean(status?.gmail.account);
  const mailboxAvailable = mailbox === 'demo' ? Boolean(status?.demo.enabled) : gmailConnected;
  const ready = session.phase === 'ready' && mailboxAvailable;

  /**
   * (Re)load the first `count` messages of the current query in pages of at
   * most MAX_PAGE_SIZE. A newer load, query change, or session change makes
   * this one's result obsolete.
   */
  const loadList = useCallback(
    async (count: number) => {
      const generation = ++listGeneration.current;
      if (!ready) {
        setList(null);
        return;
      }
      setListLoading(true);
      try {
        let merged: MessageList | null = null;
        const seen = new Set<number>();
        for (let offset = 0; offset < count; offset += MAX_PAGE_SIZE) {
          const limit = Math.min(MAX_PAGE_SIZE, count - offset);
          const page: MessageList = await api.messages(mailbox, filters, { limit, offset });
          if (generation !== listGeneration.current) return;
          const messages: MessageSummary[] = merged ? merged.messages : [];
          for (const message of page.messages) {
            if (seen.has(message.id)) continue;
            seen.add(message.id);
            messages.push(message);
          }
          merged = { ...page, messages };
          if (page.messages.length < limit || offset + limit >= page.total) break;
        }
        setList(merged);
        setListError(null);
      } catch (error) {
        if (generation !== listGeneration.current) return;
        setListError(error instanceof Error ? error.message : 'Could not load messages');
        if (error instanceof ApiError && error.status === 401) handleError(error);
      } finally {
        if (generation === listGeneration.current) setListLoading(false);
      }
    },
    [ready, mailbox, filters, handleError],
  );

  // A new query starts again from the first page and drops any in-flight page.
  useEffect(() => {
    loadedCount.current = PAGE_SIZE;
    listGeneration.current += 1;
    setList(null);
    const timer = window.setTimeout(() => void loadList(PAGE_SIZE), filters.q ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [loadList, filters.q]);

  /** Append the next page (offset = rows already shown) to the current query's list. */
  const loadMore = useCallback(async () => {
    if (!list || !ready) return;
    const generation = listGeneration.current;
    setListLoading(true);
    try {
      const page = await api.messages(mailbox, filters, { limit: PAGE_SIZE, offset: list.messages.length });
      if (generation !== listGeneration.current) return;
      setList((current) => {
        if (!current) return current;
        const seen = new Set(current.messages.map((m) => m.id));
        const messages = [...current.messages, ...page.messages.filter((m) => !seen.has(m.id))];
        loadedCount.current = Math.max(PAGE_SIZE, messages.length);
        return { ...page, messages };
      });
    } catch (error) {
      if (generation === listGeneration.current) handleError(error);
    } finally {
      if (generation === listGeneration.current) setListLoading(false);
    }
  }, [list, ready, mailbox, filters, handleError]);

  const refreshList = useCallback(() => loadList(loadedCount.current), [loadList]);

  const loadDetail = useCallback(
    async (origin: DetailOrigin) => {
      try {
        const token = ++detailWrite.current;
        const data = await api.message(origin.mailbox, origin.id);
        if (isCurrent(origin) && token === detailWrite.current) setDetail({ origin, data });
      } catch (error) {
        if (!isCurrent(origin)) return;
        handleError(error);
        // A stale deep link or a message removed by a reset: go back to the list.
        if (error instanceof ApiError && error.status === 404) select(origin.mailbox, null);
      }
    },
    [handleError, isCurrent, select],
  );

  useEffect(() => {
    selection.current = { ...selection.current, mailbox, id: selectedId };
    setDetail(null);
    if (selectedId !== null && session.phase === 'ready') {
      void loadDetail({ mailbox, id: selectedId, generation: sessionGeneration.current, selection: selection.current.token });
    }
  }, [mailbox, selectedId, session.phase, loadDetail]);

  useEffect(() => {
    if (session.phase !== 'ready' || !status) return;
    const hash = `#${mailbox}${selectedId !== null ? `/${selectedId}` : ''}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [session.phase, status, mailbox, selectedId]);

  const switchMailbox = (next: MailboxName) => {
    select(next, null);
    setFilters(EMPTY_FILTERS);
    setView('inbox');
  };

  /**
   * After a mutation: show `next` only if it is the result for the message
   * still selected, then refresh the list and status.
   */
  const afterChange = useCallback(
    async (origin?: DetailOrigin, next?: MessageDetail) => {
      if (origin && next && isCurrent(origin)) {
        // Newer than any read still in flight for this message.
        detailWrite.current += 1;
        setDetail({ origin, data: next });
      }
      await Promise.all([refreshList(), refreshStatus()]);
    },
    [refreshList, refreshStatus, isCurrent],
  );

  const reloadSelected = useCallback(async () => {
    const { mailbox: m, id, token } = selection.current;
    if (id !== null) await loadDetail({ mailbox: m, id, generation: sessionGeneration.current, selection: token });
  }, [loadDetail]);

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
      await reloadSelected();
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
    setStatus(null);
    select(mailbox, null);
    // Do not reopen the previous message from the deep link after signing back in.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${mailbox}`);
    if (session.phase === 'ready' && session.mode === 'local') {
      endSession({ phase: 'loading' });
      await establish();
    } else endSession({ phase: 'login', mode: 'password' });
  };

  const visibleDetail = detail && isCurrent(detail.origin) ? detail : null;

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
        onSignedIn={startSession}
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
              select('demo', null);
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
              <Sidebar counts={list?.counts ?? null} filters={filters} taxonomy={taxonomy?.taxonomy ?? null} onFilters={setFilters} />
              <MessageListView
                list={list}
                loading={listLoading}
                error={listError}
                filters={filters}
                taxonomy={taxonomy?.taxonomy ?? null}
                selectedId={selectedId}
                onSelect={(id) => select(mailbox, id)}
                onSearch={(q) => setFilters({ ...filters, q })}
                onLoadMore={() => void loadMore()}
                onClassify={runClassify}
                classifying={busy === 'classify'}
                mailbox={mailbox}
              />
              <MessageDetailView
                key={`${mailbox}:${selectedId ?? ''}:${selection.current.token}`}
                mailbox={mailbox}
                origin={visibleDetail?.origin ?? null}
                detail={visibleDetail?.data ?? null}
                selectedId={selectedId}
                taxonomy={taxonomy?.taxonomy ?? null}
                status={status}
                notify={notify}
                onError={handleError}
                onChanged={afterChange}
                onBack={() => select(mailbox, null)}
              />
            </>
          )}
        </main>
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))} />
    </div>
  );
}
