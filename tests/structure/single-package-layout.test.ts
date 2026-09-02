// @vitest-environment node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("single-package repository structure", () => {
  it("has no workspace, video application, or legacy CLI surface", async () => {
    for (const removed of ["apps", "packages", "pnpm-workspace.yaml", "public/cli", "scripts/install-cli.sh"]) {
      await expect(access(path.join(root, removed))).rejects.toThrow();
    }
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { workspaces?: unknown };
    expect(packageJson).not.toHaveProperty("workspaces");
  });

  it("keeps a single root lockfile importer without AMA SDK or workspace links", async () => {
    const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
    const importers = lockfile.slice(lockfile.indexOf("importers:"), lockfile.indexOf("packages:"));
    const importerKeys = [...importers.matchAll(/^ {2}([^\s].*):$/gm)].map((match) => match[1]);

    expect(importerKeys).toEqual(["."]);
    expect(lockfile).not.toMatch(/(?:ama-sdk|@ama\/|workspace:|\blink:)/i);
  });
});
