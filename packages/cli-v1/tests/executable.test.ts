// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecutable } from "../src/executable.js";

const testDir = join(tmpdir(), `ak-executable-test-${randomUUID()}`);

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveExecutable", () => {
  it("resolves an executable from a later PATH entry", () => {
    const first = join(testDir, "first");
    const second = join(testDir, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const command = process.platform === "win32" ? "codex.exe" : "codex";
    const executable = join(second, command);
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveExecutable(command, { PATH: `${first}${delimiter}${second}` })).toBe(executable);
  });

  it("honors PATHEXT and resolves npm command shims on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mkdirSync(testDir, { recursive: true });
    const shim = join(testDir, "claude.cmd");
    writeFileSync(shim, "@echo off\r\n");

    expect(resolveExecutable("claude", { PATH: testDir, PATHEXT: ".EXE;.CMD" })).toBe(shim);
  });

  it("returns null when no PATHEXT candidate exists", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mkdirSync(testDir, { recursive: true });

    expect(resolveExecutable("gemini", { PATH: testDir, PATHEXT: ".EXE;.CMD" })).toBeNull();
  });
});
