// @vitest-environment node

// Tests for the singleton/flock behavior of service_runner.sh.
//
// SAFETY: the production Agent Kanban service runs on this machine
// (port 6265). These tests NEVER touch it:
//   - AK_PORT is set to an unused port so port checks don't couple to the
//     real service (cmd_status exits service_running && port_listening).
//   - The script derives ROOT/RUN_DIR from its own path, so each test runs a
//     copy of the script inside a fresh tmp dir with its own .run directory.
//   - Only `status` / `stop` / the `start` refusal path are exercised — never
//     a real start/restart/run (those spawn vite/pnpm).

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_SRC = join(__dirname, "../service_runner.sh");
// Unused port — must never match the real service port 6265.
const FAKE_PORT = "16265";
const TEST_TIMEOUT = 15_000;

function hasCmd(cmd: string): boolean {
  return spawnSync("bash", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

const canRun =
  process.platform === "linux" && ["bash", "flock", "setsid", "ps", "kill"].every(hasCmd);

interface Instance {
  dir: string;
  script: string;
  lock: string;
  pidFile: string;
}

const tmpDirs: string[] = [];
const fakePids: number[] = [];

function makeInstance(): Instance {
  const dir = mkdtempSync(join(tmpdir(), "ak-srvrunner-test-"));
  tmpDirs.push(dir);
  const script = join(dir, "service_runner.sh");
  copyFileSync(SCRIPT_SRC, script);
  chmodSync(script, 0o755);
  // .run is normally created by acquire_lock/cmd_start; the fake lock holder
  // needs it to exist up front.
  mkdirSync(join(dir, ".run"), { recursive: true });
  return {
    dir,
    script,
    lock: join(dir, ".run", "service.lock"),
    pidFile: join(dir, ".run", "service.pid"),
  };
}

function runScript(inst: Instance, args: string[]) {
  return spawnSync("bash", [inst.script, ...args], {
    encoding: "utf8",
    timeout: TEST_TIMEOUT,
    env: { ...process.env, AK_PORT: FAKE_PORT },
  });
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

// Spawns a fake service that holds the flock on .run/service.lock and leads
// its own process group (via setsid), mirroring the detached-service shape
// that `start` creates. Returns the pid recorded in .run/service.pid.
function startFakeService(inst: Instance): number {
  // detached: true makes the setsid child a process-group leader, so setsid
  // forks and the bash holder is reparented to init — init reaps it on death.
  // Without this, the killed holder lingers as a zombie child of this test
  // process (spawnSync blocks the event loop), kill -0 keeps succeeding, and
  // cmd_stop's death-wait loop times out.
  const child = spawn(
    "setsid",
    ["bash", "-c", 'exec 9>"$LOCK"; flock -n 9; echo $$ > "$PID"; sleep 300 9>&9; wait'],
    {
      env: { ...process.env, LOCK: inst.lock, PID: inst.pidFile },
      stdio: "ignore",
      detached: true,
    },
  );
  child.unref();

  const deadline = Date.now() + 5_000;
  while (!existsSync(inst.pidFile)) {
    if (Date.now() > deadline) {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // best effort
      }
      throw new Error("fake service did not write its pidfile in time");
    }
    spawnSync("sleep", ["0.05"]);
  }
  const pid = Number(readFileSync(inst.pidFile, "utf8").trim());
  expect(Number.isInteger(pid)).toBe(true);
  fakePids.push(pid);
  return pid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  // Kill leftover fake services (group-kill first: the `sleep 300` child
  // inherits the lock fd), then remove tmp dirs. All best-effort.
  for (const pid of fakePids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already dead
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!canRun)("service_runner.sh singleton lock", () => {
  it(
    "status exits non-zero and reports the lock not held when no instance is running",
    () => {
      const inst = makeInstance();
      const result = runScript(inst, ["status"]);
      const out = outputOf(result);

      expect(result.status).not.toBe(0);
      expect(out).toContain("service lock not held");
      expect(out).toContain(`port ${FAKE_PORT} is not listening`);
    },
    TEST_TIMEOUT,
  );

  it(
    "status reports the running pid when the lock is held and the pidfile names the holder",
    () => {
      const inst = makeInstance();
      const pid = startFakeService(inst);

      const result = runScript(inst, ["status"]);
      const out = outputOf(result);

      // Assert on output text only: the final exit code is
      // service_running && port_listening, and nothing listens on FAKE_PORT.
      expect(out).toContain(`service is running (pid ${pid}`);
      expect(out).toContain(`port ${FAKE_PORT} is not listening`);
    },
    TEST_TIMEOUT,
  );

  it(
    "start refuses to start with 'Already running' when the lock is held",
    () => {
      const inst = makeInstance();
      startFakeService(inst);

      const result = runScript(inst, ["start"]);
      const out = outputOf(result);

      // No exit-code assertion here: cmd_start's refusal branch calls
      // cmd_status, whose final `service_running && port_listening` fails
      // (nothing listens on FAKE_PORT), so `set -e` exits the script before
      // the branch's explicit `return 0` — an artifact of the artificial
      // lock-held-but-port-closed state, not of the refusal logic itself.
      expect(out).toContain("Already running");
    },
    TEST_TIMEOUT,
  );

  it(
    "stop kills the lock-holding process group, removes the pidfile, and prints 'Stopped.'",
    () => {
      const inst = makeInstance();
      const pid = startFakeService(inst);

      const result = runScript(inst, ["stop"]);
      const out = outputOf(result);

      expect(result.status).toBe(0);
      expect(out).toContain("Stopped.");
      // The script waits for pid death before returning.
      expect(pidAlive(pid)).toBe(false);
      expect(existsSync(inst.pidFile)).toBe(false);

      // Afterwards, status reports the service as not running.
      const after = runScript(inst, ["status"]);
      expect(after.status).not.toBe(0);
      expect(outputOf(after)).toContain("service lock not held");
    },
    TEST_TIMEOUT,
  );

  it(
    "stop with no lock held prints 'Not running' and exits 0",
    () => {
      const inst = makeInstance();

      const result = runScript(inst, ["stop"]);
      const out = outputOf(result);

      expect(result.status).toBe(0);
      expect(out).toContain("Not running");
      expect(out).not.toContain("Stopped.");
    },
    TEST_TIMEOUT,
  );
});
