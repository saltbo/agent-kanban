import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { join } from "node:path";
import { BIN_DIR, DATA_DIR } from "./paths.js";

const AMA_RUNNER_REPOSITORY = "saltbo/any-managed-agents";
export const AMA_RUNNER_VERSION = "0.8.1";
const AMA_RUNNER_PATH = join(BIN_DIR, nodePlatform() === "win32" ? "ama-runner.exe" : "ama-runner");
const LEGACY_RUNNER_INSTALL_DIR = join(DATA_DIR, "runners", "ama-runner");

export interface AmaRunnerVersionInfo {
  name?: string;
  version?: string;
  commit?: string;
  buildDate?: string;
}

export interface ResolvedAmaRunner {
  path: string;
  version: AmaRunnerVersionInfo | null;
}

function artifactPlatform(): { os: string; arch: string; archiveExtension: ".tar.gz" | ".zip" } {
  const os = nodePlatform();
  const arch = nodeArch();
  if (os === "win32") {
    if (arch !== "x64") throw new Error(`Unsupported AMA runner architecture on Windows: ${arch}`);
    return { os: "windows", arch: "amd64", archiveExtension: ".zip" };
  }
  if (os !== "darwin" && os !== "linux") throw new Error(`Unsupported AMA runner platform: ${os}`);
  if (arch === "arm64") return { os, arch: "arm64", archiveExtension: ".tar.gz" };
  if (arch === "x64") return { os, arch: "amd64", archiveExtension: ".tar.gz" };
  throw new Error(`Unsupported AMA runner architecture: ${arch}`);
}

function releaseBaseUrl(version: string): string {
  return `https://github.com/${AMA_RUNNER_REPOSITORY}/releases/download/ama-runner-v${version}`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download AMA runner asset ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download AMA runner checksums ${url}: HTTP ${response.status}`);
  return await response.text();
}

function expectedSha256(checksums: string, artifactName: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === artifactName && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new Error(`AMA runner checksums do not include ${artifactName}`);
}

function assertSha256(data: Buffer, expected: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`AMA runner checksum mismatch: expected ${expected}, got ${actual}`);
}

function readRunnerVersion(path: string): AmaRunnerVersionInfo | null {
  const result = spawnSync(path, ["version", "--json"], { encoding: "utf-8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout) as AmaRunnerVersionInfo;
  } catch {
    return null;
  }
}

function installedRunnerMatches(path: string, version: string): boolean {
  if (!existsSync(path)) return false;
  return readRunnerVersion(path)?.version === version;
}

function cleanupLegacyInstalls(): void {
  rmSync(LEGACY_RUNNER_INSTALL_DIR, { recursive: true, force: true });
}

async function installAmaRunner(version: string, targetPath: string): Promise<void> {
  const { os, arch, archiveExtension } = artifactPlatform();
  const artifactName = `ama-runner-v${version}-${os}-${arch}${archiveExtension}`;
  const baseUrl = releaseBaseUrl(version);
  const [archive, checksums] = await Promise.all([fetchBytes(`${baseUrl}/${artifactName}`), fetchText(`${baseUrl}/checksums.txt`)]);
  assertSha256(archive, expectedSha256(checksums, artifactName));

  // Extract inside BIN_DIR so the final rename stays on one filesystem —
  // rename(2) from the OS temp dir fails with EXDEV when /tmp is tmpfs.
  mkdirSync(BIN_DIR, { recursive: true });
  const tmpDir = mkdtempSync(join(BIN_DIR, ".ama-runner-install-"));
  try {
    const archivePath = join(tmpDir, artifactName);
    writeFileSync(archivePath, archive);
    if (archiveExtension === ".zip") {
      const extract = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force -ErrorAction Stop }",
          archivePath,
          tmpDir,
        ],
        { encoding: "utf-8", windowsHide: true },
      );
      if (extract.error || extract.status !== 0) {
        throw new Error(
          `Failed to extract AMA runner: ${extract.error?.message || extract.stderr || extract.stdout || `exit status ${extract.status}`}`,
        );
      }

      const executablePath = join(tmpDir, "ama-runner.exe");
      const backupPath = join(tmpDir, "previous-ama-runner.exe");
      const hadPreviousRunner = existsSync(targetPath);
      if (hadPreviousRunner) renameSync(targetPath, backupPath);
      try {
        renameSync(executablePath, targetPath);
      } catch (error) {
        if (hadPreviousRunner) renameSync(backupPath, targetPath);
        throw error;
      }
      return;
    }
    const tar = spawnSync("tar", ["-xzf", archivePath, "-C", tmpDir], { encoding: "utf-8" });
    if (tar.status !== 0) {
      throw new Error(`Failed to extract AMA runner: ${tar.stderr || tar.stdout}`);
    }
    rmSync(targetPath, { force: true });
    renameSync(join(tmpDir, "ama-runner"), targetPath);
    chmodSync(targetPath, 0o755);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// The server can pin the runner version via machine registration; the local
// constant is the fallback for servers that don't.
export async function resolveAmaRunnerBinary(requestedVersion?: string | null): Promise<ResolvedAmaRunner> {
  const version = requestedVersion || AMA_RUNNER_VERSION;
  cleanupLegacyInstalls();
  if (!installedRunnerMatches(AMA_RUNNER_PATH, version)) {
    await installAmaRunner(version, AMA_RUNNER_PATH);
  }
  if (!existsSync(AMA_RUNNER_PATH)) throw new Error(`AMA runner installation did not produce ${AMA_RUNNER_PATH}`);
  return { path: AMA_RUNNER_PATH, version: readRunnerVersion(AMA_RUNNER_PATH) };
}
