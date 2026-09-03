export interface AgencySession {
  id: string;
  projectId: string | null;
  representation: object;
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
  if (session.id !== reference.sessionId || session.projectId !== reference.projectId) {
    throw new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned a Session outside the requested identity or Project");
  }
  return session;
}
