import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import type { MachineRuntime } from "@agent-kanban/shared";
import type { Command } from "commander";
import { type AmaRunnerVersionInfo, resolveAmaRunnerBinary } from "../amaRunner.js";
import { MachineClient } from "../client/machine.js";
import { getCredentials, saveCredentials, setCurrent } from "../config.js";
import { withoutControlPlaneSecrets } from "../controlPlaneEnv.js";
import { assertDaemonDependencies } from "../daemon/preflight.js";
import { generateDeviceId } from "../device.js";
import { resolveMachineName } from "../machineName.js";
import { DAEMON_STATE_FILE, LOGS_DIR, PID_FILE, SESSIONS_DIR, STATE_DIR } from "../paths.js";
import { getAvailableProviders } from "../providers/registry.js";
import { isPidAlive } from "../session/store.js";
import { getVersion } from "../version.js";

const MAX_LOG_ARCHIVES = 5;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_POLL_INTERVAL = 10_000;
const DEFAULT_TASK_TIMEOUT = 7_200_000;
const MAX_CONCURRENT_LIMIT = 64;
const MIN_POLL_INTERVAL = 5_000;
const MAX_POLL_INTERVAL = 300_000;
const MIN_TASK_TIMEOUT = 1_000;
const MAX_TASK_TIMEOUT = 604_800_000;
const LOCAL_READY_TIMEOUT_MS = 30_000;
// Where ama-runner persists device-login credentials. AK pins this so the login
// store is deterministic, kept under AK's own state, and isolated from a
// standalone ama-runner install that may target a different origin.
const AMA_RUNNER_CREDENTIALS_FILE = join(STATE_DIR, "ama-runner-credentials.json");
const LEGACY_AMA_RUNNER_LOGIN_FILE = join(STATE_DIR, "ama-runner-login.json");
const RUNNER_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

interface DaemonState {
  providers: string[];
  maxConcurrent: number;
  apiUrl: string;
  startedAt: string;
  runtime?: "local-daemon" | "ama-runner";
  pollInterval?: number;
  taskTimeout?: number;
  runnerPath?: string;
  runnerVersion?: AmaRunnerVersionInfo | null;
  machineId?: string;
}

interface AmaRunnerOnboardingResponse {
  origin: string;
  projectId: string;
  environmentId: string;
  version?: string | null;
}

interface RegisteredMachine {
  id: string;
  name: string;
  runner?: AmaRunnerOnboardingResponse | null;
}

type RunnerMode = "local" | "ama";

function runnerMode(value: unknown): RunnerMode {
  if (value === "local" || value === "ama") return value;
  throw new Error(`Invalid runner mode "${String(value)}". Expected local or ama.`);
}

function boundedInteger(name: string, value: unknown, min: number, max: number, allowZero = false): number {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || (allowZero && parsed === 0 ? false : parsed < min) || parsed > max) {
    const range = allowZero ? `0 or ${min}-${max}` : `${min}-${max}`;
    throw new Error(`${name} must be ${range}`);
  }
  return parsed;
}

export function parseLocalDaemonOptions(opts: Record<string, unknown>): {
  maxConcurrent: number;
  pollInterval: number;
  taskTimeout: number;
} {
  return {
    maxConcurrent: boundedInteger("--max-concurrent", opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 1, MAX_CONCURRENT_LIMIT),
    pollInterval: boundedInteger("--poll-interval", opts.pollInterval ?? DEFAULT_POLL_INTERVAL, MIN_POLL_INTERVAL, MAX_POLL_INTERVAL),
    taskTimeout: boundedInteger("--task-timeout", opts.taskTimeout ?? DEFAULT_TASK_TIMEOUT, MIN_TASK_TIMEOUT, MAX_TASK_TIMEOUT, true),
  };
}

