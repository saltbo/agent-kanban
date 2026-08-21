// @vitest-environment node

import { describe, expect, it } from "vitest";
import { api } from "../apps/web/server/routes";
import { createTestEnv } from "./helpers/db";

describe("removed public GPG and WKD routes", () => {
  it.each([
    "/agents/legacy-agent.gpg",
    "/.well-known/openpgpkey/hu/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?l=legacy-agent",
    "/.well-known/openpgpkey/policy",
  ])("returns 404 for %s", async (path) => {
    const response = await api.request(path, {}, createTestEnv());
    expect(response.status).toBe(404);
  });
});
