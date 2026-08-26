// @vitest-environment node
// Verify --kind, --handoff-to, --skills flags for create and update agent (v1.8.1)

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, setupMiniflare } from "./helpers/db";

let db: D1Database;
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("create agent: --kind flag", () => {
  it("creates an agent with kind=leader", async () => {
    const agent = await createTestAgent(db, "owner-kind", {
      username: "test-leader",
      name: "Test Leader",
      runtime: "claude",
      role: "lead",
      kind: "leader",
    });

    expect(agent.kind).toBe("leader");
  });

  it("creates an agent with kind=worker (default)", async () => {
    const agent = await createTestAgent(db, "owner-kind", {
      username: "test-worker",
      name: "Test Worker",
      runtime: "claude",
    });

    expect(agent.kind).toBe("worker");
  });

  it("kind=leader persists through getAgent", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const created = await createTestAgent(db, "owner-kind2", {
      username: "test-leader-persist",
      name: "Test Leader Persist",
      runtime: "claude",
      kind: "leader",
    });

    const fetched = await getAgent(db, created.id, "owner-kind2");
    expect(fetched).toBeTruthy();
    expect(fetched!.kind).toBe("leader");
  });

  it("kind=leader appears in listAgents", async () => {
    const { listAgents } = await import("../apps/web/server/agentRepo");
    const created = await createTestAgent(db, "owner-kind3", {
      username: "test-leader-list",
      name: "Test Leader List",
      runtime: "claude",
      kind: "leader",
    });

    const agents = await listAgents(db, "owner-kind3");
    const found = agents.find((a) => a.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.kind).toBe("leader");
  });
});

describe("create agent: --handoff-to flag", () => {
  it("creates an agent with handoff_to populated", async () => {
    const agent = await createTestAgent(db, "owner-handoff", {
      username: "test-handoff",
      name: "Test Handoff",
      runtime: "claude",
      role: "dev",
      handoff_to: ["qa"],
    });

    expect(Array.isArray(agent.handoff_to)).toBe(true);
    expect(agent.handoff_to).toEqual(["qa"]);
  });

  it("handoff_to with multiple roles is stored as array", async () => {
    const agent = await createTestAgent(db, "owner-handoff", {
      username: "test-handoff-multi",
      name: "Test Handoff Multi",
      runtime: "claude",
      handoff_to: ["qa", "devops"],
    });

    expect(agent.handoff_to).toHaveLength(2);
    expect(agent.handoff_to).toEqual(["qa", "devops"]);
  });
});

describe("create agent: --skills flag", () => {
  it("creates an agent with skills array populated", async () => {
    const agent = await createTestAgent(db, "owner-skills", {
      username: "test-skills",
      name: "Test Skills",
      runtime: "claude",
      role: "dev",
      skills: ["saltbo/agent-kanban@agent-kanban"],
    });

    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toEqual(["saltbo/agent-kanban@agent-kanban"]);
  });

  it("multiple skills are stored as array", async () => {
    const agent = await createTestAgent(db, "owner-skills", {
      username: "test-skills-multi",
      name: "Test Skills Multi",
      runtime: "claude",
      skills: ["saltbo/agent-kanban@agent-kanban", "trailofbits/skills@differential-review"],
    });

    expect(agent.skills).toHaveLength(2);
    expect(agent.skills).toContain("saltbo/agent-kanban@agent-kanban");
    expect(agent.skills).toContain("trailofbits/skills@differential-review");
  });
});

describe("update agent: --handoff-to, --skills flags", () => {
  let agentId: string;

  beforeAll(async () => {
    const agent = await createTestAgent(db, "owner-update", {
      username: "test-update-target",
      name: "Test Update Target",
      runtime: "claude",
    });
    agentId = agent.id;
  });

  it("updates handoff_to via updateAgent", async () => {
    const { updateAgent } = await import("../apps/web/server/agentRepo");
    const updated = await updateAgent(db, agentId, { handoff_to: ["qa"] });

    expect(updated).toBeTruthy();
    expect(updated!.handoff_to).toEqual(["qa"]);
  });

  it("updates skills via updateAgent", async () => {
    const { updateAgent } = await import("../apps/web/server/agentRepo");
    const updated = await updateAgent(db, agentId, { skills: ["saltbo/agent-kanban@agent-kanban"] });

    expect(updated).toBeTruthy();
    expect(updated!.skills).toEqual(["saltbo/agent-kanban@agent-kanban"]);
  });

  it("handoff_to and skills persist together", async () => {
    const { updateAgent, getAgent } = await import("../apps/web/server/agentRepo");
    await updateAgent(db, agentId, {
      handoff_to: ["release-manager"],
      skills: ["saltbo/agent-kanban@agent-kanban", "trailofbits/skills@differential-review"],
    });

    const fetched = await getAgent(db, agentId, "owner-update");
    expect(fetched!.handoff_to).toEqual(["release-manager"]);
    expect(fetched!.skills).toEqual(["saltbo/agent-kanban@agent-kanban", "trailofbits/skills@differential-review"]);
  });
});
