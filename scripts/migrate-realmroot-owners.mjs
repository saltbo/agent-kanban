#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER_TABLES = [
  ["boards", "owner_id"],
  ["repositories", "owner_id"],
  ["machines", "owner_id"],
  ["agents", "owner_id"],
  ["subagents", "owner_id"],
  ["board_maintainers", "owner_id"],
  ["ama_agent_sessions", "owner_id"],
  ["github_installations", "owner_id"],
  ["ama_owner_integrations", "tenant_id"],
];

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/migrate-realmroot-owners.mjs --mapping <owners.json> --agent-mapping <agents.json> [--database <name>] (--local|--remote) [--allow-unbound-agents] [--realmroot-cloudflare] [--apply]",
  );
  process.exit(2);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { database: "agent-kanban-db", apply: false, allowUnboundAgents: false, realmrootCloudflare: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mapping") result.mapping = args[++i];
    else if (arg === "--agent-mapping") result.agentMapping = args[++i];
    else if (arg === "--database") result.database = args[++i];
    else if (arg === "--local") result.location = "--local";
    else if (arg === "--remote") result.location = "--remote";
    else if (arg === "--allow-unbound-agents") result.allowUnboundAgents = true;
    else if (arg === "--realmroot-cloudflare") result.realmrootCloudflare = true;
    else if (arg === "--apply") result.apply = true;
    else usage(`Unknown argument: ${arg}`);
  }
  if (!result.mapping || !result.agentMapping || !result.location) usage();
  return result;
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runWrangler(options, extraArgs) {
  const wranglerArgs = [
    "wrangler",
    "d1",
    "execute",
    options.database,
    options.location,
    ...(options.realmrootCloudflare ? ["--config", "apps/web/wrangler.toml"] : []),
    "--json",
    ...extraArgs,
  ];
  const command = options.realmrootCloudflare ? "realmroot" : "pnpm";
  const commandArgs = options.realmrootCloudflare
    ? ["exec", "cloudflare", "--", "npx", ...wranglerArgs]
    : ["--filter", "@agent-kanban/web", "exec", ...wranglerArgs];
  const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed");
  const jsonStart = result.stdout.indexOf("[");
  const jsonEnd = result.stdout.lastIndexOf("]");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`wrangler d1 execute returned no JSON result: ${result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  return batches.flatMap((batch) => batch.results ?? []);
}

function query(options, statement) {
  return runWrangler(options, ["--command", statement]);
}

function loadMapping(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Mapping must be a non-empty JSON array");
  const legacyIds = new Set();
  const entries = raw.map((entry, index) => {
    const { legacyOwnerId, tenantId, subjectId, email = null, name = null, role = "member" } = entry ?? {};
    if (![legacyOwnerId, tenantId, subjectId].every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error(`Mapping entry ${index} requires legacyOwnerId, tenantId, and subjectId`);
    }
    if (email !== null && typeof email !== "string") throw new Error(`Mapping entry ${index} email must be a string or null`);
    if (name !== null && typeof name !== "string") throw new Error(`Mapping entry ${index} name must be a string or null`);
    if (typeof role !== "string" || !role) throw new Error(`Mapping entry ${index} role must be a non-empty string`);
    if (legacyIds.has(legacyOwnerId)) throw new Error(`Duplicate legacyOwnerId: ${legacyOwnerId}`);
    legacyIds.add(legacyOwnerId);
    return { legacyOwnerId, tenantId, subjectId, email, name, role };
  });
  const byLegacyId = new Map(entries.map((entry) => [entry.legacyOwnerId, entry]));
  for (const entry of entries) {
    const targetMapping = byLegacyId.get(entry.tenantId);
    if (entry.tenantId !== entry.legacyOwnerId && targetMapping && targetMapping.tenantId !== targetMapping.legacyOwnerId) {
      throw new Error(
        `Chained owner mapping is not allowed: ${entry.legacyOwnerId} targets source ${entry.tenantId}. Map every legacy owner directly to its final tenant.`,
      );
    }
  }
  return entries;
}

function loadAgentMapping(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Agent mapping must be a JSON array");
  const agentIds = new Set();
  const realmrootIds = new Set();
  return raw.map((entry, index) => {
    const { agentId, realmrootAgentId, credentialRef = null } = entry ?? {};
    if (![agentId, realmrootAgentId].every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error(`Agent mapping entry ${index} requires agentId and realmrootAgentId`);
    }
    if (credentialRef !== null && (typeof credentialRef !== "string" || !/^ama:\/\/vaults\/[^/]+\/credentials\/[^/]+$/.test(credentialRef))) {
      throw new Error(`Invalid AMA Vault credentialRef for Agent ${agentId}`);
    }
    if (agentIds.has(agentId)) throw new Error(`Duplicate agentId: ${agentId}`);
    if (realmrootIds.has(realmrootAgentId)) throw new Error(`Duplicate realmrootAgentId: ${realmrootAgentId}`);
    agentIds.add(agentId);
    realmrootIds.add(realmrootAgentId);
    return { agentId, realmrootAgentId, credentialRef };
  });
}

function discoverBusinessOwners(options) {
  return [
    ...new Set(
      OWNER_TABLES.flatMap(([table, column]) =>
        query(options, `SELECT DISTINCT ${column} AS owner_id FROM ${table} WHERE ${column} IS NOT NULL`).map(
          (row) => row.owner_id,
        ),
      ),
    ),
  ];
}

function countRows(options) {
  return OWNER_TABLES.map(([table]) => {
    const rows = query(options, `SELECT COUNT(*) AS row_count FROM ${table}`);
    const rowCount = rows[0]?.row_count;
    if (rows.length !== 1 || !Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error(`Invalid row count result for ${table}: ${JSON.stringify(rows)}`);
    }
    return { table_name: table, row_count: rowCount };
  });
}

const OWNER_UNIQUE_KEYS = [
  { table: "boards", ownerColumn: "owner_id", columns: ["name"] },
  { table: "repositories", ownerColumn: "owner_id", columns: ["url"] },
  { table: "machines", ownerColumn: "owner_id", columns: ["device_id"] },
  { table: "subagents", ownerColumn: "owner_id", columns: ["username"] },
  { table: "ama_owner_integrations", ownerColumn: "tenant_id", columns: [] },
  {
    table: "agents",
    ownerColumn: "owner_id",
    columns: ["runtime"],
    where: "kind = 'leader' AND version = 'latest'",
  },
];

function assertNoOwnerMergeCollisions(options, mapping) {
  const values = mapping.map((entry) => `(${sql(entry.legacyOwnerId)}, ${sql(entry.tenantId)})`).join(", ");
  for (const { table, ownerColumn, columns, where } of OWNER_UNIQUE_KEYS) {
    const groupColumns = columns.map((column) => `t.${column}`);
    const selectColumns = groupColumns.length > 0 ? `, ${groupColumns.join(", ")}` : "";
    const whereClause = where ? `AND (${where})` : "";
    const collision = query(
      options,
      `WITH owner_mapping(legacy_owner_id, tenant_id) AS (VALUES ${values})
       SELECT m.tenant_id${selectColumns}, COUNT(*) AS row_count
       FROM ${table} t
       JOIN owner_mapping m ON m.legacy_owner_id = t.${ownerColumn}
       WHERE 1 = 1 ${whereClause}
       GROUP BY m.tenant_id${selectColumns}
       HAVING COUNT(*) > 1
       LIMIT 1`,
    )[0];
    if (collision) {
      throw new Error(`Owner merge collision in ${table}: ${JSON.stringify(collision)}`);
    }
  }
}

function migrationSql(mapping, agentMapping) {
  const statements = [];
  for (const entry of mapping) {
    statements.push(`INSERT OR IGNORE INTO realmroot_tenants (id) VALUES (${sql(entry.tenantId)});`);
    statements.push(
      `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role) VALUES (${sql(entry.tenantId)}, ${sql(entry.subjectId)}, ${entry.email === null ? "NULL" : sql(entry.email)}, ${entry.name === null ? "NULL" : sql(entry.name)}, ${sql(entry.role)}) ON CONFLICT(tenant_id, subject_id) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');`,
    );
    statements.push(
      `INSERT INTO realmroot_identity_mappings (legacy_owner_id, tenant_id) VALUES (${sql(entry.legacyOwnerId)}, ${sql(entry.tenantId)}) ON CONFLICT(legacy_owner_id) DO UPDATE SET tenant_id=excluded.tenant_id;`,
    );
  }
  for (const [table, column] of OWNER_TABLES) {
    statements.push(
      `UPDATE ${table} SET ${column} = (SELECT tenant_id FROM realmroot_identity_mappings WHERE legacy_owner_id = ${table}.${column}) WHERE ${column} IN (SELECT legacy_owner_id FROM realmroot_identity_mappings);`,
    );
  }
  for (const entry of agentMapping) {
    statements.push(
      `UPDATE agents SET realmroot_agent_id = ${sql(entry.realmrootAgentId)}, realmroot_credential_ref = ${entry.credentialRef === null ? "NULL" : sql(entry.credentialRef)}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ${sql(entry.agentId)} AND version = 'latest';`,
    );
  }
  statements.push("UPDATE realmroot_identity_mappings SET migrated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');");
  statements.push(
    `DELETE FROM realmroot_tenants
     WHERE id IN (SELECT legacy_owner_id FROM realmroot_identity_mappings WHERE legacy_owner_id <> tenant_id)
       AND id NOT IN (SELECT tenant_id FROM realmroot_identity_mappings);`,
  );
  statements.push(
    `DELETE FROM realmroot_tenants
     WHERE id IN (SELECT id FROM user)
       AND id NOT IN (SELECT tenant_id FROM realmroot_identity_mappings)
       AND id NOT IN (SELECT tenant_id FROM realmroot_tenant_members);`,
  );
  return `${statements.join("\n")}\n`;
}

