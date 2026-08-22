// @vitest-environment node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `ak-ama-runner-test-${randomUUID()}`);
const binDir = join(testDir, "bin");
const legacyRunnersDir = join(testDir, "runners");

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return { ...actual, BIN_DIR: binDir, DATA_DIR: testDir };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, platform: () => "darwin", arch: () => "arm64" };
});

// Mutable probe config so the version stub tracks whatever AMA_RUNNER_VERSION
// the source exports. The object reference is captured at mock-factory time;
// values are written after the real module is imported below.
const probe = { version: "" };

vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    spawnSync: vi.fn((command: string, args: string[]) => {
      if (command === "tar") {
        const outputDir = args[args.indexOf("-C") + 1];
        fs.writeFileSync(path.join(outputDir, "ama-runner"), "runner");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "version") {
        return { status: 0, stdout: JSON.stringify({ name: "ama-runner", version: probe.version, commit: "test" }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }),
  };
});

const { resolveAmaRunnerBinary, AMA_RUNNER_VERSION } = await import("../src/amaRunner.js");

// Now that the source is loaded, sync the probe so the spawnSync stub returns
// the same version the source module declares as its bundled default.
probe.version = AMA_RUNNER_VERSION;

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveAmaRunnerBinary", () => {
  it("pins the bundled AMA runner release", () => {
    expect(AMA_RUNNER_VERSION).toBe("0.8.1");
  });

  it("installs a single AK-managed runner binary and removes legacy runner directories", async () => {
    mkdirSync(join(legacyRunnersDir, "ama-runner", "v0.1.0", "darwin-arm64"), { recursive: true });
    writeFileSync(join(legacyRunnersDir, "ama-runner", "v0.1.0", "darwin-arm64", "ama-runner"), "old");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/checksums.txt")) {
        const checksum = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";
        return new Response(
          [
            `${checksum} ama-runner-v${AMA_RUNNER_VERSION}-darwin-arm64.tar.gz`,
            `${checksum} ama-runner-v${AMA_RUNNER_VERSION}-darwin-amd64.tar.gz`,
            `${checksum} ama-runner-v${AMA_RUNNER_VERSION}-linux-arm64.tar.gz`,
            `${checksum} ama-runner-v${AMA_RUNNER_VERSION}-linux-amd64.tar.gz`,
          ].join("\n"),
        );
      }
      return new Response(Buffer.from("archive"));
    });

    const resolved = await resolveAmaRunnerBinary();

    expect(resolved.path).toBe(join(binDir, "ama-runner"));
    expect(resolved.version).toMatchObject({ version: AMA_RUNNER_VERSION, commit: "test" });
    expect(existsSync(join(legacyRunnersDir, "ama-runner"))).toBe(false);
    expect(existsSync(join(binDir, "ama-runner"))).toBe(true);
  });
});
