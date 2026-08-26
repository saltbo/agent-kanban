import { AmaSessionTerminalError, amaSessionRequest, deliverOutbox, readAmaSession, resolveAmaAgent } from "./ama";
import type { Env } from "./types";

type OutboxRow = {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  kind: string;
  payload_json: string;
  attempts: number;
};

export async function dispatchOutbox(env: Env, limit = 20): Promise<void> {
  await cleanupExpiredContractState(env);
  await terminalizeExhaustedClaims(env, limit);
  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, aggregate_type, aggregate_id, kind, payload_json, attempts FROM dispatch_outbox
     WHERE ((status IN ('pending','failed') AND available_at <= datetime('now'))
       OR (status = 'processing' AND claimed_at <= datetime('now', '-5 minutes')))
       AND attempts < 10 ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all<OutboxRow>();
  for (const row of rows.results) {
    const claim = await env.DB.prepare(
      `UPDATE dispatch_outbox SET status = 'processing', claimed_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ? AND ((status IN ('pending','failed') AND available_at <= datetime('now'))
         OR (status = 'processing' AND claimed_at <= datetime('now', '-5 minutes'))) AND attempts < 10`,
    )
      .bind(row.id)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) continue;
    try {
      const delivered = await deliverOutbox(env, row);
      const updates: D1PreparedStatement[] = [
        env.DB.prepare(
          "UPDATE dispatch_outbox SET status = 'delivered', claimed_at = NULL, updated_at = datetime('now'), last_error_code = NULL WHERE id = ?",
        ).bind(row.id),
      ];
      if (row.kind === "session" && delivered.uri) {
        updates.push(
          env.DB.prepare(
            `UPDATE task_runs
             SET ama_session_uri = ?,
                 status = CASE WHEN status IN ('pending','running') THEN ? ELSE status END,
                 version = version + 1,
                 updated_at = datetime('now')
             WHERE id = ? AND tenant_id = ? AND (ama_session_uri IS NULL OR ama_session_uri = ?)`,
          ).bind(
            delivered.uri,
            delivered.status === "running" ? "running" : delivered.status === "failed" || delivered.status === "cancelled" ? "failed" : "pending",
            row.aggregate_id,
            row.tenant_id,
            delivered.uri,
          ),
        );
        if (delivered.status === "running")
          updates.push(
            env.DB.prepare(
              "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = datetime('now') WHERE tenant_id = ? AND id = (SELECT task_id FROM task_runs WHERE id = ? AND tenant_id = ? AND status = 'running') AND status = 'queued'",
            ).bind(row.tenant_id, row.aggregate_id, row.tenant_id),
          );
      }
      if (row.kind === "message")
        updates.push(env.DB.prepare("UPDATE task_messages SET delivery_status = 'delivered' WHERE id = ?").bind(row.aggregate_id));
      await env.DB.batch(updates);
    } catch (error) {
      const attempts = row.attempts + 1;
      const errorCode = dispatchErrorCode(error);
      if (row.kind === "review_feedback" && error instanceof AmaSessionTerminalError) {
        const recovered = await createFallbackRun(env, row);
        const recoveryCode = recovered ? "ama_session_terminal_fallback" : "ama_session_terminal_superseded";
        await env.DB.prepare(
          "UPDATE dispatch_outbox SET status = 'delivered', claimed_at = NULL, last_error_code = ?, updated_at = datetime('now') WHERE id = ?",
        )
          .bind(recoveryCode, row.id)
          .run();
        console.warn(
          JSON.stringify({
            event: "outbox.review_feedback_recovered",
            requestId: row.id,
            tenantId: row.tenant_id,
            outboxId: row.id,
            aggregateId: row.aggregate_id,
            errorCode: recoveryCode,
          }),
        );
        continue;
      }
      console.error(
        JSON.stringify({
          event: "outbox.delivery_failed",
          requestId: row.id,
          tenantId: row.tenant_id,
          outboxId: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          kind: row.kind,
          attempts,
          errorCode,
        }),
      );
      if (attempts >= 10) {
        if (row.kind === "review_feedback") {
          const recovered = await createFallbackRun(env, row);
          await env.DB.prepare(
            "UPDATE dispatch_outbox SET status = 'delivered', claimed_at = NULL, last_error_code = ?, updated_at = datetime('now') WHERE id = ?",
          )
            .bind(recovered ? "ama_dispatch_exhausted_fallback" : "ama_dispatch_exhausted_superseded", row.id)
            .run();
          continue;
        }
        const statements: D1PreparedStatement[] = [
          env.DB.prepare(
            "UPDATE dispatch_outbox SET status = 'dead', claimed_at = NULL, last_error_code = ?, updated_at = datetime('now') WHERE id = ?",
          ).bind(errorCode, row.id),
        ];
        if (row.kind === "session")
          statements.push(
            env.DB.prepare(
              "UPDATE task_runs SET status = 'failed', failure_code = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND status IN ('pending','running')",
            ).bind("ama_dispatch_exhausted", row.aggregate_id),
          );
        if (row.kind === "message")
          statements.push(env.DB.prepare("UPDATE task_messages SET delivery_status = 'failed' WHERE id = ?").bind(row.aggregate_id));
        await env.DB.batch(statements);
        continue;
      }
      const delay = Math.min(3600, 2 ** attempts);
      await env.DB.prepare(
        "UPDATE dispatch_outbox SET status = 'failed', claimed_at = NULL, available_at = datetime('now', ?), last_error_code = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(`+${delay} seconds`, errorCode, row.id)
        .run();
    }
  }
  await reconcileAmaSessions(env, limit);
}

