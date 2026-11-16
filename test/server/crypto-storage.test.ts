import { describe, expect, it } from 'vitest';
import { DEFAULT_TAXONOMY } from '../../src/core/taxonomy.js';
import { EncryptionKeyError, SecretBox, keyFingerprint, parseEncryptionKey } from '../../src/server/crypto.js';
import { openDatabase } from '../../src/server/db/database.js';
import { StaleRevisionError, Store } from '../../src/server/db/store.js';

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

  const account = (s: Store) =>
    s.insertGmailAccount({ id: 'gmail_test', email: 'me@example.com', grantedScopes: [], refreshTokenEnc: 'v1.x.y.z', keyFingerprint: 'f' });
  const message = (id: string) => ({
    accountId: 'gmail_test',
    externalId: id,
    threadId: `t${id}`,
    from: 'a@example.com',
    to: 'b@example.com',
    cc: '',
    subject: 's',
    sentAt: '2026-11-16T00:00:00.000Z',
    internalDate: 1,
    snippet: '',
    bodyText: 'body',
    bodySource: 'plain' as const,
    bodyTruncated: false,
    signals: { hasListUnsubscribe: false, listId: null, autoSubmitted: null, precedence: null },
    labelIds: ['INBOX'],
    unread: false,
  });

  it('dedupes messages by account and external id', () => {
    const s = store();
    account(s);
    expect(s.insertMessage(message('m1'))).not.toBeNull();
    expect(s.insertMessage(message('m1'))).toBeNull();
    expect(s.countMessages('gmail_test')).toBe(1);
  });

  it('increments a per-message decision sequence and refuses results computed against an older one', () => {
    const s = store();
    account(s);
    const id = s.insertMessage(message('m1'))!;
    const answered = { status: 'answered' as const, value: 'fyi', confidence: null, selectedProbability: null, probabilities: null };
    const insert = (expectedDecisionSeq: number) =>
      s.insertClassification({
        accountId: 'gmail_test',
        messageId: id,
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
        expectedDecisionSeq,
      });
    expect(insert(0)!.seq).toBe(1);
    expect(insert(0)).toBeNull();
    expect(insert(1)!.seq).toBe(2);
    expect(s.getMessage('gmail_test', id)!.decisionSeq).toBe(2);
  });

  it('replaces the taxonomy only when its content changes', () => {
    const s = store();
    expect(s.replaceTaxonomy(structuredClone(DEFAULT_TAXONOMY))).toMatchObject({ changed: false, revision: { revision: 1 } });
    expect(s.replaceTaxonomy({ ...DEFAULT_TAXONOMY, userContext: 'Bakery owner.' })).toMatchObject({ changed: true, revision: { revision: 2 } });
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
