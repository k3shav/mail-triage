import type { EmailForModel } from '../../src/core/email.js';
import { DEFAULT_TAXONOMY, type Taxonomy } from '../../src/core/taxonomy.js';

export const SAMPLE_EMAIL: EmailForModel = {
  from: 'Priya Shah <priya@northwind.example>',
  to: 'sam@example.com',
  cc: '',
  subject: 'Contract review',
  date: '2026-11-16T09:12:00Z',
  body: 'Could you review sections 4 and 7 by Thursday?',
  signals: { hasListUnsubscribe: false, listId: null, autoSubmitted: null, precedence: null },
};

export const TAXONOMY: Taxonomy = { ...DEFAULT_TAXONOMY, userContext: 'I lead the platform team at Northwind.' };

const CATEGORY_NAMES = DEFAULT_TAXONOMY.categories.map((category) => category.name);

/** Distribution with `selected` at `p` and the remainder spread evenly. */
export function distribution(names: string[], selected: string, p: number): Record<string, number> {
  const rest = (1 - p) / (names.length - 1);
  return Object.fromEntries(names.map((name) => [name, name === selected ? p : rest]));
}

export function jevAnswers(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      category: {
        type: 'choice',
        choice: 'FYI',
        confidence: 0.82,
        probabilities: distribution(CATEGORY_NAMES, 'FYI', 0.88),
      },
      action: {
        type: 'choice',
        choice: 'Needs Response',
        confidence: 0.64,
        probabilities: { 'Needs Response': 0.76, 'Needs Action': 0.2, 'No Action': 0.04 },
      },
      priority: {
        type: 'choice',
        choice: 'High',
        confidence: 0.9,
        probabilities: { Low: 0.01, Normal: 0.06, High: 0.93 },
      },
      ...overrides,
    },
    usage: { input_tokens: 410, output_tokens: 30 },
  };
}

function asArray(probabilities: Record<string, number>) {
  return Object.entries(probabilities).map(([value, probability]) => ({ value, probability }));
}

export function openAIAnswers(overrides: Record<string, Record<string, unknown>> = {}) {
  const base: Record<string, Record<string, unknown>> = {
    category: {
      type: 'choice',
      name: 'category',
      choice: 'Meeting',
      probabilities: asArray(distribution(CATEGORY_NAMES, 'Meeting', 0.91)),
      confidence: 0.87,
    },
    action: {
      type: 'choice',
      name: 'action',
      choice: 'Needs Action',
      probabilities: asArray({ 'Needs Response': 0.1, 'Needs Action': 0.85, 'No Action': 0.05 }),
      confidence: 0.79,
    },
    priority: {
      type: 'choice',
      name: 'priority',
      choice: 'Normal',
      probabilities: asArray({ Low: 0.2, Normal: 0.7, High: 0.1 }),
      confidence: 0.55,
    },
  };
  return {
    model: 'gpt-6-luna',
    answers: ['category', 'action', 'priority'].map((name) => overrides[name] ?? base[name]),
    usage: { input_tokens: 512, output_tokens: 0, total_tokens: 512 },
  };
}