async function cleanupExpiredContractState(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM idempotency_records WHERE rowid IN (SELECT rowid FROM idempotency_records WHERE expires_at <= datetime('now') LIMIT 1000)",
    ),
    env.DB.prepare(
      "DELETE FROM pagination_snapshots WHERE token_hash IN (SELECT token_hash FROM pagination_snapshots WHERE expires_at <= datetime('now') LIMIT 1000)",
    ),
  ]);
}

async function createFallbackRun(env: Env, row: OutboxRow): Promise<boolean> {
  const payload = JSON.parse(row.payload_json) as {
    authorizedSubjectId?: string;
    projectUri?: string;
    fallback?: {
      assignmentId?: string;
      previousRunId?: string;
      agentId?: string;
      prompt?: string;
      task?: string;
      repositoryId?: string | null;
    };
  };
  const fallback = payload.fallback;
  if (
    !fallback?.assignmentId ||
    !fallback.previousRunId ||
    !fallback.agentId ||
    !fallback.prompt ||
    !fallback.task ||
    !payload.authorizedSubjectId ||
    !payload.projectUri
  )
    throw new Error("Review feedback fallback contract is incomplete");
  const suffix = row.aggregate_id.replace(/[^A-Za-z0-9_-]/g, "").slice(-48);
  const runId = `run_retry_${suffix}`;
  const outboxId = `out_retry_${suffix}`;
  const agent = await resolveAmaAgent(env, row.tenant_id, payload.authorizedSubjectId, payload.projectUri, fallback.agentId);
  const repository = fallback.repositoryId
    ? await env.DB.prepare("SELECT id, url, default_branch FROM repositories WHERE id = ? AND tenant_id = ?")
        .bind(fallback.repositoryId, row.tenant_id)
        .first<{ id: string; url: string; default_branch: string }>()
    : null;
  const sessionPayload = {
    authorizedSubjectId: payload.authorizedSubjectId,
    projectUri: payload.projectUri,
    idempotencyKey: `ak:task-run:${runId}`,
    request: amaSessionRequest(agent, repository, fallback.task, fallback.prompt),
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_runs SET status = 'failed', failure_code = 'ama_session_terminal', version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ? AND status IN ('pending','running','succeeded')
         AND EXISTS (
           SELECT 1 FROM task_reviews review
           JOIN task_submissions submission ON submission.id = review.submission_id AND submission.tenant_id = review.tenant_id
           JOIN tasks task ON task.id = review.task_id AND task.tenant_id = review.tenant_id
           JOIN task_assignments assignment ON assignment.id = ? AND assignment.tenant_id = review.tenant_id AND assignment.task_id = review.task_id
           WHERE review.id = ? AND review.tenant_id = ? AND review.decision = 'rejected'
             AND submission.status = 'rejected' AND task.status = 'in_progress' AND assignment.status = 'active'
         )`,
    ).bind(fallback.previousRunId, row.tenant_id, fallback.assignmentId, row.aggregate_id, row.tenant_id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_runs (id, tenant_id, task_id, assignment_id)
       SELECT ?, review.tenant_id, review.task_id, assignment.id
       FROM task_reviews review
       JOIN task_submissions submission ON submission.id = review.submission_id AND submission.tenant_id = review.tenant_id
       JOIN tasks task ON task.id = review.task_id AND task.tenant_id = review.tenant_id
       JOIN task_assignments assignment ON assignment.id = ? AND assignment.tenant_id = review.tenant_id AND assignment.task_id = review.task_id
       WHERE review.id = ? AND review.tenant_id = ? AND review.decision = 'rejected'
         AND submission.status = 'rejected' AND task.status = 'in_progress' AND assignment.status = 'active'
         AND EXISTS (
           SELECT 1 FROM task_runs previous
           WHERE previous.id = ? AND previous.tenant_id = review.tenant_id
             AND previous.status = 'failed' AND previous.failure_code = 'ama_session_terminal'
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_runs active
           WHERE active.tenant_id = review.tenant_id AND active.task_id = review.task_id AND active.status IN ('pending','running')
         )`,
    ).bind(runId, fallback.assignmentId, row.aggregate_id, row.tenant_id, fallback.previousRunId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO dispatch_outbox (id, tenant_id, aggregate_type, aggregate_id, kind, payload_json) SELECT ?, ?, 'task_run', id, 'session', ? FROM task_runs WHERE id = ? AND tenant_id = ?",
    ).bind(outboxId, row.tenant_id, JSON.stringify(sessionPayload), runId, row.tenant_id),
  ]);
  return Boolean(await env.DB.prepare("SELECT 1 FROM task_runs WHERE id = ? AND tenant_id = ?").bind(runId, row.tenant_id).first());
}

