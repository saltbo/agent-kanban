// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../apps/web/wrangler.toml", import.meta.url), "utf8");

function tableBody(header: string): string {
  const start = config.indexOf(header);
  if (start === -1) throw new Error(`Missing wrangler table ${header}`);
  const bodyStart = start + header.length;
  const rest = config.slice(bodyStart);
  const nextTable = rest.search(/^\s*\[/m);
  return nextTable === -1 ? rest : rest.slice(0, nextTable);
}

function stringValue(body: string, key: string): string | null {
  return body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
}

function stringArrayValue(body: string, key: string): string[] | null {
  const raw = body.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))?.[1];
  return raw === undefined ? null : [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("production wrangler configuration", () => {
  it("routes the canonical API resource and its descendants to the Worker before SPA assets", () => {
    const workerFirst = stringArrayValue(tableBody("[assets]"), "run_worker_first");

    expect(workerFirst).toEqual(expect.arrayContaining(["/api", "/api/*"]));
    expect(workerFirst?.filter((pattern) => pattern === "/api")).toHaveLength(1);
  });

  it("keeps both production hostnames routed to the worker", () => {
    const productionConfig = config.split("[env.staging]", 1)[0];
    const routes = [...productionConfig.matchAll(/^\[\[routes\]\]\s*\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)].map((match) => ({
      pattern: stringValue(match[1], "pattern"),
      zoneName: stringValue(match[1], "zone_name"),
      customDomain: match[1].match(/^custom_domain\s*=\s*(true|false)/m)?.[1] === "true",
    }));

    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "ak.tftt.cc/*", zoneName: "tftt.cc", customDomain: false },
        { pattern: "agent-kanban.dev", zoneName: null, customDomain: true },
      ]),
    );
  });

  it("pins AMA runner 0.8.1 in production and staging", () => {
    expect(stringValue(tableBody("[vars]"), "AMA_RUNNER_VERSION")).toBe("0.8.1");
    expect(stringValue(tableBody("[env.staging.vars]"), "AMA_RUNNER_VERSION")).toBe("0.8.1");
  });

  it("keeps staging routes explicitly empty", () => {
    const staging = tableBody("[env.staging]");

    expect(stringArrayValue(staging, "routes")).toEqual([]);
    expect(staging).not.toContain("ak.tftt.cc");
    expect(staging).not.toContain("agent-kanban.dev");
  });
});
