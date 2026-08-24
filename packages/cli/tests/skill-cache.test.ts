// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return {
    dataDir: mkdtempSync(join(tmpdir(), "ak-skill-cache-test-")),
    failInstall: false,
    symlinkInstall: false,
    holdAsync: false,
    asyncSignals: [] as AbortSignal[],
    installs: [] as Array<{ source: string; skill: string; cwd: string }>,
  };
});

vi.mock("../src/paths.js", () => ({ DATA_DIR: state.dataDir }));

vi.mock("node:child_process", () => {
  const install = (args: string[], options: { cwd: string }) => {
    const source = args[2];
    const skill = args[args.indexOf("--skill") + 1];
    state.installs.push({ source, skill, cwd: options.cwd });
    if (state.failInstall) throw new Error("offline");
    const { mkdirSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const installed = join(options.cwd, ".agents", "skills", skill);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "SKILL.md"), `# ${source}@${skill}\n`);
    writeFileSync(join(installed, "asset.txt"), `asset:${skill}\n`);
    if (state.symlinkInstall) symlinkSync("asset.txt", join(installed, "linked-asset"));
  };
  return {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string }) => {
      if (command === "git") return ".git/info/exclude\n";
      install(args, options);
      return Buffer.from("");
    }),
    execFile: vi.fn(
      (
        _command: string,
        args: string[],
        options: { cwd: string; signal?: AbortSignal },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (options.signal) state.asyncSignals.push(options.signal);
        let completed = false;
        const finish = () => {
          if (completed) return;
          completed = true;
          try {
            install(args, options);
            callback(null, "", "");
          } catch (err) {
            callback(err as Error);
          }
        };
        const abort = () => {
          if (completed) return;
          completed = true;
          callback(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (!state.holdAsync) queueMicrotask(finish);
        return { kill: vi.fn() };
      },
    ),
  };
});

async function loadModules() {
  vi.resetModules();
  const [skills, settings] = await Promise.all([import("../src/workspace/skills.js"), import("../src/providers/runtimeSettingsState.js")]);
  return { ...skills, ...settings };
}

