// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type AgentIdentity,
  type PreparedAgent,
  prepareAgent,
  updateAgent,
  updateAgentMetadataAnnotations,
  upsertLatestAgent,
} from "../apps/web/server/agentRepo";
import type { D1 } from "../apps/web/server/db";

/**
 * Minimal in-memory fake for the slice of D1 that agentRepo's upsert path
 * uses: prepare().bind().first()/.all()/.run() plus batch(). Rows are plain
 * objects keyed by column name; SQL is dispatched by shape (INSERT column
 * list, UPDATE SET/WHERE clauses, and the agents-table SELECT predicates the
 * repo issues). Every operation is recorded in `log` so tests can assert on
 * write counts.
 */

type Row = Record<string, unknown>;
type LogEntry = { method: "first" | "all" | "run"; sql: string; binds: unknown[] };

const ZERO_TASK_COUNTS = {
  todo_task_count: 0,
  in_progress_task_count: 0,
  in_review_task_count: 0,
  done_task_count: 0,
  cancelled_task_count: 0,
};
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_micro_usd: 0,
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Parse "col = ?" / "col = 'literal'" predicates out of a WHERE clause. */
function parseConditions(where: string): { col: string; literal?: string }[] {
  return where.split(/\s+AND\s+/i).map((cond) => {
    const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'([^']*)')$/);
    if (!m) throw new Error(`fake D1: unsupported condition "${cond}"`);
    return m[3] !== undefined ? { col: m[1], literal: m[3] } : { col: m[1] };
  });
}

class FakeStatement {
  private binds: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...binds: unknown[]): this {
    this.binds = binds;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.exec(this.sql, this.binds, "first") as T) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.exec(this.sql, this.binds, "all") as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    this.db.exec(this.sql, this.binds, "run");
    return { meta: { changes: 1 } };
  }
  /** Used by batch(): run the statement as a SELECT and wrap the rows. */
  async asBatchResult(): Promise<{ results: unknown[] }> {
    return { results: this.db.exec(this.sql, this.binds, "batch") as unknown[] };
  }
}

class FakeD1 {
  rows: Row[] = [];
  log: LogEntry[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
  async batch(statements: FakeStatement[]): Promise<{ results: unknown[] }[]> {
    return Promise.all(statements.map((s) => s.asBatchResult()));
  }

  exec(rawSql: string, binds: unknown[], method: LogEntry["method"] | "batch"): unknown {
    const sql = normalizeSql(rawSql).replace(/\ba\./g, ""); // strip table alias used by getAgent
    const logMethod = method === "batch" ? "all" : method;
    this.log.push({ method: logMethod, sql, binds });

    if (/^INSERT INTO agents/i.test(sql)) {
      const cols = sql
        .match(/INSERT INTO agents \(([^)]+)\)/i)![1]
        .split(",")
        .map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => {
        row[c] = binds[i];
      });
      this.rows.push(row);
      return undefined;
    }

    if (/^UPDATE agents/i.test(sql)) {
      const setPart = sql.match(/SET (.+) WHERE /i)![1];
      const setCols = setPart.split(",").map((s) => s.trim().match(/^(\w+)\s*=\s*\?$/)![1]);
      const where = sql.slice(sql.indexOf(" WHERE ") + 7);
      const conds = parseConditions(where);
      const whereBinds = binds.slice(setCols.length);
      const target = this.rows.find((r) => conds.every((c, i) => (c.literal !== undefined ? r[c.col] === c.literal : r[c.col] === whereBinds[i])));
      if (!target) throw new Error(`fake D1: UPDATE matched no row (${where})`);
      setCols.forEach((c, i) => {
        target[c] = binds[i];
      });
      return undefined;
    }

