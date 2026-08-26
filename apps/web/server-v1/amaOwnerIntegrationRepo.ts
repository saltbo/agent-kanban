import { createAmaEnvironment, createAmaProject, createAmaVault, readAmaProject } from "./amaRuntime";
import type { D1 } from "./db";
import type { Env } from "./types";

export interface AmaOwnerIntegration {
  tenantId: string;
  amaProjectId: string;
  sessionSecretVaultId: string | null;
  metadata: Record<string, unknown>;
}

type AmaOwnerIntegrationRow = {
  tenant_id: string;
  ama_project_id: string;
  session_secret_vault_id: string | null;
  metadata: string;
};

const INITIALIZATION_CLAIM_TTL_MS = 15_000;
const INITIALIZATION_WAIT_ATTEMPTS = 170;
const INITIALIZATION_WAIT_MS = 100;
const initializationInFlight = new Map<string, Promise<AmaOwnerIntegration>>();

export async function getAmaOwnerIntegration(db: D1, ownerId: string): Promise<AmaOwnerIntegration | null> {
  const row = await db
    .prepare("SELECT tenant_id, ama_project_id, session_secret_vault_id, metadata FROM ama_owner_integrations WHERE tenant_id = ?")
    .bind(ownerId)
    .first<AmaOwnerIntegrationRow>();
  return row ? parseIntegration(row) : null;
}

export async function ensureAmaOwnerIntegration(db: D1, env: Env, ownerId: string): Promise<AmaOwnerIntegration> {
  const existingAttempt = initializationInFlight.get(ownerId);
  if (existingAttempt) return existingAttempt;
  const attempt = ensureAmaOwnerIntegrationClaimed(db, env, ownerId);
  initializationInFlight.set(ownerId, attempt);
  try {
    return await attempt;
  } finally {
    if (initializationInFlight.get(ownerId) === attempt) initializationInFlight.delete(ownerId);
  }
}

async function ensureAmaOwnerIntegrationClaimed(db: D1, env: Env, ownerId: string): Promise<AmaOwnerIntegration> {
  const existing = await getAmaOwnerIntegration(db, ownerId);
  // Validate the stored project still exists: AMA resources can be deleted out
  // of band (e.g. a control-plane data reset), leaving our ids dangling. A
  // missing project means its vault and cloud environment are gone too, so
  // re-provision the whole integration rather than dispatch against ghosts.
  const projectAlive = existing?.amaProjectId ? (await readAmaProject(env, ownerId, existing.amaProjectId)) !== null : false;
  if (existing?.sessionSecretVaultId && projectAlive) return existing;

  const claimToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + INITIALIZATION_CLAIM_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         claim_token = excluded.claim_token,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at
       WHERE ama_resource_initializations.expires_at <= ?`,
    )
    .bind(ownerId, claimToken, expiresAt, now)
    .run();
  const claim = await db
    .prepare("SELECT claim_token FROM ama_resource_initializations WHERE tenant_id = ?")
    .bind(ownerId)
    .first<{ claim_token: string }>();
  if (claim?.claim_token !== claimToken) return waitForAmaOwnerIntegration(db, env, ownerId);

  try {
    const projectId = projectAlive
      ? existing!.amaProjectId
      : (
          await createAmaProject(env, ownerId, {
            name: `Workspace ${ownerId}`,
            idempotencyKey: await stableIdempotencyKey(`project:${ownerId}:${existing?.amaProjectId ?? "initial"}`),
          })
        ).id;
    if (!projectAlive) {
      // Persist the completed first phase before creating the vault. If vault
      // provisioning fails, the next claim reuses this project instead of
      // leaking a second project in AMA.
      const checkpointed = await storeClaimedIntegration(
        db,
        {
          tenantId: ownerId,
          amaProjectId: projectId,
          sessionSecretVaultId: null,
          metadata: {},
        },
        claimToken,
        false,
      );
      if (!checkpointed) return waitForAmaOwnerIntegration(db, env, ownerId);
    }
    const reuseVault = Boolean(projectAlive && existing?.sessionSecretVaultId);
    const vault = reuseVault
      ? null
      : await createAmaVault(env, ownerId, {
          projectId,
          name: "Session secrets",
          description: "Session credentials used by runtime sessions.",
          scope: "project",
          idempotencyKey: await stableIdempotencyKey(`vault:${ownerId}:${projectId}:session-secrets`),
        });
    const initialized = {
      tenantId: ownerId,
      amaProjectId: projectId,
      sessionSecretVaultId: reuseVault ? existing!.sessionSecretVaultId : (vault?.id ?? null),
      metadata: projectAlive ? (existing?.metadata ?? {}) : {},
    };
    if (!(await storeClaimedIntegration(db, initialized, claimToken, true))) {
      return waitForAmaOwnerIntegration(db, env, ownerId);
    }
    return initialized;
  } catch (error) {
    await db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ? AND claim_token = ?").bind(ownerId, claimToken).run();
    throw error;
  }
}

async function storeClaimedIntegration(db: D1, integration: AmaOwnerIntegration, claimToken: string, releaseClaim: boolean): Promise<boolean> {
  const statements = [
    db
      .prepare(
        `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ama_resource_initializations
           WHERE tenant_id = ? AND claim_token = ?
         )
         ON CONFLICT(tenant_id) DO UPDATE SET
           ama_project_id = excluded.ama_project_id,
           session_secret_vault_id = excluded.session_secret_vault_id,
           metadata = excluded.metadata,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .bind(
        integration.tenantId,
        integration.amaProjectId,
        integration.sessionSecretVaultId,
        JSON.stringify(integration.metadata),
        integration.tenantId,
        claimToken,
      ),
  ];
  if (releaseClaim) {
    statements.push(
      db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ? AND claim_token = ?").bind(integration.tenantId, claimToken),
    );
  }
  const [stored] = await db.batch(statements);
  return stored.meta.changes > 0;
}

