import {
  createAmaClient as createSdkClient,
  type EnvFromEntry,
  type RuntimeName,
  type Agent as SdkAgent,
  type MemoryStore as SdkMemoryStore,
  type MemoryStoreMemory as SdkMemoryStoreMemory,
  type RunnerRuntime as SdkRunnerRuntime,
  type Session as SdkSession,
  type Trigger as SdkTrigger,
  type TriggerRun as SdkTriggerRun,
  type UpdateTriggerRequest,
  type Volume,
  type VolumeMount,
} from "@any-managed-agents/sdk";
import { AmaUserGrantRequired, amaBearerToken } from "./realmrootAuth";
import type { Env } from "./types";

export class AmaUserAuthError extends Error {
  readonly status = 401;
  readonly code = "AMA_USER_AUTH_REQUIRED";

  constructor(message = "Sign in again to authorize Agent Kanban to use AMA.") {
    super(message);
    this.name = "AmaUserAuthError";
  }
}

export type AmaResourceRef = Record<string, unknown>;
export interface AmaRuntimeSecretRef {
  vaultId: string;
  credentialId: string;
  items?: AmaSecretItem[];
}

export interface AmaRuntimeSecretEnvRef extends AmaRuntimeSecretRef {
  name?: string;
  key?: string;
}

export interface AmaSecretItem {
  key: string;
  path: string;
}

export interface AmaTaskSessionInput {
  projectId: string;
  agentId: string;
  environmentId: string;
  runtime: string;
  title: string;
  initialPrompt?: string | null;
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  gitCredentialSecret?: AmaRuntimeSecretRef | null;
}

export interface AmaAgentInput {
  projectId: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  provider: string;
  model?: string | null;
  role?: string | null;
  skills?: string[] | null;
  subagents?: Record<string, unknown>[] | null;
  capabilityTags?: string[] | null;
  handoffPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  memoryPolicy?: Record<string, unknown>;
  realmroot?: { agentId: string; origin: string; credentialRef: string } | null;
}

export interface AmaAgent {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  model: string | null;
}

function amaAgentSpec(input: AmaAgentInput) {
  return {
    systemPrompt: input.instructions ?? "",
    ...(input.provider ? { provider: input.provider } : {}),
    model: input.model ?? null,
    skills: input.skills ?? [],
    subagents: toAmaAgentSubagents(input.subagents ?? []),
    allowedTools: [],
    mcpConnectors: [],
    realmroot: input.realmroot ?? null,
  };
}

export interface AmaEnvironment {
  id: string;
}

export interface AmaProviderModelProfile {
  provider: string;
  model: string | null;
  runtime: string;
}

export interface AmaSessionDispatch {
  projectId: string;
  agentId: string;
  environmentId: string;
  sessionId: string;
  status: string;
  statusReason: string | null;
}