const options = parseArgs();
const mapping = loadMapping(options.mapping);
const agentMapping = loadAgentMapping(options.agentMapping);
const discovered = [
  ...new Set([
    ...query(options, "SELECT id AS owner_id FROM user").map((row) => row.owner_id),
    ...discoverBusinessOwners(options),
  ]),
];
const mapped = new Set(mapping.map((entry) => entry.legacyOwnerId));
const targetTenantIds = new Set(mapping.map((entry) => entry.tenantId));
const missing = discovered.filter((ownerId) => !mapped.has(ownerId) && !targetTenantIds.has(ownerId));
const extra = [...mapped].filter((ownerId) => !discovered.includes(ownerId));
if (missing.length > 0 || extra.length > 0) {
  throw new Error(`Mapping is not exact. Missing: ${missing.join(", ") || "none"}; unknown: ${extra.join(", ") || "none"}`);
}
assertNoOwnerMergeCollisions(options, mapping);

const discoveredAgents = query(options, "SELECT id, kind FROM agents WHERE version = 'latest'");
const mappedAgents = new Set(agentMapping.map((entry) => entry.agentId));
const missingAgents = discoveredAgents.filter((agent) => !mappedAgents.has(agent.id));
const unknownAgents = [...mappedAgents].filter((agentId) => !discoveredAgents.some((agent) => agent.id === agentId));
if ((!options.allowUnboundAgents && missingAgents.length > 0) || unknownAgents.length > 0) {
  throw new Error(
    `Agent mapping is not exact. Missing: ${missingAgents.map((agent) => agent.id).join(", ") || "none"}; unknown: ${unknownAgents.join(", ") || "none"}`,
  );
}
if (options.allowUnboundAgents && missingAgents.length > 0) {
  console.warn(
    `Leaving ${missingAgents.length} legacy Agents unbound. They cannot authenticate until explicitly bound to a Realmroot Agent.`,
  );
}
for (const agent of discoveredAgents) {
  const binding = agentMapping.find((entry) => entry.agentId === agent.id);
  if (!binding && options.allowUnboundAgents) continue;
  if (agent.kind === "worker" && !binding?.credentialRef) throw new Error(`Worker Agent ${agent.id} requires an AMA Vault Realmroot credentialRef`);
}

