// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, setupMiniflare } from "./helpers/db";

describe("agent versioning", () => {
  let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
  let db: D1Database;

  beforeAll(async () => {
    const setup = await setupMiniflare();
    mf = setup.mf;
    db = setup.db;
    return async () => {
      await mf.dispose();
    };
  });

  it("updates latest and snapshots the previous latest for repeated usernames", async () => {
    const first = await createTestAgent(db, "owner-version", {
      username: "morgan-lee",
      name: "Morgan Lee",
      runtime: "codex",
      soul: "first soul",
    });
    const second = await createTestAgent(db, "owner-version", {
      username: "morgan-lee",
      name: "Morgan Lee",
      runtime: "codex",
      soul: "second soul",
    });

    expect(first.version).toBe("latest");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe("latest");

    const snapshots = await db.prepare("SELECT version, soul FROM agents WHERE username = ? AND version != 'latest'").bind("morgan-lee").all<any>();
    expect(snapshots.results).toHaveLength(1);
    expect(snapshots.results[0].version).toMatch(/^[a-f0-9]{10}$/);
    expect(snapshots.results[0].soul).toBe("first soul");
  });

  it("keeps the same latest row on later create", async () => {
    const first = await createTestAgent(db, "owner-republish", {
      username: "alex-kim",
      name: "Alex Kim",
      runtime: "codex",
      soul: "first",
    });
    const second = await createTestAgent(db, "owner-republish", {
      username: "alex-kim",
      name: "Alex Kim",
      runtime: "codex",
      soul: "second",
    });

    expect(second.id).toBe(first.id);
    expect(second.version).toBe("latest");
    expect(second.soul).toBe("second");
  });

  it("preserves latest identity when updating an existing agent", async () => {
    const first = await createTestAgent(db, "owner-identity", {
      username: "identity-agent",
      name: "Identity Agent",
      runtime: "codex",
      soul: "first",
    });
    const firstKey = await db.prepare("SELECT public_key, private_key, fingerprint FROM agents WHERE id = ?").bind(first.id).first<any>();

    const second = await createTestAgent(db, "owner-identity", {
      username: "identity-agent",
      name: "Identity Agent",
      runtime: "codex",
      soul: "second",
    });
    const secondKey = await db.prepare("SELECT public_key, private_key, fingerprint FROM agents WHERE id = ?").bind(second.id).first<any>();

    expect(second.id).toBe(first.id);
    expect(secondKey).toEqual(firstKey);
  });

  it("does not snapshot when applying the same profile again", async () => {
    await createTestAgent(db, "owner-idempotent", {
      username: "idempotent-agent",
      name: "Idempotent Agent",
      runtime: "codex",
      soul: "same",
    });
    await createTestAgent(db, "owner-idempotent", {
      username: "idempotent-agent",
      name: "Idempotent Agent",
      runtime: "codex",
      soul: "same",
    });

    const snapshots = await db.prepare("SELECT id FROM agents WHERE username = ? AND version != 'latest'").bind("idempotent-agent").all<any>();

    expect(snapshots.results).toHaveLength(0);
  });

  it("snapshots latest before direct latest updates", async () => {
    const { updateAgent } = await import("../apps/web/server/agentRepo");
    const agent = await createTestAgent(db, "owner-update-snapshot", {
      username: "update-snapshot-agent",
      name: "Update Snapshot Agent",
      runtime: "codex",
      soul: "before",
    });

    await updateAgent(db, agent.id, { soul: "after" });

    const latest = await db.prepare("SELECT soul, version FROM agents WHERE id = ?").bind(agent.id).first<any>();
    const snapshots = await db
      .prepare("SELECT soul, version FROM agents WHERE username = ? AND version != 'latest'")
      .bind("update-snapshot-agent")
      .all<any>();

    expect(latest).toMatchObject({ soul: "after", version: "latest" });
    expect(snapshots.results).toHaveLength(1);
    expect(snapshots.results[0].soul).toBe("before");
  });

  it("reuses an existing hash snapshot when latest returns to an old profile", async () => {
    await createTestAgent(db, "owner-reuse", {
      username: "sam-park",
      name: "Sam Park",
      runtime: "codex",
      soul: "first",
    });
    await createTestAgent(db, "owner-reuse", {
      username: "sam-park",
      name: "Sam Park",
      runtime: "codex",
      soul: "second",
    });
    await createTestAgent(db, "owner-reuse", {
      username: "sam-park",
      name: "Sam Park",
      runtime: "codex",
      soul: "first",
    });
    await createTestAgent(db, "owner-reuse", {
      username: "sam-park",
      name: "Sam Park",
      runtime: "codex",
      soul: "third",
    });

    const snapshots = await db.prepare("SELECT version, soul FROM agents WHERE username = ? AND version != 'latest'").bind("sam-park").all<any>();

    expect(snapshots.results).toHaveLength(2);
    expect(snapshots.results.map((row) => row.soul).sort()).toEqual(["first", "second"]);
    expect(new Set(snapshots.results.map((row) => row.version)).size).toBe(2);
  });

  it("does not update or delete snapshots directly", async () => {
    const { deleteAgent, updateAgent } = await import("../apps/web/server/agentRepo");
    await createTestAgent(db, "owner-snapshot-immutable", {
      username: "immutable-agent",
      name: "Immutable Agent",
      runtime: "codex",
      soul: "first",
    });
    await createTestAgent(db, "owner-snapshot-immutable", {
      username: "immutable-agent",
      name: "Immutable Agent",
      runtime: "codex",
      soul: "second",
    });
    const snapshot = await db.prepare("SELECT id FROM agents WHERE username = ? AND version != 'latest'").bind("immutable-agent").first<any>();

    await expect(updateAgent(db, snapshot.id, { soul: "mutated" })).resolves.toBeNull();
    await expect(deleteAgent(db, snapshot.id)).resolves.toBe(false);

    const persisted = await db.prepare("SELECT soul FROM agents WHERE id = ?").bind(snapshot.id).first<any>();
    expect(persisted.soul).toBe("first");
  });
});
