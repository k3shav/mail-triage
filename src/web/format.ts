import type { DecisionState, Taxonomy } from './types.js';

/** Mirrors the fixed action and priority options in src/core/taxonomy.ts. */
export const ACTIONS = [
  { id: 'needs_response', name: 'Needs Response' },
  { id: 'needs_action', name: 'Needs Action' },
  { id: 'no_action', name: 'No Action' },
] as const;

export const PRIORITIES = [
  { id: 'low', name: 'Low' },
  { id: 'normal', name: 'Normal' },
  { id: 'high', name: 'High' },
] as const;

export const STATE_LABELS: Record<DecisionState, string> = {
  unclassified: 'Not classified',
  error: 'Classification failed',
  stale: 'Stale',
  needs_review: 'Needs review',
  ready: 'Ready',
  confirmed: 'Confirmed',
};

export const STATE_HINTS: Record<DecisionState, string> = {
  unclassified: 'No decision yet for the current categories.',
  error: 'The last attempt failed; it will be retried on the next run.',
  stale: 'Categories or reader context changed after this was classified.',
  needs_review: 'Accept or correct this before labels can be applied.',
  ready: 'The model was confident enough under your review policy.',
  confirmed: 'You accepted or corrected this decision.',
};

export const PROVIDER_LABELS: Record<string, string> = {
  jev: 'Jev System One',
  'openai-decisions': 'OpenAI Decisions',
  'openai-compatible': 'OpenAI-compatible model',
  fixture: 'Demo fixtures',
  human: 'You',
};

export function categoryName(taxonomy: Taxonomy | null, id: string | null): string {
  if (!id) return '—';
  return taxonomy?.categories.find((c) => c.id === id)?.name ?? id;
}

export function actionName(id: string | null): string {
  return ACTIONS.find((a) => a.id === id)?.name ?? id ?? '—';
}

export function priorityName(id: string | null): string {
  return PRIORITIES.find((p) => p.id === id)?.name ?? id ?? '—';
}

/** Category color slot: position in the category list, so the defaults never share a color. */
export function categoryTone(taxonomy: Taxonomy | null, id: string | null): number {
  const index = id ? (taxonomy?.categories.findIndex((c) => c.id === id) ?? -1) : -1;
  return index >= 0 ? index % 8 : toneOf(id);
}

/** Stable color slot (0–7) derived from a string, for avatars. */
export function toneOf(id: string | null): number {
  if (!id) return 0;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 8;
}

/** "Priya Shah <priya@x>" → { name: "Priya Shah", address: "priya@x" }. */
export function parseAddress(value: string): { name: string; address: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1]!.trim() || match[2]!, address: match[2]! };
  return { name: value.trim() || '(unknown sender)', address: value.trim() };
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function longDate(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return longDate(ms);
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.readonly': 'Read messages (gmail.readonly)',
  'https://www.googleapis.com/auth/gmail.labels': 'Create labels (gmail.labels)',
  'https://www.googleapis.com/auth/gmail.modify': 'Change labels on messages (gmail.modify)',
  'https://mail.google.com/': 'Full mailbox access',
};
