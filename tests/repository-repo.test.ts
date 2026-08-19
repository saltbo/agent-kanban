// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "repo-test-user", "repo@test.com");
  await seedUser(env.DB, "repo-test-user-2", "repo2@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

describe("normalizeGitUrl", () => {
  it("normalizes SSH URL to HTTPS", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("strips .git from HTTPS URL", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("keeps clean HTTPS URL as-is", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("strips trailing slash from HTTPS URL", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("https://github.com/org/repo/")).toBe("https://github.com/org/repo");
  });

  it("accepts SSH git@ URL without .git suffix", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("git@gitlab.com:myorg/myrepo")).toBe("https://gitlab.com/myorg/myrepo");
  });

  it("accepts http:// URL with owner/repo path", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("http://github.example.com/owner/repo")).toBe("http://github.example.com/owner/repo");
  });

  it("rejects file:// URL with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("file:///Users/alice/proj");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("accepts an absolute local path as-is", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("/home/user/project")).toBe("/home/user/project");
  });

  it("strips trailing slashes from a local path", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("/home/user/project/")).toBe("/home/user/project");
    expect(normalizeGitUrl("/home/user/project///")).toBe("/home/user/project");
  });

  it("trims surrounding whitespace from a local path", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("  /home/user/project  ")).toBe("/home/user/project");
  });

  it("rejects a local path containing .. segments with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("/home/user/../secret");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("rejects a local path containing a NUL byte with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("/home/user/\0proj");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("rejects ~-prefixed paths with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    for (const url of ["~/proj", "~user/proj"]) {
      let thrown: unknown;
      try {
        normalizeGitUrl(url);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as any).status).toBe(400);
    }
  });

  it("rejects relative paths with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("relative/path");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("rejects plain string with no scheme with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("my-repo");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("rejects https:// URL with no owner/repo path with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("https://github.com");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("rejects single-segment HTTPS path with HTTPException 400", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      normalizeGitUrl("https://github.com/single-segment");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("strips .git and then trailing slash from https://github.com/org/repo/.git", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    // .git$ matches the end of "https://github.com/org/repo/.git", leaving "https://github.com/org/repo/"
    // trailing-slash strip then removes the slash → "https://github.com/org/repo"
    expect(normalizeGitUrl("https://github.com/org/repo/.git")).toBe("https://github.com/org/repo");
  });

  it("accepts nested group paths (gitlab.com/group/subgroup/project)", async () => {
    const { normalizeGitUrl } = await import("../apps/web/server/repositoryRepo");
    expect(normalizeGitUrl("https://gitlab.com/group/subgroup/project")).toBe("https://gitlab.com/group/subgroup/project");
  });
});

describe("isLocalRepoPath / repoSourceType", () => {
  it("isLocalRepoPath is true only for absolute paths", async () => {
    const { isLocalRepoPath } = await import("../apps/web/server/repositoryRepo");
    expect(isLocalRepoPath("/home/user/project")).toBe(true);
    expect(isLocalRepoPath("https://github.com/org/repo")).toBe(false);
    expect(isLocalRepoPath("git@github.com:org/repo")).toBe(false);
    expect(isLocalRepoPath("relative/path")).toBe(false);
  });

  it("repoSourceType maps absolute paths to local and URLs to remote", async () => {
    const { repoSourceType } = await import("../apps/web/server/repositoryRepo");
    expect(repoSourceType("/home/user/project")).toBe("local");
    expect(repoSourceType("https://github.com/org/repo")).toBe("remote");
  });
});