function useEnvironmentCredentials(opts: Record<string, unknown>): void {
  if (!opts.apiUrl && process.env.AK_API_URL) opts.apiUrl = process.env.AK_API_URL;
  if (!opts.apiKey && process.env.AK_API_KEY) opts.apiKey = process.env.AK_API_KEY;
}

function rotateLogs(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = join(LOGS_DIR, "daemon.log");
  if (!existsSync(logFile)) return;

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  renameSync(logFile, join(LOGS_DIR, `daemon-${timestamp}.log`));

  const archives = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("daemon-") && f.endsWith(".log"))
    .sort();

  while (archives.length > MAX_LOG_ARCHIVES) {
    unlinkSync(join(LOGS_DIR, archives.shift()!));
  }
}

function readDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  return isPidAlive(pid) ? pid : null;
}

function readDaemonState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function formatUptime(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatProviders(all: string[]): string {
  if (all.length === 0) return "none";
  return all.join(", ");
}

function maskApiUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function amaRunnerArgs(opts: Record<string, unknown>): string[] {
  const args: string[] = [];
  const add = (flag: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) args.push(flag, value);
  };
  // AK pre-authenticates the runner via ensureRunnerLogin before spawn; these
  // args only point run mode at the origin and the project/environment to join.
  add("--api-server", opts.amaOrigin);
  add("--project-id", opts.amaProjectId);
  add("--environment-id", opts.amaEnvironmentId);
  add("--max-concurrent", opts.maxConcurrent);
  // Parity with the old daemon, which always ran agent processes directly on
  // the host: AK acknowledges the unsandboxed process adapter on the user's
  // behalf instead of exposing a runner flag.
  args.push("--allow-unsafe-process");
  return args;
}

interface SavedRunnerCredentialProfile {
  accountId?: string;
  apiServer?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

interface SavedRunnerCredentialStore {
  active?: string;
  profiles?: SavedRunnerCredentialProfile[];
}

interface LegacyRunnerLogin {
  apiServer?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scope?: string;
}

function jwtSubject(token: string | undefined): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof decoded.sub === "string" && decoded.sub.trim() ? decoded.sub.trim() : null;
  } catch {
    return null;
  }
}

