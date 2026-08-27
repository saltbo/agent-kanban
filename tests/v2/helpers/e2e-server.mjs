import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const root = resolve(import.meta.dirname, "../../..");
const port = process.argv[process.argv.indexOf("--port") + 1] ?? "6265";
const state = mkdtempSync(resolve(tmpdir(), "ak-v2-e2e-"));
const signing = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: "e2e", use: "sig", alg: "ES256" };
let oidcOrigin = "";
let accessToken = "";
let serviceAccessToken = "";
const oidc = createServer((request, response) => {
  if (request.url === "/api/auth/.well-known/openid-configuration") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer: `${oidcOrigin}/api/auth`,
        jwks_uri: `${oidcOrigin}/api/auth/jwks`,
        token_endpoint: `${oidcOrigin}/api/auth/oauth2/token`,
      }),
    );
    return;
  }
  if (request.url === "/api/auth/jwks") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (request.url === "/e2e-token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accessToken }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/auth/oauth2/token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: serviceAccessToken, token_type: "Bearer", expires_in: 3600 }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  oidc.once("error", reject);
  oidc.listen(0, "127.0.0.1", resolve);
});
const oidcAddress = oidc.address();
if (!oidcAddress || typeof oidcAddress === "string") throw new Error("E2E OIDC server did not expose a TCP address");
oidcOrigin = `http://127.0.0.1:${oidcAddress.port}`;
const ama = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/v1/agents/agent-e2e") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        metadata: { uid: "agent-e2e", projectId: "project-e2e" },
        identity: { issuer: `${oidcOrigin}/api/auth`, subject: "agent-e2e", runtime: "ama" },
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
  REALMROOT_ISSUER: `${oidcOrigin}/api/auth`,
  REALMROOT_BROWSER_CLIENT_ID: "ak-browser-e2e",
  REALMROOT_CLI_CLIENT_ID: "realmroot-cli",
  AK_SERVICE_CLIENT_ID: "ak-service-e2e",
  AK_SERVICE_CLIENT_SECRET: "e2e-service-secret",
};
const config = resolve(state, "wrangler.ak-e2e.json");
writeFileSync(config, JSON.stringify(sourceConfig));
const seed = resolve(state, "seed.sql");
writeFileSync(
  seed,
  `INSERT INTO tenants (id) VALUES ('tenant-e2e');
INSERT INTO boards (id, tenant_id, name, description) VALUES
 ('board-main', 'tenant-e2e', 'V2 Delivery', 'End-to-end board'),
 ('board-empty', 'tenant-e2e', 'Empty Board', 'No tasks yet');
INSERT INTO tasks (id, tenant_id, board_id, title, description, status, priority, created_by_subject) VALUES
 ('task-todo', 'tenant-e2e', 'board-main', 'Plan release', 'Prepare the release notes.', 'todo', 10, 'controller-e2e'),
 ('task-working', 'tenant-e2e', 'board-main', 'Run verification', 'Execute all gates.', 'in_progress', 20, 'controller-e2e'),
 ('task-reject', 'tenant-e2e', 'board-main', 'Review rejection', 'Return this submission.', 'in_review', 30, 'controller-e2e'),
 ('task-accept', 'tenant-e2e', 'board-main', 'Review acceptance', 'Accept this submission.', 'in_review', 40, 'controller-e2e'),
 ('task-done', 'tenant-e2e', 'board-main', 'Archive v1', 'Historical source is unmounted.', 'done', 0, 'controller-e2e');
INSERT INTO ama_connections (id, tenant_id, resource_url, project_uri, created_by_subject_id) VALUES
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
  oidc.close();
  rmSync(state, { recursive: true, force: true });
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code) => {
  ama.close();
  oidc.close();
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 1);
});

const now = Math.floor(Date.now() / 1000);
accessToken = await new SignJWT({
  scope:
    "boards:read boards:write tasks:read tasks:write memberships:read memberships:write repositories:read repositories:write execution:read execution:write work:read work:write reviews:read reviews:write",
  client_id: "ak-browser-e2e",
  "urn:realmroot:params:oauth:org": "tenant-e2e",
})
  .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "e2e" })
  .setIssuer(`${oidcOrigin}/api/auth`)
  .setAudience(`http://localhost:${port}/api`)
  .setSubject("controller-e2e")
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(signing.privateKey);
serviceAccessToken = await new SignJWT({
  scope: "agents:read environments:read projects:read runners:read sessions:read sessions:write",
  client_id: "ak-service-e2e",
})
  .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "e2e" })
  .setIssuer(`${oidcOrigin}/api/auth`)
  .setAudience(`${amaOrigin}/api`)
  .setSubject("ak-service-e2e")
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(signing.privateKey);
