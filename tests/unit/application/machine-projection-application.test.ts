import { describe, expect, it, vi } from "vitest";
import {
  archiveProjectedMachine,
  createProjectedMachine,
  listProjectedMachinesPage,
  type MachineProjectionPort,
} from "../../../server/usecases/machines/projectMachines";
import type { ProjectedMachine } from "../../../shared";

const machine: ProjectedMachine = {
  id: "environment-1",
  name: "Build host",
  description: null,
  state: "online",
  current_load: 3,
  max_concurrent: 6,
  runner_count: 1,
  runners: [
    {
      id: "runner-1",
      name: "Runner one",
      state: "active",
      current_load: 3,
      max_concurrent: 6,
      runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
      runtime_usage: [
        {
          runtime: "codex",
          windows: [{ label: "5 hours", utilization: 25, resets_at: "2026-09-01T17:00:00.000Z" }],
        },
      ],
      last_heartbeat_at: "2026-09-01T12:00:01.000Z",
    },
  ],
  runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
  last_heartbeat_at: "2026-09-01T12:00:01.000Z",
  created_at: "2026-09-01T11:00:00.000Z",
  updated_at: "2026-09-01T12:00:01.000Z",
};

function port(overrides: Partial<MachineProjectionPort> = {}): MachineProjectionPort {
  return {
    listMachinesPage: vi.fn().mockResolvedValue({ items: [machine], nextCursor: null }),
    getMachine: vi.fn().mockResolvedValue(machine),
    createMachine: vi.fn().mockResolvedValue(machine),
    archiveMachine: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("Machine projection application", () => {
  it("[spec: machines/create-runner-setup] creates an Environment and returns generated Runner setup", async () => {
    const projection = port();
    const result = await createProjectedMachine(
      projection,
      "project-1",
      "machine-create-key",
      (projectId, environmentId) => `ama-runner start --project-id ${projectId} --environment-id ${environmentId}`,
    );

    expect(projection.createMachine).toHaveBeenCalledWith(
      "project-1",
      expect.stringMatching(/^computer-[a-f0-9]{8}$/),
      expect.stringMatching(/^ak-[a-f0-9]{64}$/),
    );
    expect(result).toEqual({
      machine,
      setup: {
        command: "ama-runner start --project-id project-1 --environment-id environment-1",
        project_id: "project-1",
        environment_id: "environment-1",
      },
    });
  });

  it("[spec: machines/runner-aggregation] returns the adapter's aggregated Machine projection unchanged", async () => {
    await expect(listProjectedMachinesPage(port(), "project-1", { limit: 20, cursor: null })).resolves.toEqual({
      items: [machine],
      nextCursor: null,
    });
  });

  it("[spec: machines/archive-environment] archives the authoritative Environment", async () => {
    const projection = port();
    await expect(archiveProjectedMachine(projection, "project-1", "environment-1")).resolves.toBe(true);
    expect(projection.archiveMachine).toHaveBeenCalledWith("project-1", "environment-1");
  });
});
