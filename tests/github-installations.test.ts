// @vitest-environment node

/**
 * Tests for GitHub App installation tracking:
 *  1. upsertInstallation — COALESCE owner, lowercase storage
 *  2. deleteInstallation — removes rows + child repo rows
 *  3. setInstallationSuspended — suspend / unsuspend
 *  4. replaceInstallationRepositories — full replace
 *  5. addInstallationRepositories / removeInstallationRepositories — partial edits
 *  6. handleGithubInstallationEvent — webhook dispatch: created/deleted/suspend/unsuspend
 *  7. handleGithubInstallationRepositoriesEvent — added/removed/selection flip
 *  8. repoAppStatus / repoAppStatusBatch — coverage computation
 *  9. getInstallationsForOwner — owner-scoped read
 * 10. POST /api/webhooks/github-app — installation + installation_repositories route dispatch
 * 11. GET /api/github-app/config — authenticated, owner-scoped installed/accounts fields
 * 12. repo read model — app_status on POST/GET /api/repositories
 * 13. recordInstallationFromSetup — fetch stubbed, upsert + replace exercised
 */

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const WEBHOOK_SECRET = "test-webhook-secret-xyz";
const OIDC_ISSUER = "https://github-installations.realmroot.test";
const AK_PUBLIC_ORIGIN = "http://localhost";

let db: D1Database;
let mf: Miniflare;

// Pre-computed throwaway RSA-2048 PKCS#8 private key (PEM). Embedded as a
// static constant so crypto.subtle.generateKey is never called at runtime,
// which previously caused out-of-heap-memory crashes when run repeatedly.
const sharedPrivateKey =
  "-----BEGIN PRIVATE KEY-----\n" +
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDeWh/EeP4jqpGO\n" +
  "kRUr2VgNWqS1Q4XRir9JfCHxgWuKoodrTa6dSJtBbFEoLYjHA2CRpr+xTs6OsTAO\n" +
  "9IKJSoZBkzyyMItkY7MOzGCU1diPmtNqvV+W1Q9EmrJQ/w7VekIv9CeGWcBe3YOY\n" +
  "8bJ8ZP7atroxo/gFAP5NYXaYygMSVPYgAUeC/VHGwYbB1hnYJBUV4qhy9fgTGnmD\n" +
  "AXPg0/EnAJL5BXdSxa2B+PtytFOBl2709f+e/BhxsVMY5NPikQczhghraA/6/4o4\n" +
  "lv+ZEFr7qVoFqthFxPUMVA4iOS/QEPpBIDjh6Db1Yvkbe5h/Bol2yHhJrGmjE+AP\n" +
  "BcMwUmoFAgMBAAECggEANoF2uJmlSNZy7HUVsMRMYKen6RRGjT17Ezc19ebxFxCs\n" +
  "7AmkpIMsJd84zMXOueRSy5mJ85u7KED4pC3dguytGQ2QCyk5vk/vUJEamtmKBvff\n" +
  "3BJUiJutbLaUQCUp/HxGFc2+06EUNl0MOZWEGJjEXZZ98ZW9gnKCJDNgWGdq1dbf\n" +
  "beny1KbMd7Lmtkp+fVCC/r/EOhkRrc/ltgYRrcGyG6KdvWBidI/ugAF3qgN9Kc1p\n" +
  "9TkvbmISN14xgLtxeYZbW9jG9uMcxEi4Yo1xD6eZkLJzf6Ca0cYi98DpTx4JBKy6\n" +
  "EiXtTXHHiLXLxO02Y9VrcgYxiPUeXqnT2eyxNpsxYQKBgQDwuJbXB/VVkuHy9jIn\n" +
  "JohuCvjWJxrShpsxDhBHCcbG8rsFL0KfvfZZ+k2hO0SZyNN51g4cSXGcvi+9PXTp\n" +
  "7AotmPc4h5eQx0lYNKteiDD5Agl3GTa7h8H0kyHAL1bZt2xN6Ui0xArhDHWIQwJG\n" +
  "YRU5T4uw2KkZJDQUFu/u68rTpQKBgQDsdw/aVttNLjDMrSpX7Iwx0Qd8IT/Cit/l\n" +
  "i6IRCEC2epTVIh9tXwwDiH+csJR2/kLEp/sC9ceJYN5fgALInZF39GfAGYOjzWnA\n" +
  "ng37tfDbHsv0oE5zYgH0SfN70jxa46zjRetCplKiMeeUvl9lvX2zOuk0+fGuXUGS\n" +
  "4saFuy/u4QKBgQDG8ZdgQaiFv63TUZtjddodMB41Rv5I7YxG/3t+alsIw0TDZSqn\n" +
  "wKRf+pi73rK0ciAsujbRM/WceCYWPTtptHU4+Amhg5ZExh8csfLLXr0ynndaIdF1\n" +
  "LR6j1hF3tugNaSUuQtWe58Kh+d0M72xq5ANZaR9m2bjvGVedHtPO3rqzLQKBgHcl\n" +
  "ruk3Jp0HDzOydUmEOUfIqVrUbgoaa6J/7xNh8yl/LosN/IPhhm4pUxOircwfZYkt\n" +
  "kv701KvWEXZRTBXFv0yP688RjBD3KbgSa71O+aOPKvmB5MWitpVexb64Og0Z9z01\n" +
  "N8uHfs+XEbcTDYJ4LmQm5Ob6odpXxvi6J4muvgJBAoGADJHDSJsj1jXzV9LqZQIA\n" +
  "b3mePaxUJa6jQlGQTKr1baOJtKFXZXvSP4zvKb/LiVtjyj1vqktn0D2FrCyYsXON\n" +
  "HamHhIsBF3eNRT4VUSqyGh3UyCKuLinmpQtX5W9CPWAkqYaMvhUCZqLA9FMc+nv4\n" +
  "8or33ehPHwLc5KQfnNaXXXY=\n" +
  "-----END PRIVATE KEY-----\n";

