// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v2 upgrade preflight", () => {
  it("allows a fresh database without a tasks table", () => {
    const result = runPreflight({ schemaStderr: "D1_ERROR: no such table: tasks", schemaStatus: 1 });

    expect(result.status).toBe(0);
  });

  it("allows an all-terminal Task database", () => {
    const result = runPreflight({ taskRows: [] });

    expect(result.status).toBe(0);
    expect(readFileSync(result.argumentsFile, "utf8")).toContain("status NOT IN ('done', 'cancelled')");
  });

  it("allows active v2 Tasks when the 0043 schema is already present", () => {
    const result = runPreflight({
      schemaRows: [{ name: "id" }, { name: "assignee_identity_type" }],
      taskRows: [{ id: "active-v2-task", status: "in_progress" }],
    });

    expect(result.status).toBe(0);
    expect(readFileSync(result.argumentsFile, "utf8")).not.toContain("SELECT id, status FROM tasks");
  });

  it("rejects todo, in-progress, and in-review Tasks and reports every blocking id", () => {
    const result = runPreflight({
      taskRows: [
        { id: "task-todo", status: "todo" },
        { id: "task-progress", status: "in_progress" },
        { id: "task-review", status: "in_review" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot upgrade Agent Kanban v1 to v2 while non-terminal Tasks remain:");
    expect(result.stderr).toContain("- task-todo (todo)");
    expect(result.stderr).toContain("- task-progress (in_progress)");
    expect(result.stderr).toContain("- task-review (in_review)");
  });
});

function runPreflight(output: {
  schemaRows?: Array<Record<string, unknown>>;
  schemaStderr?: string;
  schemaStatus?: number;
  taskRows?: Array<Record<string, unknown>>;
}) {
  const directory = mkdtempSync(join(tmpdir(), "ak-v2-preflight-"));
  temporaryDirectories.push(directory);
  const argumentsFile = join(directory, "arguments.txt");
  const fakePnpm = join(directory, "pnpm");
  writeFileSync(
    fakePnpm,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_PNPM_ARGUMENTS_FILE"\nif printf "%s" "$*" | grep -q "PRAGMA table_info"; then\n  printf "%s" "$FAKE_SCHEMA_STDOUT"\n  printf "%s" "$FAKE_SCHEMA_STDERR" >&2\n  exit "$FAKE_SCHEMA_STATUS"\nfi\nprintf "%s" "$FAKE_TASK_STDOUT"\nexit 0\n',
  );
  chmodSync(fakePnpm, 0o755);
  const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), ["scripts/check-v2-upgrade.ts", "--local"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_PNPM_ARGUMENTS_FILE: argumentsFile,
      FAKE_SCHEMA_STDOUT: JSON.stringify([{ results: output.schemaRows ?? [{ name: "id" }] }]),
      FAKE_SCHEMA_STDERR: output.schemaStderr ?? "",
      FAKE_SCHEMA_STATUS: String(output.schemaStatus ?? 0),
      FAKE_TASK_STDOUT: JSON.stringify([{ results: output.taskRows ?? [] }]),
    },
  });
  return { ...result, argumentsFile };
}
