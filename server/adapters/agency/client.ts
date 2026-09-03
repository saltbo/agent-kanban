import { createEnborClient, type EnborClient } from "@realmroot/enbor-sdk";

const REQUEST_TIMEOUT_MS = 10_000;

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
  return client;
}
