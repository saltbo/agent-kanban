import { AmaApiError, type AmaClient, type Project } from "@realmroot/enbor-sdk";

export interface AmaProjectBindingPort {
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

export class AmaProjectInitializationBusy extends Error {
  constructor() {
    super("AMA project initialization is still in progress. Retry the request.");
    this.name = "AmaProjectInitializationBusy";
  }
}

export async function ensureAmaProject(bindings: AmaProjectBindingPort, client: AmaClient, tenantId: string): Promise<string> {
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
      if (!renewed) throw new AmaProjectClaimLost();
    };
    const available: Project[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      await renewClaim();
      const page = await client.projects.list({ limit: 100, cursor });
      available.push(...page.data);
      const nextCursor = page.pagination.nextCursor ?? undefined;
      if (!nextCursor) break;
      if (nextCursor === cursor) throw invalidPagination("AMA Project pagination did not advance");
      if (pageNumber === 99) throw invalidPagination("AMA Project pagination exceeded the safety bound");
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
    if (error instanceof AmaProjectClaimLost) return waitForProject(bindings, client, tenantId);
    throw error;
  }
}

async function waitForProject(bindings: AmaProjectBindingPort, client: AmaClient, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    const projectId = await bindings.findProjectId(tenantId);
    if (projectId) return projectId;
    const expiry = await bindings.findClaimExpiry(tenantId);
    if (!expiry || expiry <= new Date().toISOString()) return ensureAmaProject(bindings, client, tenantId);
  }
  throw new AmaProjectInitializationBusy();
}

class AmaProjectClaimLost extends Error {}

function invalidPagination(message: string): AmaApiError {
  return new AmaApiError(502, message, null);
}