export interface AmaSessionSecretInput {
  projectId: string;
  vaultId: string;
  name: string;
  secretValue?: string;
  secretData?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface AmaSessionSecret {
  credentialId: string;
  secretRef: string;
}

export interface AmaVaultCredentialSecretInput {
  projectId: string;
  vaultId: string;
  credentialId: string;
  referenceName?: string;
  secretData: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface AmaScheduledTriggerInput {
  projectId: string;
  agentId: string;
  // Omit to leave the trigger unpinned: AMA resolves a runner-capable
  // environment for the runtime at each dispatch instead of at creation.
  environmentId?: string | null;
  runtime: string;
  name: string;
  promptTemplate: string;
  intervalSeconds: number;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
}

export interface AmaScheduledTriggerUpdate {
  agentId?: string;
  environmentId?: string | null;
  runtime?: string;
  name?: string;
  promptTemplate?: string;
  intervalSeconds?: number;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
}

export interface AmaHttpTriggerInput {
  projectId: string;
  agentId: string;
  environmentId?: string | null;
  runtime: string;
  name: string;
  promptTemplate: string;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
  concurrency?: "parallel" | "serial";
}

export interface AmaHttpTriggerUpdate {
  agentId?: string;
  environmentId?: string | null;
  runtime?: string;
  name?: string;
  promptTemplate?: string;
  status?: "active" | "paused";
  resourceRefs?: AmaResourceRef[];
  runtimeEnv?: Record<string, string>;
  runtimeSecretEnv?: AmaRuntimeSecretEnvRef[];
  metadata?: Record<string, unknown>;
  concurrency?: "parallel" | "serial";
}

export interface AmaScheduledTrigger {
  id: string;
  agentId: string;
  environmentId: string | null;
  name: string;
  promptTemplate: string;
  schedule: { intervalSeconds: number; windowSeconds?: number };
  status: "active" | "paused" | "archived";
  lastDispatchedAt: string | null;
  lastRunId: string | null;
}

export interface AmaHttpTrigger {
  id: string;
  agentId: string;
  environmentId: string | null;
  name: string;
  promptTemplate: string;
  status: "active" | "paused" | "archived";
  lastDispatchedAt: string | null;
  lastRunId: string | null;
}

export interface AmaTriggerRun {
  id: string;
  projectId: string;
  triggerId: string;
  scheduledFor: string | null;
  heartbeatAt: string | null;
  triggeredAt: string;
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AmaMemoryStore {
  id: string;
  name: string;
}

export interface AmaMemoryStoreInput {
  projectId: string;
  name: string;
  description?: string;
}

export interface AmaMemoryStoreMemory {
  id: string;
  storeId: string;
  projectId: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AmaHttpTriggerRunInput {
  projectId: string;
  triggerId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export interface AmaRuntimeCommandResult {
  accepted: boolean;
}

export interface AmaListResponse<T> {
  data: T[];
  pagination?: Record<string, unknown>;
}

export interface AmaRuntimeUsageWindow {
  label: string;
  utilization: number;
  resetsAt: string;
}
export interface AmaRuntimeUsage {
  runtime: string;
  windows: AmaRuntimeUsageWindow[];
}
export type AmaRunnerRuntime = SdkRunnerRuntime;
export interface AmaRunner {
  id: string;
  environmentId: string | null;
  status: string;
  currentLoad: number;
  maxConcurrent: number;
  lastHeartbeatAt: string | null;
  runtimeUsage?: AmaRuntimeUsage[];
  runtimes: AmaRunnerRuntime[];
}

export interface AmaProject {
  id: string;
  name: string;
}

export interface AmaVaultInput {
  projectId: string;
  name: string;
  description?: string;
  scope: "project" | "organization";
  idempotencyKey?: string;
}

export interface AmaVault {
  id: string;
}

export interface AmaVaultCredential {
  id: string;
  name: string;
  dataKeys: string[];
  state: string;
  updatedAt: string | null;
}

export interface AmaEnvironmentInput {
  projectId: string;
  name: string;
  description?: string;
  hostingMode: "self_hosted" | "cloud";
  metadata?: Record<string, unknown>;
}

// AMA's model catalog is a single global vendor catalog (auto-discovered from
// models.dev); a provider row's id IS its vendor slug, and an agent must pin a
// real catalog vendor as its providerId. For cloud (ama) the vendor is encoded
// in the model id, so it is derived per dispatch. For self-hosted CLIs the host
// owns the model universe (the runner's structured runtime report gates it), so the
// runtime's natural vendor is used as the pinned provider.
const RUNTIME_PROVIDER_PROFILES: Record<string, { providerSlug: string; cloud?: boolean }> = {
  "claude-code": { providerSlug: "anthropic" },
  codex: { providerSlug: "openai" },
  // Copilot's host runner declares its own models in its runtime report; the
  // pinned slug is AMA agent metadata for a runner-gated runtime, not a catalog
  // lookup key, so any real vendor satisfies it.
  copilot: { providerSlug: "openai" },
  ama: { providerSlug: "", cloud: true },
};

const WORKERS_AI_NATIVE_PREFIX = "@cf/";

// Provider identity in AMA's global catalog is the vendor slug, encoded in the
// model id: `@cf/{vendor}/{model}` (Workers AI native) or `{vendor}/{model}`
// (AI-gateway). Mirrors AMA's server/domain/model-catalog vendorFromModelId.
export function vendorFromModelId(modelId: string): string {
  const path = modelId.startsWith(WORKERS_AI_NATIVE_PREFIX) ? modelId.slice(WORKERS_AI_NATIVE_PREFIX.length) : modelId;
  const segments = path.split("/");
  const [first] = segments;
  return segments.length >= 2 && first ? first : "unknown";
}

function hasAmaUserClient(env: Env): boolean {
  return Boolean(
    env.REALMROOT_ISSUER &&
      env.REALMROOT_WEB_CLIENT_ID &&
      env.REALMROOT_WEB_CLIENT_SECRET &&
      env.REALMROOT_SESSION_ENCRYPTION_KEY &&
      env.AMA_RESOURCE,
  );
}

export function isAmaRuntimeConfigured(env: Env): boolean {
  return Boolean(env.AMA_ORIGIN && hasAmaUserClient(env));
}

export function isAmaTaskDispatchConfigured(env: Env): boolean {
  return isAmaRuntimeConfigured(env);
}

export async function createAmaTaskSession(env: Env, ownerId: string, input: AmaTaskSessionInput): Promise<AmaSessionDispatch> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const envFrom = toAmaEnvFrom(input.runtimeSecretEnv ?? []);
  const resources = toAmaRuntimeResources(input.resourceRefs ?? [], input.gitCredentialSecret ?? null);
  const session = await withAmaErrorDetails(env, "create session", () =>
    client.sessions.create({
      metadata: { name: input.title },
      spec: {
        agentId: input.agentId,
        environmentId: input.environmentId,
        runtime: toRuntimeName(input.runtime),
        env: input.runtimeEnv ?? {},
        envFrom,
        volumes: resources.volumes,
        volumeMounts: resources.volumeMounts,
      },
      prompt: input.initialPrompt ?? "",
    }),
  );

  return {
    projectId: input.projectId,
    agentId: session.spec.agentId,
    environmentId: session.spec.environmentId ?? input.environmentId,
    sessionId: session.metadata.uid,
    status: session.status.phase,
    statusReason: session.status.reason,
  };
}

function toRuntimeName(runtime: string): RuntimeName {
  return runtime as RuntimeName;
}

function credentialSecretRef(entry: Pick<AmaRuntimeSecretEnvRef, "vaultId" | "credentialId">): string {
  if (!entry.vaultId) throw new Error(`AMA secret env reference for credential ${entry.credentialId} is missing vaultId`);
  const vaultId = encodeURIComponent(entry.vaultId);
  const credentialId = encodeURIComponent(entry.credentialId);
  return `ama://vaults/${vaultId}/credentials/${credentialId}`;
}

export function amaCredentialSecretRef(vaultId: string, credentialId: string): string {
  return credentialSecretRef({ vaultId, credentialId });
}

function toAmaEnvFrom(entries: AmaRuntimeSecretEnvRef[]): EnvFromEntry[] {
  return entries.map(
    (entry) =>
      ({
        type: "secret",
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        secretRef: credentialSecretRef(entry),
        ...(entry.key !== undefined ? { key: entry.key } : {}),
      }) as EnvFromEntry,
  );
}

type VolumeWithSecretItems = Volume & { items?: AmaSecretItem[] };

function toAmaRuntimeResources(
  resourceRefs: AmaResourceRef[],
  gitCredentialSecret: AmaRuntimeSecretRef | null,
): { volumes: Volume[]; volumeMounts: VolumeMount[] } {
  const volumes: VolumeWithSecretItems[] = [];
  const volumeMounts: VolumeMount[] = [];
  for (const [index, resource] of resourceRefs.entries()) {
    if (resource.type === "github_repository" && typeof resource.owner === "string" && typeof resource.repo === "string") {
      const name = index === 0 ? "repo" : `repo-${index + 1}`;
      volumes.push({
        name,
        type: "git_repository",
        url: `https://github.com/${resource.owner}/${resource.repo}.git`,
        ...(gitCredentialSecret ? { secretRef: credentialSecretRef(gitCredentialSecret) } : {}),
        ...(gitCredentialSecret?.items ? { items: gitCredentialSecret.items } : {}),
      });
      volumeMounts.push({ name, mountPath: `/workspace/repos/github.com/${resource.owner}/${resource.repo}` });
    }
    if (resource.type === "memory_store" && typeof resource.storeId === "string") {
      const name = index === 0 ? "memory" : `memory-${index + 1}`;
      const readOnly = resource.readOnly === true;
      volumes.push({
        name,
        type: "memory",
        memoryRef: `ama://memories/${encodeURIComponent(resource.storeId)}`,
      });
      volumeMounts.push({ name, mountPath: `/workspace/.ama/memory-stores/${encodeURIComponent(resource.storeId)}`, readOnly });
    }
  }
  return { volumes: volumes as Volume[], volumeMounts };
}

function triggerTemplateMetadata(metadata: Record<string, unknown> | undefined) {
  return {
    labels: stringRecord((metadata?.labels as Record<string, unknown> | undefined) ?? {}),
    annotations: stringRecord((metadata?.annotations as Record<string, unknown> | undefined) ?? {}),
  };
}

function triggerExecutionSpec(input: AmaScheduledTriggerInput | AmaHttpTriggerInput) {
  const resources = toAmaRuntimeResources(input.resourceRefs ?? [], null);
  return {
    agentId: input.agentId,
    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
    runtime: toRuntimeName(input.runtime),
    env: input.runtimeEnv ?? {},
    envFrom: toAmaEnvFrom(input.runtimeSecretEnv ?? []),
    volumes: resources.volumes,
    volumeMounts: resources.volumeMounts,
    promptTemplate: input.promptTemplate,
  };
}

type AmaTriggerTemplateSpecUpdate = NonNullable<NonNullable<UpdateTriggerRequest["spec"]>["template"]>["spec"];

function triggerExecutionSpecUpdate(input: AmaScheduledTriggerUpdate | AmaHttpTriggerUpdate): AmaTriggerTemplateSpecUpdate | undefined {
  const spec: Record<string, unknown> = {};
  if (input.agentId !== undefined) spec.agentId = input.agentId;
  if (input.environmentId !== undefined) spec.environmentId = input.environmentId;
  if (input.runtime !== undefined) spec.runtime = toRuntimeName(input.runtime);
  if (input.runtimeEnv !== undefined) spec.env = input.runtimeEnv;
  if (input.runtimeSecretEnv !== undefined) spec.envFrom = toAmaEnvFrom(input.runtimeSecretEnv);
  if (input.resourceRefs !== undefined) {
    const resources = toAmaRuntimeResources(input.resourceRefs, null);
    spec.volumes = resources.volumes;
    spec.volumeMounts = resources.volumeMounts;
  }
  if (input.promptTemplate !== undefined) spec.promptTemplate = input.promptTemplate;
  return Object.keys(spec).length > 0 ? (spec as AmaTriggerTemplateSpecUpdate) : undefined;
}

function stringRecord(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
}

function toAmaAgentSubagents(subagents: Record<string, unknown>[]) {
  return subagents.map((subagent) => ({
    name: String(subagent.name ?? subagent.username ?? "subagent"),
    description: String(subagent.description ?? subagent.bio ?? ""),
    systemPrompt: String(subagent.systemPrompt ?? subagent.instructions ?? ""),
    model: typeof subagent.model === "string" ? subagent.model : null,
    allowedTools: Array.isArray(subagent.allowedTools) ? subagent.allowedTools.filter((tool): tool is string => typeof tool === "string") : [],
    skills: Array.isArray(subagent.skills) ? subagent.skills.filter((skill): skill is string => typeof skill === "string") : [],
    mcpConnectors: Array.isArray(subagent.mcpConnectors)
      ? subagent.mcpConnectors.filter((connector): connector is string => typeof connector === "string")
      : [],
  }));
}

function toAmaAgent(agent: SdkAgent, fallbackProvider: string): AmaAgent {
  return {
    id: agent.metadata.uid,
    projectId: agent.metadata.projectId ?? "",
    name: agent.metadata.name,
    provider: agent.spec.provider ?? fallbackProvider,
    model: agent.spec.model,
  };
}

function normalizeAgent(agent: SdkAgent): Record<string, unknown> {
  return {
    ...agent,
    id: agent.metadata.uid,
    projectId: agent.metadata.projectId,
    name: agent.metadata.name,
    description: agent.metadata.description,
    provider: agent.spec.provider,
    providerId: agent.spec.provider,
    model: agent.spec.model,
    archivedAt: agent.metadata.archivedAt,
  };
}

function normalizeEnvironment(environment: {
  metadata: { uid: string; projectId: string | null; name: string; description: string | null; archivedAt: string | null };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...environment,
    id: environment.metadata.uid,
    projectId: environment.metadata.projectId,
    name: environment.metadata.name,
    description: environment.metadata.description,
    archivedAt: environment.metadata.archivedAt,
  };
}

function normalizeSession(session: SdkSession): Record<string, unknown> {
  return {
    ...session,
    id: session.metadata.uid,
    projectId: session.metadata.projectId,
    name: session.metadata.name,
    title: session.metadata.name,
    agentId: session.spec.agentId,
    environmentId: session.spec.environmentId,
    runtime: session.spec.runtime,
    state: session.status.phase,
    stateReason: session.status.reason,
    status: session.status.phase,
    createdAt: session.metadata.createdAt,
    updatedAt: session.metadata.updatedAt,
    metadata: {
      ...session.metadata,
      ...session.metadata.labels,
      ...session.metadata.annotations,
    },
  };
}

function toAmaMemoryStore(store: SdkMemoryStore): AmaMemoryStore {
  return { id: store.metadata.uid, name: store.metadata.name };
}

export async function createAmaAgent(env: Env, ownerId: string, input: AmaAgentInput): Promise<AmaAgent> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const agent = await withAmaErrorDetails(env, "create runtime agent", () =>
    client.agents.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: amaAgentSpec(input),
    }),
  );
  return toAmaAgent(agent, input.provider);
}

export async function createAmaProject(env: Env, ownerId: string, input: { name: string; idempotencyKey?: string }): Promise<AmaProject> {
  const client = await createAmaClient(env, ownerId, undefined, input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : undefined);
  const project = await withAmaErrorDetails(env, "create project", () => client.projects.create({ name: input.name }));
  return { id: project.id, name: project.name };
}

export async function createAmaVault(env: Env, ownerId: string, input: AmaVaultInput): Promise<AmaVault> {
  const client = await createAmaClient(env, ownerId, input.projectId, input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : undefined);
  const vault = await withAmaErrorDetails(env, "create vault", () =>
    client.vaults.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: { scope: input.scope },
    }),
  );
  return { id: vault.metadata.uid };
}

