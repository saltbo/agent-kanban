// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AmaProjectionError, RealmrootDelegationFailure } from "@server/usecases/ama/failures";
import { ApplicationError } from "@server/usecases/applicationError";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const httpRoot = path.join(root, "server/http");
const rawSql =
  /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*\bSET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|TRIGGER)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX|TRIGGER)\b)/i;
const forbiddenInnerImport =
  /^(?:hono(?:\/|$)|@cloudflare\/|cloudflare:|wrangler(?:\/|$)|miniflare(?:\/|$)|@server\/(?:http|adapters|auth|env|db)(?:\/|$))/;
const cloudflareBinding =
  /^(?:D1(?:Database|PreparedStatement|Result|ExecResult)?|ExecutionContext|KVNamespace|R2(?:Bucket|Object)|Fetcher|AnalyticsEngineDataset|DurableObject(?:Namespace|State|Id|Storage)?)$/;

describe("HTTP route module structure", () => {
  it("keeps app.ts as a composition root without persistence or use-case implementation", async () => {
    const source = await readFile(path.join(httpRoot, "app.ts"), "utf8");

    expect(source).toContain("registerTaskWorkflowRoutes(api)");
    expect(source).toContain("registerTaskResourceRoutes(api)");
    expect(source).toContain("export { api }");
    expect(source).not.toMatch(/@server\/(?:adapters|usecases)\//);
    expect(source).not.toMatch(/\.prepare\(|\bc\.env\.DB\b|\basync function\b/);
  });

  it("keeps all HTTP production modules free of D1 preparation and raw SQL", async () => {
    const httpFiles = (await filesBelow(httpRoot)).filter((file) => file.endsWith(".ts"));
    const violations: string[] = [];
    expect(httpFiles.length).toBeGreaterThan(0);

    for (const file of httpFiles) {
      const source = await readFile(path.join(httpRoot, file), "utf8");
      const analyzed = analyzeSource(source);
      for (const match of analyzed.code.matchAll(/\.\s*prepare\s*\(/g)) {
        violations.push(location(file, source, match.index, "D1 prepare call"));
      }
      for (const literal of analyzed.literals.filter(({ value }) => rawSql.test(value))) {
        violations.push(location(file, source, literal.index, "raw SQL literal"));
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps domain and use cases independent of HTTP, adapters, auth, and runtime bindings", async () => {
    const violations: string[] = [];
    for (const layer of ["server/domain", "server/usecases"]) {
      const directory = path.join(root, layer);
      for (const file of (await filesBelow(directory)).filter((candidate) => candidate.endsWith(".ts"))) {
        const source = await readFile(path.join(directory, file), "utf8");
        const analyzed = analyzeSource(source);
        for (const match of analyzed.commentless.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm)) {
          const moduleName = match[1];
          if (forbiddenInnerImport.test(moduleName)) {
            violations.push(location(`${layer}/${file}`, source, match.index, `forbidden import ${moduleName}`));
          }
        }
        for (const match of analyzed.code.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
          if (cloudflareBinding.test(match[0])) {
            violations.push(location(`${layer}/${file}`, source, match.index, `Cloudflare binding type ${match[0]}`));
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps production adapters independent of Hono HTTP modules", async () => {
    const adaptersRoot = path.join(root, "server/adapters");
    const violations: string[] = [];

    for (const file of (await filesBelow(adaptersRoot)).filter((candidate) => candidate.endsWith(".ts"))) {
      const source = await readFile(path.join(adaptersRoot, file), "utf8");
      const analyzed = analyzeSource(source);
      for (const match of analyzed.commentless.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm)) {
        if (/^hono(?:\/|$)/.test(match[1])) {
          violations.push(location(`server/adapters/${file}`, source, match.index, `forbidden import ${match[1]}`));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the HTTP error handler independent of concrete adapters", async () => {
    const file = "middleware/errorHandler.ts";
    const source = await readFile(path.join(httpRoot, file), "utf8");
    const analyzed = analyzeSource(source);
    const violations = [...analyzed.commentless.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["'](@server\/adapters(?:\/[^"']*)?)["'];?/gm)].map(
      (match) => location(file, source, match.index, `forbidden import ${match[1]}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps use-case errors transport-neutral without numeric status or HTTP response fields", () => {
    const errors = [
      new ApplicationError("invalid-request", "application failure"),
      new AmaProjectionError("invalid-response", "projection failure"),
      new RealmrootDelegationFailure("denied", "delegation failure"),
    ];

    expect(errors.map(({ kind }) => kind)).toEqual(["invalid-request", "invalid-response", "denied"]);
    for (const error of errors) {
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("statusCode");
      expect(error).not.toHaveProperty("response");
    }
  });

  it("keeps the Task workflow entry as a registration-only split-module aggregator", async () => {
    const source = await readFile(path.join(httpRoot, "tasks/routes.ts"), "utf8");

    for (const module of ["assignmentRoutes", "claimRoutes", "cancellationRoutes", "eventRoutes", "reviewRoutes"]) {
      expect(source).toContain(`@server/http/tasks/${module}`);
    }
    expect(source).not.toMatch(/@server\/(?:adapters|usecases)\/|api\.(?:get|put|post|patch|delete)\(|\basync function\b/);
  });
});

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : [relative];
      }),
    )
  ).flat();
}

function analyzeSource(source: string): { code: string; commentless: string; literals: Array<{ index: number; value: string }> } {
  const code = [...source];
  const commentless = [...source];
  const literals: Array<{ index: number; value: string }> = [];
  for (let index = 0; index < source.length; ) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      for (let cursor = index; cursor < stop; cursor++) code[cursor] = commentless[cursor] = " ";
      index = stop;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const found = source.indexOf("*/", index + 2);
      const stop = found === -1 ? source.length : found + 2;
      for (let cursor = index; cursor < stop; cursor++) {
        if (source[cursor] !== "\n") code[cursor] = commentless[cursor] = " ";
      }
      index = stop;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      const start = index;
      index++;
      let value = "";
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index++;
          break;
        }
        value += source[index++];
      }
      literals.push({ index: start, value });
      for (let cursor = start; cursor < index; cursor++) {
        if (source[cursor] !== "\n") code[cursor] = " ";
      }
      continue;
    }
    index++;
  }
  return { code: code.join(""), commentless: commentless.join(""), literals };
}

function location(file: string, source: string, index: number, kind: string): string {
  return `${file}:${source.slice(0, index).split("\n").length} ${kind}`;
}
