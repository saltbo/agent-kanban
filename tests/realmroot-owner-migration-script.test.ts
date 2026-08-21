// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/migrate-realmroot-owners.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Realmroot owner migration script", () => {
  it.each([
    ["email", 42, "email must be a string or null"],
    ["name", { unexpected: true }, "name must be a string or null"],
    ["role", null, "role must be a non-empty string"],
    ["role", "", "role must be a non-empty string"],
  ])("rejects an invalid optional %s mapping field", (field, value, expectedMessage) => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a", [field]: value }]));
    writeFileSync(agentsPath, "[]");

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Mapping entry 0 ${expectedMessage}`);
  });

  it("retains a canonical target that is also a historical Better Auth tenant", async () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(
      mappingPath,
      JSON.stringify([
        { legacyOwnerId: "legacy-a", tenantId: "canonical-b", subjectId: "subject-a", email: "a@example.test" },
        { legacyOwnerId: "canonical-b", tenantId: "canonical-b", subjectId: "subject-b", name: "B", role: "admin" },
      ]),
    );
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);

    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "migration-script-test" },
    });
    try {
      const db = await mf.getD1Database("DB");
      await createMigrationSchema(db);
      for (const statement of result.stdout
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await db.prepare(statement).run();
      }

      const tenants = await db.prepare("SELECT id FROM realmroot_tenants ORDER BY id").all<{ id: string }>();
      expect(tenants.results.map(({ id }) => id)).toEqual(["canonical-b"]);
      await expect(db.prepare("SELECT owner_id FROM boards").first<{ owner_id: string }>()).resolves.toEqual({ owner_id: "canonical-b" });
    } finally {
      await mf.dispose();
    }
  });

  it("rejects a mapping target that is another non-canonical legacy source", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(
      mappingPath,
      JSON.stringify([
        { legacyOwnerId: "legacy-a", tenantId: "canonical-b", subjectId: "subject-a" },
        { legacyOwnerId: "canonical-b", tenantId: "canonical-c", subjectId: "subject-b" },
      ]),
    );
    writeFileSync(agentsPath, "[]");

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Chained owner mapping is not allowed");
  });

  it("requires an authoritative mapping for an inactive Better Auth user", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        AK_TEST_OWNER_IDS: "legacy-a,inactive-user",
        AK_TEST_BUSINESS_OWNER_IDS: "legacy-a",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Mapping is not exact. Missing: inactive-user");
    expect(result.stdout).toBe("");
  });

  it("creates the inactive user's tenant membership and does not report it as a stale business owner", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(
      mappingPath,
      JSON.stringify([
        { legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" },
        {
          legacyOwnerId: "inactive-user",
          tenantId: "tenant-inactive",
          subjectId: "subject-inactive",
          email: "inactive@example.test",
          name: "Inactive User",
          role: "member",
        },
      ]),
    );
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);
    const processEnv = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      AK_TEST_OWNER_IDS: "legacy-a,inactive-user",
      AK_TEST_BUSINESS_OWNER_IDS: "legacy-a",
      AK_TEST_POST_BUSINESS_OWNER_IDS: "tenant-a",
      AK_TEST_APPLY_MARKER: join(directory, "applied"),
    };

    const dryRun = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: processEnv,
    });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("INSERT OR IGNORE INTO realmroot_tenants (id) VALUES ('tenant-inactive')");
    expect(dryRun.stdout).toContain(
      "INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role) VALUES ('tenant-inactive', 'subject-inactive', 'inactive@example.test', 'Inactive User', 'member')",
    );

    const applied = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--apply"], {
      encoding: "utf8",
      env: processEnv,
    });
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Migrated 2 tenant mappings and 0 Realmroot Agent bindings");
    expect(applied.stderr).not.toContain("Legacy owner ids remain");
  });

  it("rejects missing authoritative Agent bindings by default", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: migrationEnvironment(directory, [{ id: "legacy-agent", kind: "leader" }]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Agent mapping is not exact. Missing: legacy-agent; unknown: none");
    expect(result.stdout).toBe("");
  });

  it("allows explicitly unbound legacy Agents without fabricating Realmroot bindings", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(
      process.execPath,
      [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--allow-unbound-agents"],
      {
        encoding: "utf8",
        env: migrationEnvironment(directory, [
          { id: "legacy-leader", kind: "leader" },
          { id: "legacy-worker", kind: "worker" },
        ]),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Leaving 2 legacy Agents unbound. They cannot authenticate until explicitly bound to a Realmroot Agent.");
    expect(result.stdout).toContain("UPDATE agents SET owner_id");
    expect(result.stdout).not.toContain("UPDATE agents SET realmroot_agent_id");
    expect(result.stdout).not.toContain("legacy-leader");
    expect(result.stdout).not.toContain("legacy-worker");
  });

  it("reports unbound legacy Agents after an explicitly allowed apply", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(
      process.execPath,
      [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--allow-unbound-agents", "--apply"],
      {
        encoding: "utf8",
        env: migrationEnvironment(directory, [
          { id: "legacy-leader", kind: "leader" },
          { id: "legacy-worker", kind: "worker" },
        ]),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Migrated 1 tenant mappings and 0 Realmroot Agent bindings; 2 legacy Agents remain unbound; row counts and foreign keys are intact.",
    );
  });

  it("rejects unknown Agent mappings even when unbound legacy Agents are allowed", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, JSON.stringify([{ agentId: "unknown-agent", realmrootAgentId: "rr:unknown-agent" }]));
    installFakePnpm(directory);

    const result = spawnSync(
      process.execPath,
      [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--allow-unbound-agents"],
      {
        encoding: "utf8",
        env: migrationEnvironment(directory, []),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Agent mapping is not exact. Missing: none; unknown: unknown-agent");
    expect(result.stdout).toBe("");
  });

  it("runs remote D1 commands through the Realmroot Cloudflare resource", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    const commandLogPath = join(directory, "realmroot-commands.jsonl");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakeMigrationCommand(directory, "realmroot");

    const result = spawnSync(
      process.execPath,
      [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--database", "ak-production", "--remote", "--realmroot-cloudflare"],
      {
        encoding: "utf8",
        env: { ...migrationEnvironment(directory, []), AK_TEST_COMMAND_LOG: commandLogPath },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(commandLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands).not.toHaveLength(0);
    for (const command of commands) {
      expect(command.slice(0, 12)).toEqual([
        "exec",
        "cloudflare",
        "--",
        "npx",
        "wrangler",
        "d1",
        "execute",
        "ak-production",
        "--remote",
        "--config",
        "apps/web/wrangler.toml",
        "--json",
      ]);
      expect(command).toContain("--command");
    }
  });

  it("parses Wrangler JSON surrounded by progress output and completes post-apply validation", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--apply"], {
      encoding: "utf8",
      env: {
        ...migrationEnvironment(directory, []),
        AK_TEST_WRANGLER_PREFIX: "├ Checking if file needs uploading\n",
        AK_TEST_WRANGLER_SUFFIX: "\nUploaded and executed\n",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Migrated 1 tenant mappings and 0 Realmroot Agent bindings; 0 legacy Agents remain unbound; row counts and foreign keys are intact.",
    );
  });

  it("fails fast when Wrangler exits successfully without a JSON result", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: { ...migrationEnvironment(directory, []), AK_TEST_WRANGLER_NO_JSON: "1" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wrangler d1 execute returned no JSON result");
    expect(result.stderr).toContain("Checking if file needs uploading");
    expect(result.stdout).toBe("");
  });

  it("reruns apply and completes validation after the migration SQL was already committed", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    const migratedAgent = {
      id: "already-mapped-agent",
      realmroot_agent_id: "rr:already-mapped-agent",
      realmroot_credential_ref: null,
    };
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(
      agentsPath,
      JSON.stringify([{ agentId: migratedAgent.id, realmrootAgentId: migratedAgent.realmroot_agent_id, credentialRef: null }]),
    );
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--apply"], {
      encoding: "utf8",
      env: {
        ...migrationEnvironment(directory, [{ id: migratedAgent.id, kind: "leader" }]),
        AK_TEST_BUSINESS_OWNER_IDS: "tenant-a",
        AK_TEST_POST_BUSINESS_OWNER_IDS: "tenant-a",
        AK_TEST_MIGRATED_AGENTS: JSON.stringify([migratedAgent]),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Migrated 1 tenant mappings and 1 Realmroot Agent bindings; 0 legacy Agents remain unbound; row counts and foreign keys are intact.",
    );
  });

  it("fails when a declared Realmroot Agent mapping was not applied", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, JSON.stringify([{ agentId: "mapped-agent", realmrootAgentId: "rr:mapped-agent" }]));
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--apply"], {
      encoding: "utf8",
      env: migrationEnvironment(directory, [{ id: "mapped-agent", kind: "leader" }]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Realmroot Agent binding was not applied for mapped-agent");
  });

  it("fails when a business table row count changes during apply", () => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local", "--apply"], {
      encoding: "utf8",
      env: { ...migrationEnvironment(directory, []), AK_TEST_COUNT_CHANGE_TABLE: "boards" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Business row counts changed");
    expect(result.stderr).toContain('"table_name":"boards","row_count":1');
    expect(result.stderr).toContain('"table_name":"boards","row_count":2');
  });

  it.each([
    ["an empty result", []],
    ["duplicate rows", [{ row_count: 0 }, { row_count: 0 }]],
    ["a negative count", [{ row_count: -1 }]],
    ["an unsafe integer", [{ row_count: Number.MAX_SAFE_INTEGER + 1 }]],
  ])("fails when a table count query returns %s", (_case, countResult) => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(mappingPath, JSON.stringify([{ legacyOwnerId: "legacy-a", tenantId: "tenant-a", subjectId: "subject-a" }]));
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: {
        ...migrationEnvironment(directory, []),
        AK_TEST_INVALID_COUNT_TABLE: "boards",
        AK_TEST_INVALID_COUNT_RESULT: JSON.stringify(countResult),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Invalid row count result for boards: ${JSON.stringify(countResult)}`);
    expect(result.stdout).toBe("");
  });

  it.each([
    "boards",
    "repositories",
    "machines",
    "subagents",
    "ama_owner_integrations",
    "agents",
  ])("fails before emitting migration SQL when %s has an owner-merge collision", (table) => {
    const directory = temporaryDirectory();
    const mappingPath = join(directory, "owners.json");
    const agentsPath = join(directory, "agents.json");
    writeFileSync(
      mappingPath,
      JSON.stringify([
        { legacyOwnerId: "legacy-a", tenantId: "canonical", subjectId: "subject-a" },
        { legacyOwnerId: "legacy-b", tenantId: "canonical", subjectId: "subject-b" },
      ]),
    );
    writeFileSync(agentsPath, "[]");
    installFakePnpm(directory);

    const result = spawnSync(process.execPath, [script, "--mapping", mappingPath, "--agent-mapping", agentsPath, "--local"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, AK_TEST_COLLISION_TABLE: table },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Owner merge collision in ${table}`);
    expect(result.stdout).toBe("");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ak-owner-migration-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function migrationEnvironment(directory: string, agents: Array<{ id: string; kind: string }>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    AK_TEST_OWNER_IDS: "legacy-a",
    AK_TEST_BUSINESS_OWNER_IDS: "legacy-a",
    AK_TEST_POST_BUSINESS_OWNER_IDS: "tenant-a",
    AK_TEST_APPLY_MARKER: join(directory, "applied"),
    AK_TEST_AGENTS: JSON.stringify(agents),
  };
}

function installFakePnpm(directory: string): void {
  installFakeMigrationCommand(directory, "pnpm");
}

function installFakeMigrationCommand(directory: string, command: string): void {
  const executable = join(directory, command);
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
if (process.env.AK_TEST_COMMAND_LOG) appendFileSync(process.env.AK_TEST_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.AK_TEST_APPLY_MARKER && process.argv.includes("--file")) writeFileSync(process.env.AK_TEST_APPLY_MARKER, "applied");
const statement = process.argv.at(-1) ?? "";
let results = [];
const countMatch = statement.trim().match(/^SELECT COUNT\\(\\*\\) AS row_count FROM ([a-z_]+)$/);
if (countMatch) {
  const table = countMatch[1];
  if (table === process.env.AK_TEST_INVALID_COUNT_TABLE) {
    results = JSON.parse(process.env.AK_TEST_INVALID_COUNT_RESULT ?? "[]");
  } else {
    const applied = process.env.AK_TEST_APPLY_MARKER && existsSync(process.env.AK_TEST_APPLY_MARKER);
    const row_count = table === process.env.AK_TEST_COUNT_CHANGE_TABLE ? (applied ? 2 : 1) : 0;
    results = [{ row_count }];
  }
} else if (process.env.AK_TEST_COLLISION_TABLE && statement.includes("FROM " + process.env.AK_TEST_COLLISION_TABLE + " t")) {
  results = [{ tenant_id: "canonical", row_count: 2 }];
} else if (statement.trim() === "SELECT id AS owner_id FROM user") {
  const defaults = process.env.AK_TEST_COLLISION_TABLE ? "legacy-a,legacy-b" : "legacy-a,canonical-b";
  results = (process.env.AK_TEST_OWNER_IDS ?? defaults).split(",").filter(Boolean).map((owner_id) => ({ owner_id }));
} else if (statement.includes(" AS owner_id FROM ")) {
  const defaults = process.env.AK_TEST_COLLISION_TABLE ? "legacy-a,legacy-b" : "legacy-a,canonical-b";
  const applied = process.env.AK_TEST_APPLY_MARKER && existsSync(process.env.AK_TEST_APPLY_MARKER);
  const ownerIds = applied ? process.env.AK_TEST_POST_BUSINESS_OWNER_IDS : process.env.AK_TEST_BUSINESS_OWNER_IDS;
  results = (ownerIds ?? defaults).split(",").filter(Boolean).map((owner_id) => ({ owner_id }));
}
else if (statement.includes("SELECT id, kind FROM agents")) results = JSON.parse(process.env.AK_TEST_AGENTS ?? "[]");
else if (statement.includes("realmroot_agent_id, realmroot_credential_ref FROM agents")) {
  results = process.env.AK_TEST_MIGRATED_AGENTS
    ? JSON.parse(process.env.AK_TEST_MIGRATED_AGENTS)
    : JSON.parse(process.env.AK_TEST_AGENTS ?? "[]").map(({ id }) => ({
        id,
        realmroot_agent_id: null,
        realmroot_credential_ref: null,
      }));
}
if (process.env.AK_TEST_WRANGLER_NO_JSON) {
  process.stdout.write("├ Checking if file needs uploading\\nNo structured result\\n");
} else {
  process.stdout.write(
    (process.env.AK_TEST_WRANGLER_PREFIX ?? "") +
      JSON.stringify([{ results }]) +
      (process.env.AK_TEST_WRANGLER_SUFFIX ?? ""),
  );
}
`,
  );
  chmodSync(executable, 0o755);
}

async function createMigrationSchema(db: D1Database): Promise<void> {
  const statements = [
    "CREATE TABLE realmroot_tenants (id TEXT PRIMARY KEY)",
    "INSERT INTO realmroot_tenants (id) VALUES ('legacy-a'), ('canonical-b'), ('orphan-ba-user')",
    "CREATE TABLE user (id TEXT PRIMARY KEY)",
    "INSERT INTO user (id) VALUES ('legacy-a'), ('canonical-b'), ('orphan-ba-user')",
    `CREATE TABLE realmroot_tenant_members (
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      role TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (tenant_id, subject_id)
    )`,
    `CREATE TABLE realmroot_identity_mappings (
      legacy_owner_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      migrated_at TEXT
    )`,
    "CREATE TABLE boards (owner_id TEXT)",
    "INSERT INTO boards (owner_id) VALUES ('legacy-a')",
    "CREATE TABLE repositories (owner_id TEXT)",
    "CREATE TABLE machines (owner_id TEXT)",
    `CREATE TABLE agents (
      id TEXT,
      owner_id TEXT,
      version TEXT,
      realmroot_agent_id TEXT,
      realmroot_credential_ref TEXT,
      updated_at TEXT
    )`,
    "CREATE TABLE subagents (owner_id TEXT)",
    "CREATE TABLE gpg_keys (owner_id TEXT)",
    "CREATE TABLE board_maintainers (owner_id TEXT)",
    "CREATE TABLE ama_agent_sessions (owner_id TEXT)",
    "CREATE TABLE github_installations (owner_id TEXT)",
    "CREATE TABLE ama_owner_integrations (tenant_id TEXT)",
  ];
  for (const statement of statements) await db.prepare(statement).run();
}