describe("repositoryRepo", () => {
  it("createRepository creates a repo", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "my-repo", url: "https://github.com/org/my-repo" });
    expect(repo.name).toBe("my-repo");
    expect(repo.url).toBe("https://github.com/org/my-repo");
  });

  it("listRepositories returns repos for owner", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user");
    expect(repos.length).toBeGreaterThanOrEqual(1);
  });

  it("listRepositories filters by URL", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user", { url: "https://github.com/org/my-repo" });
    expect(repos.length).toBe(1);
    expect(repos[0].url).toBe("https://github.com/org/my-repo");
  });

  it("listRepositories URL filter normalizes input", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user", { url: "git@github.com:org/my-repo.git" });
    expect(repos.length).toBe(1);
  });

  it("listRepositories returns empty for unknown URL", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user", { url: "https://github.com/org/nonexistent" });
    expect(repos.length).toBe(0);
  });

  it("deleteRepository removes a repo", async () => {
    const { createRepository, deleteRepository, listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "del-repo", url: "https://github.com/org/del-repo" });
    const deleted = await deleteRepository(env.DB, repo.id);
    expect(deleted).toBe(true);
    const repos = await listRepositories(env.DB, "repo-test-user", { url: "https://github.com/org/del-repo" });
    expect(repos.length).toBe(0);
  });

  it("deleteRepository returns false for unknown repo", async () => {
    const { deleteRepository } = await import("../apps/web/server/repositoryRepo");
    const deleted = await deleteRepository(env.DB, "nonexistent");
    expect(deleted).toBe(false);
  });

  it("findOrCreateRepository creates if not found", async () => {
    const { findOrCreateRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await findOrCreateRepository(env.DB, "repo-test-user", { name: "find-create", url: "https://github.com/org/find-create" });
    expect(repo.name).toBe("find-create");
  });

  it("findOrCreateRepository returns existing if found", async () => {
    const { findOrCreateRepository } = await import("../apps/web/server/repositoryRepo");
    const first = await findOrCreateRepository(env.DB, "repo-test-user", { name: "find-create-dup", url: "https://github.com/org/find-create-dup" });
    const second = await findOrCreateRepository(env.DB, "repo-test-user", {
      name: "find-create-dup-2",
      url: "https://github.com/org/find-create-dup",
    });
    expect(second.id).toBe(first.id);
    expect(second.full_name).toBe("org/find-create-dup");
  });

  it("repos are scoped to owner", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user-2");
    expect(repos.length).toBe(0);
  });

  it("createRepository rejects a file:// URL with 400", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      await createRepository(env.DB, "repo-test-user", { name: "bad-repo", url: "file:///Users/xudawei/skill-lake" });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("findOrCreateRepository rejects a file:// URL with 400", async () => {
    const { findOrCreateRepository } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      await findOrCreateRepository(env.DB, "repo-test-user", { name: "bad-repo", url: "file:///Users/xudawei/skill-lake" });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("listRepositories rejects a file:// url filter with 400", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      await listRepositories(env.DB, "repo-test-user", { url: "file:///Users/xudawei/skill-lake" });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(400);
  });

  it("getRepository returns null for unknown id", async () => {
    const { getRepository } = await import("../apps/web/server/repositoryRepo");
    const result = await getRepository(env.DB, "nonexistent-id", "repo-test-user");
    expect(result).toBeNull();
  });

  it("getRepository returns the repo for a known id", async () => {
    const { createRepository, getRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "get-repo", url: "https://github.com/org/get-repo" });
    const result = await getRepository(env.DB, repo.id, "repo-test-user");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(repo.id);
    expect(result!.full_name).toBe("org/get-repo");
  });

  it("getRepository returns null when owner does not match", async () => {
    const { createRepository, getRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "scoped-repo", url: "https://github.com/org/scoped-repo" });
    const result = await getRepository(env.DB, repo.id, "repo-test-user-2");
    expect(result).toBeNull();
  });

  it("createRepository registers a local path repo with source_type local", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "local-repo", url: "/home/user/local-repo" });
    expect(repo.url).toBe("/home/user/local-repo");
    expect(repo.source_type).toBe("local");
    // Local repos have no owner/repo form — the path itself is the identity.
    expect(repo.full_name).toBe("/home/user/local-repo");
  });

  it("createRepository normalizes a local path before persisting", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "local-repo-messy", url: "  /home/user/messy/  " });
    expect(repo.url).toBe("/home/user/messy");
  });

  it("createRepository marks https repos as source_type remote", async () => {
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "remote-repo", url: "https://github.com/org/remote-repo" });
    expect(repo.source_type).toBe("remote");
    expect(repo.full_name).toBe("org/remote-repo");
  });

  it("getRepository returns the path as full_name for a local repo", async () => {
    const { createRepository, getRepository } = await import("../apps/web/server/repositoryRepo");
    const repo = await createRepository(env.DB, "repo-test-user", { name: "local-get", url: "/home/user/local-get" });
    const result = await getRepository(env.DB, repo.id, "repo-test-user");
    expect(result).not.toBeNull();
    expect(result!.full_name).toBe("/home/user/local-get");
    expect(result!.source_type).toBe("local");
  });

  it("listRepositories URL filter matches local paths after normalization", async () => {
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    const repos = await listRepositories(env.DB, "repo-test-user", { url: "/home/user/local-get/" });
    expect(repos.length).toBe(1);
    expect(repos[0].url).toBe("/home/user/local-get");
  });

  it("findOrCreateRepository dedupes local paths after normalization", async () => {
    const { findOrCreateRepository } = await import("../apps/web/server/repositoryRepo");
    const first = await findOrCreateRepository(env.DB, "repo-test-user", { name: "local-dup", url: "/home/user/local-dup" });
    const second = await findOrCreateRepository(env.DB, "repo-test-user", { name: "local-dup-2", url: "/home/user/local-dup/" });
    expect(second.id).toBe(first.id);
    expect(second.full_name).toBe("/home/user/local-dup");
  });

  it("listRepositories throws 500 when a stored URL bypassed normalizeGitUrl", async () => {
    // Directly insert a row with a file:// URL to simulate a corrupt DB row (invariant broken)
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO repositories (id, owner_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("corrupt-id-1", "repo-test-user", "corrupt-repo", "file:///bad/path", now)
      .run();
    const { listRepositories } = await import("../apps/web/server/repositoryRepo");
    let thrown: unknown;
    try {
      await listRepositories(env.DB, "repo-test-user");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).toBe(500);
    // Clean up the corrupt row so it doesn't affect other tests
    await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind("corrupt-id-1").run();
  });
});
