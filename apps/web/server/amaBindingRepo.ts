import { one } from "./db";
import type { DomainRow } from "./planningRepo";

export type ActiveAmaBinding = {
  project_uri: string;
  resource_url: string;
  authorized_subject_id: string;
};

export class AmaBindingRepo {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  connection(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM ama_connections WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  binding(boardId: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM board_execution_bindings WHERE board_id = ? AND tenant_id = ?").bind(boardId, this.tenantId));
  }

  activeBinding(boardId: string, detail = "The board has no active AMA execution binding."): Promise<ActiveAmaBinding> {
    return one(
      this.db
        .prepare(
          "SELECT ac.project_uri, ac.resource_url, ac.authorized_subject_id FROM board_execution_bindings b JOIN ama_connections ac ON ac.id = b.ama_connection_id AND ac.tenant_id = b.tenant_id WHERE b.tenant_id = ? AND b.board_id = ? AND ac.status = 'active'",
        )
        .bind(this.tenantId, boardId),
      detail,
    );
  }

  createConnection(id: string, resourceUrl: string, projectUri: string, authorizedSubjectId: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO ama_connections (id, tenant_id, resource_url, project_uri, authorized_subject_id) VALUES (?, ?, ?, ?, ?)")
      .bind(id, this.tenantId, resourceUrl, projectUri, authorizedSubjectId)
      .run();
  }

  updateConnectionStatus(id: string, version: number, status: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE ama_connections SET status = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND version = ?",
      )
      .bind(status, id, this.tenantId, version)
      .run();
  }

  connectionInUse(id: string): Promise<unknown | null> {
    return this.db
      .prepare("SELECT 1 FROM board_execution_bindings WHERE tenant_id = ? AND ama_connection_id = ? LIMIT 1")
      .bind(this.tenantId, id)
      .first();
  }

  deleteUnusedConnection(id: string, version: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "DELETE FROM ama_connections WHERE id = ? AND tenant_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM board_execution_bindings WHERE tenant_id = ama_connections.tenant_id AND ama_connection_id = ama_connections.id)",
      )
      .bind(id, this.tenantId, version)
      .run();
  }

  async existingBinding(boardId: string): Promise<DomainRow | null> {
    return this.db
      .prepare("SELECT * FROM board_execution_bindings WHERE board_id = ? AND tenant_id = ?")
      .bind(boardId, this.tenantId)
      .first<DomainRow>();
  }

  hasBoardExecutionHistory(boardId: string): Promise<unknown | null> {
    return this.db
      .prepare(
        "SELECT 1 FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND t.board_id = ? LIMIT 1",
      )
      .bind(this.tenantId, boardId)
      .first();
  }

  replaceBindingWithoutHistory(boardId: string, connectionId: string, version: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "UPDATE board_execution_bindings SET ama_connection_id = ?, version = version + 1, updated_at = datetime('now') WHERE tenant_id = ? AND board_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = board_execution_bindings.tenant_id AND t.board_id = board_execution_bindings.board_id)",
      )
      .bind(connectionId, this.tenantId, boardId, version)
      .run();
  }

  createBinding(id: string, boardId: string, connectionId: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("INSERT INTO board_execution_bindings (id, tenant_id, board_id, ama_connection_id) VALUES (?, ?, ?, ?)")
      .bind(id, this.tenantId, boardId, connectionId)
      .run();
  }

  deleteBindingWithoutHistory(boardId: string, version: number): Promise<D1Result<unknown>> {
    return this.db
      .prepare(
        "DELETE FROM board_execution_bindings WHERE tenant_id = ? AND board_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id WHERE r.tenant_id = board_execution_bindings.tenant_id AND t.board_id = board_execution_bindings.board_id)",
      )
      .bind(this.tenantId, boardId, version)
      .run();
  }

  async connections(cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    const clause = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const binds = cursor ? [this.tenantId, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1] : [this.tenantId, pageSize + 1];
    return (
      await this.db
        .prepare(`SELECT * FROM ama_connections WHERE tenant_id = ?${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...binds)
        .all<DomainRow>()
    ).results;
  }
}
