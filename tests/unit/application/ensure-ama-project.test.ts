// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { type AmaProjectBindingPort, type AmaProjectCatalogPort, ensureAmaProject } from "../../../server/usecases/ama/ensureAmaProject";

const tenantId = "tenant-transparent-project";
const projectName = "Agent Kanban";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ports() {
  const bindings: AmaProjectBindingPort = {
    findProjectId: vi.fn().mockResolvedValue(null),
    claim: vi.fn().mockResolvedValue(true),
    renew: vi.fn().mockResolvedValue(true),
    findClaimExpiry: vi.fn().mockResolvedValue(new Date(Date.now() + 25_000).toISOString()),
    store: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const projects: AmaProjectCatalogPort = {
    listProjects: vi.fn().mockImplementation(async (renewClaim) => {
      await renewClaim();
      return [];
    }),
    createProject: vi.fn().mockResolvedValue({ id: "project-created", name: projectName }),
  };
  return { bindings, projects };
}

describe("transparent AMA project initialization", () => {
  it("[spec: agents/transparent-ama-project] returns an existing binding without calling AMA", async () => {
    const { bindings, projects } = ports();
    vi.mocked(bindings.findProjectId).mockResolvedValue("project-existing");

    await expect(ensureAmaProject(bindings, projects, tenantId)).resolves.toBe("project-existing");
    expect(bindings.claim).not.toHaveBeenCalled();
    expect(projects.listProjects).not.toHaveBeenCalled();
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it("[spec: agents/transparent-ama-project] reuses the exact fixed-name AMA project", async () => {
    const { bindings, projects } = ports();
    vi.mocked(projects.listProjects).mockResolvedValue([
      { id: "project-other", name: `${projectName} other` },
      { id: "project-deterministic", name: projectName },
    ]);

    await expect(ensureAmaProject(bindings, projects, tenantId)).resolves.toBe("project-deterministic");
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(bindings.store).toHaveBeenCalledWith(tenantId, "project-deterministic", expect.any(String));
  });

  it("[spec: agents/transparent-ama-project] creates and stores the fixed-name project without the tenant id", async () => {
    const { bindings, projects } = ports();

    await expect(ensureAmaProject(bindings, projects, tenantId)).resolves.toBe("project-created");
    expect(projects.createProject).toHaveBeenCalledWith(projectName);
    expect(projectName).not.toContain(tenantId);
    expect(bindings.store).toHaveBeenCalledWith(tenantId, "project-created", expect.any(String));
  });

  it("[spec: agents/transparent-ama-project] renews at page boundaries and immediately before create", async () => {
    const { bindings, projects } = ports();
    const events: string[] = [];
    vi.mocked(bindings.renew).mockImplementation(async () => {
      events.push("renew");
      return true;
    });
    vi.mocked(projects.listProjects).mockImplementation(async (renewClaim) => {
      await renewClaim();
      events.push("page-1");
      await renewClaim();
      events.push("page-2");
      return [];
    });
    vi.mocked(projects.createProject).mockImplementation(async (name) => {
      events.push("create");
      return { id: "project-created", name };
    });

    await expect(ensureAmaProject(bindings, projects, tenantId)).resolves.toBe("project-created");
    expect(events).toEqual(["renew", "page-1", "renew", "page-2", "renew", "create"]);
  });

  it("[spec: agents/transparent-ama-project] follows the winner when renewal is lost before create", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T12:00:00.000Z");
    const { bindings, projects } = ports();
    vi.mocked(bindings.findProjectId).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue("project-winner");
    vi.mocked(bindings.renew).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = ensureAmaProject(bindings, projects, tenantId);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe("project-winner");
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(bindings.release).toHaveBeenCalledWith(tenantId, expect.any(String));
  });

  it.each(["claim", "store"] as const)("[spec: agents/transparent-ama-project] waits for the winner after losing the %s race", async (race) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T12:00:00.000Z");
    const { bindings, projects } = ports();
    vi.mocked(bindings.findProjectId).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue("project-winner");
    if (race === "claim") vi.mocked(bindings.claim).mockResolvedValue(false);
    else vi.mocked(bindings.store).mockResolvedValue(false);

    const result = ensureAmaProject(bindings, projects, tenantId);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe("project-winner");
    if (race === "claim") expect(projects.listProjects).not.toHaveBeenCalled();
  });

  it("[spec: agents/transparent-ama-project] releases its claim when AMA initialization fails", async () => {
    const { bindings, projects } = ports();
    const failure = new Error("AMA projects unavailable");
    vi.mocked(projects.listProjects).mockRejectedValue(failure);

    await expect(ensureAmaProject(bindings, projects, tenantId)).rejects.toBe(failure);
    expect(bindings.release).toHaveBeenCalledWith(tenantId, expect.any(String));
    expect(bindings.store).not.toHaveBeenCalled();
  });

  it("[spec: agents/transparent-ama-project] releases a claim when a binding appears after claim", async () => {
    const { bindings, projects } = ports();
    vi.mocked(bindings.findProjectId).mockResolvedValueOnce(null).mockResolvedValueOnce("project-winner");

    await expect(ensureAmaProject(bindings, projects, tenantId)).resolves.toBe("project-winner");
    expect(bindings.release).toHaveBeenCalledWith(tenantId, expect.any(String));
    expect(projects.listProjects).not.toHaveBeenCalled();
  });
});