function migrateLegacyRunnerLogin(): void {
  if (existsSync(AMA_RUNNER_CREDENTIALS_FILE) || !existsSync(LEGACY_AMA_RUNNER_LOGIN_FILE)) return;
  let saved: LegacyRunnerLogin;
  try {
    saved = JSON.parse(readFileSync(LEGACY_AMA_RUNNER_LOGIN_FILE, "utf-8"));
  } catch {
    return;
  }
  const apiServer = saved.apiServer?.replace(/\/$/, "");
  if (!apiServer || !saved.accessToken) return;
  const accountId = jwtSubject(saved.accessToken) ?? "legacy";
  const profile: SavedRunnerCredentialProfile = {
    accountId,
    apiServer,
    accessToken: saved.accessToken,
    ...(saved.refreshToken ? { refreshToken: saved.refreshToken } : {}),
    ...(saved.expiresAt ? { expiresAt: saved.expiresAt } : {}),
  };
  const credentialStore = {
    active: `${apiServer}#${accountId}`,
    profiles: [
      {
        ...profile,
        ...(saved.tokenType ? { tokenType: saved.tokenType } : {}),
        ...(saved.scope ? { scope: saved.scope } : {}),
      },
    ],
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(AMA_RUNNER_CREDENTIALS_FILE, `${JSON.stringify(credentialStore, null, 2)}\n`, { mode: 0o600 });
}

// Mirror ama-runner's own token-validity rules: a saved login is usable when it
// targets this origin and can still produce a token (refreshable, or an
// unexpired access token). Anything else means the runner would exit demanding a
// fresh login, so AK re-runs the device flow instead.
function runnerLoginStatus(origin: string): "missing" | "valid" | "refresh" {
  migrateLegacyRunnerLogin();
  if (!existsSync(AMA_RUNNER_CREDENTIALS_FILE)) return "missing";
  let saved: SavedRunnerCredentialStore;
  try {
    saved = JSON.parse(readFileSync(AMA_RUNNER_CREDENTIALS_FILE, "utf-8"));
  } catch {
    return "missing";
  }
  const stripTrailingSlash = (value: string) => value.replace(/\/$/, "");
  const profiles = Array.isArray(saved.profiles) ? saved.profiles : [];
  const active = profiles.find((profile) => `${stripTrailingSlash(profile.apiServer ?? "")}#${profile.accountId ?? ""}` === saved.active);
  const matches = profiles.filter((profile) => stripTrailingSlash(profile.apiServer ?? "") === stripTrailingSlash(origin));
  const profile =
    active && stripTrailingSlash(active.apiServer ?? "") === stripTrailingSlash(origin) ? active : matches.length === 1 ? matches[0] : null;
  if (!profile) return "missing";
  if (profile.refreshToken) {
    if (!profile.accessToken || !profile.expiresAt) return "refresh";
    const expiresAt = Date.parse(profile.expiresAt);
    if (Number.isNaN(expiresAt)) return "refresh";
    return expiresAt > Date.now() + RUNNER_TOKEN_REFRESH_SKEW_MS ? "valid" : "refresh";
  }
  if (!profile.accessToken) return "missing";
  if (profile.expiresAt) {
    const expiresAt = Date.parse(profile.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return "missing";
  }
  return "valid";
}

// ama-runner authenticates with AMA via its own OAuth device login, a separate
// interactive step from the polling run mode. AK drives it once, foreground, so
// the user can authorize; the saved refresh token keeps later starts silent.
function ensureRunnerLogin(runnerBin: string, origin: string, env: NodeJS.ProcessEnv): void {
  const status = runnerLoginStatus(origin);
  if (status === "valid") return;
  if (status === "refresh") {
    const refreshed = spawnSync(runnerBin, ["auth", "refresh"], { stdio: "inherit", env });
    if (refreshed.error) throw new Error(`Failed to refresh ama-runner login: ${refreshed.error.message}`);
    if (refreshed.status === 0) return;
    console.error("Saved ama-runner login could not be refreshed; re-authenticating.");
    const logout = spawnSync(runnerBin, ["auth", "logout", origin], { stdio: "ignore", env });
    if (logout.error) throw new Error(`Failed to clear stale ama-runner login: ${logout.error.message}`);
  }
  mkdirSync(STATE_DIR, { recursive: true });
  console.log(`Authenticating ama-runner with AMA (${maskApiUrl(origin)})…`);
  const result = spawnSync(runnerBin, ["auth", "login", "--api-server", origin], { stdio: "inherit", env });
  if (result.error) throw new Error(`Failed to launch ama-runner login: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`ama-runner device login did not complete (exit status ${result.status}); cannot start the machine runner`);
}

function machineRuntimes(): MachineRuntime[] {
  const providers = getAvailableProviders();
  if (providers.length === 0) throw new Error("No local runtime provider is available");
  const checkedAt = new Date().toISOString();
  return providers.map((provider) => ({ name: provider.name, status: "ready", checked_at: checkedAt }));
}

async function waitForSpawn(child: ReturnType<typeof spawn>, runnerBin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    if (typeof child.once !== "function") {
      if (typeof child.pid === "number") resolve(child.pid);
      else reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
      return;
    }
    let settled = false;
    child.once("spawn", () => {
      settled = true;
      if (typeof child.pid === "number") {
        resolve(child.pid);
        return;
      }
      reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`Machine runner executable not found: ${runnerBin}`));
        return;
      }
      reject(error);
    });
  });
}

async function waitForLocalReady(child: ReturnType<typeof spawn>): Promise<{ machineId: string; pid: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let terminating = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const finish = (error: Error | null, machineId?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (typeof child.pid !== "number" || !machineId) {
        reject(new Error("Local machine runner reported readiness without a process or machine id"));
        return;
      }
      if (child.connected) child.disconnect();
      resolve({ machineId, pid: child.pid });
    };
    const onMessage = (message: unknown) => {
      const ready = message as { type?: unknown; machineId?: unknown };
      if (ready?.type === "ready" && typeof ready.machineId === "string" && ready.machineId) finish(null, ready.machineId);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminating) return;
      finish(new Error(`Local machine runner exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    };
    const timeout = setTimeout(() => {
      void (async () => {
        terminating = true;
        try {
          if (typeof child.pid === "number") await stopRunner(child.pid);
          if (child.connected) child.disconnect();
          finish(new Error(`Local machine runner did not become ready within ${LOCAL_READY_TIMEOUT_MS / 1000}s; inspect ak logs`));
        } catch (error) {
          finish(new Error(`Failed to terminate unready local machine runner: ${error instanceof Error ? error.message : String(error)}`));
        }
      })();
    }, LOCAL_READY_TIMEOUT_MS);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function startAmaRunner(opts: Record<string, unknown>) {
  const existingPid = readDaemonPid();
  if (existingPid) {
    console.error(`Runtime already running (PID ${existingPid}). Stop it first or remove ${PID_FILE}`);
    process.exit(1);
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  rotateLogs();

  const logFile = join(LOGS_DIR, "daemon.log");
  await applyAmaRunnerOnboarding(opts);
  const runner = await resolveAmaRunnerBinary(typeof opts.amaRunnerVersion === "string" ? opts.amaRunnerVersion : null);
  const env = withoutControlPlaneSecrets(process.env);
  env.AMA_RUNNER_CREDENTIALS = AMA_RUNNER_CREDENTIALS_FILE;
  // Authenticate before opening the daemon log: login is interactive and writes
  // to the terminal, while the detached runner's output belongs in the log file.
  ensureRunnerLogin(runner.path, opts.amaOrigin as string, env);
  const args = amaRunnerArgs(opts);
  const logFd = openSync(logFile, "a");
  const child = spawn(runner.path, args, { detached: true, stdio: ["ignore", logFd, logFd], env, windowsHide: true });
  let pid: number;
  try {
    pid = await waitForSpawn(child, runner.path);
  } catch (error) {
    closeSync(logFd);
    throw error;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid));
  const state: DaemonState = {
    providers: Array.isArray(opts.providers) ? (opts.providers as string[]) : [],
    maxConcurrent: parseInt(String(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT), 10),
    apiUrl: opts.apiUrl as string,
    startedAt: new Date().toISOString(),
    runtime: "ama-runner",
    runnerPath: runner.path,
    runnerVersion: runner.version,
    ...(typeof opts.machineId === "string" ? { machineId: opts.machineId } : {}),
  };
  writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
  child.unref();
  console.log(`● Machine runner started (PID ${pid}, v${getVersion()})`);
  console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
  console.log(`  Concurrency: ${state.maxConcurrent}`);
  if (state.runnerVersion?.version) console.log(`  Runner:      ${state.runnerVersion.version}`);
  console.log(`  Logs:        ${logFile}`);
}

async function registerMachine(opts: Record<string, unknown>): Promise<RegisteredMachine> {
  if (typeof opts.apiUrl !== "string" || typeof opts.apiKey !== "string") {
    throw new Error("API credentials are required to register the local machine");
  }
  const creds = { apiUrl: opts.apiUrl, apiKey: opts.apiKey };

  const runtimes = machineRuntimes();
  opts.providers = runtimes.map((runtime) => runtime.name);
  const machineResponse = await fetch(`${creds.apiUrl.replace(/\/$/, "")}/api/machines`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: resolveMachineName(),
      os: `${platform()} ${arch()} ${release()}`,
      version: getVersion(),
      runtimes,
      device_id: generateDeviceId(),
    }),
  });
  if (!machineResponse.ok) {
    throw new Error(`Machine registration failed with HTTP ${machineResponse.status}: ${await machineResponse.text()}`);
  }
  return (await machineResponse.json()) as RegisteredMachine;
}

