import { AmaApiError, connectSessionSocket, type Session } from "@realmroot/enbor-sdk";
import { createAgencyClient } from "@server/adapters/agency/client";
import type { Env } from "@server/env";
import { type AgencySession, AgencySessionObservationFailure, type AgencySessionObservationPort } from "@server/usecases/tasks/observeTaskSession";

export { AgencySessionObservationFailure } from "@server/usecases/tasks/observeTaskSession";

export interface AgencySessionObservationClient extends AgencySessionObservationPort {
  connectSessionSocket(sessionId: string): Promise<WebSocket>;
}

export function assertAgencySessionObservationConfigured(env: Env): void {
  agencyOrigin(env);
}

export function agencySessionObservationClient(
  env: Env,
  authorization: { token: string; projectId: string; traceparent?: string },
): AgencySessionObservationClient {
  const origin = agencyOrigin(env);
  const client = createAgencyClient(origin, authorization);
  return {
    async getSession(sessionId) {
      try {
        return observedSession(await client.sessions.get(sessionId));
      } catch (error) {
        if (error instanceof AmaApiError && error.status === 404) return null;
        throw observationFailure(error);
      }
    },

    async connectSessionSocket(sessionId) {
      try {
        const socketClient = createAgencyClient(origin, authorization, { Upgrade: "websocket" });
        const { response } = await connectSessionSocket({ client: socketClient.raw, path: { sessionId }, parseAs: "stream" });
        if (!response) throw unavailable("Agency request failed");
        if (response.status !== 101 || !response.webSocket) {
          throw unavailable(`Agency Session socket failed with HTTP ${response.status}`);
        }
        return response.webSocket;
      } catch (error) {
        if (error instanceof AgencySessionObservationFailure) throw error;
        throw unavailable("Agency request failed", error);
      }
    },
  };
}

function agencyOrigin(env: Env): string {
  if (!env.AMA_ORIGIN) throw unavailable("Agency Session observation is not configured");
  const origin = new URL(env.AMA_ORIGIN);
  if (origin.protocol !== "https:") throw unavailable("AMA_ORIGIN must use HTTPS");
  return origin.origin;
}

function observedSession(session: Session): AgencySession {
  if (
    typeof session?.metadata?.uid !== "string" ||
    (session.metadata.projectId !== null && typeof session.metadata.projectId !== "string") ||
    !isRecord(session.spec) ||
    !isRecord(session.status)
  ) {
    throw new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned an invalid Session response");
  }
  return {
    id: session.metadata.uid,
    projectId: session.metadata.projectId,
    representation: session,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observationFailure(error: unknown): AgencySessionObservationFailure {
  if (error instanceof AgencySessionObservationFailure) return error;
  if (!(error instanceof AmaApiError)) {
    return new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned an invalid Session response", { cause: error });
  }
  if (error.status === undefined) return unavailable("Agency request failed", error);
  if (error.status >= 200 && error.status < 300) {
    return new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned malformed Session JSON", { cause: error });
  }
  return unavailable(`Agency Session read failed with HTTP ${error.status}`, error);
}

function unavailable(message: string, cause?: unknown): AgencySessionObservationFailure {
  return new AgencySessionObservationFailure("UNAVAILABLE", message, cause === undefined ? undefined : { cause });
}
