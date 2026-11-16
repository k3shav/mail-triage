import { STATE_LABELS, actionName, categoryName, categoryTone, initials, parseAddress, shortDate, toneOf } from '../format';
import type { Filters, MailboxName, MessageList, MessageSummary, Taxonomy } from '../types';
import { IconSearch, IconSparkle } from './Icons';

interface Props {
  list: MessageList | null;
  loading: boolean;
  error: string | null;
  filters: Filters;
  taxonomy: Taxonomy | null;
  selectedId: number | null;
  mailbox: MailboxName;
  classifying: boolean;
  onSelect: (id: number) => void;
  onSearch: (q: string) => void;
  onLoadMore: () => void;
  onClassify: () => void;
}

export function StateBadge({ state }: { state: MessageSummary['decision']['state'] }) {
  return <span className={`state state-${state}`}>{STATE_LABELS[state]}</span>;
}

function Row({ message, taxonomy, selected, onSelect }: { message: MessageSummary; taxonomy: Taxonomy | null; selected: boolean; onSelect: () => void }) {
  const sender = parseAddress(message.from);
  const { decision } = message;
  return (
    <li>
      <button className={`row ${selected ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <span className={`avatar tone-${toneOf(sender.address)}`} aria-hidden="true">
          {initials(sender.name)}
        </span>
        <span className="row-main">
          <span className="row-top">
            <span className="row-sender truncate">{sender.name}</span>
            <time className="row-date">{shortDate(message.sentAt)}</time>
          </span>
          <span className="row-subject">
            {message.unread ? <span className="unread-dot" aria-label="Unread" /> : null}
            <span className="truncate">{message.subject}</span>
          </span>
          <span className="row-snippet truncate">{message.snippet}</span>
          <span className="row-chips">
            {decision.category ? <span className={`chip tone-${categoryTone(taxonomy, decision.category)}`}>{categoryName(taxonomy, decision.category)}</span> : null}
            {decision.action && decision.action !== 'no_action' ? <span className={`chip chip-action action-${decision.action}`}>{actionName(decision.action)}</span> : null}
            {decision.priority === 'high' ? <span className="chip chip-high">High</span> : null}
            {decision.state !== 'ready' && decision.state !== 'confirmed' ? <StateBadge state={decision.state} /> : null}
            {decision.state === 'confirmed' ? <span className="state state-confirmed">Confirmed</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function MessageListView(props: Props) {
  const { list, loading, error, filters, taxonomy, selectedId, mailbox } = props;
  const hasFilters = Boolean(filters.state || filters.category || filters.action || filters.unread || filters.q);
  const pendingCount = list ? (list.counts.byState.unclassified ?? 0) + (list.counts.byState.stale ?? 0) + (list.counts.byState.error ?? 0) : 0;

  return (
    <section className="list-pane" aria-label="Messages">
      <div className="list-header">
        <label className="search">
          <IconSearch />
          <input
            type="search"
            placeholder="Search sender, subject, preview"
            value={filters.q}
            maxLength={200}
            onChange={(event) => props.onSearch(event.target.value)}
            aria-label="Search messages"
          />
        </label>
        <div className="list-meta">
          {list ? `${list.total} ${list.total === 1 ? 'message' : 'messages'}` : ''}
          {loading ? <span className="spinner" aria-label="Loading" /> : null}
        </div>
      </div>

      {pendingCount > 0 && !hasFilters ? (
        <div className="list-callout">
          <span>
            {pendingCount} {pendingCount === 1 ? 'message has' : 'messages have'} no decision for the current categories.
          </span>
          <button className="btn btn-small" onClick={props.onClassify} disabled={props.classifying}>
            <IconSparkle /> {mailbox === 'demo' ? 'Apply fixtures' : 'Classify'}
          </button>
        </div>
      ) : null}

      {error ? <p className="empty error-text">{error}</p> : null}
      {list && list.messages.length === 0 && !error ? (
        <div className="empty">
          {hasFilters ? 'No messages match these filters.' : mailbox === 'gmail' ? 'No messages yet. Use Sync to fetch your newest inbox messages.' : 'The demo inbox is empty. Reset it from the banner.'}
        </div>
      ) : null}

      <ul className="rows">
        {list?.messages.map((message) => (
          <Row key={message.id} message={message} taxonomy={taxonomy} selected={message.id === selectedId} onSelect={() => props.onSelect(message.id)} />
        ))}
      </ul>
      {list && list.messages.length < list.total ? (
        <button className="btn btn-ghost load-more" onClick={props.onLoadMore} disabled={loading}>
          Show more
        </button>
      ) : null}
    </section>
  );
}
