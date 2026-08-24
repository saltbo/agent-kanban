import {
  AGENT_RUNTIMES,
  AGENT_STATUSES,
  DEFAULT_RUNTIME_SETTINGS,
  DEFAULT_SCHEDULING_SETTINGS,
  deriveUsername,
  findInvalidSkillRef,
  generateWorktreeName,
  isValidSkillRef,
  isValidTimezone,
  isValidUsername,
  isValidWorktreeName,
  LEADER_AGENT_RUNTIMES,
  normalizeRuntimeSettings,
  normalizeSchedulingSettings,
  PRIORITIES,
  parseWorktreeConfig,
  RUNTIME_LABELS,
  STALE_TIMEOUT_MS,
  TASK_ACTIONS,
  toMinutes,
  validateRuntimeSettings,
  validateSchedulingSettings,
} from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";

describe("isValidUsername", () => {
  it("accepts lowercase alphanumeric", () => {
    expect(isValidUsername("alice")).toBe(true);
  });

  it("accepts single character", () => {
    expect(isValidUsername("a")).toBe(true);
  });

  it("accepts hyphens in the middle", () => {
    expect(isValidUsername("my-agent")).toBe(true);
    expect(isValidUsername("my-cool-agent")).toBe(true);
  });

  it("rejects leading hyphen", () => {
    expect(isValidUsername("-agent")).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(isValidUsername("agent-")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(isValidUsername("my agent")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isValidUsername("MyAgent")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidUsername("agent@email")).toBe(false);
    expect(isValidUsername("agent.bot")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUsername("")).toBe(false);
  });
});

describe("deriveUsername", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(deriveUsername("My Agent")).toBe("my-agent");
  });

  it("strips non-alphanumeric characters", () => {
    expect(deriveUsername("Agent #1!")).toBe("agent-1");
  });

  it("strips leading and trailing hyphens", () => {
    expect(deriveUsername(" Agent ")).toBe("agent");
  });

  it("falls back to 'agent' for empty result", () => {
    expect(deriveUsername("!!!")).toBe("agent");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    expect(deriveUsername(long).length).toBeLessThanOrEqual(40);
  });
});

describe("isValidSkillRef", () => {
  it("accepts installable owner/repo[#ref]@skill-name refs", () => {
    expect(isValidSkillRef("trailofbits/skills@differential-review")).toBe(true);
    expect(isValidSkillRef("obra/superpowers@verification-before-completion")).toBe(true);
    expect(isValidSkillRef("saltbo/agent-kanban#feature/maintainer@ak-maintainer")).toBe(true);
  });

  it("rejects short names and malformed refs", () => {
    expect(isValidSkillRef("agent-kanban")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills@")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills@bad skill")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills#@bad")).toBe(false);
    expect(isValidSkillRef("owner/repo@.")).toBe(false);
    expect(isValidSkillRef("owner/repo@..")).toBe(false);
    expect(isValidSkillRef("owner/repo@../escape")).toBe(false);
  });

  it("returns the first invalid skill ref", () => {
    expect(findInvalidSkillRef(["owner/repo@good", "browse", "other/repo@good"])).toBe("browse");
    expect(findInvalidSkillRef(["owner/repo@good"])).toBeNull();
  });
});

