// @vitest-environment node

import { readFileSync } from "node:fs";
import { DEFAULT_RUNTIME_SETTINGS } from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";
import { getRuntimeSettings, putRuntimeSettings } from "./ownerSettingsRepo";

class SettingsDb {
  rows = new Map<string, { scheduling: string; runtime: string; updated_at: string }>();

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...bound: unknown[]) => {
        values = bound;
        return this.prepareBound(sql, () => values);
      },
    };
  }

  private prepareBound(sql: string, values: () => unknown[]) {
    return {
      first: async <T>() => {
        const ownerId = String(values()[0]);
        const row = this.rows.get(ownerId);
        if (!row) return null;
        if (sql.includes("SELECT runtime")) return { runtime: row.runtime } as T;
        if (sql.includes("SELECT scheduling")) return { scheduling: row.scheduling } as T;
        throw new Error(`Unexpected SELECT: ${sql}`);
      },
      run: async () => {
        const [ownerValue, jsonValue, updatedAtValue] = values();
        const ownerId = String(ownerValue);
        const existing = this.rows.get(ownerId) ?? { scheduling: "{}", runtime: "{}", updated_at: "" };
        if (sql.includes("runtime, updated_at")) existing.runtime = String(jsonValue);
        else if (sql.includes("scheduling, updated_at")) existing.scheduling = String(jsonValue);
        else throw new Error(`Unexpected write: ${sql}`);
        existing.updated_at = String(updatedAtValue);
        this.rows.set(ownerId, existing);
        return { success: true };
      },
    };
  }
}

describe("owner runtime settings repository", () => {
  it("returns defaults for missing and malformed rows", async () => {
    const db = new SettingsDb();
    await expect(getRuntimeSettings(db as any, "missing")).resolves.toEqual(DEFAULT_RUNTIME_SETTINGS);

    db.rows.set("broken", { scheduling: "{}", runtime: "not-json", updated_at: "" });
    const result = await getRuntimeSettings(db as any, "broken");
    expect(result).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it("round-trips normalized runtime settings without overwriting scheduling", async () => {
    const db = new SettingsDb();
    db.rows.set("owner-1", { scheduling: '{"timezone":"UTC"}', runtime: "{}", updated_at: "old" });
    const settings = { skill_cache_auto_update: false, skill_cache_refresh_hours: 48 };

    await putRuntimeSettings(db as any, "owner-1", settings);

    await expect(getRuntimeSettings(db as any, "owner-1")).resolves.toEqual(settings);
    expect(db.rows.get("owner-1")?.scheduling).toBe('{"timezone":"UTC"}');
  });
});

describe("runtime settings route contract", () => {
  const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");

  it.each(["get", "put"])("requires user identity for %s /api/settings/runtime", (method) => {
    const match = routes.match(new RegExp(`api\\.${method}\\("/api/settings/runtime",[\\s\\S]*?\\n\\}\\);`));
    expect(match?.[0]).toContain('c.get("identityType") !== "user"');
    expect(match?.[0]).toContain('HTTPException(403, { message: "User identity required" })');
  });

  it("validates and normalizes PUT payloads before persistence", () => {
    const block = routes.match(/api\.put\("\/api\/settings\/runtime",[\s\S]*?\n\}\);/)?.[0] ?? "";
    expect(block).toContain("validateRuntimeSettings(body)");
    expect(block).toContain("normalizeRuntimeSettings(body)");
    expect(block.indexOf("validateRuntimeSettings(body)")).toBeLessThan(block.indexOf("putRuntimeSettings"));
  });

  it("piggybacks runtime_settings together with scheduling on heartbeat", () => {
    const block = routes.match(/api\.post\("\/api\/machines\/:id\/heartbeat",[\s\S]*?\n\}\);/)?.[0] ?? "";
    expect(block).toContain('getRuntimeSettings(c.env.DB, c.get("ownerId"))');
    expect(block).toContain("return c.json({ ...publicMachine(updated), scheduling, runtime_settings })");
  });
});
