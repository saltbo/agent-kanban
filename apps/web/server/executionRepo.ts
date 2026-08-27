import { one } from "./db";
import type { DomainRow } from "./planningRepo";

export class ExecutionRepo {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  run(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_runs WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  submission(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_submissions WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  progress(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_progress_entries WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  message(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_messages WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  review(id: string): Promise<DomainRow> {
    return one(this.db.prepare("SELECT * FROM task_reviews WHERE id = ? AND tenant_id = ?").bind(id, this.tenantId));
  }

  async createInitialRun(input: { id: string; taskId: string; assignmentId: string; outboxId: string; payload: string }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO task_runs (id, tenant_id, task_id, assignment_id)
           SELECT ?, t.tenant_id, t.id, a.id
           FROM tasks t
           JOIN task_assignments a ON a.id = ? AND a.tenant_id = t.tenant_id AND a.task_id = t.id AND a.status = 'active'
           WHERE t.id = ? AND t.tenant_id = ? AND t.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_id = t.id AND status IN ('pending','running'))
             AND NOT EXISTS (
               SELECT 1 FROM task_dependencies d
               JOIN tasks dependency ON dependency.id = d.depends_on_task_id AND dependency.tenant_id = t.tenant_id
               WHERE d.task_id = t.id AND dependency.status <> 'done'
             )
             AND EXISTS (
               SELECT 1 FROM board_memberships membership
               WHERE membership.tenant_id = t.tenant_id AND membership.board_id = t.board_id
                 AND membership.agent_id = a.agent_id
                 AND EXISTS (SELECT 1 FROM json_each(membership.capabilities_json) WHERE value = 'work')
             )`,
        )
        .bind(input.id, input.assignmentId, input.taskId, this.tenantId),
      this.db
        .prepare(
          "INSERT INTO dispatch_outbox (id, tenant_id, aggregate_type, aggregate_id, kind, payload_json) SELECT ?, ?, 'task_run', id, 'session', ? FROM task_runs WHERE id = ? AND tenant_id = ?",
        )
        .bind(input.outboxId, this.tenantId, input.payload, input.id, this.tenantId),
    ]);
    return (results[0].meta.changes ?? 0) === 1;
  }

  async addProgress(input: { id: string; runId: string; taskId: string; kind: string; body: string }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(`INSERT INTO task_progress_entries (id, tenant_id, task_id, run_id, kind, body)
        SELECT ?, r.tenant_id, r.task_id, r.id, ?, ? FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id
        WHERE r.id = ? AND r.tenant_id = ? AND r.status IN ('pending','running') AND t.status IN ('queued','in_progress')`)
        .bind(input.id, input.kind, input.body, input.runId, this.tenantId),
      this.db
        .prepare(
          "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status IN ('queued','in_progress') AND EXISTS (SELECT 1 FROM task_progress_entries WHERE id = ?)",
        )
        .bind(input.taskId, this.tenantId, input.id),
      this.db
        .prepare(
          "UPDATE task_runs SET status = 'running', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status IN ('pending','running') AND EXISTS (SELECT 1 FROM task_progress_entries WHERE id = ?)",
        )
        .bind(input.runId, this.tenantId, input.id),
    ]);
    return (results[0].meta.changes ?? 0) === 1;
  }

  activeSession(
    taskId: string,
    boardId: string,
    statuses: readonly string[] = ["running"],
  ): Promise<{
    id: string;
    ama_session_uri: string | null;
    project_uri: string;
  } | null> {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT r.id, r.ama_session_uri, ac.project_uri
      FROM task_runs r
      JOIN board_execution_bindings beb ON beb.board_id = ? AND beb.tenant_id = r.tenant_id
      JOIN ama_connections ac ON ac.id = beb.ama_connection_id AND ac.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.task_id = ? AND r.ama_session_uri IS NOT NULL AND r.status IN (${placeholders})
      ORDER BY r.created_at DESC LIMIT 1`)
      .bind(boardId, this.tenantId, taskId, ...statuses)
      .first();
  }

  async createMessage(input: {
    id: string;
    taskId: string;
    runId: string;
    senderIssuer: string | null;
    senderSubject: string;
    body: string;
    outboxId: string;
    payload: string;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO task_messages (id, tenant_id, task_id, sender_issuer, sender_subject, body) SELECT ?, r.tenant_id, r.task_id, ?, ?, ? FROM task_runs r WHERE r.id = ? AND r.tenant_id = ? AND r.task_id = ? AND r.status = 'running' AND r.ama_session_uri IS NOT NULL",
        )
        .bind(input.id, input.senderIssuer, input.senderSubject, input.body, input.runId, this.tenantId, input.taskId),
      this.db
        .prepare(
          "INSERT INTO dispatch_outbox (id, tenant_id, aggregate_type, aggregate_id, kind, payload_json) SELECT ?, ?, 'task_message', id, 'message', ? FROM task_messages WHERE id = ? AND tenant_id = ?",
        )
        .bind(input.outboxId, this.tenantId, input.payload, input.id, this.tenantId),
    ]);
    return (results[0].meta.changes ?? 0) === 1;
  }

