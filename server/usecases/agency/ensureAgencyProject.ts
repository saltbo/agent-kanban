import { EnborApiError, type EnborClient, type Project } from "@realmroot/enbor-sdk";

export interface AgencyProjectBindingPort {
  findProjectId(tenantId: string): Promise<string | null>;
  claim(tenantId: string, claimToken: string, expiresAt: string, now: string): Promise<boolean>;
  renew(tenantId: string, claimToken: string, expiresAt: string, now: string): Promise<boolean>;
  findClaimExpiry(tenantId: string): Promise<string | null>;
  store(tenantId: string, projectId: string, claimToken: string): Promise<boolean>;
  release(tenantId: string, claimToken: string): Promise<void>;
}

const CLAIM_TTL_MS = 25_000;
const WAIT_ATTEMPTS = 100;
const WAIT_MS = 100;

export class AgencyProjectInitializationBusy extends Error {
  constructor() {
    super("Enbor project initialization is still in progress. Retry the request.");
    this.name = "AgencyProjectInitializationBusy";
  }
}

export async function ensureAgencyProject(bindings: AgencyProjectBindingPort, client: EnborClient, tenantId: string): Promise<string> {
  const existing = await bindings.findProjectId(tenantId);
  if (existing) return existing;

  const claimToken = crypto.randomUUID();
  const now = new Date();
  const claimed = await bindings.claim(tenantId, claimToken, new Date(now.getTime() + CLAIM_TTL_MS).toISOString(), now.toISOString());
  if (!claimed) return waitForProject(bindings, client, tenantId);

  try {
    const afterClaim = await bindings.findProjectId(tenantId);
    if (afterClaim) {
      await bindings.release(tenantId, claimToken);
      return afterClaim;
    }
    const name = "Agent Kanban";
    const renewClaim = async () => {
      const renewedAt = new Date();
      const renewed = await bindings.renew(tenantId, claimToken, new Date(renewedAt.getTime() + CLAIM_TTL_MS).toISOString(), renewedAt.toISOString());
      if (!renewed) throw new AgencyProjectClaimLost();
    };
    const available: Project[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      await renewClaim();
      const page = await client.projects.list({ limit: 100, cursor });
      available.push(...page.data);
      const nextCursor = page.pagination.nextCursor ?? undefined;
      if (!nextCursor) break;
      if (nextCursor === cursor) throw invalidPagination("Agency Project pagination did not advance");
      if (pageNumber === 99) throw invalidPagination("Agency Project pagination exceeded the safety bound");
      cursor = nextCursor;
    }
    let project = available.find((candidate) => candidate.name === name);
    if (!project) {
      await renewClaim();
      project = await client.projects.create({ name });
    }
    if (await bindings.store(tenantId, project.id, claimToken)) return project.id;
    return waitForProject(bindings, client, tenantId);
  } catch (error) {
    await bindings.release(tenantId, claimToken);
    if (error instanceof AgencyProjectClaimLost) return waitForProject(bindings, client, tenantId);
    throw error;
  }
}

async function waitForProject(bindings: AgencyProjectBindingPort, client: EnborClient, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    const projectId = await bindings.findProjectId(tenantId);
    if (projectId) return projectId;
    const expiry = await bindings.findClaimExpiry(tenantId);
    if (!expiry || expiry <= new Date().toISOString()) return ensureAgencyProject(bindings, client, tenantId);
  }
  throw new AgencyProjectInitializationBusy();
}

class AgencyProjectClaimLost extends Error {}

function invalidPagination(message: string): EnborApiError {
  return new EnborApiError(502, message, null);
}