function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    DB: db,
    EMAIL: { send: async () => ({ messageId: "test" }) } as any,
    ASSETS: null as any,
    AUTH_SECRET: "test-secret-32-chars-minimum-ok!!",
    ALLOWED_HOSTS: "localhost:8788",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OIDC_ISSUER,
    AK_PUBLIC_ORIGIN,
    ...overrides,
  };
}

async function signWebhookBody(body: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function apiRequest(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
  envOverrides: Record<string, unknown> = {},
  token?: string,
) {
  const { api } = await import("../server/http/app");
  const allHeaders: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http", ...headers };
  if (token?.includes(":csrf:")) {
    const [sessionToken, csrfToken] = token.split(":csrf:");
    allHeaders.cookie = `ak_session=${sessionToken}`;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") allHeaders["x-csrf-token"] = csrfToken;
  } else if (token) {
    allHeaders.Authorization = `Bearer ${token}`;
  }
  const init: RequestInit = {
    method,
    headers: allHeaders,
    ...(body !== undefined ? { body } : {}),
  };
  return api.request(path, init, makeEnv(envOverrides));
}

async function createVerifiedUserToken(): Promise<{ token: string; userId: string }> {
  const userId = `github-config-${randomUUID()}`;
  const email = `config-test-${randomUUID()}@test.local`;
  await seedUser(db, userId, email);
  const session = await createTestWebSession(db, userId, { email });
  return { token: `${session.token}:csrf:${session.csrfToken}`, userId };
}

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. upsertInstallation ────────────────────────────────────────────────────

describe("upsertInstallation", () => {
  it("inserts a new installation row", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 100_000;
    await upsertInstallation(db, {
      installationId: id,
      ownerId: "owner-insert-test",
      accountLogin: "MyOrg",
      accountId: 99,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const row = await db.prepare("SELECT * FROM github_installations WHERE installation_id = ?").bind(id).first<any>();
    expect(row).not.toBeNull();
    expect(row.owner_id).toBe("owner-insert-test");
    expect(row.account_login).toBe("myorg");
  });

  it("stores account_login lowercased", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 200_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "UpperCaseOrg",
      accountId: 100,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const row = await db
      .prepare("SELECT account_login FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ account_login: string }>();
    expect(row!.account_login).toBe("uppercaseorg");
  });

  it("COALESCE: does NOT overwrite an existing owner_id when upserted with null owner", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 300_000;
    await upsertInstallation(db, {
      installationId: id,
      ownerId: "original-owner",
      accountLogin: "acme",
      accountId: 201,
      accountType: "Organization",
      repositorySelection: "all",
    });
    // Second upsert with no ownerId — must not clobber
    await upsertInstallation(db, {
      installationId: id,
      ownerId: null,
      accountLogin: "acme",
      accountId: 201,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const row = await db.prepare("SELECT owner_id FROM github_installations WHERE installation_id = ?").bind(id).first<{ owner_id: string | null }>();
    expect(row!.owner_id).toBe("original-owner");
  });

  it("COALESCE: sets owner_id when first inserted with null then upserted with a value", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 400_000;
    await upsertInstallation(db, {
      installationId: id,
      ownerId: null,
      accountLogin: "nullfirst",
      accountId: 202,
      accountType: "User",
      repositorySelection: "all",
    });
    await upsertInstallation(db, {
      installationId: id,
      ownerId: "late-owner",
      accountLogin: "nullfirst",
      accountId: 202,
      accountType: "User",
      repositorySelection: "all",
    });
    const row = await db.prepare("SELECT owner_id FROM github_installations WHERE installation_id = ?").bind(id).first<{ owner_id: string | null }>();
    expect(row!.owner_id).toBe("late-owner");
  });

  it("updates repository_selection on conflict", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 500_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "seltest",
      accountId: 203,
      accountType: "Organization",
      repositorySelection: "all",
    });
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "seltest",
      accountId: 203,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    const row = await db
      .prepare("SELECT repository_selection FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ repository_selection: string }>();
    expect(row!.repository_selection).toBe("selected");
  });
});

// ─── 2. deleteInstallation ────────────────────────────────────────────────────

describe("deleteInstallation", () => {
  it("removes the installation row", async () => {
    const { upsertInstallation, deleteInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 600_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "deltest",
      accountId: 300,
      accountType: "Organization",
      repositorySelection: "all",
    });
    await deleteInstallation(db, id);
    const row = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("removes child repository rows when installation is deleted", async () => {
    const { upsertInstallation, deleteInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 700_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "delwithrepos",
      accountId: 301,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "delwithrepos/repo1" }]);
    await deleteInstallation(db, id);
    const repoRow = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).first();
    expect(repoRow).toBeNull();
  });
});

// ─── 3. setInstallationSuspended ─────────────────────────────────────────────

