import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { AGENT_RUNTIMES, type AgentRuntime, type MachineRuntime } from "@agent-kanban/shared";
import { MachineClient } from "../client/index.js";
import { getCredentials } from "../config.js";
import { generateDeviceId } from "../device.js";
import { createLogger } from "../logger.js";
import { resolveMachineName } from "../machineName.js";
import { PID_FILE, STATE_DIR } from "../paths.js";
import { getAvailableProviders, getProvider } from "../providers/registry.js";
import { setRuntimeSettings } from "../providers/runtimeSettingsState.js";
import { setSchedulingSettings } from "../providers/schedulingState.js";
import type { AgentProvider, HistoryEvent } from "../providers/types.js";
import { getSessionManager } from "../session/manager.js";
import { migrateLegacySessions } from "../session/store.js";
import { getVersion } from "../version.js";
import { startSkillCacheRefresh } from "../workspace/skills.js";
import { auditOrphanedTasks, cleanupLeaderSessions, cleanupStaleSessions, cleanupUntrackedWorktrees } from "./cleanup.js";
import { DaemonLoop } from "./loop.js";
import { PrMonitor } from "./prMonitor.js";
import { RateLimiter } from "./rateLimiter.js";
import { RuntimeCircuitBreaker } from "./runtimeCircuitBreaker.js";
import { isRuntimeLimitIgnored } from "./runtimeOverrides.js";
import { RuntimePool } from "./runtimePool.js";
import { TunnelClient } from "./tunnel.js";
import { UsageCollector } from "./usageCollector.js";

const logger = createLogger("daemon");

async function fetchSessionHistory(sessionId: string): Promise<HistoryEvent[]> {
  const session = getSessionManager().read(sessionId);
  if (session && !AGENT_RUNTIMES.includes(session.runtime as AgentRuntime)) {
    throw new Error(`History is unavailable for leader runtime "${session.runtime}"`);
  }
  const provider = session ? getProvider(session.runtime as AgentRuntime) : getProvider("claude");
  return provider.getHistory(sessionId, session?.providerResumeToken);
}

export interface DaemonOptions {
  maxConcurrent: number;
  pollInterval?: number;
  taskTimeout?: number;
  onReady?: (machineId: string) => void | Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<void> {
  process.on("unhandledRejection", (err: any) => {
    logger.error(`Unhandled rejection: ${err?.message ?? err}`);
  });
  const circuitBreaker = new RuntimeCircuitBreaker();

  mkdirSync(STATE_DIR, { recursive: true });

  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    logger.warn("`gh` is not authenticated — repo-based tasks will be skipped");
  }

  const client = new MachineClient();
  const availableProviders = getAvailableProviders();
  let loop: DaemonLoop;
  let sendHeartbeat: (() => Promise<void>) | null = null;
  const rateLimiter = new RateLimiter({
    onResumed: (runtime) => {
      sendHeartbeat?.().catch((e) => logger.warn(`Heartbeat failed after rate-limit resume: ${(e as Error).message}`));
      loop.resumeRateLimitedSessions(runtime).catch((e) => logger.error(`Resume error: ${(e as Error).message}`));
    },
  });

  const machineInfo = await getMachineInfo(availableProviders, rateLimiter, circuitBreaker);
  const deviceId = generateDeviceId();
  const machine = await client.registerMachine({ ...machineInfo, device_id: deviceId });
  const machineId = machine.id;
  logger.info(`Machine ready: ${machineId} (device: ${deviceId})`);

  const initialHeartbeat = await client.heartbeat(machineId, {
    version: machineInfo.version,
    runtimes: await buildRuntimeStates(availableProviders, rateLimiter, circuitBreaker),
  });
  if (initialHeartbeat && typeof initialHeartbeat === "object") {
    if ("scheduling" in initialHeartbeat) setSchedulingSettings(initialHeartbeat.scheduling);
    if ("runtime_settings" in initialHeartbeat) setRuntimeSettings(initialHeartbeat.runtime_settings);
  }
  migrateLegacySessions();
  await cleanupStaleSessions(client, machineId);
  cleanupUntrackedWorktrees();
  await auditOrphanedTasks(client, machineId);
  logger.info(`Machine online: ${machineInfo.name} (${machineInfo.os}, runtimes: ${formatRuntimeNames(machineInfo.runtimes) || "none"})`);

  const MIN_POLL_INTERVAL = 5000;
  const pollInterval = Math.max(opts.pollInterval || 10000, MIN_POLL_INTERVAL);

  const usageCollector = new UsageCollector({ providers: availableProviders });
  usageCollector.start();
  sendHeartbeat = async () => {
    const response = await client.heartbeat(machineId, {
      version: machineInfo.version,
      runtimes: await buildRuntimeStates(availableProviders, rateLimiter, circuitBreaker),
      usage_info: usageCollector.getSnapshot(),
    });
    // The server piggybacks the owner's scheduling settings (peak windows);
    // normalizeSchedulingSettings falls back to defaults on a bad payload.
    if (response && typeof response === "object" && "scheduling" in response) {
      setSchedulingSettings(response.scheduling);
    }
    if (response && typeof response === "object" && "runtime_settings" in response) {
      setRuntimeSettings(response.runtime_settings);
    }
  };

  const stopSkillCacheRefresh = startSkillCacheRefresh();