export async function listAmaVaultCredentials(env: Env, ownerId: string, projectId: string, vaultId: string): Promise<AmaVaultCredential[]> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await withAmaErrorDetails(env, "list vault credentials", () => client.vaults.listCredentials(vaultId, { limit: 100 }), true);
  return page.data.map((credential) => ({
    id: credential.metadata.uid,
    name: credential.metadata.name,
    state: credential.status.phase,
    updatedAt: credential.metadata.updatedAt,
    dataKeys: credential.status.activeVersion?.spec.dataKeys ?? [],
  }));
}

export async function createAmaEnvironment(env: Env, ownerId: string, input: AmaEnvironmentInput): Promise<AmaEnvironment> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const environment = await withAmaErrorDetails(env, "create environment", () =>
    client.environments.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: { type: input.hostingMode },
    }),
  );
  return { id: environment.metadata.uid };
}

async function withAmaErrorDetails<T>(env: Env, operation: string, fn: () => Promise<T>, idempotent = false): Promise<T> {
  try {
    return await withAmaAuthRetry(env, idempotent, fn);
  } catch (error) {
    throwIfAmaAuthError(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? ` HTTP ${(error as { status: number }).status}` : "";
    throw new Error(`AMA ${operation} failed${status}`, { cause: error });
  }
}

async function withAmaAuthRetry<T>(env: Env, idempotent: boolean, fn: () => Promise<T>): Promise<T> {
  void env;
  void idempotent;
  try {
    return await fn();
  } catch (error) {
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function readAmaAgent(env: Env, ownerId: string, projectId: string, agentId: string): Promise<AmaAgent | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    const agent = await withAmaAuthRetry(env, true, () => client.agents.get(agentId));
    return toAmaAgent(agent, "");
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function updateAmaAgentConfig(env: Env, ownerId: string, projectId: string, agentId: string, input: AmaAgentInput): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails(env, "update runtime agent config", () =>
    client.agents.update(agentId, {
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: amaAgentSpec(input),
    }),
  );
}

// AMA has no hard delete for agents/environments (they are FK-referenced by
// sessions/runners/versions with no cascade). Deleting an AK agent/machine
// archives the corresponding AMA resource (soft delete: hidden from active
// lists, history preserved). Archive is the {archived:true} lifecycle PATCH.
export async function archiveAmaAgent(env: Env, ownerId: string, projectId: string, agentId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails(env, "archive runtime agent", () => client.agents.update(agentId, { archived: true }));
}

export async function archiveAmaEnvironment(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails(env, "archive runtime environment", () => client.environments.update(environmentId, { archived: true }));
}

// Self-heal probes: AMA resources we hold an id for can be deleted out of band
// (e.g. an AMA data migration that resets the control plane). These let the
// "ensure" paths detect a dangling id and re-provision instead of dispatching
// against a resource that no longer exists.
export async function readAmaProject(env: Env, ownerId: string, projectId: string): Promise<AmaProject | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    const project = await withAmaAuthRetry(env, true, () => client.projects.get(projectId));
    return { id: project.id, name: project.name };
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function amaEnvironmentExists(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<boolean> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    await withAmaAuthRetry(env, true, () => client.environments.get(environmentId));
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return false;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export function resolveAmaProviderModelProfile(input: { runtime: string; preferredModel?: string | null }): AmaProviderModelProfile {
  const { runtime, preferredModel } = input;
  const configured = RUNTIME_PROVIDER_PROFILES[runtime];
  if (!configured) {
    throw new Error(`No AK runtime provider mapping is configured for runtime ${runtime}`);
  }
  const model = preferredModel ?? null;
  if (configured.cloud) {
    // Cloud agents must pin a catalog model; AMA validates the (vendor, model)
    // pair against the global catalog at session creation.
    if (!model) {
      throw new Error(`A cloud (${runtime}) agent must pin a model from the AMA catalog before dispatch`);
    }
    return { runtime, provider: vendorFromModelId(model), model };
  }
  return { runtime, provider: configured.providerSlug, model };
}

export async function createAmaSessionSecret(env: Env, ownerId: string, input: AmaSessionSecretInput): Promise<AmaSessionSecret> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const stringData = input.secretData ?? (input.secretValue !== undefined ? { value: input.secretValue } : null);
  if (!stringData || Object.keys(stringData).length === 0) {
    throw new Error("AMA vault credential requires at least one secret data key");
  }
  const credential = await withAmaAuthRetry(env, false, () =>
    client.vaults.createCredential(input.vaultId, {
      name: input.name,
      type: "opaque",
      metadata: input.metadata ?? {},
      secret: {
        stringData,
        referenceName: input.name,
        metadata: input.metadata ?? {},
      },
    }),
  );
  return {
    credentialId: credential.metadata.uid,
    secretRef: credentialSecretRef({ vaultId: input.vaultId, credentialId: credential.metadata.uid }),
  };
}

export async function updateAmaVaultCredentialSecret(env: Env, ownerId: string, input: AmaVaultCredentialSecretInput): Promise<AmaSessionSecret> {
  if (Object.keys(input.secretData).length === 0) {
    throw new Error("AMA vault credential secret requires at least one secret data key");
  }
  const client = await createAmaClient(env, ownerId, input.projectId);
  const credential = await withAmaErrorDetails(env, "update vault credential secret", () =>
    client.vaults.updateCredentialSecret(input.vaultId, input.credentialId, {
      stringData: input.secretData,
      referenceName: input.referenceName,
      metadata: input.metadata ?? {},
    }),
  );
  return {
    credentialId: credential.metadata.uid,
    secretRef: credentialSecretRef({ vaultId: input.vaultId, credentialId: credential.metadata.uid }),
  };
}

export interface AmaSessionUsageTotals {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export async function readAmaSessionUsageTotals(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
): Promise<AmaSessionUsageTotals | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  // /api/v1 usage-summary groups only by provider/model/agent; per-session
  // totals come from summing the session's usage records. The endpoint caps
  // limit at 100, so page through all records via the cursor.
  const totals: AmaSessionUsageTotals = { promptTokens: 0, completionTokens: 0, costMicros: 0 };
  let records = 0;
  let cursor: string | undefined;
  do {
    const page = await withAmaAuthRetry(env, true, () => client.usage.listRecords({ sessionId, limit: 100, ...(cursor ? { cursor } : {}) }));
    for (const record of page.data) {
      totals.promptTokens += record.promptTokens ?? 0;
      totals.completionTokens += record.completionTokens ?? 0;
      totals.costMicros += record.costMicros ?? 0;
    }
    records += page.data.length;
    cursor = page.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return records === 0 ? null : totals;
}

export async function revokeAmaVaultCredential(
  env: Env,
  ownerId: string,
  projectId: string,
  vaultId: string,
  credentialId: string,
  reason = "AK agent session closed",
): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaAuthRetry(env, false, () => client.vaults.updateCredential(vaultId, credentialId, { state: "revoked", revokeReason: reason }));
}

export async function sendAmaSessionMessage(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  message: string,
): Promise<AmaRuntimeCommandResult> {
  const client = await createAmaClient(env, ownerId, projectId);
  // A 201 means the prompt message was accepted and queued for the session.
  await withAmaAuthRetry(env, false, () => client.sessions.createMessage(sessionId, { type: "prompt", content: message }));
  return { accepted: true };
}

export async function readAmaSession(env: Env, ownerId: string, sessionId: string, projectId?: string): Promise<Record<string, unknown> | null> {
  const client = await createAmaClient(env, ownerId, projectId);
  try {
    return normalizeSession(await withAmaAuthRetry(env, true, () => client.sessions.get(sessionId)));
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throwIfAmaAuthError(error);
    throw error;
  }
}

export async function listAmaSessions(
  env: Env,
  ownerId: string,
  projectId: string,
  options: { limit?: number; cursor?: string; state?: string; archived?: boolean; labelSelector?: string } = {},
): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId, projectId);
  type AmaSessionState = "pending" | "running" | "idle" | "closed" | "error";
  type AmaArchivedFilter = "true" | "false";
  const query = {
    limit: options.limit ?? 50,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.state ? { state: options.state as AmaSessionState } : {}),
    ...(options.archived !== undefined ? { archived: (options.archived ? "true" : "false") as AmaArchivedFilter } : {}),
    ...(options.labelSelector ? { labelSelector: options.labelSelector } : {}),
  };
  const page = await withAmaAuthRetry(env, true, () => client.sessions.list(query));
  return { data: page.data.map(normalizeSession), pagination: page.pagination };
}

