import { one } from "./db";
import type { DomainRow } from "./planningRepo";

export class AccessRepo {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  membership(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM board_memberships WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  assignment(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_assignments WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  activeAssignment(taskId: string): Promise<{ id: string; agent_id: string }> {
    return one(
      this.db
        .prepare("SELECT id, agent_id FROM task_assignments WHERE tenant_id = ? AND task_id = ? AND status = 'active'")
        .bind(this.tenantId, taskId),
      "The task has no active assignment.",
    );
  }

  activeAssignmentWithBoard(taskId: string): Promise<{ agent_id: string; board_id: string } | null> {
    return this.db
      .prepare(
        `SELECT assignment.agent_id, task.board_id FROM task_assignments assignment
         JOIN tasks task ON task.id = assignment.task_id AND task.tenant_id = assignment.tenant_id
         WHERE assignment.tenant_id = ? AND assignment.task_id = ? AND assignment.status = 'active'`,
      )
      .bind(this.tenantId, taskId)
      .first<{ agent_id: string; board_id: string }>();
  }

  async hasCapability(boardId: string, agentId: string, capability: string): Promise<boolean> {
    return Boolean(
      await this.db
        .prepare(
          "SELECT 1 FROM board_memberships WHERE tenant_id = ? AND board_id = ? AND agent_id = ? AND EXISTS (SELECT 1 FROM json_each(capabilities_json) WHERE value = ?)",
        )
        .bind(this.tenantId, boardId, agentId, capability)
        .first(),
    );
  }

  async hasWorkMembership(boardId: string, agentId: string): Promise<boolean> {
    return this.hasCapability(boardId, agentId, "work");
  }

  async activeAssignmentsForTasks(taskIds: string[]): Promise<DomainRow[]> {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => "?").join(",");
    return (
      await this.db
        .prepare(`SELECT * FROM task_assignments WHERE tenant_id = ? AND status = 'active' AND task_id IN (${placeholders})`)
        .bind(this.tenantId, ...taskIds)
        .all<DomainRow>()
    ).results;
  }

  createMembership(id: string, boardId: string, agentId: string, capabilities: string[]): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO board_memberships (id, tenant_id, board_id, agent_id, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .bind(id, this.tenantId, boardId, agentId, JSON.stringify(capabilities))
      .run();
  }

  updateMembership(id: string, version: number, capabilities: string[]): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE board_memberships SET capabilities_json = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(JSON.stringify(capabilities), id, this.tenantId, version)
      .run();
  }

  deleteMembership(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db.prepare("DELETE FROM board_memberships WHERE id = ? AND tenant_id = ? AND version = ?").bind(id, this.tenantId, version).run();
  }

  async createAssignment(id: string, taskId: string, agentId: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO task_assignments (id, tenant_id, task_id, agent_id)
           SELECT ?, tasks.tenant_id, tasks.id, ? FROM tasks
           WHERE tasks.id = ? AND tasks.tenant_id = ? AND tasks.status = 'todo'
             AND NOT EXISTS (
               SELECT 1 FROM task_assignments
               WHERE tenant_id = tasks.tenant_id AND task_id = tasks.id AND status = 'active'
             )
             AND EXISTS (
               SELECT 1 FROM board_memberships membership
               WHERE membership.tenant_id = tasks.tenant_id AND membership.board_id = tasks.board_id
                 AND membership.agent_id = ?
                 AND EXISTS (SELECT 1 FROM json_each(membership.capabilities_json) WHERE value = 'work')
             )`,
        )
        .bind(id, agentId, taskId, this.tenantId, agentId),
      this.db
        .prepare(
          "UPDATE tasks SET status = 'queued', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'todo' AND EXISTS (SELECT 1 FROM task_assignments WHERE id = ? AND tenant_id = ?)",
        )
        .bind(taskId, this.tenantId, id, this.tenantId),
    ]);
    return (results[0].meta.changes ?? 0) === 1;
  }

  hasAssignmentExecutionHistory(assignmentId: string): Promise<unknown | null> {
    return this.db.prepare("SELECT 1 FROM task_runs WHERE tenant_id = ? AND assignment_id = ? LIMIT 1").bind(this.tenantId, assignmentId).first();
  }

  async releaseAssignmentWithoutExecutionHistory(id: string, version: number): Promise<D1Result<unknown>> {
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE task_assignments SET status = 'released', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'active' AND version = ? AND NOT EXISTS (SELECT 1 FROM task_runs WHERE tenant_id = task_assignments.tenant_id AND assignment_id = task_assignments.id)",
        )
        .bind(id, this.tenantId, version),
      this.db
        .prepare(
          "UPDATE tasks SET status = 'todo', version = version + 1, updated_at = datetime('now') WHERE tenant_id = ? AND status = 'queued' AND id = (SELECT task_id FROM task_assignments WHERE id = ? AND tenant_id = ? AND status = 'released')",
        )
        .bind(this.tenantId, id, this.tenantId),
    ]);
    return results[0];
  }

  memberships(boardId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("board_memberships", "board_id = ?", boardId, cursor, pageSize);
  }

  assignments(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_assignments", "task_id = ?", taskId, cursor, pageSize);
  }

  private async list(
    table: "board_memberships" | "task_assignments",
    predicate: string,
    value: string,
    cursor: { createdAt: string; id: string } | null,
    pageSize: number,
  ): Promise<DomainRow[]> {
    const clause = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const binds = cursor ? [this.tenantId, value, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1] : [this.tenantId, value, pageSize + 1];
    return (
      await this.db
        .prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND ${predicate}${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...binds)
        .all<DomainRow>()
    ).results;
  }
}