async function applyAmaRunnerOnboarding(opts: Record<string, unknown>) {
  const machine = await registerMachine(opts);
  const onboarding = machine.runner;
  if (!onboarding) {
    throw new Error("Machine registration did not return runner onboarding details");
  }
  opts.machineId = machine.id;
  if (onboarding.version) opts.amaRunnerVersion = onboarding.version;
  opts.amaOrigin = onboarding.origin.replace(/\/$/, "");
  opts.amaProjectId = onboarding.projectId;
  opts.amaEnvironmentId = onboarding.environmentId;
}

async function startLocalDaemon(opts: Record<string, unknown>) {
  const existingPid = readDaemonPid();
  if (existingPid) {
    console.error(`Runtime already running (PID ${existingPid}). Stop it first or remove ${PID_FILE}`);
    process.exit(1);
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);

  assertDaemonDependencies();
  rotateLogs();

  const { maxConcurrent, pollInterval, taskTimeout } = parseLocalDaemonOptions(opts);
  const logFile = join(LOGS_DIR, "daemon.log");
  const logFd = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      process.argv[1],
      "__daemon",
      "--max-concurrent",
      String(maxConcurrent),
      "--poll-interval",
      String(pollInterval),
      "--task-timeout",
      String(taskTimeout),
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd, "ipc"],
      windowsHide: true,
      env: withoutControlPlaneSecrets(process.env),
    },
  );

  let ready: { machineId: string; pid: number };
  try {
    ready = await waitForLocalReady(child);
  } catch (error) {
    closeSync(logFd);
    throw error;
  }
  closeSync(logFd);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(ready.pid));
  const state: DaemonState = {
    providers: Array.isArray(opts.providers) ? (opts.providers as string[]) : machineRuntimes().map((runtime) => runtime.name),
    maxConcurrent,
    pollInterval,
    taskTimeout,
    apiUrl: opts.apiUrl as string,
    startedAt: new Date().toISOString(),
    runtime: "local-daemon",
    machineId: ready.machineId,
  };
  writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
  child.unref();

  const timeoutLabel = taskTimeout === 0 ? "none" : `${taskTimeout / 1000}s`;
  console.log(`● Local machine runner started (PID ${ready.pid}, v${getVersion()})`);
  console.log(`  Machine:     ${ready.machineId}`);
  console.log(`  Providers:   ${formatProviders(state.providers)}`);
  console.log(`  Concurrency: ${maxConcurrent}`);
  console.log(`  Poll:        ${pollInterval / 1000}s`);
  console.log(`  Timeout:     ${timeoutLabel}`);
  console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
  console.log(`  Logs:        ${logFile}`);
}

