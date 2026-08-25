// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuiltinSkills, parseSkillFrontmatter } from "./builtinSkills";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("parseSkillFrontmatter", () => {
  it("parses inline name and description", () => {
    const raw = "---\nname: ak-verify\ndescription: Verify work before review\n---\n\n# Body\n";
    expect(parseSkillFrontmatter(raw, "fallback")).toEqual({ name: "ak-verify", description: "Verify work before review" });
  });

  it("joins block-scalar description lines with spaces", () => {
    const raw = [
      "---",
      "name: ak-plan",
      "description: |",
      "  Plan and execute a project through",
      "  Agent Kanban boards and tasks,",
      "  delegating review when present.",
      "---",
      "",
      "# Body",
    ].join("\n");
    expect(parseSkillFrontmatter(raw, "fallback")).toEqual({
      name: "ak-plan",
      description: "Plan and execute a project through Agent Kanban boards and tasks, delegating review when present.",
    });
  });

  it("parses the real skills/ak-plan/SKILL.md frontmatter", () => {
    const raw = readFileSync(join(REPO_ROOT, "skills", "ak-plan", "SKILL.md"), "utf8");
    const parsed = parseSkillFrontmatter(raw, "fallback");
    expect(parsed.name).toBe("ak-plan");
    expect(parsed.description).toContain("Plan and execute a project through Agent Kanban boards, tasks, dependencies, and workers");
    expect(parsed.description).not.toContain("\n");
  });

  it("falls back to the directory name and empty description without frontmatter", () => {
    expect(parseSkillFrontmatter("# No frontmatter here\n", "my-skill")).toEqual({ name: "my-skill", description: "" });
  });

  it("falls back for empty or whitespace-only frontmatter values", () => {
    expect(parseSkillFrontmatter("---\nname:\n---\n", "my-skill").name).toBe("my-skill");
    expect(parseSkillFrontmatter("---\ndescription: nothing here\n---\n", "my-skill")).toEqual({ name: "my-skill", description: "nothing here" });
  });
});

describe("listBuiltinSkills", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;
  let dir: string | null = null;

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function useTmpCwd(): string {
    dir = mkdtempSync(join(tmpdir(), "ak-builtin-skills-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    return dir;
  }

  it("reads skills from <cwd>/skills", async () => {
    const root = useTmpCwd();
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo skill\n---\n\n# Foo\n");
    mkdirSync(join(root, "skills", "bar"), { recursive: true });
    writeFileSync(join(root, "skills", "bar", "SKILL.md"), "---\nname: bar\ndescription: |\n  Bar skill with\n  block description.\n---\n\n# Bar\n");
    // A directory without SKILL.md is skipped.
    mkdirSync(join(root, "skills", "no-skill-md"), { recursive: true });

    const skills = await listBuiltinSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["bar", "foo"]);
    expect(skills[0].description).toBe("Bar skill with block description.");
    expect(skills[1].body).toContain("# Foo");
  });

  it("returns an empty list when no skills directory exists", async () => {
    useTmpCwd();
    await expect(listBuiltinSkills()).resolves.toEqual([]);
  });

  it("returns an empty list when the skills directory has no subdirectories", async () => {
    const root = useTmpCwd();
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "README.md"), "not a skill dir\n");
    await expect(listBuiltinSkills()).resolves.toEqual([]);
  });
});
