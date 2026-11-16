import { describe, expect, it } from 'vitest';
import { categoryTone, initials, parseAddress } from '../src/web/format.js';

describe('web formatting helpers', () => {
  it('parses display names and bare addresses', () => {
    expect(parseAddress('"Shah, Priya" <priya@northwind.example>')).toEqual({ name: 'Shah, Priya', address: 'priya@northwind.example' });
    expect(parseAddress('ops@service.example')).toEqual({ name: 'ops@service.example', address: 'ops@service.example' });
    expect(initials('Priya Shah')).toBe('PS');
    expect(initials('<script>')).toBe('S');
  });

  it('gives the default categories distinct colors', () => {
    const taxonomy = { userContext: '', categories: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, name: id, description: id })) };
    const tones = taxonomy.categories.map((c) => categoryTone(taxonomy, c.id));
    expect(new Set(tones).size).toBe(7);
  });
});
