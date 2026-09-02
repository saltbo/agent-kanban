export type AmaProject = { id: string; name: string };

export interface AmaProjectCatalogPort {
  listProjects(renewClaim: () => Promise<void>): Promise<AmaProject[]>;
  createProject(name: string): Promise<AmaProject>;
}

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

export async function ensureAmaProject(bindings: AmaProjectBindingPort, projects: AmaProjectCatalogPort, tenantId: string): Promise<string> {
  const existing = await bindings.findProjectId(tenantId);
  if (existing) return existing;

  const claimToken = crypto.randomUUID();
  const now = new Date();
  const claimed = await bindings.claim(tenantId, claimToken, new Date(now.getTime() + CLAIM_TTL_MS).toISOString(), now.toISOString());
  if (!claimed) return waitForProject(bindings, projects, tenantId);

  try {
    const afterClaim = await bindings.findProjectId(tenantId);
    if (afterClaim) {
      await bindings.release(tenantId, claimToken);
      return afterClaim;
    }
    const name = projectName(tenantId);
    const renewClaim = async () => {
      const renewedAt = new Date();
      const renewed = await bindings.renew(tenantId, claimToken, new Date(renewedAt.getTime() + CLAIM_TTL_MS).toISOString(), renewedAt.toISOString());
      if (!renewed) throw new AmaProjectClaimLost();
    };
    const available = await projects.listProjects(renewClaim);
    let project = available.find((candidate) => candidate.name === name);
    if (!project) {
      await renewClaim();
      project = await projects.createProject(name);
    }
    if (await bindings.store(tenantId, project.id, claimToken)) return project.id;
    return waitForProject(bindings, projects, tenantId);
  } catch (error) {
    await bindings.release(tenantId, claimToken);
    if (error instanceof AmaProjectClaimLost) return waitForProject(bindings, projects, tenantId);
    throw error;
  }
}

async function waitForProject(bindings: AmaProjectBindingPort, projects: AmaProjectCatalogPort, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    const projectId = await bindings.findProjectId(tenantId);
    if (projectId) return projectId;
    const expiry = await bindings.findClaimExpiry(tenantId);
    if (!expiry || expiry <= new Date().toISOString()) return ensureAmaProject(bindings, projects, tenantId);
  }
  throw new AmaProjectInitializationBusy();
}

class AmaProjectClaimLost extends Error {}

function projectName(tenantId: string): string {
  return `Agent Kanban ${tenantId}`;
}
