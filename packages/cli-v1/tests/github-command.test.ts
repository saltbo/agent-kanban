// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHomedir = vi.hoisted(() => vi.fn(() => "/tmp"));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: mockHomedir };
});

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  return {
    spawn: mockSpawn.mockImplementation(() => {
      const child: any = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }),
  };
});

const { configureGithubAuth } = await import("../src/commands/github.js");

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AK_WORKER;
  mockHomedir.mockReturnValue(tmpdir());
  mockSpawn.mockImplementation(() => {
    const child: any = new EventTarget();
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    child.stderr = { on: vi.fn() };
    child.stdin = { end: vi.fn() };
    child.on = vi.fn((event: string, callback: (value?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      if (event === "close") queueMicrotask(() => callback(0));
      return child;
    });
    return child;
  });
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
});

afterEach(() => {
  delete process.env.AK_WORKER;
  consoleLogSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe("configureGithubAuth", () => {
  it("writes isolated git and gh credentials without invoking gh auth storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-auth-"));
    try {
      await writeFile(join(home, ".git-credentials"), "https://old-token@github.com\nhttps://user:token@example.com\n");
      const calls: Array<{ file: string; args: string[]; input?: string; env?: NodeJS.ProcessEnv }> = [];
      const status = await configureGithubAuth("ghs_new_token", {
        homeDir: home,
        run: async (file, args, options) => {
          calls.push({ file, args, input: options?.input, env: options?.env });
        },
      });

      expect(status).toBe("configured");
      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe(
        "https://user:token@example.com\nhttps://x-access-token:ghs_new_token@github.com\n",
      );
      expect(await readFile(join(home, ".config", "gh", "hosts.yml"), "utf-8")).toBe(
        "github.com:\n  git_protocol: https\n  oauth_token: ghs_new_token\n  user: x-access-token\n",
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        file: "git",
        args: ["config", "--global", "credential.helper", `store --file=${join(home, ".git-credentials")}`],
      });
      expect(calls[0]?.env).toMatchObject({
        HOME: home,
        GH_CONFIG_DIR: join(home, ".config", "gh"),
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      });
      expect(calls[1]).toMatchObject({ file: "gh", args: ["--version"], input: undefined });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("still configures git credentials when gh is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-gh-missing-"));
    try {
      const status = await configureGithubAuth("ghs_git_only", {
        homeDir: home,
        run: async (file) => {
          if (file === "gh") throw new Error("not found");
        },
      });

      expect(status).toBe("missing");
      expect(await readFile(join(home, ".git-credentials"), "utf-8")).toBe("https://x-access-token:ghs_git_only@github.com\n");
      expect(await readFile(join(home, ".config", "gh", "hosts.yml"), "utf-8")).toBe(
        "github.com:\n  git_protocol: https\n  oauth_token: ghs_git_only\n  user: x-access-token\n",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