  async createSubmission(input: { id: string; taskId: string; runId: string; summary: string; artifactUrls: string[] }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(`INSERT INTO task_submissions (id, tenant_id, task_id, run_id, summary, artifact_urls_json)
        SELECT ?, r.tenant_id, r.task_id, r.id, ?, ? FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id
        WHERE r.id = ? AND r.tenant_id = ? AND r.status IN ('pending','running') AND t.status = 'in_progress'
          AND NOT EXISTS (SELECT 1 FROM task_submissions WHERE tenant_id = r.tenant_id AND task_id = r.task_id AND status = 'pending_review')`)
        .bind(input.id, input.summary, JSON.stringify(input.artifactUrls), input.runId, this.tenantId),
      this.db
        .prepare(
          "UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'in_progress' AND EXISTS (SELECT 1 FROM task_submissions WHERE id = ?)",
        )
        .bind(input.taskId, this.tenantId, input.id),
      this.db
        .prepare(
          "UPDATE task_runs SET status = 'succeeded', version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status IN ('pending','running') AND EXISTS (SELECT 1 FROM task_submissions WHERE id = ?)",
        )
        .bind(input.runId, this.tenantId, input.id),
    ]);
    return (results[0].meta.changes ?? 0) === 1;
  }

  async applyReview(input: {
    id: string;
    taskId: string;
    submissionId: string;
    reviewerIssuer: string | null;
    reviewerSubject: string;
    decision: "accepted" | "rejected";
    body: string;
    continuation?:
      | { kind: "feedback"; runId: string; outboxId: string; payload: string }
      | {
          kind: "replacement";
          runId: string;
          assignmentId: string;
          outboxId: string;
          payload: string;
        };
  }): Promise<boolean> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`INSERT INTO task_reviews (id, tenant_id, task_id, submission_id, reviewer_issuer, reviewer_subject, decision, body)
          SELECT ?, submission.tenant_id, submission.task_id, submission.id, ?, ?, ?, ?
          FROM task_submissions submission
          WHERE submission.id = ? AND submission.tenant_id = ? AND submission.task_id = ? AND submission.status = 'pending_review'
            AND NOT EXISTS (SELECT 1 FROM task_reviews WHERE tenant_id = submission.tenant_id AND submission_id = submission.id)`)
        .bind(input.id, input.reviewerIssuer, input.reviewerSubject, input.decision, input.body, input.submissionId, this.tenantId, input.taskId),
      this.db
        .prepare(
          "UPDATE task_submissions SET status = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'pending_review' AND EXISTS (SELECT 1 FROM task_reviews WHERE id = ? AND tenant_id = ?)",
        )
        .bind(input.decision, input.submissionId, this.tenantId, input.id, this.tenantId),
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'in_review' AND EXISTS (SELECT 1 FROM task_reviews WHERE id = ? AND tenant_id = ?)",
        )
        .bind(input.decision === "accepted" ? "done" : "in_progress", input.taskId, this.tenantId, input.id, this.tenantId),
    ];
    if (input.decision === "accepted") {
      statements.push(
        this.db
          .prepare(
            "UPDATE task_assignments SET status = 'completed', version = version + 1, updated_at = datetime('now') WHERE task_id = ? AND tenant_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM task_reviews WHERE id = ? AND tenant_id = ?)",
          )
          .bind(input.taskId, this.tenantId, input.id, this.tenantId),
      );
    } else if (input.continuation?.kind === "feedback") {
      statements.push(
        this.db
          .prepare(
            "UPDATE task_runs SET status = 'running', failure_code = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'succeeded' AND EXISTS (SELECT 1 FROM task_reviews WHERE id = ? AND tenant_id = ?)",
          )
          .bind(input.continuation.runId, this.tenantId, input.id, this.tenantId),
        this.db
          .prepare(
            "INSERT INTO dispatch_outbox (id, tenant_id, aggregate_type, aggregate_id, kind, payload_json) SELECT ?, ?, 'task_review', id, 'review_feedback', ? FROM task_reviews WHERE id = ? AND tenant_id = ?",
          )
          .bind(input.continuation.outboxId, this.tenantId, input.continuation.payload, input.id, this.tenantId),
      );
    } else if (input.continuation?.kind === "replacement") {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO task_runs (id, tenant_id, task_id, assignment_id) SELECT ?, tenant_id, task_id, ? FROM task_reviews WHERE id = ? AND tenant_id = ? AND NOT EXISTS (SELECT 1 FROM task_runs WHERE tenant_id = task_reviews.tenant_id AND task_id = task_reviews.task_id AND status IN ('pending','running'))",
          )
          .bind(input.continuation.runId, input.continuation.assignmentId, input.id, this.tenantId),
        this.db
          .prepare(
            "INSERT INTO dispatch_outbox (id, tenant_id, aggregate_type, aggregate_id, kind, payload_json) SELECT ?, ?, 'task_run', id, 'session', ? FROM task_runs WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM task_reviews WHERE id = ? AND tenant_id = ?)",
          )
          .bind(
            input.continuation.outboxId,
            this.tenantId,
            input.continuation.payload,
            input.continuation.runId,
            this.tenantId,
            input.id,
            this.tenantId,
          ),
      );
    }
    const results = await this.db.batch(statements);
    return (results[0].meta.changes ?? 0) === 1;
  }

  runs(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_runs", "task_id", taskId, cursor, pageSize);
  }

  progressEntries(runId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_progress_entries", "run_id", runId, cursor, pageSize);
  }

  messages(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_messages", "task_id", taskId, cursor, pageSize);
  }

  submissions(taskId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_submissions", "task_id", taskId, cursor, pageSize);
  }

  reviews(submissionId: string, cursor: { createdAt: string; id: string } | null, pageSize: number): Promise<DomainRow[]> {
    return this.list("task_reviews", "submission_id", submissionId, cursor, pageSize);
  }

  private async list(
    table: "task_runs" | "task_progress_entries" | "task_messages" | "task_submissions" | "task_reviews",
    foreignKey: "task_id" | "run_id" | "submission_id",
    value: string,
    cursor: { createdAt: string; id: string } | null,
    pageSize: number,
  ): Promise<DomainRow[]> {
    const clause = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const binds = cursor ? [this.tenantId, value, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1] : [this.tenantId, value, pageSize + 1];
    return (
      await this.db
        .prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND ${foreignKey} = ?${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...binds)
        .all<DomainRow>()
    ).results;
  }
}
