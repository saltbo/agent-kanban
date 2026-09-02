export interface AgencySession {
  metadata: {
    uid: string;
    projectId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}

export interface TaskSessionBindingLookup {
  agentActorId: string;
  runtime: string;
  runtimeSessionId: string;
}

export interface AgencySessionObservationPort {
  findByRuntimeBinding(binding: TaskSessionBindingLookup): Promise<AgencySession[]>;
}

export type AgencySessionObservationFailureCode = "UNAVAILABLE" | "INVALID_RESPONSE";

export class AgencySessionObservationFailure extends Error {
  constructor(
    readonly code: AgencySessionObservationFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgencySessionObservationFailure";
  }
}

export type TaskSessionObservationFailureCode = "SESSION_NOT_FOUND" | "SESSION_AMBIGUOUS";

export class TaskSessionObservationFailure extends Error {
  constructor(
    readonly code: TaskSessionObservationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskSessionObservationFailure";
  }
}

export async function observeTaskSession(agency: AgencySessionObservationPort, binding: TaskSessionBindingLookup): Promise<AgencySession> {
  const sessions = await agency.findByRuntimeBinding(binding);
  if (sessions.length === 0) {
    throw new TaskSessionObservationFailure("SESSION_NOT_FOUND", "Agency Session not found for the verified Task runtime binding");
  }
  if (sessions.length !== 1) {
    throw new TaskSessionObservationFailure("SESSION_AMBIGUOUS", "Multiple Agency Sessions match the verified Task runtime binding");
  }
  return sessions[0]!;
}