describe("setInstallationSuspended", () => {
  it("sets suspended_at to a timestamp when suspended", async () => {
    const { upsertInstallation, setInstallationSuspended } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 800_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "susptest",
      accountId: 400,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const ts = new Date().toISOString();
    await setInstallationSuspended(db, id, ts);
    const row = await db
      .prepare("SELECT suspended_at FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ suspended_at: string | null }>();
    expect(row!.suspended_at).toBe(ts);
  });

  it("clears suspended_at (unsuspend) by setting null", async () => {
    const { upsertInstallation, setInstallationSuspended } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 810_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "unsusptest",
      accountId: 401,
      accountType: "Organization",
      repositorySelection: "all",
      suspendedAt: new Date().toISOString(),
    });
    await setInstallationSuspended(db, id, null);
    const row = await db
      .prepare("SELECT suspended_at FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ suspended_at: string | null }>();
    expect(row!.suspended_at).toBeNull();
  });
});

// ─── 4. replaceInstallationRepositories ──────────────────────────────────────

describe("replaceInstallationRepositories", () => {
  it("inserts repos from the list", async () => {
    const { upsertInstallation, replaceInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 900_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "replacetest",
      accountId: 500,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await replaceInstallationRepositories(db, id, [{ fullName: "replacetest/alpha" }, { fullName: "replacetest/beta" }]);
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    const names = rows.results.map((r) => r.full_name).sort();
    expect(names).toEqual(["replacetest/alpha", "replacetest/beta"]);
  });

  it("replaces previous repos with the new list", async () => {
    const { upsertInstallation, replaceInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 910_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "replaceover",
      accountId: 501,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await replaceInstallationRepositories(db, id, [{ fullName: "replaceover/old" }]);
    await replaceInstallationRepositories(db, id, [{ fullName: "replaceover/new" }]);
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name)).toEqual(["replaceover/new"]);
  });

  it("stores full_name lowercased", async () => {
    const { upsertInstallation, replaceInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 920_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "lowerrepo",
      accountId: 502,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await replaceInstallationRepositories(db, id, [{ fullName: "LowerRepo/UpperCase" }]);
    const row = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .first<{ full_name: string }>();
    expect(row!.full_name).toBe("lowerrepo/uppercase");
  });

  it("empties the repo list when passed an empty array", async () => {
    const { upsertInstallation, replaceInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 930_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "emptyreplace",
      accountId: 503,
      accountType: "Organization",
      repositorySelection: "all",
    });
    await replaceInstallationRepositories(db, id, [{ fullName: "emptyreplace/x" }]);
    await replaceInstallationRepositories(db, id, []);
    const rows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(0);
  });
});

// ─── 5. addInstallationRepositories / removeInstallationRepositories ──────────

describe("addInstallationRepositories", () => {
  it("inserts the given repos", async () => {
    const { upsertInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 1_000_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "addtest",
      accountId: 600,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [
      { fullName: "addtest/r1", repoId: 1 },
      { fullName: "addtest/r2", repoId: 2 },
    ]);
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name).sort()).toEqual(["addtest/r1", "addtest/r2"]);
  });

  it("is a no-op when repos array is empty", async () => {
    const { upsertInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 1_010_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "addnoop",
      accountId: 601,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, []);
    const rows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(0);
  });

  it("is idempotent (INSERT OR IGNORE)", async () => {
    const { upsertInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 1_020_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "addidempotent",
      accountId: 602,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "addidempotent/r1" }]);
    await addInstallationRepositories(db, id, [{ fullName: "addidempotent/r1" }]);
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results).toHaveLength(1);
  });
});

describe("removeInstallationRepositories", () => {
  it("removes the specified repos", async () => {
    const { upsertInstallation, addInstallationRepositories, removeInstallationRepositories } = await import(
      "../server/adapters/github/githubInstallations"
    );
    const id = Math.floor(Math.random() * 1_000_000) + 1_100_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "rmtest",
      accountId: 700,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "rmtest/keep" }, { fullName: "rmtest/remove" }]);
    await removeInstallationRepositories(db, id, ["rmtest/remove"]);
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name)).toEqual(["rmtest/keep"]);
  });

  it("is a no-op when fullNames array is empty", async () => {
    const { upsertInstallation, addInstallationRepositories, removeInstallationRepositories } = await import(
      "../server/adapters/github/githubInstallations"
    );
    const id = Math.floor(Math.random() * 1_000_000) + 1_110_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "rmnoop",
      accountId: 701,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "rmnoop/r1" }]);
    await removeInstallationRepositories(db, id, []);
    const rows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(1);
  });

  it("matches case-insensitively (lowercases input before delete)", async () => {
    const { upsertInstallation, addInstallationRepositories, removeInstallationRepositories } = await import(
      "../server/adapters/github/githubInstallations"
    );
    const id = Math.floor(Math.random() * 1_000_000) + 1_120_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "rmcase",
      accountId: 702,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "rmcase/MyRepo" }]);
    await removeInstallationRepositories(db, id, ["RmCase/MyRepo"]);
    const rows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(0);
  });
});

// ─── 6. handleGithubInstallationEvent ────────────────────────────────────────

