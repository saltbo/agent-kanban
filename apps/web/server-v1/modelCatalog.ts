import { type AgentRuntime, isCloudAgentRuntime } from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { type AmaCatalogModel, isAmaTaskDispatchConfigured, listAmaCatalogModels, listAmaRunners } from "./amaRuntime";
import type { D1 } from "./db";
import { listMachineEnvironmentCandidatesForRuntime } from "./machineRepo";
import { amaRunnerHeartbeatFresh, amaRuntimeName } from "./runtimeRouter";
import type { Env } from "./types";

export interface RuntimeModel {
  id: string;
  name?: string;
}

// AK's preferred cloud models, most-preferred first; the rest follow in catalog
// order. Anthropic Haiku is first because smoke and default cloud agents require
// executable tool calls; the Workers AI models below currently either emit raw
// tool-call marker text or stop without a canonical tool call in AMA sessions.
const PREFERRED_CLOUD_MODELS = ["anthropic/claude-haiku-4-5", "@cf/openai/gpt-oss-120b", "@cf/moonshotai/kimi-k2.7-code"];

// Models a runtime can run for this owner. The cloud catalog is owned by AMA
// (the authority — fetched, never hardcoded here); self-hosted runtimes get the
// models declared by the owner's live AMA runners.
export async function listRuntimeModels(db: D1, env: Env, ownerId: string, runtime: AgentRuntime): Promise<RuntimeModel[]> {
  if (!isAmaTaskDispatchConfigured(env)) return [];
  if (isCloudAgentRuntime(runtime)) {
    const catalog = (await listAmaCatalogModels(env, ownerId)).filter((model) => model.availability === "available");
    return orderCloudModels(catalog).map((model) => ({ id: model.modelId, ...(model.displayName ? { name: model.displayName } : {}) }));
  }
  // Self-hosted-only runtimes discover their models from live runner reports.
  const amaRuntime = amaRuntimeName(runtime);
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) return [];
  const candidates = await listMachineEnvironmentCandidatesForRuntime(db, ownerId, runtime);
  const environmentIds = [...new Set(candidates.map((candidate) => candidate.environmentId))];
  const modelIds = new Set<string>();
  for (const environmentId of environmentIds) {
    const runners = await listAmaRunners(env, ownerId, projectId, environmentId);
    for (const runner of runners.data) {
      if (runner.status !== "active" || !amaRunnerHeartbeatFresh(runner)) continue;
      for (const entry of runner.runtimes) {
        if (entry.runtime !== amaRuntime || (entry.state !== "ready" && entry.state !== "limited")) continue;
        for (const model of entry.models) {
          modelIds.add(model);
        }
      }
    }
  }
  return [...modelIds].map((id) => ({ id }));
}

// Sorts the preferred cloud models to the front, preserving catalog order for
// the rest (Array.sort is stable).
function orderCloudModels(models: AmaCatalogModel[]): AmaCatalogModel[] {
  const rank = (modelId: string) => {
    const index = PREFERRED_CLOUD_MODELS.indexOf(modelId);
    return index === -1 ? PREFERRED_CLOUD_MODELS.length : index;
  };
  return [...models].sort((a, b) => rank(a.modelId) - rank(b.modelId));
}