async function startRunner(mode: RunnerMode, opts: Record<string, unknown>): Promise<void> {
  if (mode === "ama") {
    opts.maxConcurrent = String(parseLocalDaemonOptions(opts).maxConcurrent);
    await startAmaRunner(opts);
    return;
  }
  await startLocalDaemon(opts);
}

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the local Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--mode <mode>", "Runner mode: local or ama", "local")
    .option("--max-concurrent <n>", `Max concurrent agents (1-${MAX_CONCURRENT_LIMIT})`, String(DEFAULT_MAX_CONCURRENT))
    .option("--poll-interval <ms>", `Local task poll interval (${MIN_POLL_INTERVAL}-${MAX_POLL_INTERVAL} ms)`, String(DEFAULT_POLL_INTERVAL))
    .option("--task-timeout <ms>", `Local task timeout (0 or ${MIN_TASK_TIMEOUT}-${MAX_TASK_TIMEOUT} ms)`, String(DEFAULT_TASK_TIMEOUT))
    .action(async (opts) => {
      useEnvironmentCredentials(opts);
      // Save or resolve credentials
      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        // Switch to existing credentials for this host
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key.");
        process.exit(1);
      }

      // Clear session cache if API URL changed. Sessions are backend-specific
      // and must not survive environment switches. Identities are now scoped
      // by api-url + machine + runtime, so they remain valid side by side.
      const prevState = readDaemonState();
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startRunner(runnerMode(opts.mode), { ...opts, apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    });
}

