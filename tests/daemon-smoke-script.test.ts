// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = join(__dirname, "../scripts/daemon-smoke-test.sh");

function readScript() {
  return readFileSync(scriptPath, "utf8");
}

function functionBlock(script: string, name: string) {
  const match = script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

const tempDirs: string[] = [];

function tempCodexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-smoke-model-test-"));
  tempDirs.push(dir);
  return dir;
}

function modelHarness(extra = "runtime_default_model codex") {
  const script = readScript();
  return [
    functionBlock(script, "json_query"),
    functionBlock(script, "runtime_default_model"),
    functionBlock(script, "create_agent"),
    'ak() { printf "%s\\n" "$AK_TEST_SERVER_JSON"; }',
    "TIMESTAMP=123",
    extra,
  ].join("\n");
}

function runModelHarness(env: Record<string, string>, extra?: string) {
  return spawnSync("bash", ["-c", modelHarness(extra)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runEvidenceHarness(env: Record<string, string>, timeout = 4) {
  const script = readScript();
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        functionBlock(script, "wait_subagent_evidence"),
        'SUBAGENT_TOKEN="$AK_TOKEN"',
        "ak() {",
        '  printf "%s\\n" "$*" >> "$AK_CALL_LOG"',
        '  if [ "$1 $2" = "describe task" ]; then',
        '    if [ "$AK_DESCRIBE_MODE" = "big-hit" ]; then node -e \'process.stdout.write("x".repeat(1048576) + process.env.AK_TOKEN.toLowerCase())\'; else printf "%s\\n" "$AK_DESCRIBE_OUTPUT"; fi',
        '  elif [ "$1 $2" = "get task" ]; then',
        '    printf "%s\\n" "$AK_SESSION_OUTPUT"',
        "  fi",
        "}",
        'sleep() { printf "sleep %s\\n" "$1" >> "$AK_CALL_LOG"; }',
        `wait_subagent_evidence task-test ${timeout}`,
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("daemon smoke script", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("has valid bash syntax", () => {
    execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" });
  });

  it("creates temporary agents instead of discovering reusable smoke agents", () => {
    const script = readScript();

    expect(script).toContain("Usage: ./scripts/daemon-smoke-test.sh <runtime> [board_id] [repo_id]");
    expect(script).toContain("runtime is required");
    expect(script).toContain("CREATED_AGENT_IDS=()");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain('ak delete agent "$agent_id"');
    // New runtime set includes ama and mixed
    expect(script).toContain("codex, claude, copilot, ama, or mixed");
  });

  it("supports all runtimes: codex, claude, copilot (local), ama (cloud), and mixed", () => {
    const script = readScript();

    // Case block for runtime classification
    expect(script).toContain("codex | claude | copilot) LOCAL_RUNTIME");
    expect(script).toContain('ama) CLOUD_RUNTIME="ama"');
    expect(script).toContain("mixed)");
    expect(script).toContain('LOCAL_RUNTIME="claude"');
    expect(script).toContain('CLOUD_RUNTIME="ama"');

    // runtime_default_model() maps each runtime to a model
    expect(script).toContain("runtime_default_model()");
    expect(script).toContain('ak get model --runtime "$runtime" -o json');
    expect(script).toContain('local cache="$' + '{CODEX_HOME:-$HOME/.codex}/models_cache.json"');

    // create_agent() passes --model
    expect(script).toContain("--model");
  });

  it("prefers the first server model when the catalog has values", () => {
    const codexHome = tempCodexHome();
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "cache-model", priority: 99 }] }));

    const result = runModelHarness({
      AK_TEST_SERVER_JSON: JSON.stringify([{ id: "server-model" }, { id: "server-second" }]),
      CODEX_HOME: codexHome,
      AK_SMOKE_MODEL: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("server-model");
  });

  it("prefers AK_SMOKE_MODEL over both server catalog and local cache", () => {
    const codexHome = tempCodexHome();
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "cache-model", priority: 99 }] }));

    const result = runModelHarness({
      AK_TEST_SERVER_JSON: JSON.stringify([{ id: "server-model" }]),
      CODEX_HOME: codexHome,
      AK_SMOKE_MODEL: "explicit-model",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("explicit-model");
  });

  it("falls back to the lowest-priority visible model in the local Codex cache", () => {
    const codexHome = tempCodexHome();
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "high-priority", priority: 1, visibility: "list" },
          { slug: "hidden-low", priority: 1000, visibility: "hide" },
          { slug: "lowest-visible-priority", priority: 200, visibility: "list" },
        ],
      }),
    );

    const result = runModelHarness({ AK_TEST_SERVER_JSON: JSON.stringify([]), CODEX_HOME: codexHome, AK_SMOKE_MODEL: "" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("lowest-visible-priority");
  });

  it("fails clearly before agent creation when neither catalog nor Codex cache provides a model", () => {
    const codexHome = tempCodexHome();

    const result = runModelHarness({ AK_TEST_SERVER_JSON: JSON.stringify([]), CODEX_HOME: codexHome, AK_SMOKE_MODEL: "" }, "create_agent codex");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: no model available for runtime codex");
  });

  it("uses deterministic SMOKE-SUBAGENT-OK token instead of fuzzy phrase matching", () => {
    const script = readScript();

    // Token is set from TIMESTAMP
    expect(script).toContain('SUBAGENT_TOKEN="SMOKE-SUBAGENT-OK-$TIMESTAMP"');

    // wait_subagent_evidence polls for the token in task output
    expect(script).toContain("wait_subagent_evidence()");
    expect(script).toContain("needle");
    expect(script).toContain("$SUBAGENT_TOKEN");

    // Old fuzzy helpers must not exist
    expect(script).not.toContain("task_has_subagent_evidence");
    expect(script).not.toContain("wait_subagent_file");
  });

  it("matches a token in large describe output immediately under pipefail", () => {
    const workDir = tempCodexHome();
    const callLog = join(workDir, "calls.log");
    const result = runEvidenceHarness({
      AK_CALL_LOG: callLog,
      AK_TOKEN: "SMOKE-SUBAGENT-OK-BIG",
      AK_DESCRIBE_MODE: "big-hit",
      AK_SESSION_OUTPUT: "session miss",
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(callLog, "utf8");
    expect(calls).toContain("describe task task-test -o json");
    expect(calls).not.toContain("get task");
    expect(calls).not.toContain("sleep");
  });

  it("falls back to session output when describe output has no token", () => {
    const workDir = tempCodexHome();
    const callLog = join(workDir, "calls.log");
    const result = runEvidenceHarness({
      AK_CALL_LOG: callLog,
      AK_TOKEN: "SMOKE-SUBAGENT-OK-SESSION",
      AK_DESCRIBE_MODE: "",
      AK_DESCRIBE_OUTPUT: "describe miss",
      AK_SESSION_OUTPUT: "prefix smoke-subagent-ok-session suffix",
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(callLog, "utf8");
    expect(calls).toContain("describe task task-test -o json");
    expect(calls).toContain("get task task-test --session -o json");
    expect(calls).not.toContain("sleep");
  });

  it("times out after checking both describe and session when neither contains the token", () => {
    const workDir = tempCodexHome();
    const callLog = join(workDir, "calls.log");
    const result = runEvidenceHarness(
      {
        AK_CALL_LOG: callLog,
        AK_TOKEN: "SMOKE-SUBAGENT-OK-MISSING",
        AK_DESCRIBE_MODE: "",
        AK_DESCRIBE_OUTPUT: "describe miss",
        AK_SESSION_OUTPUT: "session miss",
      },
      4,
    );

    expect(result.status).toBe(1);
    const calls = readFileSync(callLog, "utf8").trim().split("\n");
    expect(calls.filter((line) => line.startsWith("describe task"))).toHaveLength(2);
    expect(calls.filter((line) => line.startsWith("get task"))).toHaveLength(2);
    expect(calls.filter((line) => line === "sleep 2")).toHaveLength(2);
  });

  it("checks runtime-specific subagent definition paths via subagent_definition_path()", () => {
    const script = readScript();

    // New function name
    expect(script).toContain("subagent_definition_path()");

    // Correct path mappings
    expect(script).toContain('codex) echo ".codex/agents/$SUBAGENT_USERNAME.toml"');
    expect(script).toContain('claude | copilot) echo ".claude/agents/$SUBAGENT_USERNAME.md"');

    // Old variable-assignment form must not exist
    expect(script).not.toContain('codex) expected=".codex/agents/$SUBAGENT_USERNAME.toml"');
  });

  it("starts a dev sweep loop that pokes the scheduled handler every 15s for localhost", () => {
    const script = readScript();

    expect(script).toContain("start_dev_sweep_loop()");
    expect(script).toContain("/cdn-cgi/handler/scheduled");
    expect(script).toContain("sleep 15");
    expect(script).toContain("SWEEP_PID");
    // Loop is only active for localhost targets
    expect(script).toContain("http://localhost");
  });

  it("parameterizes lifecycle phases as functions", () => {
    const script = readScript();

    expect(script).toContain("run_dispatch_phase()");
    expect(script).toContain("run_reject_phase()");
    expect(script).toContain("run_complete_phase()");
    expect(script).toContain("run_cancel_phase()");
  });

  it("checks terminal runtime state by AMA session id, not task id", () => {
    const script = readScript();
    const waitSessionStopped = functionBlock(script, "wait_session_stopped");

    expect(script).toContain("task_runtime_binding()");
    expect(script).toContain('data.metadata.annotations["ama.sessionId"]');
    expect(waitSessionStopped).toContain('session_id="$(task_runtime_binding "$task_id")"');
    expect(waitSessionStopped).toContain('state="$(task_session_state "$session_id")"');
    expect(waitSessionStopped).not.toContain('task_session_state "$task_id"');
    expect(waitSessionStopped).toContain('"$state" == stopped* || "$state" == closed*');

    expect(script).toContain(
      'session still active after completion timeout (state=$(task_runtime_state "$task_id"), binding=$(task_runtime_binding "$task_id"))',
    );
    expect(script).toContain(
      'cancelled task session still active after 60s (state=$(task_runtime_state "$task_id"), binding=$(task_runtime_binding "$task_id"))',
    );
  });

  it("skips daemon check for pure ama (cloud-only) runs", () => {
    const script = readScript();

    // daemon (ak status) guard is gated on LOCAL_RUNTIME being non-empty
    expect(script).toContain('if [ -n "$LOCAL_RUNTIME" ]');
    expect(script).toContain("ak status");
    expect(script).toContain("machine runner is not running");
  });

  it("runs 2 tests for mixed mode and 4 tests for single-placement modes", () => {
    const script = readScript();

    expect(script).toContain("[Test 1/2] Parallel dispatch");
    expect(script).toContain("[Test 2/2] Complete both");
    expect(script).toContain("[Test 1/4] Dispatch");
    expect(script).toContain("[Test 2/4] Reject/Resume");
    expect(script).toContain("[Test 3/4] Complete");
    expect(script).toContain("[Test 4/4] Cancel");
  });
});
