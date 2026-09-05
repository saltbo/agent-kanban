import { describe, expect, it, vi } from "vitest";

const authenticateRealmrootToken = vi.hoisted(() => vi.fn());

vi.mock("../../../server/auth/realmroot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/auth/realmroot")>()),
  authenticateRealmrootToken,
}));

import { authenticationMiddleware, principalProvisioningMiddleware } from "../../../server/auth/middleware";

describe("authentication middleware boundaries", () => {
  it("establishes the principal without provisioning it, then provisions in the independent middleware", async () => {
    const principal = {
      source: "token",
      type: "human",
      subjectId: "human-subject",
      tenantId: "tenant-1",
      scopes: ["board:read"],
    };
    authenticateRealmrootToken.mockResolvedValue(principal);
    const batch = vi.fn(async () => []);
    const statement = { bind: vi.fn(() => statement) };
    const values: Record<string, unknown> = {};
    const context = {
      env: { DB: { prepare: vi.fn(() => statement), batch } },
      req: { header: (name: string) => (name.toLowerCase() === "authorization" ? "DPoP access-token" : undefined) },
      set: (key: string, value: unknown) => {
        values[key] = value;
      },
      get: (key: string) => values[key],
    } as Parameters<typeof authenticationMiddleware>[0];
    const next = vi.fn(async () => undefined);

    await authenticationMiddleware(context, next);

    expect(values).toMatchObject({ principal, ownerId: "tenant-1" });
    expect(batch).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();

    next.mockClear();
    await principalProvisioningMiddleware(context, next);

    expect(batch).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
