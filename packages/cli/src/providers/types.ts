import {
  type AgentEvent,
  type AgentRuntime,
  type ContentBlock,
  type MachineRuntimeStatus,
  parseRetryAfterMs,
  type RuntimeModel,
  UsageFetchError,
  type UsageInfo,
  type UsageWindow,
} from "@agent-kanban/shared";

export type { AgentEvent, AgentRuntime, ContentBlock, UsageInfo, UsageWindow };
// UsageFetchError / parseRetryAfterMs are defined once in shared (the web
// server throws them too); re-exported here so existing CLI import sites and
// `instanceof` checks keep working against the same class object.
//   UsageFetchError: raised by `AgentProvider.fetchUsage` when the upstream
//   API is reachable but returned a non-OK status, or when the request itself
//   failed. Carries the HTTP status (if any) and parsed `Retry-After` so the
//   collector can schedule the next attempt precisely.
export { parseRetryAfterMs, UsageFetchError };

export interface RuntimeAvailability {
  status: MachineRuntimeStatus;
  detail?: string;
  reset_at?: string;
}

export type { RuntimeModel };

/** Normalized history entry returned by provider history readers. */
export interface HistoryEvent {
  id: string;
  event: AgentEvent;
  timestamp: string;
}

export interface ExecuteOpts {
  sessionId: string;
  resumeToken?: string;
  cwd: string;
  env: Record<string, string>;
  taskContext: string;
  systemPromptFile?: string;
  model?: string;
  reasoningEffort?: string;
  resume?: boolean;
}

/**
 * Uniform contract for every agent provider — SDK-based or process-based.
 *
 * Iterator termination semantics (both providers must conform):
 *   - Normal completion: iterator ends cleanly, no throw
 *   - Crash / internal failure: iterator throws (classified at boundary)
 *   - External abort(): iterator ends cleanly (abort is idempotent)
 *
 * Provider internals (process spawning, pipes, signals, zombie reaping,
 * abort idempotency) are fully encapsulated inside the provider. The daemon
 * layer never touches OS process concepts.
 */
export interface AgentHandle {
  events: AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  send(message: string): Promise<void>;
  getResumeToken?(): string | undefined;
}

export interface AgentProvider {
  readonly name: AgentRuntime;
  readonly label: string;
  checkAvailability?(): Promise<RuntimeAvailability>;
  listModels?(): Promise<RuntimeModel[]>;
  execute(opts: ExecuteOpts): Promise<AgentHandle>;
  /**
   * Retrieve session history from this provider's local storage.
   * `sessionId` is the AK session ID; `resumeToken` is the provider-specific
   * identifier (e.g. Codex thread_id) stored in the session file.
   *
   * Providers that cannot expose session history MUST still implement this
   * method and return an empty array — the caller relies on a uniform contract.
   */
  getHistory(sessionId: string, resumeToken?: string): Promise<HistoryEvent[]>;
  /**
   * Fetch current usage windows for this provider. Pure HTTP request — no
   * caching, no swallowing. Throws `UsageFetchError` on HTTP failure so the
   * caller (UsageCollector) can apply retry/backoff policy.
   *
   * Returns `null` only when the provider has no credentials configured —
   * that's a "not applicable" signal, not a failure.
   */
  fetchUsage?(): Promise<UsageInfo | null>;
}

export function availabilityFromUsage(usage: UsageInfo | null): RuntimeAvailability {
  const exhausted = usage?.windows.filter((window) => window.utilization >= 100) ?? [];
  if (exhausted.length === 0) return { status: "ready" };

  const reset_at = exhausted
    .map((window) => window.resets_at)
    .filter(Boolean)
    .sort()[0];
  return { status: "limited", detail: "runtime usage limit reached", reset_at };
}

export function availabilityFromUsageError(err: unknown, runtimeLabel: string): RuntimeAvailability {
  if (!(err instanceof UsageFetchError)) {
    return { status: "unhealthy", detail: `${runtimeLabel} usage probe failed: ${(err as Error).message}` };
  }
  if (err.status === 401 || err.status === 403) {
    return { status: "unauthorized", detail: `${runtimeLabel} authentication failed` };
  }
  if (err.status === 429) {
    const reset_at = err.retryAfterMs === undefined ? undefined : new Date(Date.now() + err.retryAfterMs).toISOString();
    return { status: "limited", detail: `${runtimeLabel} usage limit reached`, reset_at };
  }
  return { status: "unhealthy", detail: err.message };
}