export async function listAmaAgents(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  const page = await withAmaAuthRetry(env, true, () => client.agents.list({ limit: 100 }));
  return { data: page.data.map(normalizeAgent), pagination: page.pagination };
}

export async function listAmaEnvironments(env: Env, ownerId: string): Promise<AmaListResponse<Record<string, unknown>>> {
  const client = await createAmaClient(env, ownerId);
  const page = await withAmaAuthRetry(env, true, () => client.environments.list({ limit: 100 }));
  return { data: page.data.map(normalizeEnvironment), pagination: page.pagination };
}

export interface AmaCatalogModel {
  providerId: string;
  modelId: string;
  displayName?: string;
  availability: string;
}

// AMA's global model catalog (auto-discovered from models.dev, the authority —
// never hardcoded here). It is runtime-agnostic: every cloud model dispatches
// the same way through the Workers AI binding. The caller filters/orders it for
// the cloud (ama) runtime; self-hosted runtimes ignore it (their models come
// from the runner's live runtime report).
export async function listAmaCatalogModels(env: Env, ownerId: string): Promise<AmaCatalogModel[]> {
  const client = await createAmaClient(env, ownerId);
  // GET /api/v1/providers/models returns the entire catalog in one envelope
  // (the AMA route lists all rows; pagination is always {hasMore:false}), so no
  // cursor loop is needed.
  const response = await withAmaAuthRetry(env, true, () => client.providers.listModels());
  return response.data as unknown as AmaCatalogModel[];
}

