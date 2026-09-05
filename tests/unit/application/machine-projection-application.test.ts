import { EnborApiError, type EnborClient, type Environment, type Runner } from "@realmroot/enbor-sdk";
import { describe, expect, it, vi } from "vitest";
import { createMachine, listMachinesPage } from "../../../server/usecases/machines/projectMachines";

function environment(uid: string, type: Environment["spec"]["type"]): Environment {
  return { metadata: { uid }, spec: { type } } as Environment;
}

function runner(id: string, environmentId: string): Runner {
  return { id, environmentId } as Runner;
}

describe("Machine SDK orchestration", () => {
  it("[spec: machines/runner-aggregation] groups every paginated SDK Runner under its self-hosted Environment", async () => {
    const selfHosted = environment("environment-self-hosted", "self_hosted");
    const managed = environment("environment-cloud", "cloud");
    const selfHostedRunnerA = runner("runner-a", selfHosted.metadata.uid);
    const selfHostedRunnerB = runner("runner-b", selfHosted.metadata.uid);
    const managedRunner = runner("runner-managed", managed.metadata.uid);
    const environmentsList = vi.fn().mockResolvedValue({
      data: [selfHosted, managed],
      pagination: { nextCursor: "environment-next" },
    });
    const runnersList = vi
      .fn()
      .mockResolvedValueOnce({
        data: [selfHostedRunnerA],
        pagination: { nextCursor: "runner-next" },
      })
      .mockResolvedValueOnce({ data: [selfHostedRunnerB], pagination: { nextCursor: null } });
    const client = {
      environments: { list: environmentsList },
      runners: { list: runnersList },
    } as unknown as EnborClient;

    await expect(listMachinesPage(client, { limit: 20, cursor: "environment-cursor" })).resolves.toEqual({
      items: [{ environment: selfHosted, runners: [selfHostedRunnerA, selfHostedRunnerB] }],
      nextCursor: "environment-next",
    });
    expect(environmentsList).toHaveBeenCalledWith({ limit: 20, cursor: "environment-cursor" });
    expect(runnersList.mock.calls).toEqual([
      [{ limit: 100, cursor: undefined, environmentId: selfHosted.metadata.uid }],
      [{ limit: 100, cursor: "runner-next", environmentId: selfHosted.metadata.uid }],
    ]);
    expect(managedRunner.environmentId).toBe(managed.metadata.uid);
  });

  it("[spec: machines/create-runner-setup] creates a self-hosted SDK Environment and returns Runner setup", async () => {
    const created = environment("environment-created", "self_hosted");
    const environmentsCreate = vi.fn().mockResolvedValue(created);
    const client = { environments: { create: environmentsCreate } } as unknown as EnborClient;

    await expect(
      createMachine(
        client,
        "project-1",
        "machine-create-key",
        (projectId, environmentId) => `enbor-runner start --project-id ${projectId} --environment-id ${environmentId}`,
      ),
    ).resolves.toEqual({
      machine: { environment: created, runners: [] },
      setup: {
        command: "enbor-runner start --project-id project-1 --environment-id environment-created",
        project_id: "project-1",
        environment_id: "environment-created",
      },
    });
    expect(environmentsCreate).toHaveBeenCalledWith(
      {
        metadata: { name: expect.stringMatching(/^computer-[a-f0-9]{8}$/) },
        spec: { scope: "project", type: "self_hosted" },
      },
      expect.stringMatching(/^ak-[a-f0-9]{64}$/),
    );
  });

  it("rejects a repeated SDK Runner pagination cursor", async () => {
    const selfHosted = environment("environment-self-hosted", "self_hosted");
    const client = {
      environments: {
        list: vi.fn().mockResolvedValue({ data: [selfHosted], pagination: { nextCursor: null } }),
      },
      runners: {
        list: vi
          .fn()
          .mockResolvedValueOnce({ data: [], pagination: { nextCursor: "repeated" } })
          .mockResolvedValueOnce({ data: [], pagination: { nextCursor: "repeated" } }),
      },
    } as unknown as EnborClient;

    const error = await listMachinesPage(client, { limit: 20, cursor: null }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnborApiError);
    expect(error).toMatchObject({ status: 502, responseText: "Enbor Runner pagination did not advance" });
  });
});
