import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('gmail', 'demo')),
    email TEXT NOT NULL,
    granted_scopes TEXT NOT NULL DEFAULT '',
    refresh_token_enc TEXT,
    key_fingerprint TEXT,
    token_status TEXT NOT NULL DEFAULT 'ok' CHECK (token_status IN ('ok', 'reauth_required')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX accounts_one_gmail ON accounts(kind) WHERE kind = 'gmail';

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    cc_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    internal_date INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_source TEXT NOT NULL CHECK (body_source IN ('plain', 'html', 'none')),
    body_truncated INTEGER NOT NULL DEFAULT 0,
    signals TEXT NOT NULL,
    label_ids TEXT NOT NULL,
    unread INTEGER NOT NULL,
    decision_seq INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    fetched_at INTEGER NOT NULL,
    labels_checked_at INTEGER NOT NULL,
    UNIQUE (account_id, external_id)
  );
  CREATE INDEX messages_by_date ON messages(account_id, internal_date DESC);

  CREATE TABLE taxonomy_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    taxonomy TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE classifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    taxonomy_revision INTEGER NOT NULL,
    taxonomy_hash TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    provider TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    model TEXT NOT NULL,
    confidence_kind TEXT NOT NULL,
    fields TEXT NOT NULL,
    usage TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX classifications_by_message ON classifications(message_id, seq DESC);

  CREATE TABLE corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    taxonomy_revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('accept', 'edit')),
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    priority TEXT NOT NULL,
    based_on_classification_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX corrections_by_message ON corrections(message_id, seq DESC);

  CREATE TABLE label_previews (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    taxonomy_revision INTEGER NOT NULL,
    decision_seq INTEGER NOT NULL,
    decision_source TEXT NOT NULL,
    decision_ref INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    labels TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );

  CREATE TABLE label_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preview_id TEXT NOT NULL UNIQUE REFERENCES label_previews(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'noop', 'failed')),
    added_labels TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE gmail_labels (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (account_id, label_id)
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sync', 'classify')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );
  CREATE INDEX runs_by_account ON runs(account_id, kind, id DESC);
  `,
];

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    }).immediate();
  }
}