export async function listAmaRunners(env: Env, ownerId: string, projectId: string, environmentId: string): Promise<AmaListResponse<AmaRunner>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await withAmaAuthRetry(env, true, () => client.runners.list({ environmentId, limit: 100 }));
  // /api/v1 runners report lifecycle as `state`; AK's dispatch gate reads
  // `status` (active | draining | disabled | offline).
  return {
    data: page.data.map((runner) => ({
      id: runner.id,
      environmentId: runner.environmentId,
      status: runner.state,
      currentLoad: runner.currentLoad,
      maxConcurrent: runner.maxConcurrent,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      runtimeUsage: runner.runtimeUsage,
      runtimes: runner.runtimes,
    })),
    pagination: page.pagination,
  };
}

interface AmaTriggerResponse {
  metadata: {
    uid: string;
    name: string;
    archivedAt: string | null;
  };
  spec: {
    source:
      | { type: "schedule"; schedule: { intervalSeconds: number; windowSeconds?: number } }
      | { type: "http"; concurrency?: { mode: "parallel" | "serial" } };
    suspend: boolean;
    template: {
      spec: {
        agentId: string;
        environmentId: string | null;
        promptTemplate: string;
      };
    };
  };
  status: {
    lastDispatchedAt: string | null;
    lastRunId: string | null;
  };
}