describe("shared constants", () => {
  it("TASK_ACTIONS includes all v2 actions", () => {
    expect(TASK_ACTIONS).toContain("assigned");
    expect(TASK_ACTIONS).toContain("released");
    expect(TASK_ACTIONS).toContain("timed_out");
  });

  it("AGENT_STATUSES has online, offline", () => {
    expect(AGENT_STATUSES).toEqual(["online", "offline"]);
  });

  it("STALE_TIMEOUT_MS is 24 hours", () => {
    expect(STALE_TIMEOUT_MS).toBe(86400000);
  });

  it("PRIORITIES has 4 levels", () => {
    expect(PRIORITIES).toHaveLength(4);
    expect(PRIORITIES).toContain("urgent");
  });

  it("keeps worker runtimes separate from the broader leader runtime set", () => {
    expect(AGENT_RUNTIMES).toEqual(["claude", "codex", "gemini", "copilot", "hermes", "ama"]);
    expect(LEADER_AGENT_RUNTIMES).toEqual([
      "claude",
      "codex",
      "gemini",
      "copilot",
      "hermes",
      "antigravity",
      "opencode",
      "cursor",
      "qwen",
      "goose",
      "amp",
      "kiro",
      "pi",
    ]);
    expect(LEADER_AGENT_RUNTIMES).not.toContain("ama");
  });

  it("defines display labels for every supported runtime", () => {
    expect(Object.keys(RUNTIME_LABELS).sort()).toEqual([...new Set([...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES])].sort());
    expect(RUNTIME_LABELS).toMatchObject({
      antigravity: "Antigravity CLI",
      opencode: "OpenCode",
      cursor: "Cursor CLI",
      qwen: "Qwen Code",
      goose: "Goose",
      amp: "Amp",
      kiro: "Kiro CLI",
      pi: "Pi Agent",
    });
  });
});

describe("parseWorktreeConfig", () => {
  it("defaults to enabled for null/undefined/missing metadata", () => {
    expect(parseWorktreeConfig(null)).toEqual({ enabled: true });
    expect(parseWorktreeConfig(undefined)).toEqual({ enabled: true });
    expect(parseWorktreeConfig({})).toEqual({ enabled: true });
    expect(parseWorktreeConfig({ annotations: { notes: "x" } })).toEqual({ enabled: true });
  });

  it("defaults to enabled for non-object metadata", () => {
    expect(parseWorktreeConfig("worktree")).toEqual({ enabled: true });
    expect(parseWorktreeConfig(42)).toEqual({ enabled: true });
    expect(parseWorktreeConfig([{ worktree: { enabled: false } }])).toEqual({ enabled: true });
  });

  it("defaults to enabled when the worktree key is not an object", () => {
    expect(parseWorktreeConfig({ worktree: "yes" })).toEqual({ enabled: true });
    expect(parseWorktreeConfig({ worktree: false })).toEqual({ enabled: true });
    expect(parseWorktreeConfig({ worktree: [{ enabled: false }] })).toEqual({ enabled: true });
  });

  it("reads enabled: false", () => {
    expect(parseWorktreeConfig({ worktree: { enabled: false } })).toEqual({ enabled: false, name: undefined });
  });

  it("reads a valid custom name", () => {
    expect(parseWorktreeConfig({ worktree: { enabled: true, name: "my-branch" } })).toEqual({ enabled: true, name: "my-branch" });
  });

  it("treats an invalid name as absent", () => {
    expect(parseWorktreeConfig({ worktree: { enabled: true, name: "-bad" } })).toEqual({ enabled: true, name: undefined });
    expect(parseWorktreeConfig({ worktree: { enabled: false, name: "has space" } })).toEqual({ enabled: false, name: undefined });
    expect(parseWorktreeConfig({ worktree: { name: 123 } })).toEqual({ enabled: true, name: undefined });
  });

  it("treats any enabled value other than false as enabled", () => {
    expect(parseWorktreeConfig({ worktree: { enabled: "yes" } }).enabled).toBe(true);
    expect(parseWorktreeConfig({ worktree: {} }).enabled).toBe(true);
  });
});

