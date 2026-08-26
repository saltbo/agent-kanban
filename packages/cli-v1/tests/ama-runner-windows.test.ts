// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDir = join(tmpdir(), `ak-ama-runner-windows-test-${randomUUID()}`);
const binDir = join(testDir, "bin");
const archiveBytes = Buffer.from("windows ama runner zip archive");
const runnerBytes = Buffer.from("extracted windows ama runner executable");

type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: Error };

function spawnSyncImplementation(command: string, args: string[]): SpawnResult {
  if (command === "powershell.exe") {
    writeFileSync(join(args.at(-1)!, "ama-runner.exe"), runnerBytes);
    return { status: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "version") {
    return { status: 0, stdout: JSON.stringify({ name: "ama-runner", version: "0.8.1", commit: "windows-test" }), stderr: "" };
  }
  return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
}

const spawnSyncMock = vi.fn(spawnSyncImplementation);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, platform: () => "win32", arch: () => "x64" };
});

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return { ...actual, BIN_DIR: binDir, DATA_DIR: testDir };
});

const { AMA_RUNNER_VERSION, resolveAmaRunnerBinary } = await import("../src/amaRunner.js");
const { renameSync: realRenameSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

beforeEach(() => {
  spawnSyncMock.mockImplementation(spawnSyncImplementation);
  vi.mocked(renameSync).mockImplementation(realRenameSync);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveAmaRunnerBinary on Windows", () => {
  it("downloads, verifies, and extracts the amd64 ZIP with PowerShell", async () => {
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/checksums.txt")) return new Response(`${checksum}  ${artifactName}\r\n`);
      if (url.endsWith(`/${artifactName}`)) return new Response(archiveBytes);
      return new Response("not found", { status: 404 });
    });

    const resolved = await resolveAmaRunnerBinary();

    expect(fetchSpy).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${artifactName.replaceAll(".", "\\.")}$`)));
    expect(resolved.path).toBe(join(binDir, "ama-runner.exe"));
    expect(resolved.version).toMatchObject({ version: AMA_RUNNER_VERSION, commit: "windows-test" });
    expect(existsSync(resolved.path)).toBe(true);
    expect(readFileSync(resolved.path)).toEqual(runnerBytes);
    expect(spawnSyncMock).not.toHaveBeenCalledWith("tar", expect.anything(), expect.anything());
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force -ErrorAction Stop }",
        expect.stringMatching(new RegExp(`${artifactName.replaceAll(".", "\\.")}$`)),
      ]),
      expect.objectContaining({ encoding: "utf-8", windowsHide: true }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(resolved.path, ["version", "--json"], expect.objectContaining({ windowsHide: true }));
  });

  it("rejects a ZIP whose checksum does not match without extracting or installing", async () => {
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/checksums.txt")) return new Response(`${"0".repeat(64)}  ${artifactName}\n`);
      return new Response(archiveBytes);
    });

    await expect(resolveAmaRunnerBinary()).rejects.toThrow("AMA runner checksum mismatch");
    expect(existsSync(join(binDir, "ama-runner.exe"))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalledWith("powershell.exe", expect.anything(), expect.anything());
  });

  it("keeps the previous executable when PowerShell extraction fails", async () => {
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    const targetPath = join(binDir, "ama-runner.exe");
    const previousBytes = Buffer.from("previous windows runner");
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(targetPath, previousBytes);
    spawnSyncMock.mockImplementation((command, args) => {
      if (command === "powershell.exe") return { status: 1, stdout: "", stderr: "Expand-Archive failed" };
      if (args[0] === "version") {
        return { status: 0, stdout: JSON.stringify({ name: "ama-runner", version: "0.5.15", commit: "old" }), stderr: "" };
      }
      return spawnSyncImplementation(command, args);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/checksums.txt")) return new Response(`${checksum}  ${artifactName}\n`);
      return new Response(archiveBytes);
    });

    await expect(resolveAmaRunnerBinary()).rejects.toThrow("Failed to extract AMA runner: Expand-Archive failed");

    expect(readFileSync(targetPath)).toEqual(previousBytes);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("reports a PowerShell spawn error and keeps the previous executable", async () => {
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    const targetPath = join(binDir, "ama-runner.exe");
    const previousBytes = Buffer.from("previous windows runner");
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(targetPath, previousBytes);
    spawnSyncMock.mockImplementation((command, args) => {
      if (command === "powershell.exe") {
        return { status: null, stdout: "ignored stdout", stderr: "ignored stderr", error: new Error("spawn powershell.exe ENOENT") };
      }
      if (args[0] === "version") {
        return { status: 0, stdout: JSON.stringify({ name: "ama-runner", version: "0.5.15", commit: "old" }), stderr: "" };
      }
      return spawnSyncImplementation(command, args);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/checksums.txt")) return new Response(`${checksum}  ${artifactName}\n`);
      return new Response(archiveBytes);
    });

    await expect(resolveAmaRunnerBinary()).rejects.toThrow("Failed to extract AMA runner: spawn powershell.exe ENOENT");

    expect(readFileSync(targetPath)).toEqual(previousBytes);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("restores the previous executable when the atomic replacement fails", async () => {
    const artifactName = `ama-runner-v${AMA_RUNNER_VERSION}-windows-amd64.zip`;
    const targetPath = join(binDir, "ama-runner.exe");
    const previousBytes = Buffer.from("previous windows runner");
    const checksum = createHash("sha256").update(archiveBytes).digest("hex");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(targetPath, previousBytes);
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ name: "ama-runner", version: "0.5.14", commit: "old" }),
      stderr: "",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/checksums.txt")) return new Response(`${checksum}  ${artifactName}\n`);
      return new Response(archiveBytes);
    });
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (basename(String(source)) === "ama-runner.exe" && String(source).includes(".ama-runner-install-") && destination === targetPath) {
        const error = new Error("simulated replacement failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      realRenameSync(source, destination);
    });

    await expect(resolveAmaRunnerBinary()).rejects.toThrow("simulated replacement failure");

    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath)).toEqual(previousBytes);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(3);
  });
});
