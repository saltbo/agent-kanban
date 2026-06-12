import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Agent, AgentRuntime } from "@agent-kanban/shared";
import { AgentClient } from "../client/agent.js";
import type { ApiClient } from "../client/base.js";
import { MachineClient } from "../client/machine.js";
import { getCredentials } from "../config.js";
import { PID_FILE } from "../paths.js";
import { findLeaderSession, isPidAlive, writeSession } from "../session/store.js";
import { loadIdentity, type StoredIdentity, saveIdentity } from "./identity.js";
import { detectRuntime, findRuntimeAncestorPid } from "./runtime.js";

function isDaemonAlive(): boolean {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the daemon process exists but lives in a security context we
    // may not signal. On Windows this happens when `ak start` is launched by
    // Task Scheduler (S4U) into Session 0 (Services) and we probe it from a
    // normal user session — the cross-session signal is denied, not absent.
    // Treat EPERM as alive, otherwise `ak get task` aborts with the spurious
    // "Could not locate claude process in ancestry" error.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function missingIdentityMessage(runtime: AgentRuntime): string {
  return [
    `No identity found for runtime "${runtime}".`,
    "",
    "Create one explicitly with:",
    "  ak identity create --username <username> [--name <name>]",
    "",
    "Choose the identity values yourself:",
    "  --username  required, user-like handle chosen by the agent",
    "  --name      optional full name shown in the UI",
    "",
    `This identity is reused for the same api-url + machine + runtime (${runtime}).`,
    "",
    "Examples:",
    "  ak identity create --username alex",
    '  ak identity create --username alex --name "Alex Chen"',
  ].join("\n");
}

async function restoreIdentity(runtime: AgentRuntime, client: MachineClient): Promise<StoredIdentity | null> {
  const agents = (await client.listAgents()) as Agent[];
  const leaders = agents.filter((agent) => agent.kind === "leader" && agent.runtime === runtime);
  if (leaders.length !== 1) return null;
  const leader = leaders[0];
  const identity: StoredIdentity = { agent_id: leader.id, name: leader.name, fingerprint: leader.fingerprint };
  saveIdentity(runtime, identity);
  return identity;
}

export async function getIdentity(runtime: AgentRuntime): Promise<StoredIdentity | null> {
  const local = loadIdentity(runtime);
  if (local) return local;
  return restoreIdentity(runtime, new MachineClient());
}

export async function createIdentity(input: { runtime: AgentRuntime; username: string; name?: string }): Promise<StoredIdentity> {
  const existing = loadIdentity(input.runtime);
  if (existing) {
    throw new Error(`Identity for runtime "${input.runtime}" already exists.`);
  }

  const client = new MachineClient();
  const payload: { username: string; name?: string; runtime: AgentRuntime; kind: "leader" } = {
    username: input.username,
    runtime: input.runtime,
    kind: "leader",
  };
  if (input.name) payload.name = input.name;

  const agent = (await client.createAgent(payload)) as Agent;
  const identity: StoredIdentity = { agent_id: agent.id, name: agent.name, fingerprint: agent.fingerprint };
  saveIdentity(input.runtime, identity);
  return identity;
}

let cachedLeaderClient: AgentClient | null = null;

/**
 * Returns AgentClient for the current identity.
 * - Daemon-spawned workers: reads AK_AGENT_* env vars
 * - Leader agents: auto-initializes from runtime detection + session file
 * - No runtime: throws (human in terminal)
 */
export async function createClient(): Promise<ApiClient> {
  const fromEnv = await AgentClient.fromEnv();
  if (fromEnv) return fromEnv;

  if (cachedLeaderClient) return cachedLeaderClient;

  const runtime = detectRuntime() as AgentRuntime | null;
  if (!runtime) {
    throw new Error("This command requires agent identity. Run inside an agent runtime.");
  }

  // Anchor the leader session to the long-lived runtime process PID so it outlives
  // the ephemeral shell that spawns `ak`. Without this, every ak invocation would
  // create a fresh session that the daemon's heartbeat immediately reaps.
  const leaderPid = findRuntimeAncestorPid(runtime);
  if (leaderPid === null) {
    throw new Error(`Could not locate ${runtime} process in ancestry. ak must be invoked from inside a ${runtime} session.`);
  }

  const existing = findLeaderSession(leaderPid);
  if (existing && existing.runtime === runtime && isPidAlive(leaderPid)) {
    const key = await crypto.subtle.importKey("jwk", existing.privateKeyJwk, { name: "Ed25519" } as any, false, ["sign"]);
    cachedLeaderClient = new AgentClient(existing.apiUrl, existing.agentId, existing.sessionId, key);
    return cachedLeaderClient;
  }

  const machineClient = new MachineClient();
  const identity = loadIdentity(runtime) ?? (await restoreIdentity(runtime, machineClient));
  if (!identity) {
    throw new Error(missingIdentityMessage(runtime));
  }

  if (!isDaemonAlive()) {
    throw new Error("Daemon is not running. Start it with: ak start");
  }

  // First call — create a leader session for an existing identity
  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!pubJwk.x) throw new Error("Ed25519 key export missing x component");
  const sessionId = randomUUID();
  const apiUrl = getCredentials().apiUrl;
  await machineClient.createSession(identity.agent_id, sessionId, pubJwk.x);

  writeSession({
    type: "leader",
    agentId: identity.agent_id,
    sessionId,
    pid: leaderPid,
    runtime,
    startedAt: Date.now(),
    apiUrl,
    privateKeyJwk: privJwk,
  });

  cachedLeaderClient = new AgentClient(apiUrl, identity.agent_id, sessionId, privateKey);
  return cachedLeaderClient;
}
