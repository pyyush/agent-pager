-- AgentPager SQLite Schema
-- WAL mode for concurrent reads during writes

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  agent_version TEXT DEFAULT '',
  task TEXT DEFAULT '',
  cwd TEXT DEFAULT '',
  tmux_session TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  auto_approve INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

-- Events (append-only log — enables replay on reconnect)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

-- Pending approvals (active permission requests)
CREATE TABLE IF NOT EXISTS pending_approvals (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'safe',
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_pending_unresolved ON pending_approvals(resolved_at) WHERE resolved_at IS NULL;

-- Paired devices
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- Auto-approve trust rules
CREATE TABLE IF NOT EXISTS trust_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  target_pattern TEXT,
  risk_max TEXT NOT NULL DEFAULT 'safe',
  scope TEXT NOT NULL DEFAULT 'session',
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trust_tool ON trust_rules(tool);
CREATE INDEX IF NOT EXISTS idx_trust_session ON trust_rules(session_id);

-- FTS5 for full-text search of events
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  payload,
  content=events,
  content_rowid=id
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, payload) VALUES (new.id, new.payload);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload);
  INSERT INTO events_fts(rowid, payload) VALUES (new.id, new.payload);
END;
