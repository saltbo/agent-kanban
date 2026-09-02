import { glob, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const validLayers = new Set(["domain", "usecase", "api", "web", "e2e"]);
const scenarioPattern = /^\s*@([a-z0-9-]+\/[a-z0-9-]+)\s+@([a-z]+)\s*$/;
const breadcrumbPattern = /\[spec:\s*([a-z0-9-]+\/[a-z0-9-]+)\s*\]/g;
const testGlobs = ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "tests/**/*.spec.ts"];
const layerHomes: Record<string, RegExp> = {
  domain: /^(?:server\/domain\/.*\.test\.ts|tests\/unit\/domain\/.*\.test\.(?:ts|tsx))$/,
  usecase: /^(?:server\/usecases\/.*\.test\.ts|tests\/unit\/application\/.*\.test\.(?:ts|tsx))$/,
  api: /^(?:server\/http\/.*\.test\.ts|tests\/integration\/http\/.*\.test\.(?:ts|tsx))$/,
  web: /^(?:src\/.*\.test\.tsx|tests\/unit\/component\/.*\.test\.tsx)$/,
  e2e: /^tests\/.*\.spec\.ts$/,
};

interface Scenario {
  id: string;
  layer: string;
  file: string;
  line: number;
}

async function collectScenarios(): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();
  for await (const file of glob("spec/*.feature", { cwd: root })) {
    const lines = (await readFile(path.join(root, file), "utf8")).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trimStart().startsWith("@")) continue;
      const match = line.match(scenarioPattern);
      if (!match || !validLayers.has(match[2])) {
        throw new Error(`${file}:${index + 1} must have one scenario id and one valid proof-layer tag`);
      }
      if (seen.has(match[1])) throw new Error(`Duplicate scenario id ${match[1]} at ${file}:${index + 1}`);
      seen.add(match[1]);
      scenarios.push({ id: match[1], layer: match[2], file, line: index + 1 });
    }
  }
  return scenarios;
}

async function collectBreadcrumbs(): Promise<Map<string, Set<string>>> {
  const breadcrumbs = new Map<string, Set<string>>();
  for (const pattern of testGlobs) {
    for await (const file of glob(pattern, { cwd: root })) {
      const contents = await readFile(path.join(root, file), "utf8");
      for (const match of contents.matchAll(breadcrumbPattern)) {
        const files = breadcrumbs.get(match[1]) ?? new Set<string>();
        files.add(file);
        breadcrumbs.set(match[1], files);
      }
    }
  }
  return breadcrumbs;
}

const scenarios = await collectScenarios();
const breadcrumbs = await collectBreadcrumbs();
const missing = scenarios.filter(({ id }) => !breadcrumbs.has(id));
const misplaced = scenarios.filter(({ id, layer }) => {
  const files = breadcrumbs.get(id);
  return files && ![...files].some((file) => layerHomes[layer].test(file));
});
const unknown = [...breadcrumbs.keys()].filter((id) => !scenarios.some((scenario) => scenario.id === id));

if (missing.length || misplaced.length || unknown.length) {
  for (const scenario of missing) console.error(`Missing [spec: ${scenario.id}] (${scenario.file}:${scenario.line}, @${scenario.layer})`);
  for (const scenario of misplaced) {
    console.error(`Misplaced [spec: ${scenario.id}] for @${scenario.layer}: ${[...(breadcrumbs.get(scenario.id) ?? [])].join(", ")}`);
  }
  for (const id of unknown) console.error(`Unknown test breadcrumb [spec: ${id}]`);
  process.exitCode = 1;
} else {
  console.log(`spec coverage OK — ${scenarios.length} scenarios traced`);
}
