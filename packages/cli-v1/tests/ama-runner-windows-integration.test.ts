// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `ak-ama-runner-windows-integration-${randomUUID()}`);
const binDir = join(testDir, "bin");

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return { ...actual, BIN_DIR: binDir, DATA_DIR: testDir };
});

const { AMA_RUNNER_VERSION, resolveAmaRunnerBinary } = await import("../src/amaRunner.js");

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveAmaRunnerBinary Windows ZIP integration", () => {
  it.runIf(process.platform === "win32")("extracts a real PowerShell-created ZIP into the isolated runner path", async () => {
    const fixtureDir = join(testDir, "fixture");
    const fixtureExecutable = join(fixtureDir, "ama-runner.exe");
    const archivePath = join(testDir, "fixture.zip");
    const expectedBytes = Buffer.from("real powershell zip fixture\r\n", "utf8");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixtureExecutable, expectedBytes);

    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force -ErrorAction Stop }",
        fixtureExecutable,
        archivePath,
      ],
      { windowsHide: true },
    );

    const archiveBytes = readFileSync(archivePath);
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/checksums.txt")) return new Response(`${checksum}  ${artifactName}\r\n`);
      if (url.endsWith(`/${artifactName}`)) return new Response(archiveBytes);
      return new Response("not found", { status: 404 });
    });

    const resolved = await resolveAmaRunnerBinary();

    expect(resolved.path).toBe(join(binDir, "ama-runner.exe"));
    expect(readFileSync(resolved.path)).toEqual(expectedBytes);
  });
});
