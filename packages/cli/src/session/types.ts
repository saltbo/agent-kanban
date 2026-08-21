import type { AgentRuntime, LeaderAgentRuntime } from "@agent-kanban/shared";
import type { WorkspaceInfo } from "../types.js";

export type SessionStatus = "active" | "rate_limited" | "in_review" | "completing" | "closed";

/**
 * Persisted session file.
 *
 * Worker sessions (type="worker") back a task claimed by this daemon. Leader
 * sessions (type="leader") are anchored to an external long-lived runtime
 * (e.g. a CI step running `ak leader`) — the `pid` field is only meaningful
 * for leader sessions, and refers to that parent runtime's pid.
 *
 * NOTE: worker sessions no longer carry a `pid`. "Is this worker session
 * running?" is answered in-memory by the AgentRuntimePool, not by consulting
 * the filesystem or kernel. On daemon restart, any worker session not held
 * by the pool is orphaned by definition — no pid check needed.
 */
export interface SessionFile {
  type: "worker" | "leader";
  agentId: string;
  sessionId: string;
  runtime: AgentRuntime | LeaderAgentRuntime;
  startedAt: number;
  apiUrl: string;
  privateKeyJwk: JsonWebKey;

  // Leader-only fields
  /** Leader runtime pid. Undefined for worker sessions. */
  pid?: number;

  // Worker-only fields
  taskId?: string;
  workspace?: WorkspaceInfo;
  status?: SessionStatus;
  model?: string;
  reasoningEffort?: string;
  providerResumeToken?: string;
  gpgSubkeyId?: string | null;
  agentUsername?: string;
  agentName?: string;

  /**
   * Exponential backoff (ms) applied on the next resume attempt. Set when a
   * transient error (network, 429, tunnel down) occurs during resume; cleared
   * after a successful resume. Persisted so backoff survives daemon restart.
   */
  resumeBackoffMs?: number;

  /**
   * Next scheduled resume time (epoch ms). When set, the scheduler will not
   * attempt to resume this session until Date.now() >= resumeAfter.
   */
  resumeAfter?: number;

  /**
   * Consecutive relay-quota suspensions (mid-run 403/429 on a quota-managed
   * relay endpoint). Capped — a permanent 403 (plan/region/model block) must
   * not loop forever burning relay quota. Reset when the session produces a
   * result (reaches in_review).
   */
  quotaSuspensions?: number;

  /**
   * Set to true if workspace/cleanup fs operations failed during terminal
   * cleanup. OrphanReaper retries on next pass. Presence of this flag on an
   * otherwise-terminal session means it's waiting on a retriable cleanup.
   */
  cleanupPending?: boolean;
}

export interface SessionFilter {
  type?: "worker" | "leader";
  status?: SessionStatus;
}