interface AmaTriggerRunResponse {
  metadata: {
    uid: string;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  spec: {
    triggerId: string;
    scheduledFor: string | null;
    metadata: Record<string, unknown>;
  };
  status: {
    phase: string;
    heartbeatAt: string | null;
    triggeredAt: string;
    sessionId: string | null;
    errorMessage: string | null;
  };
}

// /api/v1 triggers expose enablement as a boolean + an archive timestamp; AK's
// maintainer status is the tri-state derived from them.
function amaTriggerStatus(trigger: AmaTriggerResponse): AmaScheduledTrigger["status"] {
  if (trigger.metadata.archivedAt) return "archived";
  return trigger.spec.suspend ? "paused" : "active";
}

function toAmaScheduledTrigger(trigger: AmaTriggerResponse): AmaScheduledTrigger {
  if (trigger.spec.source.type !== "schedule") {
    throw new Error(`AMA trigger ${trigger.metadata.uid} is not scheduled`);
  }
  return {
    id: trigger.metadata.uid,
    agentId: trigger.spec.template.spec.agentId,
    environmentId: trigger.spec.template.spec.environmentId,
    name: trigger.metadata.name,
    promptTemplate: trigger.spec.template.spec.promptTemplate,
    schedule: { intervalSeconds: trigger.spec.source.schedule.intervalSeconds, windowSeconds: trigger.spec.source.schedule.windowSeconds },
    status: amaTriggerStatus(trigger),
    lastDispatchedAt: trigger.status.lastDispatchedAt,
    lastRunId: trigger.status.lastRunId,
  };
}

function toAmaHttpTrigger(trigger: AmaTriggerResponse): AmaHttpTrigger {
  return {
    id: trigger.metadata.uid,
    agentId: trigger.spec.template.spec.agentId,
    environmentId: trigger.spec.template.spec.environmentId,
    name: trigger.metadata.name,
    promptTemplate: trigger.spec.template.spec.promptTemplate,
    status: amaTriggerStatus(trigger),
    lastDispatchedAt: trigger.status.lastDispatchedAt,
    lastRunId: trigger.status.lastRunId,
  };
}

function toAmaTriggerRun(run: AmaTriggerRunResponse): AmaTriggerRun {
  return {
    id: run.metadata.uid,
    projectId: run.metadata.projectId ?? "",
    triggerId: run.spec.triggerId,
    scheduledFor: run.spec.scheduledFor,
    heartbeatAt: run.status.heartbeatAt,
    triggeredAt: run.status.triggeredAt,
    status: run.status.phase,
    sessionId: run.status.sessionId,
    errorMessage: run.status.errorMessage,
    metadata: run.spec.metadata,
    createdAt: run.metadata.createdAt,
    updatedAt: run.metadata.updatedAt,
  };
}

export async function listAmaTriggerRuns(
  env: Env,
  ownerId: string,
  projectId: string,
  triggerId: string,
  options: { limit?: number } = {},
): Promise<AmaListResponse<AmaTriggerRun>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await withAmaAuthRetry(env, true, () => client.triggers.listRuns(triggerId, { limit: options.limit ?? 20 }));
  return { data: page.data.map((run) => toAmaTriggerRun(run as SdkTriggerRun)), pagination: page.pagination };
}