async function flushAsync() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("immutable skill cache", () => {
  beforeEach(() => {
    rmSync(state.dataDir, { recursive: true, force: true });
    mkdirSync(state.dataDir, { recursive: true });
    state.failInstall = false;
    state.symlinkInstall = false;
    state.holdAsync = false;
    state.asyncSignals.length = 0;
    state.installs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(state.dataDir, { recursive: true, force: true });
  });

  it("installs cache misses once and serves later hits without network access", async () => {
    const { prepareSkillSnapshots } = await loadModules();

    const first = await prepareSkillSnapshots(["owner/tools@review"]);
    expect(first?.map((snapshot) => snapshot.skill)).toEqual(["agent-kanban", "review"]);
    expect(state.installs).toHaveLength(2);

    state.installs.length = 0;
    const second = await prepareSkillSnapshots(["owner/tools@review"]);
    expect(second).toEqual(first);
    expect(state.installs).toHaveLength(0);
  });

  it("publishes a valid manifest atomically without leaving temp files", async () => {
    const { prepareSkillSnapshots, skillCachePaths } = await loadModules();

    expect(await prepareSkillSnapshots([])).not.toBeNull();

    const manifest = JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8"));
    expect(manifest).toMatchObject({ version: 1, entries: { "saltbo/agent-kanban@agent-kanban": expect.any(Object) } });
    expect(readdirSync(skillCachePaths.cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["invalid entries structure", { version: 1, entries: [] }],
    [
      "path-traversing content hash",
      {
        version: 1,
        entries: {
          "saltbo/agent-kanban@agent-kanban": {
            ref: "saltbo/agent-kanban@agent-kanban",
            source: "saltbo/agent-kanban",
            skill: "agent-kanban",
            contentHash: "../../outside",
            fetchedAt: 1,
            checkedAt: 1,
          },
        },
      },
    ],
  ])("ignores and rebuilds a corrupt manifest with %s", async (_case, corruptManifest) => {
    const { prepareSkillSnapshots, skillCachePaths } = await loadModules();
    await prepareSkillSnapshots([]);
    writeFileSync(skillCachePaths.manifestFile, JSON.stringify(corruptManifest));
    state.installs.length = 0;

    const rebuilt = await prepareSkillSnapshots([]);

    expect(rebuilt).toHaveLength(1);
    expect(state.installs).toHaveLength(1);
    expect(rebuilt?.[0].objectDir.startsWith(skillCachePaths.objectsDir)).toBe(true);
    expect(existsSync(join(state.dataDir, "outside"))).toBe(false);
  });

  it("keeps a valid last-known-good entry when a malformed sibling poisons the manifest", async () => {
    const { prepareSkillSnapshots, skillCachePaths } = await loadModules();
    const original = (await prepareSkillSnapshots([]))!;
    const manifest = JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8"));
    manifest.entries["attacker/repo@poison"] = {
      ref: "attacker/repo@poison",
      source: "different/repo",
      skill: "../escape",
      contentHash: "../../outside",
      fetchedAt: "never",
      checkedAt: null,
    };
    writeFileSync(skillCachePaths.manifestFile, JSON.stringify(manifest));
    state.installs.length = 0;
    state.failInstall = true;

    const offline = await prepareSkillSnapshots([]);

    expect(offline).toEqual(original);
    expect(state.installs).toHaveLength(0);
    expect(readFileSync(join(offline![0].objectDir, "SKILL.md"), "utf8")).toContain("agent-kanban");
  });

  it("rebuilds a cached object when its contents no longer match its hash", async () => {
    const { prepareSkillSnapshots } = await loadModules();
    const original = (await prepareSkillSnapshots([]))!;
    writeFileSync(join(original[0].objectDir, "SKILL.md"), "tampered\n");
    state.installs.length = 0;

    const rebuilt = await prepareSkillSnapshots([]);

    expect(state.installs).toHaveLength(1);
    expect(rebuilt).toHaveLength(1);
    expect(readFileSync(join(rebuilt![0].objectDir, "SKILL.md"), "utf8")).not.toBe("tampered\n");
  });

  it("rejects installer output containing symlinks without publishing it", async () => {
    const { prepareSkillSnapshots, skillCachePaths } = await loadModules();
    state.symlinkInstall = true;

    await expect(prepareSkillSnapshots([])).resolves.toBeNull();
    expect(existsSync(skillCachePaths.manifestFile)).toBe(false);
    expect(readdirSync(skillCachePaths.objectsDir)).toEqual([]);
  });

  it.each(["owner/repo@.", "owner/repo@..", "owner/repo@../escape"])("treats dangerous skill name %s as a zero-write failure", async (ref) => {
    const { prepareSkillSnapshots, skillCachePaths } = await loadModules();

    await expect(prepareSkillSnapshots([ref])).resolves.toBeNull();
    expect(state.installs).toHaveLength(0);
    expect(existsSync(skillCachePaths.cacheDir)).toBe(false);
    expect(existsSync(join(state.dataDir, "escape"))).toBe(false);
  });

  it("materializes independent copies into universal and Claude skill directories", async () => {
    const { materializeSkillSnapshots, prepareSkillSnapshots } = await loadModules();
    const snapshots = (await prepareSkillSnapshots([]))!;
    const workspace = mkdtempSync(join(tmpdir(), "ak-skill-workspace-"));
    try {
      mkdirSync(join(workspace, ".git", "info"), { recursive: true });
      writeFileSync(join(workspace, ".gitignore"), "tracked-rule\n");
      writeFileSync(join(workspace, ".git", "info", "exclude"), "existing-rule\n");
      expect(materializeSkillSnapshots(workspace, snapshots)).toBe(true);
      const universal = join(workspace, ".agents", "skills", "agent-kanban", "SKILL.md");
      const claude = join(workspace, ".claude", "skills", "agent-kanban", "SKILL.md");
      expect(readFileSync(universal, "utf8")).toContain("agent-kanban");
      expect(readFileSync(claude, "utf8")).toContain("agent-kanban");

      writeFileSync(universal, "workspace mutation");
      expect(readFileSync(`${snapshots[0].objectDir}/SKILL.md`, "utf8")).toContain("agent-kanban");
      expect(readFileSync(claude, "utf8")).not.toBe("workspace mutation");
      expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe("tracked-rule\n");
      const exclude = readFileSync(join(workspace, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain(".claude/skills/");
      expect(exclude).toContain(".agents/");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the last-known-good object and manifest when refresh fails", async () => {
    const { prepareSkillSnapshots, setRuntimeSettings, skillCachePaths, startSkillCacheRefresh } = await loadModules();
    const original = (await prepareSkillSnapshots([]))!;
    const manifest = JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8"));
    manifest.entries[original[0].ref].checkedAt = 0;
    writeFileSync(skillCachePaths.manifestFile, JSON.stringify(manifest));
    state.installs.length = 0;
    state.failInstall = true;
    setRuntimeSettings({ skill_cache_auto_update: true, skill_cache_refresh_hours: 1 });

    const stop = startSkillCacheRefresh();
    await flushAsync();
    stop();

    expect(state.installs).toHaveLength(1);
    expect(existsSync(join(original[0].objectDir, "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8")).entries[original[0].ref].contentHash).toBe(original[0].contentHash);
    expect((await prepareSkillSnapshots([]))?.[0].contentHash).toBe(original[0].contentHash);
  });

  it("honors the auto-update switch", async () => {
    const { prepareSkillSnapshots, setRuntimeSettings, skillCachePaths, startSkillCacheRefresh } = await loadModules();
    const snapshots = (await prepareSkillSnapshots([]))!;
    const manifest = JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8"));
    manifest.entries[snapshots[0].ref].checkedAt = 0;
    writeFileSync(skillCachePaths.manifestFile, JSON.stringify(manifest));
    state.installs.length = 0;
    setRuntimeSettings({ skill_cache_auto_update: false, skill_cache_refresh_hours: 1 });

    const stop = startSkillCacheRefresh();
    await flushAsync();
    stop();

    expect(state.installs).toHaveLength(0);
  });

  it("refreshes stale entries on the configured hourly check and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    const { prepareSkillSnapshots, setRuntimeSettings, startSkillCacheRefresh } = await loadModules();
    await prepareSkillSnapshots([]);
    state.installs.length = 0;
    setRuntimeSettings({ skill_cache_auto_update: true, skill_cache_refresh_hours: 1 });

    const stop = startSkillCacheRefresh();
    await flushAsync();
    expect(state.installs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(state.installs).toHaveLength(1);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(state.installs).toHaveLength(1);
  });

  it("keeps background refresh asynchronous and aborts an in-flight installer when stopped", async () => {
    const { prepareSkillSnapshots, setRuntimeSettings, skillCachePaths, startSkillCacheRefresh } = await loadModules();
    const snapshots = (await prepareSkillSnapshots([]))!;
    const manifest = JSON.parse(readFileSync(skillCachePaths.manifestFile, "utf8"));
    manifest.entries[snapshots[0].ref].checkedAt = 0;
    writeFileSync(skillCachePaths.manifestFile, JSON.stringify(manifest));
    state.installs.length = 0;
    state.holdAsync = true;
    setRuntimeSettings({ skill_cache_auto_update: true, skill_cache_refresh_hours: 1 });

    let eventLoopProgressed = false;
    const stop = startSkillCacheRefresh();
    queueMicrotask(() => {
      eventLoopProgressed = true;
    });
    await flushAsync();

    expect(eventLoopProgressed).toBe(true);
    expect(state.asyncSignals).toHaveLength(1);
    expect(state.asyncSignals[0].aborted).toBe(false);
    stop();
    expect(state.asyncSignals[0].aborted).toBe(true);
    await flushAsync();
    expect(state.installs).toHaveLength(0);
  });
});