export function registerStopCommand(program: Command) {
  program
    .command("stop")
    .description("Stop the Machine runner")
    .action(async () => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      let uptimeStr = "";
      const state = readDaemonState();
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      }

      const forceKilled = await stopRunner(pid);
      if (forceKilled) {
        console.log(`● Machine runner force-killed (PID ${pid}, SIGTERM timed out)`);
      } else {
        console.log(`● Machine runner stopped (PID ${pid})`);
      }
      if (uptimeStr) console.log(`  Uptime: ${uptimeStr}`);
    });
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show Machine runner status")
    .action(async () => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      const state = readDaemonState();

      let uptimeStr = "";
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      } else {
        try {
          uptimeStr = formatUptime(statSync(PID_FILE).mtimeMs);
        } catch {
          /* skip */
        }
      }

      console.log(`● Machine runner running (PID ${pid}, v${getVersion()})`);
      if (uptimeStr) console.log(`  Uptime:      ${uptimeStr}`);
      if (state) {
        console.log(`  Mode:        ${state.runtime === "ama-runner" ? "ama" : "local"}`);
        const providersLabel = formatProviders(state.providers ?? []);
        console.log(`  Providers:   ${providersLabel}`);
        console.log(`  Concurrency: ${state.maxConcurrent}`);
        console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
      }

      // The runner reports to the server, not local stdout — surface its real
      // health (a live local process does not imply it is heartbeating).
      if (state?.machineId) {
        try {
          const machine = await new MachineClient().getMachine(state.machineId);
          const online = machine.status === "online";
          const heartbeat = machine.last_heartbeat_at ? ` (heartbeat ${formatUptime(new Date(machine.last_heartbeat_at).getTime())} ago)` : "";
          console.log(`  Runner:      ${online ? "●" : "○"} ${machine.status ?? "unknown"}${heartbeat}`);
          const ready = (machine.runtimes ?? []).filter((runtime) => runtime.status === "ready").map((runtime) => runtime.name);
          if (ready.length > 0) console.log(`  Runtimes:    ${ready.join(", ")}`);
        } catch (error) {
          console.log(`  Runner:      (could not reach AK API: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
    });
}

export function registerRestartCommand(program: Command) {
  program
    .command("restart")
    .description("Restart the Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--mode <mode>", "Runner mode: local or ama")
    .option("--max-concurrent <n>", `Max concurrent agents (1-${MAX_CONCURRENT_LIMIT})`)
    .option("--poll-interval <ms>", `Local task poll interval (${MIN_POLL_INTERVAL}-${MAX_POLL_INTERVAL} ms)`)
    .option("--task-timeout <ms>", `Local task timeout (0 or ${MIN_TASK_TIMEOUT}-${MAX_TASK_TIMEOUT} ms)`)
    .action(async (opts) => {
      useEnvironmentCredentials(opts);
      const prevState = readDaemonState();
      const mode = runnerMode(opts.mode ?? (prevState?.runtime === "ama-runner" ? "ama" : "local"));
      const localOptions = parseLocalDaemonOptions({
        maxConcurrent: opts.maxConcurrent ?? prevState?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        pollInterval: opts.pollInterval ?? prevState?.pollInterval ?? DEFAULT_POLL_INTERVAL,
        taskTimeout: opts.taskTimeout ?? prevState?.taskTimeout ?? DEFAULT_TASK_TIMEOUT,
      });

      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key, or run `ak start` first.");
        process.exit(1);
      }

      // Only stop a healthy runner after all replacement settings and
      // credentials have been validated. A typo must not cause an outage.
      const pid = readDaemonPid();
      if (pid) {
        const forceKilled = await stopRunner(pid);
        if (forceKilled) {
          console.log(`● Machine runner force-killed (PID ${pid})`);
        } else {
          console.log(`● Machine runner stopped (PID ${pid})`);
        }
      } else {
        console.log("○ Machine runner was not running");
      }

      // Clear session cache if API URL changed
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startRunner(mode, {
        ...opts,
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        ...localOptions,
      });
    });
}

const LOG_DIVIDER = "\n──────────────────────── daemon restarted ────────────────────────\n\n";
const FOLLOW_POLL_MS = 500;

async function stopRunner(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") throw new Error(`Cannot stop Machine runner PID ${pid}: permission denied`);
    throw error;
  }

  const deadline = Date.now() + 10_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(200);
  if (!isPidAlive(pid)) return false;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error(`Cannot force-stop Machine runner PID ${pid}: permission denied`);
    }
    throw error;
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isPidAlive(pid)) await sleep(50);
  if (isPidAlive(pid)) throw new Error(`Machine runner PID ${pid} remained alive after SIGKILL`);
  return true;
}

export function readLastLogLines(logFile: string, lineCount: number): string {
  if (!Number.isInteger(lineCount) || lineCount < 0) throw new Error("--lines must be a non-negative integer");
  if (lineCount === 0) return "";
  const fd = openSync(logFile, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= lineCount) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const count = readSync(fd, chunk, bytesRead, length - bytesRead, position + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead < length) throw new Error(`Could not read ${logFile}`);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlineCount++;
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    const trailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (trailingNewline) lines.pop();
    const selected = lines.slice(-lineCount).join("\n");
    return selected ? `${selected}${trailingNewline ? "\n" : ""}` : "";
  } finally {
    closeSync(fd);
  }
}

function followLogFile(logFile: string): void {
  let currentIdentity: string | null = null;
  let currentOffset = 0;

  // Initialise inode/offset from current file end
  try {
    const stat = statSync(logFile);
    currentIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    currentOffset = stat.size;
  } catch {
    // File may not exist yet; will pick it up on first poll
  }

  const poll = (): void => {
    try {
      const stat = statSync(logFile);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

      if (currentIdentity !== null && (identity !== currentIdentity || stat.size < currentOffset)) {
        // File was rotated — new daemon.log created
        process.stdout.write(LOG_DIVIDER);
        currentOffset = 0;
      }

      currentIdentity = identity;

      if (stat.size > currentOffset) {
        const fd = openSync(logFile, "r");
        try {
          const size = fstatSync(fd).size;
          if (size < currentOffset) {
            currentOffset = 0;
          }
          const buf = Buffer.alloc(size - currentOffset);
          let bytesRead = 0;
          while (bytesRead < buf.length) {
            const count = readSync(fd, buf, bytesRead, buf.length - bytesRead, currentOffset + bytesRead);
            if (count === 0) break;
            bytesRead += count;
          }
          if (bytesRead > 0) process.stdout.write(buf.subarray(0, bytesRead));
          currentOffset += bytesRead;
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // File temporarily absent during rotation — retry next tick
    }
  };

  const timer = setInterval(poll, FOLLOW_POLL_MS);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

export function registerLogsCommand(program: Command) {
  program
    .command("logs")
    .description("Show local runtime logs")
    .option("--lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Stream new log lines as they appear")
    .action((opts) => {
      const logFile = join(LOGS_DIR, "daemon.log");
      if (!existsSync(logFile)) {
        console.log("No daemon logs found");
        return;
      }

      if (opts.follow) {
        const lines = Number(opts.lines);
        process.stdout.write(readLastLogLines(logFile, lines));
        followLogFile(logFile);
      } else {
        process.stdout.write(readLastLogLines(logFile, Number(opts.lines)));
      }
    });
}
