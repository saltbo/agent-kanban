import type { Page, Route } from "@playwright/test";

export const SESSION_COOKIE = "ak-v2-e2e-session";
export const CONNECTION_ID = "ama-e2e";
export const PROJECT_ID = "project-e2e";

export async function signIn(page: Page) {
  await page.context().addCookies([{ name: "ak_session", value: SESSION_COOKIE, url: "http://127.0.0.1:6265", httpOnly: true, sameSite: "Lax" }]);
}

export function collection(items: unknown[]) {
  return { items, pagination: { pageSize: 100 } };
}

export function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });
}

export const readyAgent = {
  metadata: {
    uid: "agent-ready",
    projectId: PROJECT_ID,
    name: "Release Engineer",
    description: "Owns release verification.",
    labels: {},
    annotations: {},
    createdBy: "controller-e2e",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    archivedAt: null,
  },
  identity: {
    issuer: "https://realmroot.test/api/auth",
    subject: "agt_release_engineer",
    username: "release-engineer",
    runtime: "ama",
  },
  spec: {
    runtime: "codex",
    systemPrompt: "Verify the release.",
    provider: "workers-ai",
    model: "gpt-5.6-sol",
    skills: ["owner/repository@release-verification"],
    subagents: [],
    allowedTools: ["read", "bash", "grep"],
    mcpConnectors: [],
  },
  status: {
    phase: "active",
    ready: true,
    retirementStage: null,
    currentVersionId: "agent-version-ready",
    version: 3,
  },
};

export const provisioningAgent = {
  ...readyAgent,
  metadata: { ...readyAgent.metadata, uid: "agent-provisioning", name: "Provisioning Agent" },
  identity: { ...readyAgent.identity, subject: "agt_provisioning", username: "provisioning-agent" },
  status: { ...readyAgent.status, ready: false, currentVersionId: null, version: 0 },
};

export const localMachine = {
  id: "env-local",
  name: "Build Mac",
  description: "Local release runner environment.",
  type: "self_hosted",
  phase: "active",
  status: "online",
  lastHeartbeatAt: "2026-08-23T00:00:00.000Z",
  sessionCount: 1,
  activeSessionCount: 1,
  runtimes: [{ runtime: "codex", models: ["gpt-5.6-sol"], version: "0.48.0", state: "ready" }],
  warnings: [],
  environment: {
    metadata: {
      uid: "env-local",
      projectId: PROJECT_ID,
      name: "Build Mac",
      description: "Local release runner environment.",
      labels: {},
      annotations: {},
      createdBy: "controller-e2e",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      archivedAt: null,
    },
    spec: {
      scope: "project",
      type: "self_hosted",
      networking: { type: "limited", allowMcpServers: false, allowPackageManagers: true, allowedHosts: [] },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      variables: {},
    },
    status: { phase: "active", currentVersionId: "env-version-local", version: 1 },
  },
  runners: [
    {
      id: "runner-local",
      projectId: PROJECT_ID,
      name: "mac-mini-runner",
      environmentId: "env-local",
      secretRef: null,
      authMode: "realmroot",
      state: "active",
      currentLoad: 1,
      maxConcurrent: 2,
      runtimeUsage: [],
      runtimes: [{ runtime: "codex", models: ["gpt-5.6-sol"], version: "0.48.0", state: "ready" }],
      metadata: { os: "darwin-arm64" },
      lastHeartbeatAt: "2026-08-23T00:00:00.000Z",
      archivedAt: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
  ],
  sessions: [{ metadata: { uid: "session-active", name: "Release run" }, status: { phase: "running" }, spec: { agentId: "agent-ready" } }],
  agents: [readyAgent],
};
