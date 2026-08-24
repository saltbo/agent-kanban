// @vitest-environment node

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../apps/web/migrations/0044_task_error_queue.sql", import.meta.url), "utf8");

let db: DatabaseSync | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createPreMigrationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE boards (id TEXT PRIMARY KEY);
    CREATE TABLE repositories (id TEXT PRIMARY KEY);
    CREATE TABLE agents (id TEXT PRIMARY KEY);

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'todo'
        CHECK(status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
      title TEXT NOT NULL,
      description TEXT,
      repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
      labels TEXT,
      created_by TEXT,
      assigned_to TEXT REFERENCES agents(id) ON DELETE SET NULL,
      result TEXT,
      pr_url TEXT,
      input TEXT,
      created_from TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      seq INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_tasks_board ON tasks(board_id);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_repository ON tasks(repository_id);
    CREATE INDEX idx_tasks_created_from ON tasks(created_from);
    CREATE UNIQUE INDEX idx_tasks_board_seq ON tasks(board_id, seq);
    CREATE INDEX idx_tasks_assigned_status ON tasks(assigned_to, status);

    CREATE TABLE task_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
    CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);
    CREATE INDEX idx_task_actions_session ON task_actions(session_id);

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on),
      CHECK(task_id != depends_on)
    );
    CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent')),
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_messages_task ON messages(task_id, created_at);

    INSERT INTO boards (id) VALUES ('board-1');
    INSERT INTO repositories (id) VALUES ('repo-1');
    INSERT INTO agents (id) VALUES ('agent-1');
    INSERT INTO tasks (
      id, board_id, status, title, description, repository_id, labels,
      created_by, assigned_to, input, position, created_at, updated_at, seq, metadata
    ) VALUES (
      'task-parent', 'board-1', 'done', 'Parent', 'parent detail', 'repo-1', '["parent"]',
      'user-1', 'agent-1', '{"source":"test"}', 1,
      '2026-08-24T01:00:00.000Z', '2026-08-24T02:00:00.000Z', 1, '{"annotations":{"keep":true}}'
    );
    INSERT INTO tasks (
      id, board_id, status, title, created_from, position, created_at, updated_at, seq, metadata
    ) VALUES (
      'task-child', 'board-1', 'in_progress', 'Child', 'task-parent', 2,
      '2026-08-24T03:00:00.000Z', '2026-08-24T04:00:00.000Z', 2, '{}'
    );
    INSERT INTO task_dependencies (task_id, depends_on) VALUES ('task-child', 'task-parent');
    INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
      VALUES ('action-1', 'task-child', 'agent:worker', 'agent-1', 'claimed', 'claim detail', 'session-1', '2026-08-24T05:00:00.000Z');
    INSERT INTO messages (id, task_id, sender_type, sender_id, content, created_at)
      VALUES ('message-1', 'task-child', 'user', 'user-1', 'preserve me', '2026-08-24T06:00:00.000Z');
  `);
  return database;
}

describe("0044 task error queue migration", () => {
  it("preserves task graph data when executed transactionally with foreign keys enabled", () => {
    db = createPreMigrationDatabase();
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });

    db.exec(`BEGIN IMMEDIATE;\n${migration}\nCOMMIT;`);

    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_actions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });

    expect(db.prepare("SELECT status, created_from, seq, metadata FROM tasks WHERE id = 'task-child'").get()).toEqual({
      status: "in_progress",
      created_from: "task-parent",
      seq: 2,
      metadata: "{}",
    });
    expect(db.prepare("SELECT task_id, depends_on FROM task_dependencies").get()).toEqual({
      task_id: "task-child",
      depends_on: "task-parent",
    });
    expect(db.prepare("SELECT action, detail, session_id, created_at FROM task_actions WHERE id = 'action-1'").get()).toEqual({
      action: "claimed",
      detail: "claim detail",
      session_id: "session-1",
      created_at: "2026-08-24T05:00:00.000Z",
    });
    expect(db.prepare("SELECT content, created_at FROM messages WHERE id = 'message-1'").get()).toEqual({
      content: "preserve me",
      created_at: "2026-08-24T06:00:00.000Z",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    db.exec(`
      UPDATE tasks SET status = 'error' WHERE id = 'task-child';
      INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, created_at)
        VALUES ('action-failed', 'task-child', 'machine', 'machine-1', 'failed', '2026-08-24T07:00:00.000Z');
      INSERT INTO task_errors (
        id, task_id, session_id, runtime, category, code, message, http_status, retryable, created_at
      ) VALUES (
        'error-1', 'task-child', 'session-1', 'claude', 'authentication', 'HTTP_403',
        'permission denied', 403, 0, '2026-08-24T07:00:00.000Z'
      );
    `);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'task-child'").get()).toEqual({ status: "error" });
    expect(db.prepare("SELECT category, code, http_status, retryable FROM task_errors WHERE id = 'error-1'").get()).toEqual({
      category: "authentication",
      code: "HTTP_403",
      http_status: 403,
      retryable: 0,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
