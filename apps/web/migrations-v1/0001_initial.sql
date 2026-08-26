-- Agent Kanban schema
-- Auth tables (user, session, account, verification) managed by better-auth

-- Better Auth
CREATE TABLE "user" (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  emailVerified  INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  createdAt      TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "session" (
  id        TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  ipAddress TEXT,
  userAgent TEXT,
  userId    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "account" (
  id                    TEXT PRIMARY KEY,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  password              TEXT,
  createdAt             TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "verification" (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Better Auth plugins: API key, Agent Auth
CREATE TABLE "apikey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "configId" TEXT NOT NULL,
  "name" TEXT,
  "start" TEXT,
  "referenceId" TEXT NOT NULL,
  "prefix" TEXT,
  "key" TEXT NOT NULL,
  "refillInterval" INTEGER,
  "refillAmount" INTEGER,
  "lastRefillAt" DATE,
  "enabled" INTEGER,
  "rateLimitEnabled" INTEGER,
  "rateLimitTimeWindow" INTEGER,
  "rateLimitMax" INTEGER,
  "requestCount" INTEGER,
  "remaining" INTEGER,
  "lastRequest" DATE,
  "expiresAt" DATE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "permissions" TEXT,
  "metadata" TEXT
);
CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");

CREATE TABLE "agentHost" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "defaultCapabilities" TEXT,
  "publicKey" TEXT,
  "kid" TEXT,
  "jwksUrl" TEXT,
  "enrollmentTokenHash" TEXT,
  "enrollmentTokenExpiresAt" DATE,
  "status" TEXT NOT NULL,
  "activatedAt" DATE,
  "expiresAt" DATE,
  "lastUsedAt" DATE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "agentHost_userId_idx" ON "agentHost" ("userId");
CREATE INDEX "agentHost_kid_idx" ON "agentHost" ("kid");
CREATE INDEX "agentHost_enrollmentTokenHash_idx" ON "agentHost" ("enrollmentTokenHash");
CREATE INDEX "agentHost_status_idx" ON "agentHost" ("status");

CREATE TABLE "agent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "hostId" TEXT NOT NULL REFERENCES "agentHost" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "kid" TEXT,
  "jwksUrl" TEXT,
  "lastUsedAt" DATE,
  "activatedAt" DATE,
  "expiresAt" DATE,
  "metadata" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "agent_userId_idx" ON "agent" ("userId");
CREATE INDEX "agent_hostId_idx" ON "agent" ("hostId");
CREATE INDEX "agent_status_idx" ON "agent" ("status");
CREATE INDEX "agent_kid_idx" ON "agent" ("kid");

CREATE TABLE "agentCapabilityGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  "capability" TEXT NOT NULL,
  "deniedBy" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "grantedBy" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "expiresAt" DATE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "constraints" TEXT
);
CREATE INDEX "agentCapabilityGrant_agentId_idx" ON "agentCapabilityGrant" ("agentId");
CREATE INDEX "agentCapabilityGrant_capability_idx" ON "agentCapabilityGrant" ("capability");
CREATE INDEX "agentCapabilityGrant_grantedBy_idx" ON "agentCapabilityGrant" ("grantedBy");
CREATE INDEX "agentCapabilityGrant_status_idx" ON "agentCapabilityGrant" ("status");

CREATE TABLE "approvalRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "method" TEXT NOT NULL,
  "agentId" TEXT REFERENCES "agent" ("id") ON DELETE CASCADE,
  "hostId" TEXT REFERENCES "agentHost" ("id") ON DELETE CASCADE,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "capabilities" TEXT,
  "status" TEXT NOT NULL,
  "userCodeHash" TEXT,
  "loginHint" TEXT,
  "bindingMessage" TEXT,
  "clientNotificationToken" TEXT,
  "clientNotificationEndpoint" TEXT,
  "deliveryMode" TEXT,
  "interval" INTEGER NOT NULL,
  "lastPolledAt" DATE,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "approvalRequest_agentId_idx" ON "approvalRequest" ("agentId");
CREATE INDEX "approvalRequest_hostId_idx" ON "approvalRequest" ("hostId");
CREATE INDEX "approvalRequest_userId_idx" ON "approvalRequest" ("userId");
CREATE INDEX "approvalRequest_status_idx" ON "approvalRequest" ("status");

-- Boards
CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_boards_owner ON boards(owner_id);
CREATE UNIQUE INDEX idx_boards_owner_name ON boards(owner_id, name);

-- Repositories
CREATE TABLE repositories (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_repositories_owner ON repositories(owner_id);
CREATE UNIQUE INDEX idx_repositories_owner_url ON repositories(owner_id, url);

-- Machines (no key_hash — auth handled by Better Auth API key plugin)
CREATE TABLE machines (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'offline',
  os                TEXT,
  version           TEXT,
  runtimes          TEXT,
  usage_info        TEXT,
  last_heartbeat_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_machines_owner ON machines(owner_id);

-- Agents (persistent identity, owned by tenant)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  bio             TEXT,
  soul            TEXT,
  role            TEXT,
  handoff_to      TEXT,
  runtime         TEXT,
  model           TEXT,
  skills          TEXT,
  public_key      TEXT NOT NULL,
  private_key     TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  builtin         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agents_owner ON agents(owner_id);

-- Agent Sessions (ephemeral, PGP subkey delegation)
CREATE TABLE agent_sessions (
  id                    TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  machine_id            TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed')),
  public_key            TEXT NOT NULL,
  delegation_proof      TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at             TEXT
);
CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX idx_agent_sessions_machine ON agent_sessions(machine_id);

-- Tasks
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'todo'
               CHECK(status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  title        TEXT NOT NULL,
  description  TEXT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  labels       TEXT,
  priority     TEXT CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  created_by   TEXT,
  assigned_to  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  result       TEXT,
  pr_url       TEXT,
  input        TEXT,
  created_from TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_board ON tasks(board_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repository ON tasks(repository_id);
CREATE INDEX idx_tasks_created_from ON tasks(created_from);

-- Task dependencies (DAG)
CREATE TABLE task_dependencies (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK(task_id != depends_on)
);
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on);

-- Task logs
CREATE TABLE task_logs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id    TEXT,
  session_id  TEXT,
  action      TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected', 'review_requested'
  )),
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_logs_task ON task_logs(task_id);

-- Messages
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent')),
  sender_id   TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_task ON messages(task_id, created_at);
