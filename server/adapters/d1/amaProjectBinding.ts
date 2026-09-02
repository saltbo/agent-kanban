import type { AmaProjectBindingPort } from "@server/usecases/ama/ensureAmaProject";

export class D1AmaProjectBindingAdapter implements AmaProjectBindingPort {
  constructor(private readonly db: D1Database) {}

  async findProjectId(tenantId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT ama_project_id FROM ama_owner_integrations WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ ama_project_id: string }>();
    return row?.ama_project_id ?? null;
  }

  async claim(tenantId: string, claimToken: string, expiresAt: string, now: string): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT INTO ama_resource_initializations (tenant_id, claim_token, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           claim_token = excluded.claim_token,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at
         WHERE ama_resource_initializations.expires_at <= ?`,
      )
      .bind(tenantId, claimToken, expiresAt, now)
      .run();
    const row = await this.db
      .prepare("SELECT claim_token FROM ama_resource_initializations WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ claim_token: string }>();
    return row?.claim_token === claimToken;
  }

  async findClaimExpiry(tenantId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT expires_at FROM ama_resource_initializations WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ expires_at: string }>();
    return row?.expires_at ?? null;
  }

  async renew(tenantId: string, claimToken: string, expiresAt: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE ama_resource_initializations
         SET expires_at = ?, created_at = ?
         WHERE tenant_id = ? AND claim_token = ?`,
      )
      .bind(expiresAt, now, tenantId, claimToken)
      .run();
    return result.meta.changes === 1;
  }

  async store(tenantId: string, projectId: string, claimToken: string): Promise<boolean> {
    const [stored] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
           SELECT ?, ?, NULL, '{}'
           WHERE EXISTS (
             SELECT 1 FROM ama_resource_initializations
             WHERE tenant_id = ? AND claim_token = ?
           )
           ON CONFLICT(tenant_id) DO UPDATE SET
             ama_project_id = excluded.ama_project_id,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(tenantId, projectId, tenantId, claimToken),
      this.db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ? AND claim_token = ?").bind(tenantId, claimToken),
    ]);
    return stored.meta.changes > 0;
  }

  async release(tenantId: string, claimToken: string): Promise<void> {
    await this.db.prepare("DELETE FROM ama_resource_initializations WHERE tenant_id = ? AND claim_token = ?").bind(tenantId, claimToken).run();
  }
}