  const prMonitor = new PrMonitor(client);

  const { apiUrl, apiKey } = getCredentials();
  const tunnel = new TunnelClient(apiUrl, apiKey);
  try {
    await tunnel.connect();
  } catch (err) {
    logger.warn(`Tunnel connection failed: ${err instanceof Error ? err.message : err}`);
  }

  const pool = new RuntimePool(
    client,
    { onSlotFreed: () => loop.onSlotFreed() },
    {
      onRateLimited: async (runtime, resetAt) => {
        rateLimiter.pause(runtime, resetAt);
        await sendHeartbeat?.().catch((e) => logger.warn(`Heartbeat failed after rate limit: ${(e as Error).message}`));
      },
      onRateLimitResumed: (runtime) => rateLimiter.resumeRateLimit(runtime),
    },
    opts.taskTimeout,
    tunnel,
    circuitBreaker,
    // Earliest exhausted-window reset from the usage snapshot — schedules
    // relay quota suspensions (mid-run 403/429) for context-preserving resume.
    (runtime) =>
      usageCollector
        .getSnapshot()
        ?.windows.filter((w) => (w.runtime === runtime || w.runtime === null) && w.utilization >= 100)
        .map((w) => w.resets_at)
        .sort()[0],
  );

  tunnel.onHistoryRequest((sessionId, requestId) => {
    fetchSessionHistory(sessionId)
      .then((events) => tunnel.sendHistory(events, requestId, sessionId))
      .catch((e) => logger.warn(`History fetch failed for ${sessionId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`));
  });

  tunnel.onHumanMessage(async (sessionId, content) => {
    const delivered = await pool.sendToSession(sessionId, content);
    if (!delivered) {
      logger.warn(`Human message for session ${sessionId.slice(0, 8)} dropped: no live agent`);
    }
  });

  loop = new DaemonLoop(
    client,
    pool,
    rateLimiter,
    prMonitor,
    {
      maxConcurrent: opts.maxConcurrent,
      pollInterval,
    },
    circuitBreaker,
  );

  const heartbeatInterval = setInterval(() => {
    (async () => {
      await sendHeartbeat?.();
      await cleanupLeaderSessions(client);
    })().catch((err: any) => logger.warn(`Heartbeat failed: ${err.message}`));
  }, 30000);

  const shutdown = async () => {
    logger.info("Shutting down daemon...");
    loop.stop();
    rateLimiter.stop();
    circuitBreaker.stop();
    prMonitor.stop();
    usageCollector.stop();
    stopSkillCacheRefresh();
    clearInterval(heartbeatInterval);
    await pool.killAll();
    tunnel.disconnect();
    await cleanupLeaderSessions(client);
    removePidFile();
    logger.info("Daemon stopped.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    `Daemon started (PID ${process.pid}, v${machineInfo.version}, max_concurrent=${opts.maxConcurrent}, runtimes=${formatRuntimeNames(machineInfo.runtimes) || "none"})`,
  );

  prMonitor.start();
  loop.start();
  await opts.onReady?.(machineId);
}

function removePidFile(): void {
  try {
    if (readFileSync(PID_FILE, "utf-8").trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

async function getMachineInfo(providers: AgentProvider[], rateLimiter: RateLimiter, circuitBreaker: RuntimeCircuitBreaker) {
  const os = `${platform()} ${arch()} ${release()}`;
  const runtimes = await buildRuntimeStates(providers, rateLimiter, circuitBreaker);
  return { name: resolveMachineName(), os, version: getVersion(), runtimes };
}

async function buildRuntimeStates(
  providers: AgentProvider[],
  rateLimiter: RateLimiter,
  circuitBreaker: RuntimeCircuitBreaker,
): Promise<MachineRuntime[]> {
  const checked_at = new Date().toISOString();
  return Promise.all(
    providers.map(async (provider) => {
      const models =
        provider.name === "codex" && provider.listModels
          ? await provider.listModels().catch((err) => {
              logger.warn(`Could not read ${provider.label} model catalog: ${(err as Error).message}`);
              return [];
            })
          : [];
      const modelCatalog = models.length > 0 ? { models } : {};
      if (isRuntimeLimitIgnored(provider.name)) {
        return { name: provider.name, status: "ready", detail: "runtime limit ignored by AK_IGNORE_RUNTIME_LIMITS", ...modelCatalog, checked_at };
      }
      const reset_at = rateLimiter.pauseResetAt(provider.name);
      if (reset_at) {
        return { name: provider.name, status: "limited", detail: "runtime paused by rate limiter", reset_at, ...modelCatalog, checked_at };
      }
      if (circuitBreaker.isRuntimePaused(provider.name)) {
        return {
          name: provider.name,
          status: "limited",
          detail: "runtime paused by circuit breaker",
          reset_at: circuitBreaker.pauseResetAt(provider.name) ?? undefined,
          ...modelCatalog,
          checked_at,
        };
      }
      const availability = (await provider.checkAvailability?.()) ?? { status: "ready" };
      return { name: provider.name, ...availability, ...modelCatalog, checked_at };
    }),
  );
}

function formatRuntimeNames(runtimes: MachineRuntime[]): string {
  return runtimes.map((runtime) => `${runtime.name}:${runtime.status}`).join(",");
}
