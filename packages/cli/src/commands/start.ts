import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { getCredentials, setCurrent } from "../config.js";
import { generateDeviceId } from "../device.js";
import { resolveMachineName } from "../machineName.js";
import { DAEMON_STATE_FILE, LOGS_DIR, PID_FILE, SESSIONS_DIR, STATE_DIR } from "../paths.js";
import { getAvailableProviders } from "../providers/registry.js";
import { isPidAlive } from "../session/store.js";
import { getVersion } from "../version.js";

const MAX_LOG_ARCHIVES = 5;
const DEFAULT_MAX_CONCURRENT = 5;
// Where ama-runner persists Context-login credentials. AK pins this so the login
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
  runtime?: "ama-runner";
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

function runnerContextLoginMarker(origin: string): string {
  const canonicalOrigin = origin.replace(/\/$/, "");
  const originHash = createHash("sha256").update(canonicalOrigin).digest("hex").slice(0, 32);
  return join(STATE_DIR, `ama-runner-context-login-${originHash}-v1`);
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
// fresh login, so AK re-runs the interactive login instead.
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

// ama-runner authenticates with AMA via its own OAuth Context login, a separate
// interactive step from the polling run mode. AK drives it once, foreground, so
// the user can authorize; the saved refresh token keeps later starts silent.
function ensureRunnerLogin(runnerBin: string, origin: string, env: NodeJS.ProcessEnv): void {
  const contextLoginMarker = runnerContextLoginMarker(origin);
  if (!existsSync(contextLoginMarker) && existsSync(AMA_RUNNER_CREDENTIALS_FILE)) {
    const logout = spawnSync(runnerBin, ["auth", "logout", origin], { stdio: "ignore", env });
    if (logout.error) throw new Error(`Failed to clear pre-Context ama-runner login: ${logout.error.message}`);
    if (logout.status !== 0) throw new Error(`Failed to clear pre-Context ama-runner login (exit status ${logout.status})`);
  }
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
  if (result.status !== 0) throw new Error(`ama-runner login did not complete (exit status ${result.status}); cannot start the machine runner`);
  writeFileSync(contextLoginMarker, "authorization-code-pkce\n", { mode: 0o600 });
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
  const env = { ...process.env };
  delete env.AMA_TOKEN;
  delete env.AMA_RUNNER_CONFIG;
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
  } finally {
    closeSync(logFd);
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

async function applyAmaRunnerOnboarding(opts: Record<string, unknown>) {
  if (typeof opts.apiUrl !== "string") throw new Error("A Realmroot-authenticated AK environment is required");

  const runtimes = machineRuntimes();
  opts.providers = runtimes.map((runtime) => runtime.name);
  const machine = (await new MachineClient().registerMachine({
    name: resolveMachineName(),
    os: `${platform()} ${arch()} ${release()}`,
    version: getVersion(),
    runtimes,
    device_id: generateDeviceId(),
  })) as RegisteredMachine;
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

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--max-concurrent <n>", "Max concurrent agents", String(DEFAULT_MAX_CONCURRENT))
    .action(async (opts) => {
      // Save or resolve credentials
      if (opts.apiUrl) {
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No Realmroot login for ${opts.apiUrl}. Run ak auth login --api-url ${opts.apiUrl}.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("Realmroot login required. Run ak auth login --api-url <url>.");
        process.exit(1);
      }

      // Clear session cache if API URL changed. Sessions are backend-specific
      // and must not survive environment switches. Identities are now scoped
      // by api-url + machine + runtime, so they remain valid side by side.
      const prevState = readDaemonState();
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startAmaRunner({ ...opts, apiUrl: creds.apiUrl });
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
        const providersLabel = formatProviders(state.providers ?? []);
        console.log(`  Providers:   ${providersLabel}`);
        console.log(`  Concurrency: ${state.maxConcurrent}`);
        console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
      }

      // The runner reports to the server, not local stdout — surface its real
      // health (a live local process does not imply it is heartbeating).
      if (state?.runtime === "ama-runner" && state.machineId) {
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
    .option("--max-concurrent <n>", "Max concurrent agents")
    .action(async (opts) => {
      const prevState = readDaemonState();

      // Stop existing runtime if running
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

      if (opts.apiUrl) {
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No Realmroot login for ${opts.apiUrl}. Run ak auth login --api-url ${opts.apiUrl}.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("Realmroot login required. Run ak auth login --api-url <url>.");
        process.exit(1);
      }

      // Clear session cache if API URL changed
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startAmaRunner({
        ...opts,
        apiUrl: creds.apiUrl,
        maxConcurrent: opts.maxConcurrent ?? String(prevState?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
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
