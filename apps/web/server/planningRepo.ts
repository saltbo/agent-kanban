import { one } from "./db";

export type DomainRow = Record<string, unknown> & { id: string; created_at: string; version?: number };

export class PlanningRepo {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  ensureTenant(): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO tenants (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')")
      .bind(this.tenantId)
      .run();
  }

  board(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM boards WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  repository(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM repositories WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  task(id: string): Promise<DomainRow> {
    return one(
      this.db
        .prepare(
          "SELECT tasks.*, EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id = d.depends_on_task_id WHERE d.task_id = tasks.id AND prerequisite.status <> 'done') AS blocked FROM tasks WHERE tasks.id = ? AND tasks.tenant_id = ?",
        )
        .bind(id, this.tenantId),
    );
  }

  label(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM labels WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  async labelsForTasks(taskIds: string[]): Promise<Array<{ task_id: string; id: string; name: string; color: string }>> {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => "?").join(",");
    return (
      await this.db
        .prepare(
          `SELECT tl.task_id, l.id, l.name, l.color
           FROM task_labels tl JOIN labels l ON l.id = tl.label_id
           WHERE l.tenant_id = ? AND tl.task_id IN (${placeholders})`,
        )
        .bind(this.tenantId, ...taskIds)
        .all<{ task_id: string; id: string; name: string; color: string }>()
    ).results;
  }

  createBoard(id: string, name: string, description: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO boards (id, tenant_id, name, description) VALUES (?, ?, ?, ?)")
      .bind(id, this.tenantId, name, description)
      .run();
  }

  updateBoard(id: string, version: number, name: string, description: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE boards SET name = ?, description = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(name, description, id, this.tenantId, version)
      .run();
  }

  hasBoardExecutionHistory(boardId: string): Promise<unknown | null> {
    return this.db
      .prepare(
        "SELECT 1 FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND t.board_id = ? LIMIT 1",
      )
      .bind(this.tenantId, boardId)
      .first();
  }

  deleteBoardWithoutExecutionHistory(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "DELETE FROM boards WHERE id = ? AND tenant_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = boards.tenant_id AND t.board_id = boards.id)",
      )
      .bind(id, this.tenantId, version)
      .run();
  }

  createRepository(id: string, name: string, url: string, defaultBranch: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO repositories (id, tenant_id, name, url, default_branch) VALUES (?, ?, ?, ?, ?)")
      .bind(id, this.tenantId, name, url, defaultBranch)
      .run();
  }

  updateRepository(id: string, version: number, name: string, defaultBranch: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE repositories SET name = ?, default_branch = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(name, defaultBranch, id, this.tenantId, version)
      .run();
  }

  deleteRepository(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db.prepare("DELETE FROM repositories WHERE id = ? AND tenant_id = ? AND version = ?").bind(id, this.tenantId, version).run();
  }

  createTask(input: {
    id: string;
    boardId: string;
    repositoryId: string | null;
    createdFromTaskId: string | null;
    title: string;
    description: string;
    priority: number;
    createdByIssuer: string | null;
    createdBySubject: string;
  }): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "INSERT INTO tasks (id, tenant_id, board_id, repository_id, created_from_task_id, title, description, priority, created_by_issuer, created_by_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.id,
        this.tenantId,
        input.boardId,
        input.repositoryId,
        input.createdFromTaskId,
        input.title,
        input.description,
        input.priority,
        input.createdByIssuer,
        input.createdBySubject,
      )
      .run();
  }

  updateTask(id: string, version: number, title: string, description: string, priority: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE tasks SET title = ?, description = ?, priority = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(title, description, priority, id, this.tenantId, version)
      .run();
  }

  hasTaskExecutionHistory(taskId: string): Promise<unknown | null> {
    return this.db.prepare("SELECT 1 FROM task_runs WHERE tenant_id = ? AND task_id = ? LIMIT 1").bind(this.tenantId, taskId).first();
  }

  deleteTaskWithoutExecutionHistory(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "DELETE FROM tasks WHERE id = ? AND tenant_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM task_runs WHERE tenant_id = tasks.tenant_id AND task_id = tasks.id)",
      )
      .bind(id, this.tenantId, version)
      .run();
  }

  async dependencies(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    const clause = cursor ? "AND (created_at < ? OR (created_at = ? AND depends_on_task_id < ?))" : "";
    const binds = cursor ? [taskId, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1] : [taskId, pageSize + 1];
    return (
      await this.db
        .prepare(
          `SELECT depends_on_task_id AS id, task_id, depends_on_task_id, created_at FROM task_dependencies WHERE task_id = ? ${clause} ORDER BY created_at DESC, depends_on_task_id DESC LIMIT ?`,
        )
        .bind(...binds)
        .all<DomainRow>()
    ).results;
  }

  dependency(taskId: string, dependencyId: string): Promise<DomainRow> {
    return one(
      this.db
        .prepare(
          "SELECT depends_on_task_id AS id, task_id, depends_on_task_id, created_at FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?",
        )
        .bind(taskId, dependencyId),
    );
  }

  async addDependency(taskId: string, dependencyId: string): Promise<"created" | "existing" | "cycle" | "locked"> {
    const inserted = await this.db
      .prepare(`WITH RECURSIVE reachable(id) AS (
      SELECT ? UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.id
    ) INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
    SELECT ?, ? FROM tasks t
    WHERE t.id = ? AND t.tenant_id = ? AND t.status = 'todo'
      AND NOT EXISTS (SELECT 1 FROM reachable WHERE id = ?)`)
      .bind(dependencyId, taskId, dependencyId, taskId, this.tenantId, taskId)
      .run();
    if ((inserted.meta.changes ?? 0) === 1) return "created";
    const existing = await this.db
      .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .bind(taskId, dependencyId)
      .first();
    if (existing) return "existing";
    const mutable = await this.db
      .prepare("SELECT 1 FROM tasks WHERE id = ? AND tenant_id = ? AND status = 'todo'")
      .bind(taskId, this.tenantId)
      .first();
    return mutable ? "cycle" : "locked";
  }

  removeDependency(taskId: string, dependencyId: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = task_dependencies.task_id AND tenant_id = ? AND status = 'todo')",
      )
      .bind(taskId, dependencyId, this.tenantId)
      .run();
  }

  createLabel(id: string, boardId: string, name: string, color: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO labels (id, tenant_id, board_id, name, color) VALUES (?, ?, ?, ?, ?)")
      .bind(id, this.tenantId, boardId, name, color)
      .run();
  }

  updateLabel(id: string, version: number, name: string, color: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE labels SET name = ?, color = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(name, color, id, this.tenantId, version)
      .run();
  }

  deleteLabel(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db.prepare("DELETE FROM labels WHERE id = ? AND tenant_id = ? AND version = ?").bind(id, this.tenantId, version).run();
  }

  attachLabel(taskId: string, labelId: string): Promise<D1Result<unknown>> {
    return this.db.prepare("INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)").bind(taskId, labelId).run();
  }

  async hasTaskLabel(taskId: string, labelId: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 FROM task_labels WHERE task_id = ? AND label_id = ?").bind(taskId, labelId).first());
  }

  async taskLabels(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    const cursorClause = cursor ? " AND (l.created_at < ? OR (l.created_at = ? AND l.id < ?))" : "";
    const values = cursor
      ? [this.tenantId, taskId, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1]
      : [this.tenantId, taskId, pageSize + 1];
    const result = await this.db
      .prepare(
        `SELECT l.* FROM labels l
         JOIN task_labels tl ON tl.label_id = l.id
         WHERE l.tenant_id = ? AND tl.task_id = ?${cursorClause}
         ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
      )
      .bind(...values)
      .all<DomainRow>();
    return result.results;
  }

  detachLabel(taskId: string, labelId: string): Promise<D1Result<unknown>> {
    return this.db.prepare("DELETE FROM task_labels WHERE task_id = ? AND label_id = ?").bind(taskId, labelId).run();
  }

  boards(cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("boards", "tenant_id = ?", [this.tenantId], cursor, pageSize);
  }

  repositories(cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("repositories", "tenant_id = ?", [this.tenantId], cursor, pageSize);
  }

  tasks(boardId: string, status: string | undefined, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return status
      ? this.list("tasks", "tenant_id = ? AND board_id = ? AND status = ?", [this.tenantId, boardId, status], cursor, pageSize)
      : this.list("tasks", "tenant_id = ? AND board_id = ?", [this.tenantId, boardId], cursor, pageSize);
  }

  labels(boardId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("labels", "tenant_id = ? AND board_id = ?", [this.tenantId, boardId], cursor, pageSize);
  }

  private async list(
    table: string,
    where: string,
    values: unknown[],
    cursor: { createdAt: string; id: string } | null,
    pageSize: number,
  ): Promise<DomainRow[]> {
    const cursorClause = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const binds = cursor ? [...values, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1] : [...values, pageSize + 1];
    const selection =
      table === "tasks"
        ? "tasks.*, EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id = d.depends_on_task_id WHERE d.task_id = tasks.id AND prerequisite.status <> 'done') AS blocked"
        : "*";
    return (
      await this.db
        .prepare(`SELECT ${selection} FROM ${table} WHERE ${where}${cursorClause} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...binds)
        .all<DomainRow>()
    ).results;
  }
}
