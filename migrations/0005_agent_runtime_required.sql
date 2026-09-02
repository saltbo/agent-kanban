-- Backfill NULL runtimes with 'claude-code' then enforce NOT NULL
-- Normalize legacy runtime names
UPDATE agents SET runtime = 'claude' WHERE runtime IN ('claude-code', 'Claude Code');
UPDATE agents SET runtime = 'codex' WHERE runtime = 'codex-cli';

-- Backfill NULL runtimes with 'claude'
UPDATE agents SET runtime = 'claude' WHERE runtime IS NULL;

-- D1 doesn't support ALTER COLUMN, so recreate the table
CREATE TABLE agents_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT,
  soul TEXT,
  role TEXT,
  kind TEXT NOT NULL DEFAULT 'worker',
  handoff_to TEXT,
  runtime TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  skills TEXT,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agents_new (id, owner_id, name, bio, soul, role, kind, handoff_to, runtime, model, skills, public_key, private_key, fingerprint, builtin, created_at, updated_at)
  SELECT id, owner_id, name, bio, soul, role, kind, handoff_to, runtime, model, skills, public_key, private_key, fingerprint, builtin, created_at, updated_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
