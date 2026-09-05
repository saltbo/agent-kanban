import type { Agent, EnborClient } from "@realmroot/enbor-sdk";
import type { PreparedTaskLaunch, TaskLaunchLease } from "./dispatchTaskLaunches";

export interface TaskRepositoryWorkspace {
  url: string;
  ref: string;
  secretRef: string;
  mountPath: string;
}

export async function prepareTaskLaunch(input: {
  lease: TaskLaunchLease;
  projectId: string;
  client: { agents: Pick<EnborClient["agents"], "list"> };
  issuer: string;
  publicOrigin: string;
  prepareWorkspace: (lease: TaskLaunchLease) => Promise<TaskRepositoryWorkspace>;
}): Promise<PreparedTaskLaunch> {
  const matches: Agent[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await input.client.agents.list({ limit: 100, cursor });
    matches.push(
      ...page.data.filter((agent) => agent.spec.identity?.issuer === input.issuer && agent.spec.identity.subject === input.lease.assignee_actor_id),
    );
    const next = page.pagination.nextCursor ?? undefined;
    if (!next) break;
    if (next === cursor || pageIndex === 99) throw new Error("Enbor Agent pagination did not complete");
    cursor = next;
  }
  if (matches.length !== 1) throw new Error(`Expected one Enbor Agent for the assigned Realmroot identity; found ${matches.length}`);
  const agent = matches[0];
  if (agent.metadata.projectId !== input.projectId) throw new Error("Enbor Agent belongs to a different Project");
  const workspace = input.lease.repository_id ? await input.prepareWorkspace(input.lease) : null;
  const taskUrl = new URL(`/api/tasks/${encodeURIComponent(input.lease.task_id)}`, input.publicOrigin).href;
  const contextId = input.lease.owner_id.startsWith("user:") ? input.lease.owner_id.slice(5) : input.lease.owner_id;
  return {
    projectId: input.projectId,
    request: {
      metadata: {
        name: `AK Task ${input.lease.task_id}`,
        labels: { "agent-kanban.dev/managed-by": "agent-kanban", "agent-kanban.dev/launch-id": input.lease.id },
        annotations: { "agent-kanban.dev/task-id": input.lease.task_id, "agent-kanban.dev/task-url": taskUrl },
      },
      spec: {
        agentId: agent.metadata.uid,
        ...(workspace
          ? {
              volumes: [
                { name: "task-repository", type: "git_repository" as const, url: workspace.url, ref: workspace.ref, secretRef: workspace.secretRef },
              ],
              volumeMounts: [{ name: "task-repository", mountPath: workspace.mountPath }],
            }
          : {}),
      },
      prompt: [
        `Execute Agent Kanban Task ${input.lease.task_id} using the agent-kanban skill and your own Realmroot Agent identity.`,
        `AK origin: ${input.publicOrigin}. Launch: ${input.lease.id}.`,
        `AK Context ID: ${contextId}. Use --context ${contextId} for this Task's Realmroot Toolbox operations.`,
        "Read the Task and create its Claim through Realmroot Toolbox before changing files or performing Task work. Do not work if Claim is denied or the Task is cancelled or assigned to someone else.",
        ...(workspace ? [`Use the prepared repository at ${workspace.mountPath}.`] : []),
        "Follow the Task requirements, record the result, and submit it for review through the Task workflow.",
      ].join("\n"),
    },
  };
}
