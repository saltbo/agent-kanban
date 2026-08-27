import type { Page, Route } from "@playwright/test";

export const CONNECTION_ID = "ama-e2e";
export const PROJECT_ID = "project-e2e";

export async function signIn(page: Page) {
  const config = (await (await page.request.get("/api/configz")).json()) as { issuer: string };
  const fixture = (await (await page.request.get(`${new URL(config.issuer).origin}/e2e-token`)).json()) as { accessToken: string };
  await page.addInitScript(
    ({ akToken, amaToken }) => {
      localStorage.setItem("ak:e2e-access-token", akToken);
      localStorage.setItem("ak:e2e-ama-access-token", amaToken);
    },
    { akToken: fixture.accessToken, amaToken: "e2e-ama-token" },
  );
}

export function collection(items: unknown[]) {
  return { items, pagination: { pageSize: 100 } };
}

export function amaCollection(data: unknown[]) {
  return { data, pagination: { hasMore: false, nextCursor: null } };
}

export async function routeAmaAgents(page: Page, agents: any[] = [readyAgent], sessions: any[] = []) {
  await page.route(/\/api\/v1\/agents(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.match(/\/api\/v1\/agents\/([^/]+)$/)?.[1];
    return fulfillJson(
      route,
      id ? (agents.find((agent) => agent.metadata.uid === id) ?? { detail: "Agent not found" }) : amaCollection(agents),
      id && !agents.some((agent) => agent.metadata.uid === id) ? 404 : 200,
    );
  });
  await page.route(/\/api\/v1\/sessions(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection(sessions)));
}

export async function routeAmaMachines(page: Page, machines: any[] = [localMachine]) {
  await page.route(/\/api\/v1\/environments(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    return fulfillJson(route, amaCollection(machines.flatMap((machine) => (machine.environment ? [machine.environment] : []))));
  });
  await page.route(/\/api\/v1\/runners(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection(machines.flatMap((machine) => machine.runners))));
  await page.route(/\/api\/v1\/sessions(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection(machines.flatMap((machine) => machine.sessions))));
  await page.route(/\/api\/v1\/agents(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection(machines.flatMap((machine) => machine.agents))));
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
  sessions: [
    {
      metadata: { uid: "session-active", name: "Release run" },
      status: { phase: "running" },
      spec: { agentId: "agent-ready", environmentId: "env-local" },
    },
  ],
  agents: [readyAgent],
};
