import type { Project } from "@realmroot/enbor-sdk";
import { createAgencyClient, toAmaProjectionError } from "@server/adapters/agency/client";
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
    return this.call(async () => {
      const projects: AmaProject[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        await renewClaim();
        const page = await this.client().projects.list({ limit: 100, ...(cursor ? { cursor } : {}) });
        assertProjectPage(page.data, page.pagination, 100);
        projects.push(...page.data.map(({ id, name }) => ({ id, name })));
        if (!page.pagination.hasMore) return projects;
        if (!page.pagination.nextCursor) throw invalidResponse("AMA returned invalid Project pagination");
        if (page.pagination.nextCursor === cursor) throw invalidResponse("AMA Project pagination did not advance");
        cursor = page.pagination.nextCursor;
      }
      throw invalidResponse("AMA Project pagination exceeded the safety bound");
    });
  }

  async createProject(name: string): Promise<AmaProject> {
    return this.call(async () => {
      const project = await this.client().projects.create({ name });
      assertProject(project);
      const { id, name: createdName } = project;
      return { id, name: createdName };
    });
  }

  private client() {
    return createAgencyClient(required(this.env.AMA_ORIGIN), { token: this.token, traceparent: this.traceparent });
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toAmaProjectionError(error);
    }
  }
}

function required(value: string | undefined): string {
  if (!value) throw new AmaProjectionError("unavailable", "AMA_ORIGIN is required");
  return value;
}

function invalidResponse(message: string): AmaProjectionError {
  return new AmaProjectionError("invalid-response", message);
}

function assertProjectPage(data: Project[], pagination: { hasMore: boolean; nextCursor: string | null }, requestedLimit: number): void {
  if (!Array.isArray(data) || data.length > requestedLimit) throw invalidResponse("AMA Project page exceeded the requested limit");
  for (const project of data) assertProject(project);
  if (
    typeof pagination?.hasMore !== "boolean" ||
    (pagination.hasMore && !nonEmptyString(pagination.nextCursor)) ||
    (!pagination.hasMore && pagination.nextCursor !== null)
  ) {
    throw invalidResponse("AMA returned invalid Project pagination");
  }
}

function assertProject(project: Project): void {
  if (!nonEmptyString(project?.id) || !nonEmptyString(project.name)) throw invalidResponse("AMA returned an invalid Project");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