    // SELECTs
    if (/ FROM tasks /i.test(sql)) return [ZERO_TASK_COUNTS];
    if (/agent_sessions/i.test(sql)) return [ZERO_USAGE];
    if (/ FROM agents /i.test(sql)) {
      let effectiveBinds = binds;
      if (/last_heartbeat_at >= \?/.test(sql)) effectiveBinds = binds.slice(1); // runtime cutoff bind inside EXISTS
      // lastIndexOf: skip WHERE clauses of EXISTS subqueries, use the outer one
      const where = sql.slice(sql.lastIndexOf(" WHERE ") + 7);
      const conds = parseConditions(where);
      let bindIdx = 0;
      const matches = this.rows.filter((r) =>
        conds.every((c) => {
          if (c.literal !== undefined) return r[c.col] === c.literal;
          return r[c.col] === effectiveBinds[bindIdx++];
        }),
      );
      const rows = matches.map((r) => {
        const clone = structuredClone(r);
        if (/runtime_ready/.test(sql)) clone.runtime_ready = 0;
        return clone;
      });
      return method === "first" ? (rows[0] ?? null) : rows;
    }
    throw new Error(`fake D1: unsupported SQL: ${sql}`);
  }
}

const OWNER = "owner-1";
const identity: AgentIdentity = {
  id: "agent-id-1",
  publicKeyBase64: "cHVibGljLWtleQ==",
  fingerprint: "fp-1",
  privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" } as JsonWebKey,
};

function prepare(username: string, reasoning_effort?: string | null): Promise<PreparedAgent> {
  return prepareAgent(OWNER, { username, runtime: "claude", reasoning_effort: reasoning_effort ?? undefined }, identity);
}

function latestRow(db: FakeD1): Row {
  const row = db.rows.find((r) => r.id === identity.id && r.version === "latest");
  if (!row) throw new Error("no latest row in fake store");
  return row;
}

function latestMetadata(db: FakeD1): Record<string, unknown> {
  return JSON.parse(latestRow(db).metadata as string);
}

const writeOps = (db: FakeD1) => db.log.filter((e) => e.method === "run");

describe("upsertLatestAgent metadata merge + profile idempotency", () => {
  it("preserves metadata.annotations across re-register with a reasoning_effort change", async () => {
    const db = new FakeD1();
    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "high"));
    // Simulate the UI writing annotations into metadata after registration.
    await updateAgentMetadataAnnotations(db as unknown as D1, OWNER, identity.id, { notes: "keep me" });

    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "low"));

    const metadata = latestMetadata(db);
    expect(metadata.annotations).toEqual({ notes: "keep me" });
    expect(metadata.reasoning_effort).toBe("low");
    // A snapshot of the previous profile was inserted before the update.
    expect(db.rows).toHaveLength(2);
    expect(db.rows.some((r) => r.version !== "latest" && r.username === "bot")).toBe(true);
  });

  it("performs no INSERT/UPDATE on idempotent re-register with identical profile", async () => {
    const db = new FakeD1();
    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "high"));
    expect(writeOps(db)).toHaveLength(1); // initial INSERT

    db.log = [];
    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "high"));

    expect(writeOps(db)).toHaveLength(0); // no snapshot INSERT, no UPDATE
    expect(db.rows).toHaveLength(1);
  });

  it("treats a prepared profile without reasoning_effort as unspecified, preserving the stored value", async () => {
    // updateLatestFromPrepared merges metadata rather than replacing it, so a
    // re-register that omits reasoning_effort keeps the UI-set value (and any
    // other keys). Clearing is updateAgent's job — covered below.
    const db = new FakeD1();
    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "high"));
    await updateAgentMetadataAnnotations(db as unknown as D1, OWNER, identity.id, { notes: "keep me" });

    await upsertLatestAgent(db as unknown as D1, await prepare("bot"));

    const metadata = latestMetadata(db);
    expect(metadata.reasoning_effort).toBe("high");
    expect(metadata.annotations).toEqual({ notes: "keep me" });
  });

  it("updateAgent with reasoning_effort: null clears it from metadata while preserving other keys", async () => {
    const db = new FakeD1();
    await upsertLatestAgent(db as unknown as D1, await prepare("bot", "high"));
    await updateAgentMetadataAnnotations(db as unknown as D1, OWNER, identity.id, { notes: "keep me" });

    const updated = await updateAgent(db as unknown as D1, identity.id, { reasoning_effort: null });

    expect(updated).not.toBeNull();
    const metadata = latestMetadata(db);
    expect(metadata).not.toHaveProperty("reasoning_effort");
    expect(metadata.annotations).toEqual({ notes: "keep me" });
  });
});
