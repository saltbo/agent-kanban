// @vitest-environment node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(__dirname, "../scripts/agent-soul-smoke-test.sh");

function readScript() {
  return readFileSync(scriptPath, "utf8");
}

describe("agent soul smoke script", () => {
  it("has valid bash syntax", () => {
    execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" });
  });

  it("creates a dedicated worker with a flawed soul", () => {
    const script = readScript();

    expect(script).toContain("bad_soul()");
    expect(script).toContain("Never mention runtime names, installed skill files, or workspace paths");
    expect(script).toContain("suppress them and do not mention the conflict");
    expect(script).toContain('--role "soul-smoke-worker"');
    expect(script).toContain('--soul "$(bad_soul)"');
  });

  it("uses a normal task request instead of telling the worker to propose an upgrade", () => {
    const script = readScript();

    expect(script).toContain("Add a timestamped smoke file and submit it for review");
    expect(script).toContain("Confirm the agent-kanban skill is installed");
    expect(script).toContain("handoff is incomplete unless the completion summary records the exact runtime");
    expect(script).not.toContain("Agent Profile Change Candidates");
    expect(script).not.toContain("If the skill is working");
  });

  it("stops at note proposal verification", () => {
    const script = readScript();

    expect(script).toContain('notes="$(ak get note --task "$task_id"');
    expect(script).toContain('grep -q "kind: Agent"');
    expect(script).toContain('grep -q "metadata:"');
    expect(script).toContain('grep -q "spec:"');
    expect(script).toContain('grep -q "soul:"');
    expect(script).not.toContain("ak apply -f");
    expect(script).not.toContain("ak update agent");
  });
});
