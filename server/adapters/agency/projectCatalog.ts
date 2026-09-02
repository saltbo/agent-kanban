import type { Env } from "@server/env";
import type { AmaProject, AmaProjectCatalogPort } from "@server/usecases/ama/ensureAmaProject";
import { AmaProjectionError } from "@server/usecases/ama/failures";

export class AmaProjectCatalogAdapter implements AmaProjectCatalogPort {
  constructor(
    private readonly env: Env,
    private readonly token: string,
    private readonly traceparent?: string,
  ) {}

  async listProjects(renewClaim: () => Promise<void>): Promise<AmaProject[]> {
    const projects: AmaProject[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      await renewClaim();
      const url = new URL("/api/v1/projects", required(this.env.AMA_ORIGIN));
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const value = decodeProjectPage(await this.request(`${url.pathname}${url.search}`), 100);
      projects.push(...value.data);
      if (!value.pagination.hasMore) return projects;
      if (value.pagination.nextCursor === cursor) throw invalidResponse("AMA Project pagination did not advance");
      cursor = value.pagination.nextCursor;
    }
    throw invalidResponse("AMA Project pagination exceeded the safety bound");
  }

  async createProject(name: string): Promise<AmaProject> {
    return decodeProject(await this.request("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) }));
  }

  private async request(path: string, options: { method?: string; body?: string } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, required(this.env.AMA_ORIGIN)), {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(this.traceparent ? { traceparent: this.traceparent } : {}),
        },
        body: options.body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AmaProjectionError("unavailable", "AMA is unavailable");
    }
    if (!response.ok) {
      const kind = amaFailureKind(response.status);
      throw new AmaProjectionError(kind, kind === "unavailable" ? "AMA is unavailable" : "AMA request was rejected");
    }
    return response.json().catch(() => null);
  }
}

function decodeProjectPage(
  value: unknown,
  requestedLimit: number,
): { data: AmaProject[]; pagination: { hasMore: boolean; nextCursor: string | null } } {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.pagination)) throw invalidResponse("AMA returned an invalid Project page");
  if (value.data.length > requestedLimit) throw invalidResponse("AMA Project page exceeded the requested limit");
  const hasMore = value.pagination.hasMore;
  const nextCursor = value.pagination.nextCursor;
  if (typeof hasMore !== "boolean" || (hasMore && (typeof nextCursor !== "string" || nextCursor.length === 0)) || (!hasMore && nextCursor !== null)) {
    throw invalidResponse("AMA returned invalid Project pagination");
  }
  return { data: value.data.map(decodeProject), pagination: { hasMore, nextCursor: hasMore ? (nextCursor as string) : null } };
}

function decodeProject(value: unknown): AmaProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isDateTime(value.createdAt) ||
    !isDateTime(value.updatedAt)
  ) {
    throw invalidResponse("AMA returned an invalid Project");
  }
  return { id: value.id, name: value.name };
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function invalidResponse(message: string): AmaProjectionError {
  return new AmaProjectionError("invalid-response", message);
}

function required(value: string | undefined): string {
  if (!value) throw new AmaProjectionError("unavailable", "AMA_ORIGIN is required");
  return value.replace(/\/$/, "");
}

function amaFailureKind(status: number): "not-found" | "denied" | "rejected" | "invalid-response" | "unavailable" {
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "denied";
  if (status === 408 || status === 429 || (status >= 500 && status !== 502)) return "unavailable";
  return status === 502 ? "invalid-response" : "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