describe("handleGithubInstallationEvent", () => {
  it("returns handled:false when installation id is missing", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const result = await handleGithubInstallationEvent(db, { action: "created", installation: undefined });
    expect(result.handled).toBe(false);
  });

  it("inserts a new installation row on 'created' with selection 'all'", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_300_000;
    const result = await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "AllOrg", id: 50, type: "Organization" }, repository_selection: "all" },
    });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("created");
    const row = await db
      .prepare("SELECT account_login, repository_selection FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<any>();
    expect(row!.account_login).toBe("allorg");
    expect(row!.repository_selection).toBe("all");
  });

  it("owner remains NULL when no github account row matches", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_310_000;
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "unknownorg", id: 12345, type: "Organization" }, repository_selection: "all" },
    });
    const row = await db.prepare("SELECT owner_id FROM github_installations WHERE installation_id = ?").bind(id).first<{ owner_id: string | null }>();
    expect(row!.owner_id).toBeNull();
  });

  it("seeds selected-repo rows when selection is 'selected' with repositories in payload", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_320_000;
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "SelOrg", id: 51, type: "Organization" }, repository_selection: "selected" },
      repositories: [
        { full_name: "SelOrg/repo1", id: 1001 },
        { full_name: "SelOrg/repo2", id: 1002 },
      ],
    });
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name).sort()).toEqual(["selorg/repo1", "selorg/repo2"]);
  });

  it("deletes the installation row on 'deleted'", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_340_000;
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "todelete", id: 52, type: "Organization" }, repository_selection: "all" },
    });
    const result = await handleGithubInstallationEvent(db, {
      action: "deleted",
      installation: { id },
    });
    expect(result.handled).toBe(true);
    const row = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("deletes selected-repo rows when installation is deleted", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_350_000;
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "deletewithrepos", id: 53, type: "Organization" }, repository_selection: "selected" },
      repositories: [{ full_name: "deletewithrepos/r1" }],
    });
    await handleGithubInstallationEvent(db, {
      action: "deleted",
      installation: { id },
    });
    const repoRows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(repoRows.results).toHaveLength(0);
  });

  it("sets suspended_at on 'suspend'", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_360_000;
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "susporg", id: 54, type: "Organization" }, repository_selection: "all" },
    });
    const ts = new Date().toISOString();
    await handleGithubInstallationEvent(db, {
      action: "suspend",
      installation: { id, suspended_at: ts },
    });
    const row = await db
      .prepare("SELECT suspended_at FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ suspended_at: string | null }>();
    expect(row!.suspended_at).toBe(ts);
  });

  it("clears suspended_at on 'unsuspend'", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_370_000;
    const ts = new Date().toISOString();
    await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id, account: { login: "unsusporg", id: 55, type: "Organization" }, repository_selection: "all", suspended_at: ts },
    });
    await handleGithubInstallationEvent(db, {
      action: "unsuspend",
      installation: { id },
    });
    const row = await db
      .prepare("SELECT suspended_at FROM github_installations WHERE installation_id = ?")
      .bind(id)
      .first<{ suspended_at: string | null }>();
    expect(row!.suspended_at).toBeNull();
  });

  it("is idempotent: sending 'created' twice results in one row", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_380_000;
    const payload = {
      action: "created" as const,
      installation: { id, account: { login: "idempotentorg", id: 56, type: "Organization" }, repository_selection: "all" },
    };
    await handleGithubInstallationEvent(db, payload);
    await handleGithubInstallationEvent(db, payload);
    const rows = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(1);
  });

  it("returns handled:false and skips upsert when account info is missing", async () => {
    const { handleGithubInstallationEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_390_000;
    const result = await handleGithubInstallationEvent(db, {
      action: "created",
      installation: { id },
    });
    expect(result.handled).toBe(false);
    const row = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(id).first();
    expect(row).toBeNull();
  });
});

// ─── 8. handleGithubInstallationRepositoriesEvent ────────────────────────────

describe("handleGithubInstallationRepositoriesEvent", () => {
  it("returns handled:false when installation id is missing", async () => {
    const { handleGithubInstallationRepositoriesEvent } = await import("../server/adapters/github/githubWebhook");
    const result = await handleGithubInstallationRepositoriesEvent(db, { action: "added", installation: undefined });
    expect(result.handled).toBe(false);
  });

  it("adds repository rows on 'added' action", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const { handleGithubInstallationRepositoriesEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_400_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "addrepoorg",
      accountId: 800,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await handleGithubInstallationRepositoriesEvent(db, {
      action: "added",
      installation: { id, account: { login: "addrepoorg", id: 800, type: "Organization" }, repository_selection: "selected" },
      repository_selection: "selected",
      repositories_added: [{ full_name: "addrepoorg/new-repo", id: 9001 }],
      repositories_removed: [],
    });
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name)).toContain("addrepoorg/new-repo");
  });

  it("removes repository rows on 'removed' action", async () => {
    const { upsertInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const { handleGithubInstallationRepositoriesEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_410_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "rmrepoorg",
      accountId: 801,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "rmrepoorg/old-repo" }, { fullName: "rmrepoorg/keep-repo" }]);
    await handleGithubInstallationRepositoriesEvent(db, {
      action: "removed",
      installation: { id, account: { login: "rmrepoorg", id: 801, type: "Organization" }, repository_selection: "selected" },
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ full_name: "rmrepoorg/old-repo", id: 9002 }],
    });
    const rows = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .all<{ full_name: string }>();
    expect(rows.results.map((r) => r.full_name)).toEqual(["rmrepoorg/keep-repo"]);
  });

  it("clears selected-repo rows when selection flips to 'all'", async () => {
    const { upsertInstallation, addInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const { handleGithubInstallationRepositoriesEvent } = await import("../server/adapters/github/githubWebhook");
    const id = Math.floor(Math.random() * 1_000_000) + 1_420_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "fliptoall",
      accountId: 802,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    await addInstallationRepositories(db, id, [{ fullName: "fliptoall/r1" }]);
    await handleGithubInstallationRepositoriesEvent(db, {
      action: "added",
      installation: { id, account: { login: "fliptoall", id: 802, type: "Organization" }, repository_selection: "all" },
      repository_selection: "all",
      repositories_added: [],
      repositories_removed: [],
    });
    const rows = await db.prepare("SELECT 1 FROM github_installation_repositories WHERE installation_id = ?").bind(id).all();
    expect(rows.results).toHaveLength(0);
  });
});