async function waitForAmaOwnerIntegration(db: D1, env: Env, ownerId: string): Promise<AmaOwnerIntegration> {
  for (let attempt = 0; attempt < INITIALIZATION_WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_WAIT_MS));
    const claim = await db
      .prepare("SELECT expires_at FROM ama_resource_initializations WHERE tenant_id = ?")
      .bind(ownerId)
      .first<{ expires_at: string }>();
    if (!claim || claim.expires_at <= new Date().toISOString()) return ensureAmaOwnerIntegrationClaimed(db, env, ownerId);
  }
  throw new Error(`AMA resource initialization is already in progress for tenant ${ownerId}`);
}

async function stableIdempotencyKey(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `ak-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function resolveAmaProjectId(db: D1, env: Env, ownerId: string): Promise<string> {
  return (await ensureAmaOwnerIntegration(db, env, ownerId)).amaProjectId;
}

// Read-only variant for GET paths: a read must never provision AMA resources.
export async function getAmaProjectId(db: D1, ownerId: string): Promise<string | null> {
  return (await getAmaOwnerIntegration(db, ownerId))?.amaProjectId ?? null;
}

// Read-only project id for dispatch. Resource initialization happens before
// dispatch, so this path never mutates the control plane.
export async function requireAmaProjectId(db: D1, ownerId: string): Promise<string> {
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) {
    throw new Error(`AMA resources are not initialized for tenant ${ownerId}`);
  }
  return projectId;
}

// Creates a fresh cloud-sandbox AMA environment for a cloud-sandbox machine.
// Each cloud sandbox is its own environment (AMA scales sandboxes per session),
// so this always provisions a new one rather than reusing a per-owner singleton.
export async function createAmaCloudSandboxEnvironment(
  db: D1,
  env: Env,
  ownerId: string,
  name: string,
): Promise<{ projectId: string; environmentId: string }> {
  const integration = await ensureAmaOwnerIntegration(db, env, ownerId);
  const environment = await createAmaEnvironment(env, ownerId, {
    projectId: integration.amaProjectId,
    name,
    description: `Cloud sandbox for AK owner ${ownerId}.`,
    hostingMode: "cloud",
    metadata: { ownerId },
  });
  return { projectId: integration.amaProjectId, environmentId: environment.id };
}

export async function resolveAmaSessionSecretVaultId(db: D1, env: Env, ownerId: string): Promise<string> {
  const binding = await ensureAmaOwnerIntegration(db, env, ownerId);
  if (!binding.sessionSecretVaultId) {
    throw new Error(`AMA session secret vault is missing for owner ${ownerId}`);
  }
  return binding.sessionSecretVaultId;
}

function parseIntegration(row: AmaOwnerIntegrationRow): AmaOwnerIntegration {
  return {
    tenantId: row.tenant_id,
    amaProjectId: row.ama_project_id,
    sessionSecretVaultId: row.session_secret_vault_id,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}
