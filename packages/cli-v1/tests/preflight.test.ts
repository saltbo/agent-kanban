// @vitest-environment node
/**
 * Unit tests for checkDaemonDependencies() and assertDaemonDependencies().
 *
 * resolveExecutable and getAvailableProviders are mocked so tests never touch the real
 * filesystem or PATH — they control exactly which binaries appear present.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock executable resolution BEFORE importing the module under test ──────────
vi.mock("../src/executable.js", () => ({
  resolveExecutable: vi.fn(),
}));

// ── Mock node:os so we can control the platform branch in hintFor() ───────────
vi.mock("node:os", () => ({
  platform: vi.fn().mockReturnValue("darwin"),
}));

// ── Mock the providers registry ───────────────────────────────────────────────
vi.mock("../src/providers/registry.js", () => ({
  getAvailableProviders: vi.fn(),
}));

// ── Import mocks and module under test AFTER vi.mock declarations ─────────────
import { platform } from "node:os";
import { assertDaemonDependencies, checkDaemonDependencies } from "../src/daemon/preflight.js";
import { resolveExecutable } from "../src/executable.js";
import { getAvailableProviders } from "../src/providers/registry.js";

const mockPlatform = vi.mocked(platform);

const mockResolveExecutable = vi.mocked(resolveExecutable);
const mockGetAvailableProviders = vi.mocked(getAvailableProviders);

/** Make every dependency resolve by default. */
function allBinariesPresent() {
  mockResolveExecutable.mockImplementation((command) => `/usr/bin/${command}`);
}

/** Make one command fail resolution. */
function missingBinary(missing: string) {
  mockResolveExecutable.mockImplementation((command) => (command === missing ? null : `/usr/bin/${command}`));
}

/** Make multiple commands fail resolution. */
function missingBinaries(...missing: string[]) {
  mockResolveExecutable.mockImplementation((command) => (missing.includes(command) ? null : `/usr/bin/${command}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all binaries present, one runtime available
  allBinariesPresent();
  mockGetAvailableProviders.mockReturnValue([{ name: "claude" } as any]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── checkDaemonDependencies ───────────────────────────────────────────────────

describe("checkDaemonDependencies()", () => {
  it("returns empty array when all binaries are present and a runtime is available", () => {
    const errors = checkDaemonDependencies();
    expect(errors).toEqual([]);
  });

  it("returns one error block when git is missing", () => {
    missingBinary("git");

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`git`");
    expect(errors[0]).toContain("Install:");
  });

  it("includes a platform-appropriate install hint for missing git", () => {
    missingBinary("git");

    const errors = checkDaemonDependencies();

    // At least one of the known install hint substrings must appear
    const hint = errors[0];
    const hasKnownHint = hint.includes("brew install git") || hint.includes("apt install git") || hint.includes("git-scm.com");
    expect(hasKnownHint).toBe(true);
  });

  it("returns one error block when gh is missing", () => {
    missingBinary("gh");

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`gh`");
    expect(errors[0]).toContain("Install:");
  });

  it("returns one error block when npx is missing", () => {
    missingBinary("npx");

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`npx`");
    expect(errors[0]).toContain("Install:");
  });

  it("returns two distinct error blocks when gh and npx are both missing", () => {
    missingBinaries("gh", "npx");

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(2);
    const joined = errors.join("\n");
    expect(joined).toContain("`gh`");
    expect(joined).toContain("`npx`");
  });

  it("returns an error block when no agent runtime is available", () => {
    mockGetAvailableProviders.mockReturnValue([]);

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no agent runtime on PATH");
  });

  it("lists all five runtime names in the no-runtime error block", () => {
    mockGetAvailableProviders.mockReturnValue([]);

    const errors = checkDaemonDependencies();

    const block = errors[0];
    expect(block).toContain("claude");
    expect(block).toContain("codex");
    expect(block).toContain("gemini");
    expect(block).toContain("copilot");
    expect(block).toContain("hermes");
  });

  it("returns errors for both missing binaries and missing runtime together", () => {
    missingBinary("git");
    mockGetAvailableProviders.mockReturnValue([]);

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(2);
    const joined = errors.join("\n");
    expect(joined).toContain("`git`");
    expect(joined).toContain("no agent runtime on PATH");
  });

  it("returns three error blocks when all required binaries are missing", () => {
    missingBinaries("git", "gh", "npx", "gpg");

    const errors = checkDaemonDependencies();

    expect(errors).toHaveLength(3);
    const joined = errors.join("\n");
    expect(joined).toContain("`git`");
    expect(joined).toContain("`gh`");
    expect(joined).toContain("`npx`");
    expect(joined).not.toContain("`gpg`");
  });

  it("uses the linux hint when running on linux", () => {
    mockPlatform.mockReturnValue("linux");
    missingBinary("git");

    const errors = checkDaemonDependencies();

    expect(errors[0]).toContain("apt install git");
  });

  it("uses the generic hint when running on an unknown platform", () => {
    mockPlatform.mockReturnValue("win32");
    missingBinary("git");

    const errors = checkDaemonDependencies();

    expect(errors[0]).toContain("git-scm.com");
  });
});

// ── assertDaemonDependencies ──────────────────────────────────────────────────

describe("assertDaemonDependencies()", () => {
  it("does not call process.exit when all dependencies are satisfied", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    assertDaemonDependencies();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("calls process.exit(1) when a dependency is missing", () => {
    missingBinary("git");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertDaemonDependencies();

    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("calls console.error with output containing the error block when a dependency is missing", () => {
    missingBinary("gh");
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertDaemonDependencies();

    const allOutput = errorSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(allOutput).toContain("`gh`");
    errorSpy.mockRestore();
  });

  it("calls console.error with the preamble message when errors exist", () => {
    missingBinary("npx");
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertDaemonDependencies();

    const allOutput = errorSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(allOutput).toContain("Cannot start daemon");
    errorSpy.mockRestore();
  });

  it("does not call console.error when all dependencies are satisfied", () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertDaemonDependencies();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
