import { type Agent, EnborApiError, type EnborClient, type RuntimeName } from "@realmroot/enbor-sdk";

const AGENT_KANBAN_SKILL = "saltbo/agent-kanban@agent-kanban";
const TASK_INBOX_PROMPT =
  "A task notification from Agent Kanban is ready. Use the exact AK Context ID carried by the Inbox message for every Realmroot Toolbox operation; do not rely on a default Context. Use the Agent Kanban work skill to read the referenced Task, claim it, perform the requested work, record useful progress, and submit the result for review.";

export interface CreateAgencyAgentInput {
  name: string;
  description?: string | null;
  username: string;
  runtime: RuntimeName;
  systemPrompt: string;
  provider?: string | null;
  model?: string | null;
  skills?: string[];
  idempotencyKey: string;
}

export async function createAgencyAgent(client: EnborClient, input: CreateAgencyAgentInput): Promise<Agent> {
  const identity = await client.identities.create(
    {
      metadata: { name: input.name },
      spec: { username: input.username, runtime: input.runtime },
    },
    await derivedKey(input.idempotencyKey, "identity"),
  );
  let agent: Agent;
  try {
    agent = await client.agents.create(
      {
        metadata: { name: input.name, description: input.description },
        spec: {
          systemPrompt: input.systemPrompt,
          provider: input.provider,
          model: input.model,
          skills: withAgentKanbanSkill(input.skills),
          identityRef: identity.metadata.uid,
        },
      },
      await derivedKey(input.idempotencyKey, "agent"),
    );
  } catch (error) {
    if (
      error instanceof EnborApiError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      await client.identities.delete(identity.metadata.uid);
    }
    throw error;
  }
  const createTrigger = client.triggers.create as (
    body: Parameters<EnborClient["triggers"]["create"]>[0],
    idempotencyKey?: string,
  ) => ReturnType<EnborClient["triggers"]["create"]>;
  const trigger = await createTrigger(
    {
      metadata: { name: triggerName(input.name) },
      spec: {
        source: { type: "inbox" },
        template: {
          metadata: {
            labels: { "agent-kanban.dev/managed-by": "agent-kanban" },
            annotations: { "agent-kanban.dev/agent-id": agent.metadata.uid },
          },
          spec: {
            agentId: agent.metadata.uid,
            environmentId: null,
            runtime: input.runtime,
            promptTemplate: TASK_INBOX_PROMPT,
          },
        },
      },
    },
    await derivedKey(input.idempotencyKey, "trigger"),
  );
  if (trigger.status.subscription?.phase !== "active") {
    throw new EnborApiError(502, "Enbor did not activate the Agent Inbox Trigger", trigger);
  }
  return agent;
}

function withAgentKanbanSkill(skills: string[] | undefined): string[] {
  return skills?.includes(AGENT_KANBAN_SKILL) ? skills : [...(skills ?? []), AGENT_KANBAN_SKILL];
}

function triggerName(agentName: string): string {
  const suffix = " task inbox";
  return `${agentName.slice(0, 160 - suffix.length)}${suffix}`;
}

async function derivedKey(parent: string, stage: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parent}:${stage}`));
  return `ak-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
