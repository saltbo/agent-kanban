import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSpecCoverage } from "../../../scripts/check-spec-coverage";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("checkSpecCoverage", () => {
  it("accepts a valid scenario with a breadcrumb in its canonical proof layer", async () => {
    const root = await fixture({
      "spec/boards.feature": feature("boards/view", "unit"),
      "tests/unit/application/boards.test.ts": proof("boards/view"),
    });

    await expect(checkSpecCoverage(root)).resolves.toBe(1);
  });

  it("rejects malformed scenario metadata", async () => {
    const root = await fixture({
      "spec/boards.feature": `Feature: Boards

  @journey:boards/view @entrypoint:unknown @proof:unit
  Scenario: View a Board
`,
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("must have one journey, entrypoint, and canonical proof tag");
  });

  it("rejects duplicate scenario ids", async () => {
    const root = await fixture({
      "spec/boards.feature": `${feature("boards/view", "unit")}
  @journey:boards/view @entrypoint:http @proof:unit
  Scenario: View the Board again
`,
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Duplicate scenario id boards/view");
  });

  it("rejects a journey assigned to the wrong capability", async () => {
    const root = await fixture({ "spec/boards.feature": feature("tasks/view", "unit") });

    await expect(checkSpecCoverage(root)).rejects.toThrow("journey tasks/view must belong to capability boards");
  });

  it("reports a missing breadcrumb", async () => {
    const root = await fixture({ "spec/boards.feature": feature("boards/view", "unit") });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Missing [spec: boards/view]");
  });

  it("reports a breadcrumb outside the canonical proof layer", async () => {
    const root = await fixture({
      "spec/boards.feature": feature("boards/view", "e2e"),
      "tests/unit/application/boards.test.ts": proof("boards/view"),
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Misplaced [spec: boards/view] for @proof:e2e");
  });

  it("reports an orphan breadcrumb with no matching scenario", async () => {
    const root = await fixture({
      "spec/boards.feature": feature("boards/view", "unit"),
      "tests/unit/application/boards.test.ts": `${proof("boards/view")}
it("[spec: boards/orphan] proves nothing", () => {});
`,
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Unknown test breadcrumb [spec: boards/orphan]");
  });

  it("ignores breadcrumbs that only appear in comments or fixture strings", async () => {
    const root = await fixture({
      "spec/boards.feature": feature("boards/view", "unit"),
      "tests/unit/application/boards.test.ts": `// [spec: boards/view]
const fixtureText = "[spec: boards/view]";
it("does not prove the scenario", () => fixtureText);
`,
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Missing [spec: boards/view]");
  });

  it("ignores breadcrumbs inside non-title template interpolation strings", async () => {
    const root = await fixture({
      "spec/boards.feature": feature("boards/view", "unit"),
      "tests/unit/application/boards.test.ts": [
        'const schema = "board";',
        "const ref = `schema $" + "{schema} [spec: boards/view]`;",
        'it("does not prove the scenario", () => ref);',
      ].join("\n"),
    });

    await expect(checkSpecCoverage(root)).rejects.toThrow("Missing [spec: boards/view]");
  });
});

function feature(id: string, proofLayer: "unit" | "integration" | "e2e"): string {
  return `Feature: Boards

  @journey:${id} @entrypoint:http @proof:${proofLayer}
  Scenario: View a Board
`;
}

function proof(id: string): string {
  return `import { it } from "vitest";
it("[spec: ${id}] proves the scenario", () => {});
`;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ak-spec-coverage-"));
  fixtureRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return root;
}
