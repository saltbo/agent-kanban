import { AmaApiError, type AmaClient, createAmaClient } from "@realmroot/enbor-sdk";
import { AmaProjectionError, type AmaProjectionFailureKind } from "@server/usecases/ama/failures";

const REQUEST_TIMEOUT_MS = 10_000;

export function createAgencyClient(
  baseUrl: string,
  authorization: { token: string; projectId?: string; traceparent?: string },
  headers: Record<string, string> = {},
): AmaClient {
  const client = createAmaClient({
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

export function isAgencyNotFound(error: unknown): boolean {
  return error instanceof AmaApiError && error.status === 404;
}

export function toAmaProjectionError(error: unknown): AmaProjectionError {
  if (error instanceof AmaProjectionError) return error;
  if (!(error instanceof AmaApiError)) return new AmaProjectionError("invalid-response", "AMA returned an invalid resource representation");
  const kind = failureKind(error.status);
  return new AmaProjectionError(
    kind,
    kind === "unavailable"
      ? "AMA is unavailable"
      : kind === "invalid-response"
        ? "AMA returned an invalid resource representation"
        : "AMA request was rejected",
  );
}

function failureKind(status: number | undefined): AmaProjectionFailureKind {
  if (status === undefined || status === 408 || status === 429 || (status >= 500 && status !== 502)) return "unavailable";
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "denied";
  if ((status >= 200 && status < 300) || status === 502) return "invalid-response";
  return "rejected";
}