export async function closeAmaSession(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error",
) {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaAuthRetry(env, false, () =>
    client.sessions.update(sessionId, { state: "closed", metadata: { annotations: { closeReason: reason } } }),
  );
}

export async function reopenAmaSession(
  env: Env,
  ownerId: string,
  projectId: string,
  sessionId: string,
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> },
) {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaAuthRetry(env, false, () => client.sessions.update(sessionId, { state: "idle", ...(metadata ? { metadata } : {}) }));
}

export async function createAmaScheduledAgentTrigger(env: Env, ownerId: string, input: AmaScheduledTriggerInput): Promise<AmaScheduledTrigger> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const trigger = await withAmaErrorDetails(env, "create scheduled trigger", () =>
    client.triggers.create({
      metadata: { name: input.name },
      spec: {
        source: { type: "schedule", schedule: { type: "interval", intervalSeconds: input.intervalSeconds } },
        suspend: (input.status ?? "active") === "paused",
        template: {
          metadata: triggerTemplateMetadata(input.metadata),
          spec: triggerExecutionSpec(input),
        },
      },
    }),
  );
  return toAmaScheduledTrigger(trigger as SdkTrigger);
}

export async function createAmaHttpAgentTrigger(env: Env, ownerId: string, input: AmaHttpTriggerInput): Promise<AmaHttpTrigger> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const trigger = await withAmaErrorDetails(env, "create HTTP trigger", () =>
    client.triggers.create({
      metadata: { name: input.name },
      spec: {
        source: { type: "http", concurrency: { mode: input.concurrency ?? "parallel" } },
        suspend: (input.status ?? "active") === "paused",
        template: {
          metadata: triggerTemplateMetadata(input.metadata),
          spec: triggerExecutionSpec(input),
        },
      },
    }),
  );
  return toAmaHttpTrigger(trigger as SdkTrigger);
}

export async function updateAmaScheduledAgentTrigger(
  env: Env,
  ownerId: string,
  projectId: string,
  scheduleId: string,
  input: AmaScheduledTriggerUpdate,
): Promise<AmaScheduledTrigger> {
  const body: UpdateTriggerRequest = {};
  if (input.name !== undefined) body.metadata = { name: input.name };
  body.spec = {};
  if (input.intervalSeconds !== undefined) {
    body.spec.source = { type: "schedule", schedule: { type: "interval", intervalSeconds: input.intervalSeconds } };
  }
  if (input.status !== undefined) body.spec.suspend = input.status === "paused";
  const template = triggerExecutionSpecUpdate(input);
  const metadata = input.metadata !== undefined ? triggerTemplateMetadata(input.metadata) : undefined;
  if (template || metadata) body.spec.template = { ...(metadata ? { metadata } : {}), ...(template ? { spec: template } : {}) };
  if (Object.keys(body.spec).length === 0) delete body.spec;
  const client = await createAmaClient(env, ownerId, projectId);
  const trigger = await withAmaErrorDetails(env, "update scheduled trigger", () => client.triggers.update(scheduleId, body));
  return toAmaScheduledTrigger(trigger as SdkTrigger);
}

export async function updateAmaHttpAgentTrigger(
  env: Env,
  ownerId: string,
  projectId: string,
  triggerId: string,
  input: AmaHttpTriggerUpdate,
): Promise<AmaHttpTrigger> {
  const body: UpdateTriggerRequest = {};
  if (input.name !== undefined) body.metadata = { name: input.name };
  body.spec = {};
  if (input.concurrency !== undefined) body.spec.source = { type: "http", concurrency: { mode: input.concurrency } };
  if (input.status !== undefined) body.spec.suspend = input.status === "paused";
  const template = triggerExecutionSpecUpdate(input);
  const metadata = input.metadata !== undefined ? triggerTemplateMetadata(input.metadata) : undefined;
  if (template || metadata) body.spec.template = { ...(metadata ? { metadata } : {}), ...(template ? { spec: template } : {}) };
  if (Object.keys(body.spec).length === 0) delete body.spec;
  const client = await createAmaClient(env, ownerId, projectId);
  const trigger = await withAmaErrorDetails(env, "update HTTP trigger", () => client.triggers.update(triggerId, body));
  return toAmaHttpTrigger(trigger as SdkTrigger);
}

export async function deleteAmaScheduledAgentTrigger(env: Env, ownerId: string, projectId: string, scheduleId: string): Promise<void> {
  await deleteAmaTrigger(env, ownerId, projectId, scheduleId);
}

export async function deleteAmaTrigger(env: Env, ownerId: string, projectId: string, triggerId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails(env, "delete trigger", () => client.triggers.delete(triggerId));
}

export async function createAmaMemoryStore(env: Env, ownerId: string, input: AmaMemoryStoreInput): Promise<AmaMemoryStore> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const store = await withAmaErrorDetails(env, "create memory store", () =>
    client.memoryStores.create({
      metadata: {
        name: input.name,
        description: input.description ?? null,
      },
      spec: {},
    }),
  );
  return toAmaMemoryStore(store);
}