// ─── 9. repoAppStatus / repoAppStatusBatch ───────────────────────────────────

describe("repoAppStatus / repoAppStatusBatch", () => {
  const OWNER_A = `status-owner-a-${randomUUID()}`;
  const OWNER_B = `status-owner-b-${randomUUID()}`;

  beforeAll(async () => {
    await seedUser(db, OWNER_A, `${OWNER_A}@test.local`);
    await seedUser(db, OWNER_B, `${OWNER_B}@test.local`);
  });

  let installForCounter = 9_000_000;
  async function installFor(
    ownerId: string,
    accountLogin: string,
    accountId: number,
    selection: "all" | "selected",
    repos: string[] = [],
    suspendedAt: string | null = null,
  ) {
    const { upsertInstallation, replaceInstallationRepositories } = await import("../server/adapters/github/githubInstallations");
    const id = installForCounter++;
    await upsertInstallation(db, {
      installationId: id,
      ownerId,
      accountLogin,
      accountId,
      accountType: "Organization",
      repositorySelection: selection,
      suspendedAt,
    });
    if (selection === "selected" && repos.length > 0) {
      await replaceInstallationRepositories(
        db,
        id,
        repos.map((r) => ({ fullName: r })),
      );
    }
    return id;
  }

  it("returns 'covered' for any repo under account when selection is 'all'", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_A, "allcovered-acme", 1001, "all");
    expect(await repoAppStatus(db, OWNER_A, "allcovered-acme/anything")).toBe("covered");
    expect(await repoAppStatus(db, OWNER_A, "allcovered-acme/other")).toBe("covered");
  });

  it("returns 'covered' only for listed repos when selection is 'selected'", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_A, "selcovered-corp", 1002, "selected", ["selcovered-corp/listed-repo"]);
    expect(await repoAppStatus(db, OWNER_A, "selcovered-corp/listed-repo")).toBe("covered");
    expect(await repoAppStatus(db, OWNER_A, "selcovered-corp/unlisted-repo")).toBe("not_covered");
  });

  it("returns 'suspended' when installation suspended_at is set", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_A, "suspendedacct", 1003, "all", [], new Date().toISOString());
    expect(await repoAppStatus(db, OWNER_A, "suspendedacct/any-repo")).toBe("suspended");
  });

  it("returns 'app_not_installed' when no installation exists for the account", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    expect(await repoAppStatus(db, OWNER_A, "nonexistent-account/repo")).toBe("app_not_installed");
  });

  it("is case-insensitive (Acme/Repo vs stored acme/repo)", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_A, "CaseOrg", 1004, "selected", ["CaseOrg/MyRepo"]);
    expect(await repoAppStatus(db, OWNER_A, "CaseOrg/MyRepo")).toBe("covered");
    expect(await repoAppStatus(db, OWNER_A, "caseorg/myrepo")).toBe("covered");
  });

  it("cross-tenant isolation: owner B's install on 'sharedacct' does not cover owner A's query", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_B, "sharedacct", 1005, "all");
    // Owner A has no installation on sharedacct
    expect(await repoAppStatus(db, OWNER_A, "sharedacct/shared-repo")).toBe("app_not_installed");
  });

  it("repoAppStatusBatch returns a map keyed by the original input strings", async () => {
    const { repoAppStatusBatch } = await import("../server/adapters/github/githubInstallations");
    await installFor(OWNER_A, "batchacct", 1006, "selected", ["batchacct/repo-a"]);
    const result = await repoAppStatusBatch(db, OWNER_A, ["batchacct/repo-a", "batchacct/repo-b"]);
    expect(result.get("batchacct/repo-a")).toBe("covered");
    expect(result.get("batchacct/repo-b")).toBe("not_covered");
  });

  it("repoAppStatusBatch returns empty map for empty input", async () => {
    const { repoAppStatusBatch } = await import("../server/adapters/github/githubInstallations");
    const result = await repoAppStatusBatch(db, OWNER_A, []);
    expect(result.size).toBe(0);
  });
});

// ─── 10. getInstallationsForOwner ────────────────────────────────────────────

