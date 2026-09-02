import type { Env } from "@server/env";
import { type AgencySession, AgencySessionObservationFailure, type AgencySessionObservationPort } from "@server/usecases/tasks/observeTaskSession";

export { AgencySessionObservationFailure } from "@server/usecases/tasks/observeTaskSession";

export interface AgencySessionObservationClient extends AgencySessionObservationPort {
  connectSessionSocket(sessionId: string): Promise<WebSocket>;
}

export function agencySessionObservationClient(
  env: Env,
  authorization: { token: string; projectId: string; traceparent?: string },
): AgencySessionObservationClient {
  const origin = agencyOrigin(env);
  return {
    async getSession(sessionId) {
      const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, origin);
      const response = await dependencyFetch(url, {
        headers: requestHeaders(authorization),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw unavailable(`Agency Session read failed with HTTP ${response.status}`);
      }
      try {
        return decodeSession(await response.json());
      } catch (error) {
        if (error instanceof AgencySessionObservationFailure) throw error;
        throw new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned malformed Session JSON", { cause: error });
      }
    },

    async connectSessionSocket(sessionId) {
      const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/socket`, origin);
      const response = await dependencyFetch(url, {
        headers: { ...requestHeaders(authorization), Upgrade: "websocket" },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw unavailable(`Agency Session socket failed with HTTP ${response.status}`);
      }
      return response.webSocket;
    },
  };
}

function agencyOrigin(env: Env): string {
  if (!env.AMA_ORIGIN) throw unavailable("Agency Session observation is not configured");
  const origin = new URL(env.AMA_ORIGIN);
  if (origin.protocol !== "https:") throw unavailable("AMA_ORIGIN must use HTTPS");
  return origin.origin;
}

function requestHeaders(authorization: { token: string; projectId: string; traceparent?: string }): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${authorization.token}`,
    "X-AMA-Project-ID": authorization.projectId,
    ...(authorization.traceparent ? { traceparent: authorization.traceparent } : {}),
  };
}

async function dependencyFetch(input: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw unavailable("Agency request failed", error);
  }
}

function decodeSession(value: unknown): AgencySession {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.spec) || !isRecord(value.status)) throw invalidResponse();
  const metadata = value.metadata;
  if (
    typeof metadata.uid !== "string" ||
    typeof metadata.projectId !== "string" ||
    typeof metadata.name !== "string" ||
    typeof metadata.createdAt !== "string" ||
    typeof metadata.updatedAt !== "string" ||
    (metadata.archivedAt !== null && typeof metadata.archivedAt !== "string")
  ) {
    throw invalidResponse();
  }
  return {
    metadata: {
      uid: metadata.uid,
      projectId: metadata.projectId,
      name: metadata.name,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archivedAt: metadata.archivedAt,
    },
    spec: value.spec,
    status: value.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unavailable(message: string, cause?: unknown): AgencySessionObservationFailure {
  return new AgencySessionObservationFailure("UNAVAILABLE", message, cause === undefined ? undefined : { cause });
}

function invalidResponse(): AgencySessionObservationFailure {
  return new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned an invalid Session response");
}
