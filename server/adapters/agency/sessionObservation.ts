import { realmrootClientCredentialsToken } from "@server/adapters/realmroot/clientCredentials";
import { amaResource } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import {
  type AgencySession,
  AgencySessionObservationFailure,
  type AgencySessionObservationPort,
  type TaskSessionBindingLookup,
} from "@server/usecases/tasks/observeTaskSession";

export { AgencySessionObservationFailure } from "@server/usecases/tasks/observeTaskSession";

export interface AgencySessionObservationClient extends AgencySessionObservationPort {
  connectSessionSocket(sessionId: string, binding: TaskSessionBindingLookup): Promise<WebSocket>;
}

export function agencySessionObservationClient(env: Env): AgencySessionObservationClient {
  const configuration = agencyConfiguration(env);
  return {
    async findByRuntimeBinding(binding) {
      const token = await accessToken(configuration, "sessions:read");
      const url = new URL("/api/v1/sessions", configuration.origin);
      url.searchParams.set("agentActorId", binding.agentActorId);
      url.searchParams.set("runtime", binding.runtime);
      url.searchParams.set("runtimeSessionId", binding.runtimeSessionId);
      url.searchParams.set("limit", "2");
      const response = await dependencyFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) {
        throw unavailable(`Agency Session lookup failed with HTTP ${response.status}`);
      }
      try {
        return decodeSessionList(await response.json());
      } catch (error) {
        if (error instanceof AgencySessionObservationFailure) throw error;
        throw new AgencySessionObservationFailure("INVALID_RESPONSE", "Agency returned malformed Session JSON", { cause: error });
      }
    },

    async connectSessionSocket(sessionId, binding) {
      const token = await accessToken(configuration, "sessions:write");
      const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/socket`, configuration.origin);
      url.searchParams.set("agentActorId", binding.agentActorId);
      url.searchParams.set("runtime", binding.runtime);
      url.searchParams.set("runtimeSessionId", binding.runtimeSessionId);
      const response = await dependencyFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw unavailable(`Agency Session socket failed with HTTP ${response.status}`);
      }
      return response.webSocket;
    },
  };
}

function agencyConfiguration(env: Env): { issuer: string; origin: string; resource: string; clientId: string; clientSecret: string } {
  if (!env.AMA_ORIGIN || !env.OIDC_SERVICE_CLIENT_ID || !env.OIDC_SERVICE_CLIENT_SECRET) {
    throw unavailable("AK Agency Session observation is not configured");
  }
  const origin = new URL(env.AMA_ORIGIN);
  if (origin.protocol !== "https:") throw unavailable("AMA_ORIGIN must use HTTPS");
  return {
    issuer: env.OIDC_ISSUER,
    origin: origin.origin,
    resource: amaResource(env),
    clientId: env.OIDC_SERVICE_CLIENT_ID,
    clientSecret: env.OIDC_SERVICE_CLIENT_SECRET,
  };
}

async function accessToken(
  configuration: { issuer: string; resource: string; clientId: string; clientSecret: string },
  scope: string,
): Promise<string> {
  try {
    return await realmrootClientCredentialsToken({ ...configuration, scope });
  } catch (error) {
    throw unavailable("Agency authorization failed", error);
  }
}

async function dependencyFetch(input: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw unavailable("Agency request failed", error);
  }
}

function decodeSessionList(value: unknown): AgencySession[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw invalidResponse();
  const sessions = value.data.map(decodeSession);
  const pagination = value.pagination;
  if (!isRecord(pagination) || typeof pagination.hasMore !== "boolean") throw invalidResponse();
  if (pagination.hasMore) {
    if (sessions.length === 0) throw invalidResponse();
    return sessions.length > 1 ? sessions : [sessions[0]!, sessions[0]!];
  }
  return sessions;
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
