// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return {
    dataDir: mkdtempSync(join(tmpdir(), "ak-skill-ak-ref-test-")),
    failInstall: false,
  };
});

vi.mock("../packages/cli/src/paths.js", () => ({ DATA_DIR: state.dataDir }));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((command: string, args: string[], options: { cwd: string }) => {
    if (command === "git") return ".git/info/exclude\n";
    if (state.failInstall) throw new Error("offline");
    const skill = args[args.indexOf("--skill") + 1];
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const installed = join(options.cwd, ".agents", "skills", skill);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "SKILL.md"), `---\nname: ${skill}\n---\n\n# installed ${skill}\n`);
    return Buffer.from("");
  }),
  execFile: vi.fn(),
}));

async function loadSkills() {
  vi.resetModules();
  return import("../packages/cli/src/workspace/skills.js");
}

function fakeClient(content: { name: string; description: string; body: string }) {
  return { getSkillContent: vi.fn(async (_name: string) => content) };
}

function failingClient(err: Error) {
  return {
    getSkillContent: vi.fn(async (_name: string) => {
      throw err;
    }),
  };
}

describe("buildAkSkillMarkdown", () => {
  it("rebuilds frontmatter with quoted scalars and a trimmed body", async () => {
    const { buildAkSkillMarkdown } = await loadSkills();
    expect(buildAkSkillMarkdown("ak-verify", "Verify work", "  # Verify\n\nDo the thing.\n\n")).toBe(
      '---\nname: "ak-verify"\ndescription: "Verify work"\n---\n\n# Verify\n\nDo the thing.\n',
    );
  });

  it("collapses a multiline description onto one line", async () => {
    const { buildAkSkillMarkdown } = await loadSkills();
    const out = buildAkSkillMarkdown("ak-plan", "Plan and execute\na project through boards", "body");
    expect(out).toContain('description: "Plan and execute a project through boards"');
    expect(out.endsWith("body\n")).toBe(true);
  });

  it("quotes special characters safely", async () => {
    const { buildAkSkillMarkdown } = await loadSkills();
    const out = buildAkSkillMarkdown("weird", 'say "hi": yes', "body");
    expect(out).toContain('description: "say \\"hi\\": yes"');
  });
});

describe("prepareSkillSnapshots with ak@ refs", () => {
  beforeEach(() => {
    rmSync(state.dataDir, { recursive: true, force: true });
    mkdirSync(state.dataDir, { recursive: true });
    state.failInstall = false;
  });

  afterAll(() => {
    rmSync(state.dataDir, { recursive: true, force: true });
  });

  it("fetches ak@ skills through the client and materializes them into the workspace", async () => {
    const { materializeSkillSnapshots, prepareSkillSnapshots } = await loadSkills();
    const client = fakeClient({ name: "my-skill", description: "My custom skill", body: "# My Skill\n\nDo custom things.\n" });

    const snapshots = await prepareSkillSnapshots(["ak@my-skill"], client);

    expect(client.getSkillContent).toHaveBeenCalledWith("my-skill");
    expect(snapshots?.map((snapshot) => ({ ref: snapshot.ref, skill: snapshot.skill }))).toEqual([
      { ref: "saltbo/agent-kanban@agent-kanban", skill: "agent-kanban" },
      { ref: "ak@my-skill", skill: "my-skill" },
    ]);

    const worktree = mkdtempSync(join(tmpdir(), "ak-ak-ref-worktree-"));
    try {
      expect(materializeSkillSnapshots(worktree, snapshots!)).toBe(true);
      for (const base of [".agents", ".claude"]) {
        const skillMd = readFileSync(join(worktree, base, "skills", "my-skill", "SKILL.md"), "utf8");
        expect(skillMd).toBe('---\nname: "my-skill"\ndescription: "My custom skill"\n---\n\n# My Skill\n\nDo custom things.\n');
      }
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("returns null when the ak@ fetch fails and no cached snapshot exists", async () => {
    const { prepareSkillSnapshots } = await loadSkills();
    const client = failingClient(new Error("API unreachable"));

    await expect(prepareSkillSnapshots(["ak@missing"], client)).resolves.toBeNull();
    expect(client.getSkillContent).toHaveBeenCalledWith("missing");
  });

  it("returns null for ak@ refs when no client is provided", async () => {
    const { prepareSkillSnapshots } = await loadSkills();

    await expect(prepareSkillSnapshots(["ak@my-skill"])).resolves.toBeNull();
  });
});
