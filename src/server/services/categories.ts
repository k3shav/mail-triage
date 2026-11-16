import { open } from 'node:fs/promises';
import { TaxonomySchema, type Taxonomy } from '../../core/taxonomy.js';
import type { Store, TaxonomyRevision } from '../db/store.js';

export const MAX_CATEGORIES_FILE_BYTES = 256 * 1024;

const TOP_LEVEL_KEYS = new Set(['$schema', 'categories', 'userContext']);
const CATEGORY_KEYS = new Set(['id', 'name', 'description']);

export type ParsedCategories = { ok: true; taxonomy: Taxonomy } | { ok: false; error: string };

/**
 * Validate a categories document. Unknown keys are rejected rather than
 * ignored, so a typo such as "usercontext" cannot silently drop a setting.
 */
export function parseCategoriesJson(text: string): ParsedCategories {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${(error as Error).message.slice(0, 120)})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the top level must be a JSON object' };
  const issues: string[] = [];
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) issues.push(`unknown key "${key.slice(0, 40)}"`);
  const categories = (raw as { categories?: unknown }).categories;
  if (Array.isArray(categories)) {
    categories.forEach((category, index) => {
      if (category && typeof category === 'object' && !Array.isArray(category)) {
        for (const key of Object.keys(category)) if (!CATEGORY_KEYS.has(key)) issues.push(`categories.${index}: unknown key "${key.slice(0, 40)}"`);
      }
    });
  }
  const parsed = TaxonomySchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  if (issues.length > 0 || !parsed.success) {
    const shown = issues.slice(0, 8);
    if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
    return { ok: false, error: shown.join('; ') };
  }
  return { ok: true, taxonomy: parsed.data };
}

/** Read the whole file (bounded) before validating, so a partial read never becomes a taxonomy. */
export async function readCategoriesFile(file: string): Promise<ParsedCategories> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? 'file not found' : `cannot be read (${code ?? 'error'})` };
  }
  try {
    const buffer = Buffer.alloc(MAX_CATEGORIES_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_CATEGORIES_FILE_BYTES) return { ok: false, error: `larger than ${MAX_CATEGORIES_FILE_BYTES / 1024} KiB` };
    }
    return parseCategoriesJson(buffer.subarray(0, length).toString('utf8'));
  } finally {
    await handle.close();
  }
}

export type CategoriesSync =
  | { ok: true; revision: TaxonomyRevision; changed: boolean }
  | { ok: false; error: string; revision: TaxonomyRevision };

/**
 * Load `file` and make it the current taxonomy. A new revision is created
 * only when the content differs from the current one. On any error the
 * stored taxonomy is left exactly as it was.
 */
export async function syncCategoriesFile(store: Store, file: string): Promise<CategoriesSync> {
  const loaded = await readCategoriesFile(file);
  if (!loaded.ok) return { ok: false, error: `CATEGORIES_FILE ${loaded.error}`, revision: store.currentTaxonomy() };
  const { revision, changed } = store.replaceTaxonomy(loaded.taxonomy);
  return { ok: true, revision, changed };
}