describe("isValidWorktreeName", () => {
  it("accepts a single alphanumeric character", () => {
    expect(isValidWorktreeName("a")).toBe(true);
    expect(isValidWorktreeName("7")).toBe(true);
  });

  it("accepts 41 characters (the maximum)", () => {
    expect(isValidWorktreeName("a".repeat(41))).toBe(true);
  });

  it("rejects 42 characters", () => {
    expect(isValidWorktreeName("a".repeat(42))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidWorktreeName("")).toBe(false);
  });

  it("accepts hyphens and underscores after the first character", () => {
    expect(isValidWorktreeName("my-branch_name2")).toBe(true);
  });

  it("rejects a leading hyphen or underscore", () => {
    expect(isValidWorktreeName("-bad")).toBe(false);
    expect(isValidWorktreeName("_bad")).toBe(false);
  });

  it("rejects spaces and dots", () => {
    expect(isValidWorktreeName("has space")).toBe(false);
    expect(isValidWorktreeName("has.dot")).toBe(false);
  });
});

describe("generateWorktreeName", () => {
  it("produces ak-<word>-<word>-<hex4> with an injected rand", () => {
    // rand() = 0 → first adjective, first noun, suffix 0000.
    expect(generateWorktreeName(() => 0)).toBe("ak-amber-atlas-0000");
  });

  it("uses each rand call for adjective, noun, then suffix", () => {
    const rolls = [0.05, 0.95, 0.5];
    let i = 0;
    const name = generateWorktreeName(() => rolls[i++]);
    // 0.05 * 20 = 1 → "brisk"; 0.95 * 20 = 19 → "tundra"; 0.5 * 0xffff = 32767 → "7fff"
    expect(name).toBe("ak-brisk-tundra-7fff");
  });

  it("output passes isValidWorktreeName across the rand range", () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const name = generateWorktreeName(() => roll);
      expect(name).toMatch(/^ak-[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      expect(isValidWorktreeName(name)).toBe(true);
    }
  });

  it("pads short hex suffixes to four characters", () => {
    // floor(0.001 * 0xffff) = 65 → "41" → padded "0041"
    expect(generateWorktreeName(() => 0.001)).toBe("ak-amber-atlas-0041");
  });
});

describe("validateSchedulingSettings", () => {
  it("accepts the defaults", () => {
    expect(validateSchedulingSettings(DEFAULT_SCHEDULING_SETTINGS)).toBeNull();
  });

  it("accepts empty peak windows", () => {
    expect(validateSchedulingSettings({ peak_windows: [], timezone: "UTC" })).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(validateSchedulingSettings(null)).toBe("settings must be an object");
    expect(validateSchedulingSettings(undefined)).toBe("settings must be an object");
    expect(validateSchedulingSettings("settings")).toBe("settings must be an object");
  });

  it("rejects an invalid timezone", () => {
    const err = validateSchedulingSettings({ peak_windows: [], timezone: "Mars/Olympus_Mons" });
    expect(err).toBe("timezone must be a valid IANA name");
  });

  it("rejects a missing timezone", () => {
    expect(validateSchedulingSettings({ peak_windows: [] })).toBe("timezone must be a valid IANA name");
  });

  it("rejects non-array peak_windows", () => {
    expect(validateSchedulingSettings({ peak_windows: "09:00-12:00", timezone: "UTC" })).toBe("peak_windows must be an array");
  });

  it("rejects malformed HH:MM times", () => {
    for (const w of [
      { start: "9:00", end: "12:00" }, // missing leading zero
      { start: "09:00", end: "24:00" }, // hour out of range
      { start: "09:60", end: "12:00" }, // minute out of range
      { start: 900, end: "12:00" }, // non-string
    ]) {
      expect(validateSchedulingSettings({ peak_windows: [w], timezone: "UTC" })).toMatch(/invalid (start|end) time/);
    }
  });

  it("rejects a window whose start is not before its end", () => {
    const err = validateSchedulingSettings({ peak_windows: [{ start: "12:00", end: "09:00" }], timezone: "UTC" });
    expect(err).toContain("must start before it ends");
    expect(validateSchedulingSettings({ peak_windows: [{ start: "09:00", end: "09:00" }], timezone: "UTC" })).toContain("must start before it ends");
  });

  it("rejects overlapping windows", () => {
    const err = validateSchedulingSettings({
      peak_windows: [
        { start: "11:00", end: "13:00" },
        { start: "09:00", end: "12:00" },
      ],
      timezone: "UTC",
    });
    expect(err).toBe("peak windows must not overlap");
  });

  it("accepts adjacent (touching) windows", () => {
    expect(
      validateSchedulingSettings({
        peak_windows: [
          { start: "09:00", end: "12:00" },
          { start: "12:00", end: "14:00" },
        ],
        timezone: "UTC",
      }),
    ).toBeNull();
  });

  it("rejects non-object window entries", () => {
    expect(validateSchedulingSettings({ peak_windows: ["09:00-12:00"], timezone: "UTC" })).toBe("each peak window must be an object");
  });
});

