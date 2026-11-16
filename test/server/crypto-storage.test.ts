import { describe, expect, it } from 'vitest';
import { DEFAULT_TAXONOMY } from '../../src/core/taxonomy.js';
import { EncryptionKeyError, SecretBox, keyFingerprint, parseEncryptionKey } from '../../src/server/crypto.js';
import { openDatabase } from '../../src/server/db/database.js';
import { StaleRevisionError, Store } from '../../src/server/db/store.js';
import { seedDemoInbox } from '../../src/server/services/sync.js';

describe('token encryption', () => {
  const key = parseEncryptionKey(Buffer.alloc(32, 1).toString('base64'));
  const box = new SecretBox(key);

  it('round-trips and uses a fresh IV each time', () => {
    const a = box.encrypt('1//refresh-token', 'gmail_abc');
    const b = box.encrypt('1//refresh-token', 'gmail_abc');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh');
    expect(box.decrypt(a, 'gmail_abc')).toBe('1//refresh-token');
  });

  it('binds ciphertext to its account and detects tampering or a wrong key', () => {
    const sealed = box.encrypt('secret', 'gmail_abc');
    expect(() => box.decrypt(sealed, 'gmail_other')).toThrow(EncryptionKeyError);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'gmail_abc')).toThrow(EncryptionKeyError);
    const other = new SecretBox(parseEncryptionKey('ab'.repeat(32)));
    expect(() => other.decrypt(sealed, 'gmail_abc')).toThrow(EncryptionKeyError);
  });

  it('accepts base64 and hex keys of exactly 32 bytes', () => {
    expect(parseEncryptionKey('00'.repeat(32))).toHaveLength(32);
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 random bytes/);
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('storage', () => {
  const store = () => new Store(openDatabase(':memory:'));

  it('seeds the default taxonomy as revision 1 and versions edits with optimistic concurrency', () => {
    const s = store();
    expect(s.currentTaxonomy().revision).toBe(1);
    const edited = { ...DEFAULT_TAXONOMY, userContext: 'I run a bakery.' };
    const result = s.updateTaxonomy(edited, 1);
    expect(result).toMatchObject({ changed: true, revision: { revision: 2 } });
    expect(() => s.updateTaxonomy(DEFAULT_TAXONOMY, 1)).toThrow(StaleRevisionError);
    expect(s.updateTaxonomy(edited, 2).changed).toBe(false);
  });

  it('dedupes messages by account and external id', () => {
    const s = store();
    expect(seedDemoInbox(s)).toBe(12);
    expect(seedDemoInbox(s)).toBe(0);
    expect(s.countMessages('demo')).toBe(12);
  });

  it('increments a per-message decision sequence across classifications and corrections', () => {
    const s = store();
    seedDemoInbox(s);
    const [message] = s.listMessages('demo', 1);
    const answered = { status: 'answered' as const, value: 'fyi', confidence: null, selectedProbability: null, probabilities: null };
    const c = s.insertClassification({
      accountId: 'demo',
      messageId: message!.id,
      taxonomyRevision: 1,
      taxonomyHash: s.currentTaxonomy().hash,
      promptVersion: 'p',
      decision: {
        provider: 'fixture',
        requestedModel: 'm',
        model: 'm',
        confidenceKind: 'none',
        fields: { category: answered, action: { ...answered, value: 'no_action' }, priority: { ...answered, value: 'low' } },
        usage: null,
      },
      expectedDecisionSeq: 0,
    })!;
    const k = s.insertCorrection({
      accountId: 'demo',
      messageId: message!.id,
      expectedTaxonomyRevision: 1,
      expectedDecisionSeq: 1,
      kind: 'edit',
      category: 'receipt',
      action: 'no_action',
      priority: 'low',
      basedOnClassificationId: c.id,
    });
    expect([c.seq, k.seq]).toEqual([1, 2]);
    expect(s.getMessage('demo', message!.id)!.decisionSeq).toBe(2);
  });

  it('grants a lock to one owner until it is released or expires', () => {
    let now = 1000;
    const s = new Store(openDatabase(':memory:'), () => now);
    expect(s.acquireLock('sync:a', 'one', 100)).toBe(true);
    expect(s.acquireLock('sync:a', 'two', 100)).toBe(false);
    now += 101;
    expect(s.acquireLock('sync:a', 'two', 100)).toBe(true);
    s.releaseLock('sync:a', 'one');
    expect(s.acquireLock('sync:a', 'three', 100)).toBe(false);
    s.releaseLock('sync:a', 'two');
    expect(s.acquireLock('sync:a', 'three', 100)).toBe(true);
  });
});
