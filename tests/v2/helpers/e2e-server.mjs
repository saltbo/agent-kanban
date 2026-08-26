import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const port = process.argv[process.argv.indexOf("--port") + 1] ?? "6265";
const state = mkdtempSync(resolve(tmpdir(), "ak-v2-e2e-"));
const ama = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/v1/agents/agent-e2e") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        metadata: { uid: "agent-e2e", projectId: "project-e2e" },
        identity: { issuer: "http://127.0.0.1:8/api/auth", subject: "agent-e2e", runtime: "ama" },
        spec: { runtime: "codex" },
        status: { phase: "active", ready: true },
      }),
    );
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  ama.once("error", reject);
  ama.listen(0, "127.0.0.1", resolve);
});
const amaAddress = ama.address();
if (!amaAddress || typeof amaAddress === "string") throw new Error("E2E AMA server did not expose a TCP address");
const amaOrigin = `http://127.0.0.1:${amaAddress.port}`;
const sourceConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, "wrangler.ak-e2e.jsonc"), "utf8"));
sourceConfig.main = resolve(root, "apps/web/worker/index.ts");
sourceConfig.d1_databases[0].migrations_dir = resolve(root, "apps/web/migrations");
sourceConfig.vars = {
  ...sourceConfig.vars,
  AK_API_URL: `http://127.0.0.1:${port}`,
  AK_RESOURCE: `http://127.0.0.1:${port}/api`,
  AMA_ORIGIN: amaOrigin,
  AMA_RESOURCE: `${amaOrigin}/api`,
  AMA_DEV_ACCESS_TOKEN: "e2e-ama-token",
};
const config = resolve(state, "wrangler.ak-e2e.json");
writeFileSync(config, JSON.stringify(sourceConfig));
const seed = resolve(state, "seed.sql");
writeFileSync(
  seed,
  `INSERT INTO tenants (id) VALUES ('tenant-e2e');
INSERT INTO web_sessions (id, token_hash, tenant_id, subject_id, email, name, role, scopes_json, csrf_token, expires_at)
VALUES ('session-e2e', 'c258a7f80311b9a8c6ed537658edb18333bbfe7428102e90e0b254a1fb2f834e', 'tenant-e2e', 'controller-e2e', 'controller@example.test', 'Test Controller', 'admin', '["boards:read","boards:write","tasks:read","tasks:write","memberships:read","memberships:write","repositories:read","repositories:write","execution:read","execution:write","work:read","work:write","reviews:read","reviews:write"]', 'csrf-e2e', '2099-01-01T00:00:00.000Z');
INSERT INTO ama_grants
 (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce, access_token_ciphertext, access_token_nonce, access_token_expires_at)
VALUES ('tenant-e2e', 'controller-e2e', 'unused', 'unused', 'unused', 'unused', '2099-01-01T00:00:00.000Z');
INSERT INTO boards (id, tenant_id, name, description) VALUES
 ('board-main', 'tenant-e2e', 'V2 Delivery', 'End-to-end board'),
 ('board-empty', 'tenant-e2e', 'Empty Board', 'No tasks yet');
INSERT INTO tasks (id, tenant_id, board_id, title, description, status, priority, created_by_subject) VALUES
 ('task-todo', 'tenant-e2e', 'board-main', 'Plan release', 'Prepare the release notes.', 'todo', 10, 'controller-e2e'),
 ('task-working', 'tenant-e2e', 'board-main', 'Run verification', 'Execute all gates.', 'in_progress', 20, 'controller-e2e'),
 ('task-reject', 'tenant-e2e', 'board-main', 'Review rejection', 'Return this submission.', 'in_review', 30, 'controller-e2e'),
 ('task-accept', 'tenant-e2e', 'board-main', 'Review acceptance', 'Accept this submission.', 'in_review', 40, 'controller-e2e'),
 ('task-done', 'tenant-e2e', 'board-main', 'Archive v1', 'Historical source is unmounted.', 'done', 0, 'controller-e2e');
INSERT INTO ama_connections (id, tenant_id, resource_url, project_uri, authorized_subject_id) VALUES
 ('ama-e2e', 'tenant-e2e', '${amaOrigin}/api', '${amaOrigin}/api/v1/projects/project-e2e', 'controller-e2e');
INSERT INTO board_execution_bindings (id, tenant_id, board_id, ama_connection_id) VALUES
 ('binding-e2e', 'tenant-e2e', 'board-main', 'ama-e2e');
INSERT INTO board_memberships (id, tenant_id, board_id, agent_id, capabilities_json) VALUES
 ('membership-e2e', 'tenant-e2e', 'board-main', 'agent-e2e', '["work"]');
INSERT INTO task_assignments (id, tenant_id, task_id, agent_id) VALUES
 ('assignment-working', 'tenant-e2e', 'task-working', 'agent-e2e'),
 ('assignment-reject', 'tenant-e2e', 'task-reject', 'agent-e2e'),
 ('assignment-accept', 'tenant-e2e', 'task-accept', 'agent-e2e');
INSERT INTO task_runs (id, tenant_id, task_id, assignment_id, status) VALUES
 ('run-working', 'tenant-e2e', 'task-working', 'assignment-working', 'running'),
 ('run-reject', 'tenant-e2e', 'task-reject', 'assignment-reject', 'succeeded'),
 ('run-accept', 'tenant-e2e', 'task-accept', 'assignment-accept', 'succeeded');
INSERT INTO task_progress_entries (id, tenant_id, task_id, run_id, kind, body) VALUES
 ('progress-working', 'tenant-e2e', 'task-working', 'run-working', 'checkpoint', 'Vitest and Playwright are green.');
INSERT INTO task_messages (id, tenant_id, task_id, sender_issuer, sender_subject, body, delivery_status) VALUES
 ('message-working', 'tenant-e2e', 'task-working', 'http://realmroot.test/api/auth', 'agent-e2e', 'Verification is running.', 'delivered');
INSERT INTO task_submissions (id, tenant_id, task_id, run_id, summary, artifact_urls_json, status) VALUES
 ('submission-reject', 'tenant-e2e', 'task-reject', 'run-reject', 'Missing failure proof.', '[]', 'pending_review'),
 ('submission-accept-history', 'tenant-e2e', 'task-accept', 'run-accept', 'Earlier review attempt.', '["https://example.test/artifacts/verification.txt"]', 'accepted'),
 ('submission-accept', 'tenant-e2e', 'task-accept', 'run-accept', 'All acceptance checks pass.', '[]', 'pending_review');
INSERT INTO task_reviews (id, tenant_id, task_id, submission_id, reviewer_issuer, reviewer_subject, decision, body) VALUES
 ('review-accept-history', 'tenant-e2e', 'task-accept', 'submission-accept-history', 'http://realmroot.test/api/auth', 'controller-e2e', 'accepted', 'Historical proof verified.');
`,
);

function run(args) {
  const result = spawnSync("pnpm", args, { cwd: root, env: process.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
}

run([
  "--filter",
  "@agent-kanban/web",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "agent-kanban-v2-e2e",
  "--local",
  "--config",
  config,
  "--persist-to",
  state,
]);
run([
  "--filter",
  "@agent-kanban/web",
  "exec",
  "wrangler",
  "d1",
  "execute",
  "agent-kanban-v2-e2e",
  "--local",
  "--config",
  config,
  "--persist-to",
  state,
  "--file",
  seed,
]);

const child = spawn(
  "pnpm",
  ["--filter", "@agent-kanban/web", "exec", "vite", "dev", "--config", "vite.e2e.config.ts", "--host", "127.0.0.1", "--port", port],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_PORT: port, AK_E2E_STATE: state, AK_E2E_WRANGLER_CONFIG: config },
  },
);

function stop(signal) {
  child.kill(signal);
  ama.close();
  rmSync(state, { recursive: true, force: true });
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code) => {
  ama.close();
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 1);
});