describe("getInstallationsForOwner", () => {
  it("returns only installations belonging to the given owner", async () => {
    const { upsertInstallation, getInstallationsForOwner } = await import("../server/adapters/github/githubInstallations");
    const owner1 = `owner-list-1-${randomUUID()}`;
    const owner2 = `owner-list-2-${randomUUID()}`;
    const id1 = Math.floor(Math.random() * 1_000_000) + 3_000_000;
    const id2 = Math.floor(Math.random() * 1_000_000) + 3_100_000;
    await upsertInstallation(db, {
      installationId: id1,
      ownerId: owner1,
      accountLogin: "owner1acct",
      accountId: 2001,
      accountType: "User",
      repositorySelection: "all",
    });
    await upsertInstallation(db, {
      installationId: id2,
      ownerId: owner2,
      accountLogin: "owner2acct",
      accountId: 2002,
      accountType: "User",
      repositorySelection: "all",
    });
    const result = await getInstallationsForOwner(db, owner1);
    const ids = result.map((i) => i.installationId);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });

  it("returns empty array when owner has no installations", async () => {
    const { getInstallationsForOwner } = await import("../server/adapters/github/githubInstallations");
    const result = await getInstallationsForOwner(db, "owner-with-no-installs");
    expect(result).toHaveLength(0);
  });

  it("parses fields correctly from the row", async () => {
    const { upsertInstallation, getInstallationsForOwner } = await import("../server/adapters/github/githubInstallations");
    const owner = `owner-parse-${randomUUID()}`;
    const id = Math.floor(Math.random() * 1_000_000) + 3_200_000;
    const ts = new Date().toISOString();
    await upsertInstallation(db, {
      installationId: id,
      ownerId: owner,
      accountLogin: "ParseOrg",
      accountId: 2003,
      accountType: "Organization",
      repositorySelection: "selected",
      suspendedAt: ts,
    });
    const [install] = await getInstallationsForOwner(db, owner);
    expect(install.installationId).toBe(id);
    expect(install.accountLogin).toBe("parseorg");
    expect(install.accountType).toBe("Organization");
    expect(install.repositorySelection).toBe("selected");
    expect(install.suspendedAt).toBe(ts);
  });
});

// ─── 11. Webhook route — installation + installation_repositories events ──────

describe("POST /api/webhooks/github-app — installation events", () => {
  it("handles installation 'created' event via route", async () => {
    const id = Math.floor(Math.random() * 1_000_000) + 4_000_000;
    const payload = JSON.stringify({
      action: "created",
      installation: { id, account: { login: "webhookroute-org", id: 3001, type: "Organization" }, repository_selection: "all" },
    });
    const sig = await signWebhookBody(payload);
    const res = await apiRequest("POST", "/api/webhooks/github-app", payload, {
      "x-hub-signature-256": sig,
      "x-github-event": "installation",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.handled).toBe(true);
    expect(json.action).toBe("created");
    // Verify persistence
    const row = await db.prepare("SELECT account_login FROM github_installations WHERE installation_id = ?").bind(id).first<any>();
    expect(row!.account_login).toBe("webhookroute-org");
  });

  it("handles installation 'deleted' event via route", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 4_100_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "routedelete-org",
      accountId: 3002,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const payload = JSON.stringify({ action: "deleted", installation: { id } });
    const sig = await signWebhookBody(payload);
    const res = await apiRequest("POST", "/api/webhooks/github-app", payload, {
      "x-hub-signature-256": sig,
      "x-github-event": "installation",
    });
    expect(res.status).toBe(200);
    const row = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("handles installation_repositories 'added' event via route", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 4_200_000;
    await upsertInstallation(db, {
      installationId: id,
      accountLogin: "routeaddrepo",
      accountId: 3003,
      accountType: "Organization",
      repositorySelection: "selected",
    });
    const payload = JSON.stringify({
      action: "added",
      installation: { id, account: { login: "routeaddrepo", id: 3003, type: "Organization" }, repository_selection: "selected" },
      repository_selection: "selected",
      repositories_added: [{ full_name: "routeaddrepo/via-webhook", id: 8001 }],
      repositories_removed: [],
    });
    const sig = await signWebhookBody(payload);
    const res = await apiRequest("POST", "/api/webhooks/github-app", payload, {
      "x-hub-signature-256": sig,
      "x-github-event": "installation_repositories",
    });
    expect(res.status).toBe(200);
    const row = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(id)
      .first<{ full_name: string }>();
    expect(row!.full_name).toBe("routeaddrepo/via-webhook");
  });

  it("returns 200 handled:false for unknown event type", async () => {
    const payload = JSON.stringify({ action: "foo" });
    const sig = await signWebhookBody(payload);
    const res = await apiRequest("POST", "/api/webhooks/github-app", payload, {
      "x-hub-signature-256": sig,
      "x-github-event": "release",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.handled).toBe(false);
  });
});

// ─── 12. GET /api/github-app/config (authenticated) ─────────────────────────

describe("GET /api/github-app/config", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await apiRequest("GET", "/api/github-app/config");
    expect(res.status).toBe(401);
  });

  it("returns configured:false + installed:false + accounts:[] when GITHUB_APP_ID is not set and owner has no installations", async () => {
    const { token } = await createVerifiedUserToken();
    const res = await apiRequest(
      "GET",
      "/api/github-app/config",
      undefined,
      {},
      {
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_SLUG: undefined,
      },
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.configured).toBe(false);
    expect(json.slug).toBeNull();
    expect(json.install_url).toBeNull();
    expect(json.installed).toBe(false);
    expect(json.accounts).toEqual([]);
  });

  it("returns configured:true + slug + install_url when env is set and owner has no installations", async () => {
    const { token } = await createVerifiedUserToken();
    const res = await apiRequest(
      "GET",
      "/api/github-app/config",
      undefined,
      {},
      {
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "fake-key",
        GITHUB_APP_SLUG: "agent-kanban",
      },
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.configured).toBe(true);
    expect(json.slug).toBe("agent-kanban");
    expect(json.install_url).toBe("https://github.com/apps/agent-kanban/installations/new");
    expect(json.installed).toBe(false);
    expect(json.accounts).toEqual([]);
  });

  it("returns installed:true + accounts list when owner has a non-suspended installation", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const { token, userId } = await createVerifiedUserToken();
    const installId = Math.floor(Math.random() * 1_000_000) + 8_000_000;
    await upsertInstallation(db, {
      installationId: installId,
      ownerId: userId,
      accountLogin: "config-test-org",
      accountId: 99001,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const res = await apiRequest(
      "GET",
      "/api/github-app/config",
      undefined,
      {},
      {
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "fake-key",
        GITHUB_APP_SLUG: "agent-kanban",
      },
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.installed).toBe(true);
    expect(json.accounts).toContain("config-test-org");
  });

  it("returns installed:false when owner's installation is suspended", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const { token, userId } = await createVerifiedUserToken();
    const installId = Math.floor(Math.random() * 1_000_000) + 8_100_000;
    await upsertInstallation(db, {
      installationId: installId,
      ownerId: userId,
      accountLogin: "suspended-config-org",
      accountId: 99002,
      accountType: "Organization",
      repositorySelection: "all",
      suspendedAt: new Date().toISOString(),
    });
    const res = await apiRequest("GET", "/api/github-app/config", undefined, {}, {}, token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.installed).toBe(false);
    expect(json.accounts).toEqual([]);
  });
});

