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

export interface AgencySessionObservationPort {
  getSession(sessionId: string): Promise<AgencySession | null>;
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

export type TaskSessionObservationFailureCode = "SESSION_NOT_FOUND";

export class TaskSessionObservationFailure extends Error {
  constructor(
    readonly code: TaskSessionObservationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskSessionObservationFailure";
  }
}

export async function observeTaskSession(
  agency: AgencySessionObservationPort,
  reference: { sessionId: string; projectId: string },
): Promise<AgencySession> {
  const session = await agency.getSession(reference.sessionId);
  if (!session) {
    throw new TaskSessionObservationFailure("SESSION_NOT_FOUND", "Agency Session not found for the Task");
  }
  if (session.metadata.uid !== reference.sessionId || session.metadata.projectId !== reference.projectId) {
    throw new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned a Session outside the requested identity or Project");
  }
  return session;
}
