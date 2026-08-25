/// <reference types="vite/client" />
// Built-in skills ship with the repository under skills/<name>/SKILL.md.
// Primary source: vite bundles them as raw strings at build time — this works
// inside workerd (virtual /bundle fs, real host paths unreadable) and on
// Cloudflare deploys. Fallback: fs read for plain-node self-hosted servers.

// Tolerant frontmatter reader: inline `key: value` and `key: |` block scalars.
export function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: fallbackName, description: "" };
  const lines = match[1].split(/\r?\n/);
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv || line.startsWith(" ") || line.startsWith("\t")) continue;
    const key = kv[1];
    let value = kv[2];
    if (value.startsWith("|") || value.startsWith(">")) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[i + 1].trim());
        i++;
      }
      value = block.join(" ");
    }
    if (key === "name") name = value.trim();
    if (key === "description") description = value.trim();
  }
  return { name: name || fallbackName, description };
}

// Bundled at build time: keys are paths like "../../../skills/<name>/SKILL.md".
// Under vitest this resolves against the real repo; in the worker bundle the
// contents are inlined as strings.
const BUNDLED_SKILLS = import.meta.glob("../../../skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function skillsFromBundle(bundled: Record<string, string>): { name: string; description: string; body: string }[] {
  const skills = Object.entries(bundled).map(([path, raw]) => {
    const dirName = path.split("/").slice(-2)[0] ?? path;
    const { name, description } = parseSkillFrontmatter(raw, dirName);
    return { name, description, body: raw };
  });
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// fs fallback: plain-node self-hosted servers (no vite bundling).
export async function listBuiltinSkills(): Promise<{ name: string; description: string; body: string }[]> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");
    const candidates = [resolve(process.cwd(), "skills"), resolve(process.cwd(), "..", "..", "skills")];
    let skillsDir: string | null = null;
    for (const candidate of candidates) {
      try {
        const entries = await readdir(candidate, { withFileTypes: true });
        if (entries.some((entry) => entry.isDirectory())) {
          skillsDir = candidate;
          break;
        }
      } catch {}
    }
    if (!skillsDir) return [];
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: { name: string; description: string; body: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf8");
        const { name, description } = parseSkillFrontmatter(raw, entry.name);
        skills.push({ name, description, body: raw });
      } catch {}
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // fs unavailable (Cloudflare Workers) or skills dir missing — degrade to [].
    return [];
  }
}

// Route handler entry point: prefer the build-time bundle (workerd/CF), fall
// back to fs for plain-node self-hosted servers.
export async function readBuiltinSkills(): Promise<{ name: string; description: string; body: string }[]> {
  const bundled = skillsFromBundle(BUNDLED_SKILLS);
  if (bundled.length > 0) return bundled;
  return listBuiltinSkills();
}
