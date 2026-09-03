// @vitest-environment node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const enborSdkVersion = "0.1.0";
const legacyEnborSdkRelease = "https://github.com/realmroot/enbor/releases/download/enbor-sdk-v0.1.0/realmroot-enbor-sdk-0.1.0.tgz";

describe("single-package repository structure", () => {
  it("has no workspace, video application, or legacy CLI surface", async () => {
    for (const removed of ["apps", "packages", "pnpm-workspace.yaml", "public/cli", "scripts/install-cli.sh"]) {
      await expect(access(path.join(root, removed))).rejects.toThrow();
    }
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { workspaces?: unknown };
    expect(packageJson).not.toHaveProperty("workspaces");
  });

  it("keeps a single root lockfile importer with the pinned Enbor SDK npm package and no legacy SDK or workspace links", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
    const importers = lockfile.slice(lockfile.indexOf("importers:"), lockfile.indexOf("packages:"));
    const importerKeys = [...importers.matchAll(/^ {2}([^\s].*):$/gm)].map((match) => match[1]);

    expect(importerKeys).toEqual(["."]);
    expect(packageJson.dependencies?.["@realmroot/enbor-sdk"]).toBe(enborSdkVersion);
    expect(importers).toContain(`specifier: ${enborSdkVersion}\n        version: ${enborSdkVersion}`);
    expect(lockfile).toMatch(/^ {2}'@realmroot\/enbor-sdk@0\.1\.0':\n {4}resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}$/m);
    expect(lockfile).not.toContain(legacyEnborSdkRelease);
    expect(lockfile).not.toMatch(/(?:@realmroot\/ama-sdk|@ama\/|workspace:|\blink:)/i);
  });
});
