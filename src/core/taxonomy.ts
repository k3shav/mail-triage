import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Category, action, and priority are separate questions. A deployment
 * notification can need action; a marketing email usually does not.
 */

export const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_CATEGORIES = 25;
export const MIN_CATEGORIES = 2;
export const MAX_USER_CONTEXT_CHARS = 2000;
export const MAX_CATEGORY_DESCRIPTION_CHARS = 500;

/** Names become Gmail label path segments and model-visible choice values. */
const categoryName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(40, 'Name must be 40 characters or fewer')
  .refine((value) => !/[/\\]/.test(value), 'Name cannot contain slashes')
  .refine((value) => !/\p{Cc}/u.test(value), 'Name cannot contain control characters');

export const CategorySchema = z.object({
  id: z.string().regex(CATEGORY_ID_PATTERN, 'Id must be lowercase letters, digits, or underscores'),
  name: categoryName,
  description: z
    .string()
    .trim()
    .min(1, 'Description is required')
    .max(MAX_CATEGORY_DESCRIPTION_CHARS),
});
export type Category = z.infer<typeof CategorySchema>;

export const TaxonomySchema = z
  .object({
    categories: z.array(CategorySchema).min(MIN_CATEGORIES).max(MAX_CATEGORIES),
    userContext: z.string().trim().max(MAX_USER_CONTEXT_CHARS).default(''),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    value.categories.forEach((category, index) => {
      if (ids.has(category.id)) {
        ctx.addIssue({ code: 'custom', path: ['categories', index, 'id'], message: `Duplicate category id "${category.id}"` });
      }
      const folded = category.name.toLocaleLowerCase('en-US');
      if (names.has(folded)) {
        ctx.addIssue({ code: 'custom', path: ['categories', index, 'name'], message: `Duplicate category name "${category.name}"` });
      }
      ids.add(category.id);
      names.add(folded);
    });
  });
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const DEFAULT_CATEGORIES: readonly Category[] = [
  {
    id: 'fyi',
    name: 'FYI',
    description:
      'Personal or work updates written for me to read, such as announcements, status updates, or shared information, that are not newsletters or automated alerts.',
  },
  {
    id: 'marketing',
    name: 'Marketing',
    description:
      'Promotions, newsletters, product announcements, sales, and other bulk mail sent to many recipients to sell or promote something.',
  },
  {
    id: 'comment',
    name: 'Comment',
    description:
      'A comment, mention, reply, or review on a shared document, issue, pull request, post, or thread.',
  },
  {
    id: 'notification',
    name: 'Notification',
    description:
      'Automated alerts from a service or system, such as security alerts, build results, shipping updates, account changes, or reminders.',
  },
  {
    id: 'receipt',
    name: 'Receipt',
    description: 'Receipts, invoices, order confirmations, payment confirmations, and billing statements.',
  },
  {
    id: 'meeting',
    name: 'Meeting',
    description:
      'Calendar invitations, meeting requests, scheduling, rescheduling, cancellations, or meeting notes.',
  },
  {
    id: 'other',
    name: 'Other',
    description: 'Email that does not clearly fit any other category.',
  },
];

export const DEFAULT_TAXONOMY: Taxonomy = {
  categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
  userContext: '',
};

export interface FixedOption {
  id: string;
  name: string;
  description: string;
}

export const ACTIONS = [
  {
    id: 'needs_response',
    name: 'Needs Response',
    description: 'The sender is waiting for a written reply from me.',
  },
  {
    id: 'needs_action',
    name: 'Needs Action',
    description:
      'I need to do something other than reply, such as pay, approve, review, sign, fix, register, or follow up, but no written reply is expected.',
  },
  {
    id: 'no_action',
    name: 'No Action',
    description: 'Nothing is required from me; reading it, or ignoring it, is enough.',
  },
] as const satisfies readonly FixedOption[];
export type ActionId = (typeof ACTIONS)[number]['id'];

export const PRIORITIES = [
  {
    id: 'low',
    name: 'Low',
    description: 'Can wait indefinitely or be skimmed later; no consequence if it is never read.',
  },
  {
    id: 'normal',
    name: 'Normal',
    description: 'Should be read in the ordinary course of the next few days.',
  },
  {
    id: 'high',
    name: 'High',
    description: 'Time-sensitive or important to me; should be read today.',
  },
] as const satisfies readonly FixedOption[];
export type PriorityId = (typeof PRIORITIES)[number]['id'];

export const FIELD_NAMES = ['category', 'action', 'priority'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  category: 'Category',
  action: 'Action',
  priority: 'Priority',
};

export function optionsForField(taxonomy: Taxonomy, field: FieldName): readonly FixedOption[] {
  if (field === 'category') return taxonomy.categories;
  if (field === 'action') return ACTIONS;
  return PRIORITIES;
}

export function isValidOptionId(taxonomy: Taxonomy, field: FieldName, id: string): boolean {
  return optionsForField(taxonomy, field).some((option) => option.id === id);
}

export function optionName(taxonomy: Taxonomy, field: FieldName, id: string): string | undefined {
  return optionsForField(taxonomy, field).find((option) => option.id === id)?.name;
}

/** Derive a stable id for a new category; ids never change after creation. */
export function slugifyCategoryId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  if (!base || !/^[a-z]/.test(base)) base = `c_${base}`.replace(/_+$/, '').slice(0, 24) || 'category';
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content hash of everything that changes what the model is asked. Category
 * order is included because some providers are sensitive to option order.
 */
export function taxonomyHash(taxonomy: Taxonomy, promptVersion: string): string {
  return createHash('sha256')
    .update(canonicalJson({ promptVersion, taxonomy }))
    .digest('hex')
    .slice(0, 16);
}