export async function listAmaMemoryStoreMemories(
  env: Env,
  ownerId: string,
  projectId: string,
  storeId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<AmaListResponse<AmaMemoryStoreMemory>> {
  const client = await createAmaClient(env, ownerId, projectId);
  const page = await withAmaErrorDetails(
    env,
    "list memories",
    () =>
      client.memoryStores.listMemories(storeId, {
        limit: options.limit ?? 100,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    true,
  );
  return { data: page.data.map(toAmaMemoryStoreMemory), pagination: page.pagination };
}

export async function archiveAmaMemoryStore(env: Env, ownerId: string, projectId: string, storeId: string): Promise<void> {
  const client = await createAmaClient(env, ownerId, projectId);
  await withAmaErrorDetails(env, "archive memory store", () => client.memoryStores.update(storeId, { archived: true }));
}

export async function dispatchAmaHttpTriggerRun(env: Env, ownerId: string, input: AmaHttpTriggerRunInput): Promise<AmaTriggerRun> {
  const client = await createAmaClient(env, ownerId, input.projectId);
  const run = await withAmaErrorDetails(env, "create HTTP trigger run", () =>
    client.triggers.createRun(input.triggerId, input.body, {
      ...(input.idempotencyKey ? { headers: { "idempotency-key": input.idempotencyKey } } : {}),
    }),
  );
  return toAmaTriggerRun(run as SdkTriggerRun);
}

function throwIfAmaAuthError(error: unknown): void {
  if (error instanceof AmaUserGrantRequired) throw new AmaUserAuthError(error.message);
  if (isAmaUnauthorizedError(error)) {
    throw new AmaUserAuthError();
  }
}

function isAmaUnauthorizedError(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; responseText?: unknown; body?: unknown; cause?: unknown };
  if (candidate.status === 401 || candidate.statusCode === 401) return true;
  const detail = [
    error instanceof Error ? error.message : String(error),
    typeof candidate.responseText === "string" ? candidate.responseText : "",
    typeof candidate.body === "string" ? candidate.body : JSON.stringify(candidate.body ?? ""),
    candidate.cause instanceof Error ? candidate.cause.message : "",
  ].join(" ");
  return /\bHTTP 401\b/.test(detail) || /unauthorized|authentication required|invalid[_ -]?token/i.test(detail);
}

async function createAmaClient(env: Env, ownerId: string, projectId?: string, requestHeaders: Record<string, string> = {}) {
  const baseUrl = requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN");
  const accessToken = await requiredAmaBearerToken(env, ownerId);
  const client = createSdkClient({
    baseUrl,
    projectId,
    headers: { ...requestHeaders, authorization: `Bearer ${accessToken}` },
  });
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${await requiredAmaBearerToken(env, ownerId)}`);
    let response = await fetch(new Request(request, { headers }));
    if (response.status === 401) {
      const refreshed = await requiredAmaBearerToken(env, ownerId, true);
      if (request.method === "GET" || request.method === "HEAD") {
        headers.set("authorization", `Bearer ${refreshed}`);
        response = await fetch(new Request(request, { headers }));
      }
    }
    return response;
  };
  client.raw.setConfig({ fetch: authenticatedFetch });
  return client;
}

// Browsers connect only to AK. AK validates the Session Cookie and tenant-owned
// session before opening a user-authorized upstream socket to AMA.
export async function getAmaSessionSocketUrl(env: Env, _ownerId: string, sessionId: string, _projectId?: string): Promise<string> {
  const baseUrl = requireEnv(env.AK_API_URL ?? env.AK_RESOURCE, "AK_API_URL");
  const wsBase = baseUrl.replace(/^http(s?):\/\//i, (_match, secure) => `ws${secure}://`).replace(/\/api\/?$/, "");
  return `${wsBase}/api/ama/sessions/${encodeURIComponent(sessionId)}/socket`;
}

export async function proxyAmaSessionSocket(env: Env, ownerId: string, sessionId: string, projectId: string): Promise<Response> {
  const baseUrl = requireEnv(env.AMA_ORIGIN, "AMA_ORIGIN");
  const upstreamUrl = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/socket`, baseUrl).toString();
  const connect = async (forceRefresh = false) => {
    return fetch(upstreamUrl, {
      headers: {
        authorization: `Bearer ${await requiredAmaBearerToken(env, ownerId, forceRefresh)}`,
        upgrade: "websocket",
        "x-ama-project-id": projectId,
      },
    });
  };
  let response = await connect();
  if (response.status === 401) {
    response = await connect(true);
  }
  if (response.status === 101 && response.webSocket) return response;
  console.error("AMA WebSocket handshake failed", { status: response.status, sessionId, projectId });
  throw new Error("AMA WebSocket handshake failed");
}

async function requiredAmaBearerToken(env: Env, ownerId: string, forceRefresh = false): Promise<string> {
  try {
    return await amaBearerToken(env, ownerId, forceRefresh);
  } catch (error) {
    if (error instanceof AmaUserGrantRequired) throw new AmaUserAuthError(error.message);
    throw error;
  }
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function toAmaMemoryStoreMemory(memory: SdkMemoryStoreMemory): AmaMemoryStoreMemory {
  return {
    id: memory.metadata.uid,
    storeId: memory.spec.storeId,
    projectId: memory.metadata.projectId ?? "",
    path: memory.spec.path,
    content: memory.spec.content,
    metadata: memory.spec.metadata,
    createdAt: memory.metadata.createdAt,
    updatedAt: memory.metadata.updatedAt,
  };
}