// ─── 13. app_status on repo read model ───────────────────────────────────────

describe("app_status on /api/repositories read model", () => {
  // These tests exercise repoAppStatus + repoAppStatusBatch called from route handlers.
  // We test the underlying functions directly (same contract as the routes compute)
  // to avoid needing auth headers, while verifying the read-model contract.
  const OWNER = `repo-model-owner-${randomUUID()}`;

  beforeAll(async () => {
    await seedUser(db, OWNER, `${OWNER}@test.local`);
  });

  it("repoAppStatus returns 'covered' after installing app on the account", async () => {
    const { upsertInstallation, repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 5_000_000;
    await upsertInstallation(db, {
      installationId: id,
      ownerId: OWNER,
      accountLogin: "repomodel-org",
      accountId: 4001,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const status = await repoAppStatus(db, OWNER, "repomodel-org/my-repo");
    expect(status).toBe("covered");
  });

  it("repoAppStatus returns 'app_not_installed' for a repo with no installation", async () => {
    const { repoAppStatus } = await import("../server/adapters/github/githubInstallations");
    const status = await repoAppStatus(db, OWNER, "no-install-org/random-repo");
    expect(status).toBe("app_not_installed");
  });

  it("repoAppStatusBatch includes all requested repos in result map", async () => {
    const { upsertInstallation, repoAppStatusBatch } = await import("../server/adapters/github/githubInstallations");
    const id = Math.floor(Math.random() * 1_000_000) + 5_100_000;
    await upsertInstallation(db, {
      installationId: id,
      ownerId: OWNER,
      accountLogin: "batchmodel-org",
      accountId: 4002,
      accountType: "Organization",
      repositorySelection: "all",
    });
    const result = await repoAppStatusBatch(db, OWNER, ["batchmodel-org/r1", "other-org/r2"]);
    expect(result.get("batchmodel-org/r1")).toBe("covered");
    expect(result.get("other-org/r2")).toBe("app_not_installed");
  });
});

// ─── 14. recordInstallationFromSetup (fetch stubbed) ─────────────────────────

describe("recordInstallationFromSetup", () => {
  const OWNER = `setup-owner-${randomUUID()}`;

  beforeAll(async () => {
    await seedUser(db, OWNER, `${OWNER}@test.local`);
  });

  // Stub RSA crypto before each test to prevent OOM. githubAppJwt calls
  // crypto.subtle.importKey + crypto.subtle.sign for every JWT. The mocked
  // fetch in each test never validates JWT contents, so a fake signature is
  // fine. vi.spyOn intercepts calls at the object-property level; the outer
  // afterEach's vi.restoreAllMocks() clears the spy, so we re-apply in each
  // beforeEach.
  beforeEach(() => {
    // Capture originals BEFORE spying to avoid infinite recursion in the passthrough.
    const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    const realSign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (format: any, keyData: any, algorithm: any, extractable: any, keyUsages: any) => {
      const alg = typeof algorithm === "string" ? algorithm : (algorithm as { name: string }).name;
      if (alg === "RSASSA-PKCS1-v1_5") {
        return { type: "private", extractable: false, algorithm: { name: "RSASSA-PKCS1-v1_5" }, usages: ["sign"] } as unknown as CryptoKey;
      }
      return realImportKey(format, keyData, algorithm, extractable, keyUsages);
    });
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (algorithm: any, key: any, data: any) => {
      const alg = typeof algorithm === "string" ? algorithm : (algorithm as { name: string }).name;
      if (alg === "RSASSA-PKCS1-v1_5") {
        return new Uint8Array(256).buffer;
      }
      return realSign(algorithm, key, data);
    });
  });

  it("upserts the installation under the owner when fetch returns 'all' selection", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_000_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`)) {
          return new Response(
            JSON.stringify({
              id: installId,
              account: { login: "setup-all-org", id: 5001, type: "Organization" },
              repository_selection: "all",
              suspended_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    const details = await recordInstallationFromSetup(db, env, OWNER, installId);
    expect(details.id).toBe(installId);
    expect(details.account.login).toBe("setup-all-org");

    const row = await db
      .prepare("SELECT owner_id, account_login, repository_selection FROM github_installations WHERE installation_id = ?")
      .bind(installId)
      .first<any>();
    expect(row!.owner_id).toBe(OWNER);
    expect(row!.account_login).toBe("setup-all-org");
    expect(row!.repository_selection).toBe("all");
  });

  it("accepts a GitHub App private key PEM with escaped newlines", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_050_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`)) {
          return new Response(
            JSON.stringify({
              id: installId,
              account: { login: "setup-escaped-key-org", id: 5003, type: "Organization" },
              repository_selection: "all",
              suspended_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey.replaceAll("\n", "\\n"), GITHUB_APP_SLUG: "agent-kanban" });
    const details = await recordInstallationFromSetup(db, env, OWNER, installId);
    expect(details.account.login).toBe("setup-escaped-key-org");
  });

  it("accepts GitHub's RSA PRIVATE KEY PEM shape", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_060_000;
    const rsaPrivateKey = "-----BEGIN RSA PRIVATE KEY-----\n" + "AQIDBAUGBwgJCgsMDQ4PEA==\n" + "-----END RSA PRIVATE KEY-----";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`)) {
          return new Response(
            JSON.stringify({
              id: installId,
              account: { login: "setup-rsa-key-org", id: 5004, type: "Organization" },
              repository_selection: "all",
              suspended_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: rsaPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    const details = await recordInstallationFromSetup(db, env, OWNER, installId);
    expect(details.account.login).toBe("setup-rsa-key-org");
  });

  it("upserts the installation and stores selected repos when selection is 'selected'", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_100_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`) && !url.includes("access_tokens")) {
          return new Response(
            JSON.stringify({
              id: installId,
              account: { login: "setup-sel-org", id: 5002, type: "Organization" },
              repository_selection: "selected",
              suspended_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_test_token" }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/installation/repositories")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              repositories: [
                {
                  id: 7001,
                  name: "selected-repo",
                  full_name: "setup-sel-org/selected-repo",
                  clone_url: "https://github.com/setup-sel-org/selected-repo.git",
                  html_url: "https://github.com/setup-sel-org/selected-repo",
                  private: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    await recordInstallationFromSetup(db, env, OWNER, installId);

    const repoRow = await db
      .prepare("SELECT full_name FROM github_installation_repositories WHERE installation_id = ?")
      .bind(installId)
      .first<{ full_name: string }>();
    expect(repoRow!.full_name).toBe("setup-sel-org/selected-repo");
  });

  it("throws when GitHub API returns non-ok for getInstallation", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_200_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    await expect(recordInstallationFromSetup(db, env, OWNER, installId)).rejects.toThrow(/404/);
  });

  it("throws when mintInstallationWideToken fails (access_tokens returns non-ok)", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_300_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/app/installations/${installId}`) && !url.includes("access_tokens")) {
          return new Response(
            JSON.stringify({
              id: installId,
              account: { login: "wide-token-fail-org", id: 9000, type: "Organization" },
              repository_selection: "selected",
              suspended_at: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("access_tokens")) {
          return new Response("Forbidden", { status: 403 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    await expect(recordInstallationFromSetup(db, env, OWNER, installId)).rejects.toThrow(/403/);
  });

  it("throws when listInstallationRepositories list call returns non-ok", async () => {
    const { listInstallationRepositories } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_400_000;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_list_fail_token" }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/installation/repositories")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const env = makeEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: sharedPrivateKey, GITHUB_APP_SLUG: "agent-kanban" });
    await expect(listInstallationRepositories(env, installId)).rejects.toThrow(/500/);
  });

  it("throws when GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set", async () => {
    const { recordInstallationFromSetup } = await import("../server/adapters/github/githubApp");
    const installId = Math.floor(Math.random() * 1_000_000) + 6_500_000;
    const env = makeEnv({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined });
    await expect(recordInstallationFromSetup(db, env, OWNER, installId)).rejects.toThrow(/not configured/i);
  });
});

// ─── 15. DELETE /api/repositories — does not touch github_installations ──────

describe("DELETE /api/repositories does not remove installation rows", () => {
  const OWNER = `del-repo-owner-${randomUUID()}`;

  beforeAll(async () => {
    await seedUser(db, OWNER, `${OWNER}@test.local`);
  });

  it("github_installations row survives after deleting a repository", async () => {
    const { upsertInstallation } = await import("../server/adapters/github/githubInstallations");
    const { createRepository, deleteRepository } = await import("../server/adapters/d1/repositoryRepo");

    // Install app
    const installId = Math.floor(Math.random() * 1_000_000) + 7_000_000;
    await upsertInstallation(db, {
      installationId: installId,
      ownerId: OWNER,
      accountLogin: "del-repo-acme",
      accountId: 6001,
      accountType: "Organization",
      repositorySelection: "all",
    });

    // Create and delete repo — fetch must never be called
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch must not be called on repo delete");
      }),
    );

    const repo = await createRepository(db, OWNER, { name: "del-test-repo", url: "https://github.com/del-repo-acme/del-test-repo" });
    await deleteRepository(db, repo.id, OWNER);

    // Installation row must still be there
    const row = await db.prepare("SELECT 1 FROM github_installations WHERE installation_id = ?").bind(installId).first();
    expect(row).not.toBeNull();
  });
});
