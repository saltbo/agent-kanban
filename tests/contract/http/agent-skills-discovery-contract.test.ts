// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, glob, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const skillsRoot = path.join(root, "skills");
const publishedRoot = path.join(root, "public", ".well-known", "agent-skills");

interface DiscoveryIndex {
  $schema: string;
  skills: Array<{
    name: string;
    type: string;
    description: string;
    url: string;
    digest: string;
  }>;
}

describe("Agent Skills Discovery artifacts", () => {
  it("[spec: resource-server/agent-skills] publishes every owned Skill as a complete digest-verified 0.2.0 archive", async () => {
    const index = JSON.parse(await readFile(path.join(publishedRoot, "index.json"), "utf8")) as DiscoveryIndex;
    const skillNames = (await Array.fromAsync(glob("*/SKILL.md", { cwd: skillsRoot }))).map(path.dirname).sort();
    const publishedInstructions: string[] = [];

    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills.map(({ name }) => name)).toEqual(skillNames);

    for (const skill of index.skills) {
      expect(skill).toMatchObject({
        name: skill.name,
        type: "archive",
        description: expect.any(String),
        url: `/.well-known/agent-skills/${skill.name}.tar.gz`,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });

      const archive = await readFile(path.join(publishedRoot, `${skill.name}.tar.gz`));
      expect(skill.digest).toBe(`sha256:${createHash("sha256").update(archive).digest("hex")}`);

      const archivedFiles = readTarFiles(archive);
      const sourceFiles = await listFiles(path.join(skillsRoot, skill.name));
      expect([...archivedFiles.keys()].sort()).toEqual(sourceFiles);
      expect(sourceFiles).toContain("SKILL.md");
      publishedInstructions.push(archivedFiles.get("SKILL.md")!.toString());
      for (const relativePath of sourceFiles) {
        expect(archivedFiles.get(relativePath)?.equals(await readFile(path.join(skillsRoot, skill.name, relativePath)))).toBe(true);
      }
    }

    const instructions = publishedInstructions.join("\n");
    expect(instructions).toContain("agent-kanban/tasks/<task-id>/claims");
    expect(instructions).toContain("realmroot toolbox patch agent-kanban/tasks/<task-id>");
    expect(instructions).not.toContain('If-Match: "<task-etag>"');
    expect(instructions).not.toContain("claims/<claim-id>");
    expect(instructions).not.toContain('If-Match: "<claim-etag>"');
    for (const legacyPath of [
      "agent-kanban/task-assignments",
      "agent-kanban/task-claims",
      "agent-kanban/task-review-submissions",
      "agent-kanban/task-review-rejections",
      "agent-kanban/task-review-completions",
      "agent-kanban/task-cancellations",
    ]) {
      expect(instructions).not.toContain(legacyPath);
    }
  });

  it("rejects a stale archive when a Skill supporting file changes", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "ak-agent-skills-"));
    try {
      await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
      await cp(path.join(root, "scripts", "build-agent-skills.mjs"), path.join(fixtureRoot, "scripts", "build-agent-skills.mjs"));
      await cp(skillsRoot, path.join(fixtureRoot, "skills"), { recursive: true });
      const reference = path.join(fixtureRoot, "skills", "agent-kanban", "references", "toolbox.md");
      await mkdir(path.dirname(reference), { recursive: true });
      await writeFile(reference, "initial instructions\n");

      const script = path.join(fixtureRoot, "scripts", "build-agent-skills.mjs");
      execFileSync(process.execPath, [script]);
      const archive = await readFile(path.join(fixtureRoot, "public", ".well-known", "agent-skills", "agent-kanban.tar.gz"));
      expect(readTarFiles(archive).get("references/toolbox.md")?.toString()).toBe("initial instructions\n");

      await writeFile(reference, "changed instructions\n");
      const check = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });

      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain("agent-kanban.tar.gz is stale. Run pnpm run build:skills.");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(path.join(directory, entry.name), name) : [name];
    }),
  );
  return files.flat().sort();
}

function readTarFiles(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const contentsStart = offset + 512;
    files.set(name, tar.subarray(contentsStart, contentsStart + size));
    offset = contentsStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}
