import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const validEntrypoints = new Set(["product-ui", "toolbox", "public-http", "http", "webhook", "deployment"]);
const validProofs = new Set(["unit", "integration", "e2e"]);
const scenarioPattern = /^\s*@journey:([a-z0-9-]+\/[a-z0-9-]+)\s+@entrypoint:([a-z0-9-]+)\s+@proof:([a-z0-9-]+)\s*$/;
const breadcrumbPattern = /\[spec:\s*([a-z0-9-]+\/[a-z0-9-]+)\s*\]/g;
const testGlobs = ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "tests/**/*.spec.ts"];
const testModifiers = new Set(["concurrent", "each", "fails", "only", "runIf", "skip", "skipIf", "todo"]);
const parameterizedModifiers = new Set(["each", "runIf", "skipIf"]);
const layerHomes: Record<string, RegExp> = {
  unit: /^(?:server\/(?:domain|usecases)\/.*\.test\.ts|src\/.*\.test\.(?:ts|tsx)|tests\/unit\/.*\.test\.(?:ts|tsx))$/,
  integration: /^(?:server\/(?:adapters|http)\/.*\.test\.ts|tests\/(?:integration|contract)\/.*\.test\.(?:ts|tsx)|tests\/[^/]+\.test\.(?:ts|tsx))$/,
  e2e: /^tests\/e2e\/.*\.spec\.ts$/,
};

interface Scenario {
  id: string;
  proof: string;
  file: string;
  line: number;
}

async function collectScenarios(root: string): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();
  for await (const file of glob("spec/*.feature", { cwd: root })) {
    const lines = (await readFile(path.join(root, file), "utf8")).split(/\r?\n/);
    let metadataCount = 0;
    for (const [index, line] of lines.entries()) {
      if (!line.trimStart().startsWith("@")) continue;
      metadataCount += 1;
      const match = line.match(scenarioPattern);
      if (!match || !validEntrypoints.has(match[2]) || !validProofs.has(match[3])) {
        throw new Error(`${file}:${index + 1} must have one journey, entrypoint, and canonical proof tag`);
      }
      const nextLine = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
      if (!nextLine?.trimStart().startsWith("Scenario:")) {
        throw new Error(`${file}:${index + 1} scenario metadata must immediately precede a Scenario`);
      }
      if (seen.has(match[1])) throw new Error(`Duplicate scenario id ${match[1]} at ${file}:${index + 1}`);
      const capability = path.basename(file, ".feature");
      if (!match[1].startsWith(`${capability}/`)) {
        throw new Error(`${file}:${index + 1} journey ${match[1]} must belong to capability ${capability}`);
      }
      seen.add(match[1]);
      scenarios.push({ id: match[1], proof: match[3], file, line: index + 1 });
    }
    const scenarioCount = lines.filter((line) => line.trimStart().startsWith("Scenario:")).length;
    if (metadataCount !== scenarioCount) {
      throw new Error(`${file} has ${scenarioCount} Scenarios but ${metadataCount} metadata declarations`);
    }
  }
  return scenarios;
}

async function collectBreadcrumbs(root: string): Promise<Map<string, Set<string>>> {
  const breadcrumbs = new Map<string, Set<string>>();
  for (const pattern of testGlobs) {
    for await (const file of glob(pattern, { cwd: root })) {
      const contents = await readFile(path.join(root, file), "utf8");
      for (const title of collectTestTitles(contents)) {
        for (const match of title.matchAll(breadcrumbPattern)) {
          const files = breadcrumbs.get(match[1]) ?? new Set<string>();
          files.add(file);
          breadcrumbs.set(match[1], files);
        }
      }
    }
  }
  return breadcrumbs;
}

interface Token {
  kind: "identifier" | "string" | "punctuation";
  value: string;
}

function collectTestTitles(contents: string): string[] {
  const tokens = tokenize(contents);

  const titles: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const root = tokens[index];
    if (root.kind !== "identifier" || (root.value !== "it" && root.value !== "test")) continue;
    let cursor = index + 1;
    let valid = true;
    while (tokens[cursor]?.value === ".") {
      const modifier = tokens[cursor + 1];
      if (modifier?.kind !== "identifier" || !testModifiers.has(modifier.value)) {
        valid = false;
        break;
      }
      cursor += 2;
      if (parameterizedModifiers.has(modifier.value) && tokens[cursor]?.value === "(") {
        cursor = afterBalancedParentheses(tokens, cursor);
      }
    }
    if (!valid || tokens[cursor]?.value !== "(") continue;
    const title = tokens[cursor + 1];
    if (title?.kind === "string") titles.push(title.value);
  }
  return titles;
}

function afterBalancedParentheses(tokens: Token[], start: number): number {
  let depth = 0;
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === "(") depth += 1;
    if (tokens[cursor].value === ")") depth -= 1;
    if (depth === 0) return cursor + 1;
  }
  return tokens.length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let value = "";
      let interpolated = false;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          value += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{") interpolated = true;
        if (source[index] === quote) {
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      if (!interpolated) tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: char });
    index += 1;
  }
  return tokens;
}

export async function checkSpecCoverage(root: string): Promise<number> {
  const scenarios = await collectScenarios(root);
  const breadcrumbs = await collectBreadcrumbs(root);
  const missing = scenarios.filter(({ id }) => !breadcrumbs.has(id));
  const misplaced = scenarios.filter(({ id, proof }) => {
    const files = breadcrumbs.get(id);
    return files && ![...files].some((file) => layerHomes[proof].test(file));
  });
  const unknown = [...breadcrumbs.keys()].filter((id) => !scenarios.some((scenario) => scenario.id === id));
  const failures: string[] = [];

  for (const scenario of missing) {
    failures.push(`Missing [spec: ${scenario.id}] (${scenario.file}:${scenario.line}, @proof:${scenario.proof})`);
  }
  for (const scenario of misplaced) {
    failures.push(`Misplaced [spec: ${scenario.id}] for @proof:${scenario.proof}: ${[...(breadcrumbs.get(scenario.id) ?? [])].join(", ")}`);
  }
  for (const id of unknown) failures.push(`Unknown test breadcrumb [spec: ${id}]`);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return scenarios.length;
}

async function run(): Promise<void> {
  try {
    const count = await checkSpecCoverage(path.resolve(import.meta.dirname, ".."));
    console.log(`spec coverage OK — ${count} scenarios traced`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run();
}
