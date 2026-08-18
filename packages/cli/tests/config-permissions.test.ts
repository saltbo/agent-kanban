// @vitest-environment node

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { configDir, configFile } = vi.hoisted(() => {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = join(tmpdir(), `ak-config-permissions-${randomUUID()}`);
  return { configDir: dir, configFile: join(dir, "config.json") };
});

vi.mock("../src/paths.js", () => ({
  CONFIG_DIR: configDir,
  CONFIG_FILE: configFile,
}));

const { readConfig, writeConfig } = await import("../src/config.js");

function permissionBits(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("config permissions", () => {
  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes the config directory as 0700 and config file as 0600", () => {
    writeConfig({ current: "ak.test", credentials: { "ak.test": { "api-url": "https://ak.test", "api-key": "secret" } } });

    expect(permissionBits(configDir)).toBe(0o700);
    expect(permissionBits(configFile)).toBe(0o600);
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({ current: "ak.test" });
  });

  it("repairs permissive directory/file modes while reading and migrates legacy credentials", () => {
    mkdirSync(configDir, { recursive: true, mode: 0o777 });
    writeFileSync(configFile, JSON.stringify({ "api-url": "https://legacy.test", "api-key": "legacy-secret" }), { mode: 0o666 });
    chmodSync(configDir, 0o777);
    chmodSync(configFile, 0o666);

    expect(readConfig()).toEqual({
      current: "legacy.test",
      credentials: { "legacy.test": { "api-url": "https://legacy.test", "api-key": "legacy-secret" } },
    });
    expect(permissionBits(configDir)).toBe(0o700);
    expect(permissionBits(configFile)).toBe(0o600);
  });
});