describe("runtime settings", () => {
  it("accepts the defaults and valid boundary values", () => {
    expect(validateRuntimeSettings(DEFAULT_RUNTIME_SETTINGS)).toBeNull();
    expect(validateRuntimeSettings({ skill_cache_auto_update: false, skill_cache_refresh_hours: 1 })).toBeNull();
    expect(validateRuntimeSettings({ skill_cache_auto_update: true, skill_cache_refresh_hours: 168 })).toBeNull();
  });

  it.each([
    [null, "settings must be an object"],
    [[], "settings must be an object"],
    [{ skill_cache_auto_update: "yes", skill_cache_refresh_hours: 24 }, "skill_cache_auto_update must be a boolean"],
    [{ skill_cache_auto_update: true, skill_cache_refresh_hours: 1.5 }, "skill_cache_refresh_hours must be a whole number"],
    [{ skill_cache_auto_update: true, skill_cache_refresh_hours: 0 }, "skill_cache_refresh_hours must be between 1 and 168"],
    [{ skill_cache_auto_update: true, skill_cache_refresh_hours: 169 }, "skill_cache_refresh_hours must be between 1 and 168"],
  ])("rejects invalid runtime settings %#", (raw, message) => {
    expect(validateRuntimeSettings(raw)).toBe(message);
  });

  it("normalizes valid input to a detached value", () => {
    const raw = { skill_cache_auto_update: false, skill_cache_refresh_hours: 72 };
    const normalized = normalizeRuntimeSettings(raw);
    expect(normalized).toEqual(raw);
    expect(normalized).not.toBe(raw);
  });

  it("normalizes malformed input to a detached defaults object", () => {
    const normalized = normalizeRuntimeSettings({ skill_cache_auto_update: true, skill_cache_refresh_hours: -1 });
    expect(normalized).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(normalized).not.toBe(DEFAULT_RUNTIME_SETTINGS);
  });
});

describe("normalizeSchedulingSettings", () => {
  it("falls back to defaults for invalid input", () => {
    expect(normalizeSchedulingSettings(null)).toEqual(DEFAULT_SCHEDULING_SETTINGS);
    expect(normalizeSchedulingSettings("garbage")).toEqual(DEFAULT_SCHEDULING_SETTINGS);
    expect(normalizeSchedulingSettings({ peak_windows: [{ start: "12:00", end: "09:00" }], timezone: "UTC" })).toEqual(DEFAULT_SCHEDULING_SETTINGS);
    expect(normalizeSchedulingSettings({ peak_windows: [], timezone: "Not/AZone" })).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });

  it("preserves valid input", () => {
    const input = { peak_windows: [{ start: "10:00", end: "11:30" }], timezone: "Europe/London" };
    expect(normalizeSchedulingSettings(input)).toEqual(input);
  });

  it("returns a copy, not the input's window objects", () => {
    const input = { peak_windows: [{ start: "10:00", end: "11:30" }], timezone: "Europe/London" };
    const out = normalizeSchedulingSettings(input);
    expect(out.peak_windows[0]).not.toBe(input.peak_windows[0]);
  });
});

describe("isValidTimezone / toMinutes", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("toMinutes converts HH:MM to minutes since midnight", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("09:30")).toBe(570);
    expect(toMinutes("23:59")).toBe(1439);
  });
});
