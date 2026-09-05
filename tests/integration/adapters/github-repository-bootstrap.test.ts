import { generateKeyPairSync } from "node:crypto";
import { createRepository } from "@server/adapters/d1/repositoryRepo";
import { upsertInstallation } from "@server/adapters/github/githubInstallations";
import { repositoryBootstrap } from "@server/adapters/github/repositoryBootstrap";
import type { Env } from "@server/env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedUser, setupMiniflare } from "../../helpers/db";

let resources: Awaited<ReturnType<typeof setupMiniflare>>;
let privateKey: string;
beforeAll(async () => {
  resources = await setupMiniflare();
  privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});
afterAll(async () => resources.mf.dispose());
afterEach(() => vi.unstubAllGlobals());

async function fixture(repositoryResponse?: Response) {
  const ownerId = crypto.randomUUID();
  await seedUser(resources.db, ownerId, `${ownerId}@test.local`);
  const repository = await createRepository(resources.db, ownerId, { name: "Source", url: "https://github.com/example/source" });
  const installationId = Math.floor(Date.now() + Math.random() * 1000000);
  await upsertInstallation(resources.db, {
    installationId,
    ownerId,
    accountLogin: "example",
    accountId: 42,
    accountType: "Organization",
    repositorySelection: "selected",
  });
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/app/installations/${installationId}`))
      return Response.json({
        id: installationId,
        account: { id: 42, login: "example", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({ repositories: ["source"], permissions: { contents: "read" } });
      return Response.json({ token: "bootstrap-fixture-token", expires_at: expiresAt });
    }
    expect(url).toBe("https://api.github.com/repos/example/source");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bootstrap-fixture-token");
    expect(init?.redirect).toBe("manual");
    if (repositoryResponse) return repositoryResponse;
    return Response.json({ id: 123, owner: { id: 42 }, full_name: "example/source", default_branch: "main" });
  });
  vi.stubGlobal("fetch", fetch);
  const env = { DB: resources.db, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey } as Env;
  return { env, ownerId, repository, fetch, expiresAt };
}

describe("GitHub repository bootstrap", () => {
  it("rejects a repository redirect without forwarding the credential", async () => {
    const { env, ownerId, repository, fetch } = await fixture(
      new Response(null, { status: 301, headers: { location: "https://example.org/redirect" } }),
    );
    await expect(repositoryBootstrap(env, ownerId, repository.id)).rejects.toThrow("HTTP 301");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects changed repository inputs before minting a token", async () => {
    const { env, ownerId, repository, fetch } = await fixture();
    await expect(repositoryBootstrap(env, ownerId, repository.id, "https://github.com/example/original")).rejects.toThrow("Repository changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("[spec: tasks/repository-bootstrap] mints only repository read authority and retains expiry and default branch", async () => {
    const { env, ownerId, repository, expiresAt } = await fixture();
    await expect(repositoryBootstrap(env, ownerId, repository.id)).resolves.toMatchObject({
      repositoryId: repository.id,
      ref: "main",
      url: "https://github.com/example/source.git",
      mountPath: "/workspace/repos/github.com/example/source",
      expiresAt,
    });
  });
  it("rejects another tenant's Repository before requesting an App token", async () => {
    const { env, repository, fetch } = await fixture();
    await expect(repositoryBootstrap(env, "another-owner", repository.id)).rejects.toThrow("this tenant");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing installation authorization without borrowing another owner's installation", async () => {
    const { env, ownerId, repository, fetch } = await fixture();
    await resources.db.prepare("UPDATE github_installations SET owner_id = NULL WHERE owner_id = ?").bind(ownerId).run();
    await expect(repositoryBootstrap(env, ownerId, repository.id)).rejects.toThrow("Connect the GitHub App");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects changed installation ownership before minting", async () => {
    const { env, ownerId, repository, fetch } = await fixture();
    fetch.mockResolvedValueOnce(Response.json({ account: { id: 99, login: "example" }, suspended_at: null }));
    await expect(repositoryBootstrap(env, ownerId, repository.id)).rejects.toThrow("ownership changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