const beforeCounts = countRows(options);
const generated = migrationSql(mapping, agentMapping);
if (!options.apply) {
  process.stdout.write(generated);
  console.error("Dry run only. Re-run with --apply during the maintenance window after taking a D1 backup.");
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), "ak-realmroot-migration-"));
try {
  const sqlFile = join(tempDir, "owners.sql");
  writeFileSync(sqlFile, generated, { mode: 0o600 });
  runWrangler(options, ["--file", sqlFile]);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const afterCounts = countRows(options);
if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
  throw new Error(`Business row counts changed: before=${JSON.stringify(beforeCounts)} after=${JSON.stringify(afterCounts)}`);
}
const stale = discoverBusinessOwners(options).filter((ownerId) => mapped.has(ownerId) && !targetTenantIds.has(ownerId));
if (stale.length > 0) throw new Error(`Legacy owner ids remain: ${stale.join(", ")}`);
const residualBetterAuthIds = query(
  options,
  "SELECT rt.id FROM realmroot_tenants rt JOIN user u ON u.id = rt.id WHERE rt.id NOT IN (SELECT tenant_id FROM realmroot_identity_mappings)",
);
if (residualBetterAuthIds.length > 0) {
  throw new Error(`Residual Better Auth ids remain: ${residualBetterAuthIds.map((row) => row.id).join(", ")}`);
}
const foreignKeyViolations = query(options, "PRAGMA foreign_key_check");
if (foreignKeyViolations.length > 0) throw new Error(`Foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`);
const migratedAgents = query(
  options,
  "SELECT id, realmroot_agent_id, realmroot_credential_ref FROM agents WHERE version = 'latest'",
);
for (const binding of agentMapping) {
  const migrated = migratedAgents.find((agent) => agent.id === binding.agentId);
  if (
    migrated?.realmroot_agent_id !== binding.realmrootAgentId ||
    (migrated.realmroot_credential_ref ?? null) !== binding.credentialRef
  ) {
    throw new Error(`Realmroot Agent binding was not applied for ${binding.agentId}`);
  }
}
const unboundAgents = migratedAgents.filter((agent) => agent.realmroot_agent_id === null);
const allowedUnboundAgentIds = new Set(options.allowUnboundAgents ? missingAgents.map((agent) => agent.id) : []);
const unexpectedUnboundAgents = unboundAgents.filter((agent) => !allowedUnboundAgentIds.has(agent.id));
if (unexpectedUnboundAgents.length > 0) {
  throw new Error(`Unbound Realmroot Agents remain: ${unexpectedUnboundAgents.map((agent) => agent.id).join(", ")}`);
}
console.log(
  `Migrated ${mapping.length} tenant mappings and ${agentMapping.length} Realmroot Agent bindings; ${unboundAgents.length} legacy Agents remain unbound; row counts and foreign keys are intact.`,
);
