import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TAXONOMY } from '../../src/core/taxonomy.js';
import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import { MAX_CATEGORIES_FILE_BYTES, parseCategoriesJson, syncCategoriesFile } from '../../src/server/services/categories.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-triage-cat-'));
  dirs.push(dir);
  const target = path.join(dir, 'categories.json');
  writeFileSync(target, content);
  return target;
}

describe('categories file', () => {
  it('ships an example equal to the built-in defaults', () => {
    const example = parseCategoriesJson(readFileSync(new URL('../../examples/categories.json', import.meta.url), 'utf8'));
    expect(example).toEqual({ ok: true, taxonomy: DEFAULT_TAXONOMY });
  });

  it('creates a revision only when the content changes, regardless of formatting', async () => {
    const store = new Store(openDatabase(':memory:'));
    const target = file(JSON.stringify(DEFAULT_TAXONOMY));
    expect(await syncCategoriesFile(store, target)).toMatchObject({ ok: true, changed: false, revision: { revision: 1 } });

    const edited = { ...DEFAULT_TAXONOMY, userContext: 'I run a small bakery.' };
    writeFileSync(target, JSON.stringify(edited));
    expect(await syncCategoriesFile(store, target)).toMatchObject({ ok: true, changed: true, revision: { revision: 2 } });
    writeFileSync(target, JSON.stringify(edited, null, 4));
    expect(await syncCategoriesFile(store, target)).toMatchObject({ ok: true, changed: false, revision: { revision: 2 } });
  });

  it('leaves the saved taxonomy untouched for missing, malformed, invalid, or oversized files', async () => {
    const store = new Store(openDatabase(':memory:'));
    const saved = store.currentTaxonomy();
    const bad = [
      ['{ "categories": [', /not valid JSON/],
      ['[]', /top level must be a JSON object/],
      [JSON.stringify({ ...DEFAULT_TAXONOMY, usercontext: 'typo' }), /unknown key "usercontext"/],
      [JSON.stringify({ categories: [{ ...DEFAULT_TAXONOMY.categories[0], label: 'x' }, DEFAULT_TAXONOMY.categories[1]] }), /categories\.0: unknown key "label"/],
      [JSON.stringify({ categories: [DEFAULT_TAXONOMY.categories[0]] }), /categories/],
      [JSON.stringify({ categories: [{ id: 'a', name: 'A/B', description: 'x' }, { id: 'b', name: 'B', description: 'y' }] }), /slashes/],
      [JSON.stringify({ categories: [{ id: 'Bad Id', name: 'A', description: 'x' }, { id: 'b', name: 'B', description: 'y' }] }), /lowercase/],
      [' '.repeat(MAX_CATEGORIES_FILE_BYTES + 1), /larger than/],
    ] as const;
    for (const [content, message] of bad) {
      const result = await syncCategoriesFile(store, file(content));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(message);
    }
    expect((await syncCategoriesFile(store, '/nonexistent/categories.json')).ok).toBe(false);
    expect(store.currentTaxonomy()).toEqual(saved);
  });
});
