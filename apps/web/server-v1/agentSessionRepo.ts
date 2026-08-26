import type { AgentSession, AgentSessionWithMachine, SessionUsageInput } from "@agent-kanban/shared";
import { signDelegation } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgentPrivateKey } from "./agentRepo";
import type { D1 } from "./db";
import type { Env } from "./types";

export async function createSession(
  db: D1,
  env: Env,
  agentId: string,
  machineId: string,
  sessionId: string,
  sessionPublicKey: string,
  ownerId: string,
): Promise<{ delegation_proof: string }> {
  const agentPrivateKey = await getAgentPrivateKey(db, agentId);
  if (!agentPrivateKey) throw new Error("Agent not found");

  const delegationProof = await signDelegation(agentPrivateKey, sessionPublicKey);
  const now = new Date().toISOString();

  await db
    .prepare(`
    INSERT INTO agent_sessions (id, agent_id, machine_id, status, public_key, delegation_proof, created_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `)
    .bind(sessionId, agentId, machineId, sessionPublicKey, delegationProof, now)
    .run();

  return { delegation_proof: delegationProof };
}

export async function createAmaAgentSession(
  db: D1,
  env: Env,
  input: {
    ownerId: string;
    agentId: string;
    sessionId: string;
    sessionPublicKey: string;
    amaSessionId?: string | null;
  },
): Promise<{ delegation_proof: string }> {
  const agent = await db.prepare("SELECT owner_id FROM agents WHERE id = ?").bind(input.agentId).first<{ owner_id: string }>();
  if (!agent) throw new Error("Agent not found");
  if (agent.owner_id !== input.ownerId) throw new Error("Agent does not belong to owner");

  const agentPrivateKey = await getAgentPrivateKey(db, input.agentId);
  if (!agentPrivateKey) throw new Error("Agent not found");

  const delegationProof = await signDelegation(agentPrivateKey, input.sessionPublicKey);
  const now = new Date().toISOString();

  await db
    .prepare(`
    INSERT INTO ama_agent_sessions (
      id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof, created_at
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `)
    .bind(input.sessionId, input.ownerId, input.agentId, input.amaSessionId ?? null, input.sessionPublicKey, delegationProof, now)
    .run();

  return { delegation_proof: delegationProof };
}

export async function bindAmaAgentSession(db: D1, sessionId: string, amaSessionId: string): Promise<void> {
  await db.prepare("UPDATE ama_agent_sessions SET ama_session_id = ? WHERE id = ?").bind(amaSessionId, sessionId).run();
}

export async function setAmaAgentSessionSecretRef(db: D1, sessionId: string, secretRef: string | null): Promise<void> {
  await db.prepare("UPDATE ama_agent_sessions SET secret_ref = ? WHERE id = ?").bind(secretRef, sessionId).run();
}

// Absolute set (idempotent) — usage comes pre-aggregated from the AMA usage
// summary at teardown time, unlike the legacy delta-based updateSessionUsage.
export async function setAmaAgentSessionUsageTotals(
  db: D1,
  sessionId: string,
  totals: { promptTokens: number; completionTokens: number; costMicros: number },
): Promise<void> {
  await db
    .prepare("UPDATE ama_agent_sessions SET input_tokens = ?, output_tokens = ?, cost_micro_usd = ? WHERE id = ?")
    .bind(totals.promptTokens, totals.completionTokens, totals.costMicros, sessionId)
    .run();
}

export interface AmaAgentSessionRow {
  id: string;
  owner_id: string;
  agent_id: string;
  ama_session_id: string | null;
  status: "active" | "closed";
  secret_ref: string | null;
}

export async function getAmaAgentSession(db: D1, sessionId: string): Promise<AmaAgentSessionRow | null> {
  return db
    .prepare("SELECT id, owner_id, agent_id, ama_session_id, status, secret_ref FROM ama_agent_sessions WHERE id = ?")
    .bind(sessionId)
    .first<AmaAgentSessionRow>();
}

export async function getSession(db: D1, sessionId: string): Promise<AgentSession | null> {
  return db.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(sessionId).first<AgentSession>();
}

export async function closeSession(db: D1, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE agent_sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, sessionId).run();
  await db.prepare("UPDATE ama_agent_sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, sessionId).run();
}

export async function reopenSession(db: D1, sessionId: string): Promise<void> {
  const row = await db.prepare("SELECT status FROM agent_sessions WHERE id = ?").bind(sessionId).first<{ status: string }>();
  const runtimeRow = row ?? (await db.prepare("SELECT status FROM ama_agent_sessions WHERE id = ?").bind(sessionId).first<{ status: string }>());
  if (!runtimeRow) throw new HTTPException(404, { message: `Session ${sessionId} not found` });
  if (runtimeRow.status === "active") return;
  await db.prepare("UPDATE agent_sessions SET status = 'active', closed_at = NULL WHERE id = ?").bind(sessionId).run();
  await db.prepare("UPDATE ama_agent_sessions SET status = 'active', closed_at = NULL WHERE id = ?").bind(sessionId).run();
}

export async function updateSessionUsage(db: D1, sessionId: string, usage: SessionUsageInput): Promise<void> {
  await db
    .prepare(`
    UPDATE agent_sessions SET
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      cache_creation_tokens = cache_creation_tokens + ?,
      cost_micro_usd = cost_micro_usd + ?
    WHERE id = ?
  `)
    .bind(usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_creation_tokens, usage.cost_micro_usd, sessionId)
    .run();
  await db
    .prepare(`
    UPDATE ama_agent_sessions SET
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      cache_creation_tokens = cache_creation_tokens + ?,
      cost_micro_usd = cost_micro_usd + ?
    WHERE id = ?
  `)
    .bind(usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_creation_tokens, usage.cost_micro_usd, sessionId)
    .run();
}

export async function listSessions(db: D1, agentId: string): Promise<AgentSessionWithMachine[]> {
  const result = await db
    .prepare(`
    SELECT
      s.id,
      s.agent_id,
      s.machine_id,
      s.status,
      s.public_key,
      s.delegation_proof,
      s.input_tokens,
      s.output_tokens,
      s.cache_read_tokens,
      s.cache_creation_tokens,
      s.cost_micro_usd,
      s.created_at,
	      s.closed_at,
	      m.name AS machine_name,
	      'machine' AS runtime_source,
	      NULL AS ama_session_id
    FROM agent_sessions s
    JOIN machines m ON s.machine_id = m.id
    WHERE s.agent_id = ?
    UNION ALL
	    SELECT
	      s.id,
	      s.agent_id,
	      'ama-runtime-' || s.owner_id AS machine_id,
	      s.status,
      s.public_key,
      s.delegation_proof,
      s.input_tokens,
      s.output_tokens,
      s.cache_read_tokens,
      s.cache_creation_tokens,
      s.cost_micro_usd,
      s.created_at,
	      s.closed_at,
	      'AMA runtime' AS machine_name,
	      'ama' AS runtime_source,
	      s.ama_session_id AS ama_session_id
	    FROM ama_agent_sessions s
	    WHERE s.agent_id = ?
    ORDER BY created_at DESC
  `)
    .bind(agentId, agentId)
    .all<AgentSessionWithMachine>();
  return result.results;
}
