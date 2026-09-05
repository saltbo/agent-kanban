import {
  type CreateSessionRequest,
  type CreateTriggerRequest,
  createEnborClient,
  EnborApiError,
  type EnborClient,
  type Session,
  type Trigger,
} from "@realmroot/enbor-sdk";

const REQUEST_TIMEOUT_MS = 30_000;

export function createAgencyClient(
  baseUrl: string,
  authorization: { token: string; projectId?: string; traceparent?: string },
  headers: Record<string, string> = {},
): EnborClient {
  const client = createEnborClient({
    baseUrl,
    projectId: authorization.projectId,
    headers: {
      Authorization: `Bearer ${authorization.token}`,
      ...(authorization.traceparent ? { traceparent: authorization.traceparent } : {}),
      ...headers,
    },
  });
  const sdkFetch = client.raw.getConfig().fetch ?? globalThis.fetch;
  client.raw.setConfig({
    fetch: (input, init) => sdkFetch(new Request(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })),
  });
  const createTrigger = client.triggers.create;
  client.triggers.create = ((body: CreateTriggerRequest, idempotencyKey?: string) =>
    idempotencyKey ? createIdempotentTrigger(client, body, idempotencyKey) : createTrigger(body)) as EnborClient["triggers"]["create"];
  return client;
}

async function createIdempotentTrigger(client: EnborClient, body: CreateTriggerRequest, idempotencyKey: string): Promise<Trigger> {
  const result = (await client.raw.post({
    url: "/api/v1/triggers",
    body,
    headers: { "Content-Type": "application/json", "idempotency-key": idempotencyKey },
  })) as { data?: Trigger; error?: unknown; response?: Response };
  if (result.response?.ok && result.error === undefined && result.data) return result.data;
  const responseBody = result.error ?? result.data;
  throw new EnborApiError(
    result.response?.status,
    typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody ?? {}),
    responseBody,
  );
}

export async function createAgencySession(client: EnborClient, body: CreateSessionRequest, idempotencyKey: string): Promise<Session> {
  const result = (await client.raw.post({
    url: "/api/v1/sessions",
    body,
    headers: { "Content-Type": "application/json", "idempotency-key": idempotencyKey },
  })) as { data?: Session; error?: unknown; response?: Response };
  if (result.response?.ok && result.error === undefined && result.data) return result.data;
  const responseBody = result.error ?? result.data;
  throw new EnborApiError(
    result.response?.status,
    typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody ?? {}),
    responseBody,
  );
}
