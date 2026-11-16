import { ACTIONS, categoryTone } from '../format';
import type { Filters, MessageList, Taxonomy } from '../types';

interface Props {
  counts: MessageList['counts'] | null;
  filters: Filters;
  taxonomy: Taxonomy | null;
  onFilters: (filters: Filters) => void;
}

const VIEWS: Array<{ state: Filters['state']; label: string; countOf: (c: MessageList['counts']) => number }> = [
  { state: '', label: 'All mail', countOf: (c) => c.total },
  { state: 'needs_review', label: 'Needs review', countOf: (c) => c.byState.needs_review ?? 0 },
  { state: 'ready', label: 'Ready to label', countOf: (c) => c.byState.ready ?? 0 },
  { state: 'confirmed', label: 'Confirmed', countOf: (c) => c.byState.confirmed ?? 0 },
  { state: 'pending', label: 'Pending', countOf: (c) => (c.byState.unclassified ?? 0) + (c.byState.stale ?? 0) + (c.byState.error ?? 0) },
];

export function Sidebar({ counts, filters, taxonomy, onFilters }: Props) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });

  return (
    <nav className="sidebar" aria-label="Filters">
      <div className="sidebar-group">
        <h3>Views</h3>
        {VIEWS.map((view) => (
          <button
            key={view.label}
            className={`nav-item ${filters.state === view.state ? 'active' : ''}`}
            onClick={() => set({ state: view.state })}
          >
            <span>{view.label}</span>
            <span className="count">{counts ? view.countOf(counts) : ''}</span>
          </button>
        ))}
        <label className="toggle-row">
          <input type="checkbox" checked={filters.unread === 'true'} onChange={(event) => set({ unread: event.target.checked ? 'true' : '' })} />
          <span>Unread only</span>
          <span className="count">{counts?.unread ?? ''}</span>
        </label>
      </div>

      <div className="sidebar-group">
        <h3>Category</h3>
        {taxonomy?.categories.map((category) => (
          <button
            key={category.id}
            className={`nav-item ${filters.category === category.id ? 'active' : ''}`}
            onClick={() => set({ category: filters.category === category.id ? '' : category.id })}
            title={category.description}
          >
            <span className="nav-label">
              <span className={`swatch tone-${categoryTone(taxonomy, category.id)}`} />
              {category.name}
            </span>
            <span className="count">{counts?.byCategory[category.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-group">
        <h3>Action</h3>
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            className={`nav-item ${filters.action === action.id ? 'active' : ''}`}
            onClick={() => set({ action: filters.action === action.id ? '' : action.id })}
          >
            <span className="nav-label">
              <span className={`action-dot action-${action.id}`} />
              {action.name}
            </span>
            <span className="count">{counts?.byAction[action.id] ?? 0}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