async function terminalizeExhaustedClaims(env: Env, limit: number): Promise<void> {
  const exhausted = await env.DB.prepare(
    `SELECT id, tenant_id, aggregate_type, aggregate_id, kind, payload_json, attempts FROM dispatch_outbox
     WHERE attempts >= 10 AND (status = 'failed' OR (status = 'processing' AND claimed_at <= datetime('now', '-5 minutes')))
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(limit)
    .all<OutboxRow>();
  for (const row of exhausted.results) {
    if (row.kind === "review_feedback") {
      const recovered = await createFallbackRun(env, row);
      await env.DB.prepare(
        "UPDATE dispatch_outbox SET status = 'delivered', claimed_at = NULL, last_error_code = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('failed','processing')",
      )
        .bind(recovered ? "ama_dispatch_exhausted_fallback" : "ama_dispatch_exhausted_superseded", row.id)
        .run();
      continue;
    }
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE dispatch_outbox SET status = 'dead', claimed_at = NULL, last_error_code = 'ama_dispatch_exhausted', updated_at = datetime('now') WHERE id = ? AND status IN ('failed','processing')",
      ).bind(row.id),
    ];
    if (row.kind === "session")
      statements.push(
        env.DB.prepare(
          "UPDATE task_runs SET status = 'failed', failure_code = 'ama_dispatch_exhausted', version = version + 1, updated_at = datetime('now') WHERE id = ? AND status IN ('pending','running')",
        ).bind(row.aggregate_id),
      );
    if (row.kind === "message")
      statements.push(env.DB.prepare("UPDATE task_messages SET delivery_status = 'failed' WHERE id = ?").bind(row.aggregate_id));
    await env.DB.batch(statements);
    console.error(
      JSON.stringify({
        event: "outbox.delivery_exhausted",
        requestId: row.id,
        tenantId: row.tenant_id,
        outboxId: row.id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        kind: row.kind,
        attempts: row.attempts,
        errorCode: "ama_dispatch_exhausted",
      }),
    );
  }
}

async function reconcileAmaSessions(env: Env, limit: number): Promise<void> {
  const sessions = await env.DB.prepare(`SELECT r.id, r.tenant_id, r.ama_session_uri, ac.authorized_subject_id, ac.project_uri
    FROM task_runs r JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id
    JOIN board_execution_bindings b ON b.board_id = t.board_id AND b.tenant_id = r.tenant_id
    JOIN ama_connections ac ON ac.id = b.ama_connection_id AND ac.tenant_id = r.tenant_id
    WHERE r.status IN ('pending','running') AND r.ama_session_uri IS NOT NULL ORDER BY r.updated_at LIMIT ?`)
    .bind(limit)
    .all<{ id: string; tenant_id: string; ama_session_uri: string; authorized_subject_id: string; project_uri: string }>();
  for (const session of sessions.results) {
    try {
      const amaStatus = await readAmaSession(env, session.tenant_id, session.authorized_subject_id, session.project_uri, session.ama_session_uri);
      const status = amaStatus === "running" || amaStatus === "idle" ? "running" : ["error", "closed"].includes(amaStatus) ? "failed" : "pending";
      await env.DB.prepare(
        "UPDATE task_runs SET status = ?, version = version + 1, updated_at = datetime('now'), failure_code = ? WHERE id = ? AND tenant_id = ? AND status IN ('pending','running') AND status <> ?",
      )
        .bind(status, status === "failed" ? `ama_session_${amaStatus}` : null, session.id, session.tenant_id, status)
        .run();
      if (status === "running")
        await env.DB.prepare(
          "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = datetime('now') WHERE tenant_id = ? AND id = (SELECT task_id FROM task_runs WHERE id = ? AND tenant_id = ? AND status = 'running') AND status = 'queued'",
        )
          .bind(session.tenant_id, session.id, session.tenant_id)
          .run();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "ama.session_reconcile_failed",
          requestId: session.id,
          tenantId: session.tenant_id,
          taskRunId: session.id,
          errorCode: dispatchErrorCode(error),
        }),
      );
    }
  }
}

function dispatchErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("contract") || message.includes("status.phase")) return "ama_contract_invalid";
  if (message.includes("origin mismatch")) return "ama_uri_invalid";
  if (message.includes("HTTP 401") || message.includes("HTTP 403")) return "ama_access_denied";
  if (message.includes("HTTP 404")) return "ama_resource_missing";
  if (message.includes("Timeout") || message.includes("timed out")) return "ama_timeout";
  return "ama_unavailable";
}
