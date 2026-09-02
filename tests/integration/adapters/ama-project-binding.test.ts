// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1AmaProjectBindingAdapter } from "../../../server/adapters/d1/amaProjectBinding";
import { seedUser, setupMiniflare } from "../../helpers/db";

const tenantId = "tenant-transparent-project-binding";
let fixture: Awaited<ReturnType<typeof setupMiniflare>>;

beforeEach(async () => {
  fixture = await setupMiniflare();
  await seedUser(fixture.db, tenantId, "project-binding@example.test");
});

afterEach(async () => fixture.mf.dispose());

describe("D1 AMA project initialization binding", () => {
  it("[spec: agents/transparent-ama-project] conditionally claims and stores only the winning project binding", async () => {
    const adapter = new D1AmaProjectBindingAdapter(fixture.db);
    const now = "2026-09-01T12:00:00.000Z";
    const expiry = "2026-09-01T12:00:25.000Z";

    await expect(adapter.claim(tenantId, "claim-winner", expiry, now)).resolves.toBe(true);
    await expect(adapter.claim(tenantId, "claim-loser", expiry, now)).resolves.toBe(false);
    await expect(adapter.renew(tenantId, "claim-loser", "2026-09-01T12:00:40.000Z", "2026-09-01T12:00:15.000Z")).resolves.toBe(false);
    await expect(adapter.findClaimExpiry(tenantId)).resolves.toBe(expiry);
    await expect(adapter.renew(tenantId, "claim-winner", "2026-09-01T12:00:45.000Z", "2026-09-01T12:00:20.000Z")).resolves.toBe(true);
    await expect(adapter.findClaimExpiry(tenantId)).resolves.toBe("2026-09-01T12:00:45.000Z");
    await expect(adapter.store(tenantId, "project-loser", "claim-loser")).resolves.toBe(false);
    await expect(adapter.findProjectId(tenantId)).resolves.toBeNull();

    await expect(adapter.store(tenantId, "project-winner", "claim-winner")).resolves.toBe(true);
    await expect(adapter.findProjectId(tenantId)).resolves.toBe("project-winner");
    await expect(adapter.findClaimExpiry(tenantId)).resolves.toBeNull();
    await expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM ama_owner_integrations WHERE tenant_id = ?").bind(tenantId).first(),
    ).resolves.toEqual({ count: 1 });
  });
});
