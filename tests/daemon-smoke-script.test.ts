// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(__dirname, "../scripts/daemon-smoke-test.sh");

function readScript() {
  return readFileSync(scriptPath, "utf8");
}

function functionBlock(script: string, name: string) {
  const match = script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("daemon smoke script", () => {
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
    // codex queries the server for declared models and picks the first one
    expect(script).toContain('codex) run_json_query "data[0]?.id" ak get model --runtime "$runtime" -o json');
    // ama queries the server dynamically (no hardcoded model id)
    expect(script).toContain('ama) run_json_query "data[0]?.id" ak get model --runtime "$runtime" -o json');
    expect(script).toContain("opus");

    // create_agent() passes --model
    expect(script).toContain("--model");
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

  it.each(["board", "repo", "model"])("fails fast with the original ak error when %s discovery fails", (failedResource) => {
    const fakeBin = mkdtempSync(join(tmpdir(), "ak-daemon-smoke-discovery-"));
    const callLog = join(fakeBin, "calls.log");
    const fakeAk = join(fakeBin, "ak");
    writeFileSync(
      fakeAk,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${callLog}"
resource="\${2:-}"
if [ "$1" = "get" ] && [ "$resource" = "${failedResource}" ]; then
  echo "${failedResource} discovery failed upstream" >&2
  exit 42
fi
case "$1 $resource" in
  "get board") printf '%s\\n' '[{"id":"board-1","name":"Demo","type":"dev"}]' ;;
  "get repo") printf '%s\\n' '[{"id":"repo-1","name":"slink"}]' ;;
  "get model") printf '%s\\n' '[{"id":"model-1"}]' ;;
  *) echo "unexpected continuation: $*" >&2; exit 97 ;;
esac
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [scriptPath, "codex"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${failedResource} discovery failed upstream`);
      expect(result.stderr).not.toMatch(/JSON\.parse|Unexpected end of JSON input|SyntaxError/);
      const calls = readFileSync(callLog, "utf8").trim().split("\n");
      expect(calls.at(-1)).toMatch(new RegExp(`^get ${failedResource}(?: |$)`));
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
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
