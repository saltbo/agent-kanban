import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Agent, LeaderAgentRuntime } from "@agent-kanban/shared";
import { missingAuthSessionMessage } from "../auth/guidance.js";
import { AgentClient } from "../client/agent.js";
import { type ApiClient, ApiError } from "../client/base.js";
import { MachineClient } from "../client/machine.js";
import { getCredentials } from "../config.js";
import { DAEMON_STATE_FILE } from "../paths.js";
import { isPidAlive, listSessions, removeSession, writeSession } from "../session/store.js";
import { loadIdentity, removeIdentity, type StoredIdentity, saveIdentity } from "./identity.js";
import { detectRuntime, findRuntimeAncestorPid } from "./runtime.js";

function machineClient(): MachineClient {
  const state = JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf8")) as { machineId?: string };
  if (!state.machineId) throw new Error("Run `ak start` before creating a leader Agent session.");
  const client = new MachineClient();
  client.bindMachine(state.machineId);
  return client;
}

async function restoreIdentity(runtime: LeaderAgentRuntime, client: MachineClient): Promise<StoredIdentity | null> {
  const agents = (await client.listAgents()) as Agent[];
  const leaders = agents.filter((agent) => agent.kind === "leader" && agent.runtime === runtime);
  if (leaders.length !== 1) return null;
  const leader = leaders[0];
  const identity = { agent_id: leader.id, name: leader.name, fingerprint: leader.fingerprint };
  saveIdentity(runtime, identity);
  return identity;
}

async function loadOrRestoreIdentity(runtime: LeaderAgentRuntime, client: MachineClient): Promise<StoredIdentity | null> {
  const local = loadIdentity(runtime);
  if (local) {
    try {
      const agent = (await client.getAgent(local.agent_id)) as Agent;
      if (agent.kind === "leader" && agent.runtime === runtime) return local;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    removeIdentity(runtime);
  }
  return restoreIdentity(runtime, client);
}

export async function getIdentity(runtime: LeaderAgentRuntime): Promise<StoredIdentity | null> {
  return loadOrRestoreIdentity(runtime, machineClient());
}

export async function createIdentity(input: { runtime: LeaderAgentRuntime; username: string; name?: string }): Promise<StoredIdentity> {
  if (loadIdentity(input.runtime)) throw new Error(`Identity for runtime "${input.runtime}" already exists.`);
  const client = machineClient();
  const agent = (await client.createAgent({ username: input.username, name: input.name, runtime: input.runtime, kind: "leader" })) as Agent;
  const identity = { agent_id: agent.id, name: agent.name, fingerprint: agent.fingerprint };
  saveIdentity(input.runtime, identity);
  return identity;
}

export async function loginLeaderAgent(input: { runtime: LeaderAgentRuntime; username: string; name?: string }) {
  const leaderPid = findRuntimeAncestorPid(input.runtime);
  if (leaderPid === null) throw new Error(`Could not locate ${input.runtime} process in ancestry.`);
  const { apiUrl } = getCredentials();
  const client = machineClient();
  const machineId = (JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf8")) as { machineId: string }).machineId;
  let identity = await loadOrRestoreIdentity(input.runtime, client);
  const reusedIdentity = Boolean(identity);
  identity ??= await createIdentity(input);

  const existing = listSessions({ type: "leader" }).find(
    (session) => session.pid === leaderPid && session.runtime === input.runtime && session.apiUrl === apiUrl,
  );
  if (existing && isPidAlive(leaderPid) && existing.agentId === identity.agent_id) {
    return { identity, sessionId: existing.sessionId, reusedIdentity };
  }
  if (existing) removeSession(existing.sessionId);

  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" } as AlgorithmIdentifier, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  if (!publicJwk.x) throw new Error("Ed25519 key export missing x component");
  const sessionId = randomUUID();
  await client.createSession(identity.agent_id, sessionId, publicJwk.x, machineId);
  writeSession({
    type: "leader",
    agentId: identity.agent_id,
    sessionId,
    pid: leaderPid,
    runtime: input.runtime,
    startedAt: Date.now(),
    apiUrl,
    privateKeyJwk: privateJwk,
  });
  cachedLeaderClient = new AgentClient(apiUrl, identity.agent_id, sessionId, keys.privateKey);
  return { identity, sessionId, reusedIdentity };
}

let cachedLeaderClient: AgentClient | null = null;

export async function createClient(): Promise<ApiClient> {
  const fromEnv = await AgentClient.fromEnv();
  if (fromEnv) return fromEnv;
  if (cachedLeaderClient) return cachedLeaderClient;
  const runtime = detectRuntime();
  if (!runtime) throw new Error(missingAuthSessionMessage());
  const leaderPid = findRuntimeAncestorPid(runtime);
  const apiUrl = getCredentials().apiUrl;
  const existing = listSessions({ type: "leader" }).find(
    (session) => session.pid === leaderPid && session.runtime === runtime && session.apiUrl === apiUrl,
  );
  if (!existing || !isPidAlive(leaderPid ?? undefined)) throw new Error(missingAuthSessionMessage());
  const key = await crypto.subtle.importKey("jwk", existing.privateKeyJwk, { name: "Ed25519" } as AlgorithmIdentifier, false, ["sign"]);
  cachedLeaderClient = new AgentClient(existing.apiUrl, existing.agentId, existing.sessionId, key);
  return cachedLeaderClient;
}
