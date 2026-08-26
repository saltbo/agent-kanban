import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const AK_ROOT = resolve(import.meta.dirname, "../../..");
const AMA_ROOT = resolve(AK_ROOT, "../any-managed-agents");
const RR_CLI_ROOT = resolve(AK_ROOT, "../realmroot/cli");
const RR_ROOT = resolve(AK_ROOT, "../realmroot/realmroot");
const API_VERSION = "2026-08-22";
const TIMEOUT = Number(process.env.AK_V2_SMOKE_TIMEOUT_MS ?? 12 * 60_000);
const DEV = process.argv.includes("--dev");
const DEV_AMA_BROWSER_SCOPES =
  "openid profile email offline_access agents:read agents:write audit-records:read audit-records:write auth:read auth:write budgets:read budgets:write connectors:read connectors:write environments:read environments:write leases:read leases:write memory-stores:read memory-stores:write projects:read projects:write providers:read providers:write runners:read runners:write sessions:read sessions:write triggers:read triggers:write usage-records:read usage-records:write usage-summary:read usage-summary:write vaults:read vaults:write work-items:read work-items:write";
const ADMIN = { email: "admin@example.com", username: "admin", password: "admin2026", name: "Smoke Admin" };
const processes = [];
let browser;

class FatalSmokeError extends Error {}

function info(message) {
  console.log(`[ak-v2-smoke] ${message}`);
}

function fail(message, detail) {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function fatal(message, detail) {
  throw new FatalSmokeError(detail ? `${message}\n${detail}` : message);
}

function run(command, args, cwd = AK_ROOT, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function start(name, command, args, cwd, env = process.env) {
  const output = [];
  const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk) => {
    const value = chunk.toString();
    output.push(value);
    if (output.length > 300) output.splice(0, output.length - 300);
    if (process.env.AK_V2_SMOKE_VERBOSE === "true") process.stdout.write(`[${name}] ${value}`);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  processes.push({ name, child, output });
  return child;
}

async function stopAll() {
  await browser?.close().catch(() => undefined);
  for (const entry of processes.reverse()) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
    try {
      if (process.platform !== "win32" && entry.child.pid) process.kill(-entry.child.pid, "SIGTERM");
      else entry.child.kill("SIGTERM");
    } catch {}
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  for (const entry of processes) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
    try {
      if (process.platform !== "win32" && entry.child.pid) process.kill(-entry.child.pid, "SIGKILL");
      else entry.child.kill("SIGKILL");
    } catch {}
  }
}

async function stopProcess(name) {
  const entry = [...processes].reverse().find((candidate) => candidate.name === name);
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  if (process.platform !== "win32" && entry.child.pid) process.kill(-entry.child.pid, "SIGTERM");
  else entry.child.kill("SIGTERM");
  await new Promise((resolveExit) => entry.child.once("exit", resolveExit));
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address !== "string" ? resolvePort(address.port) : reject(new Error("No port"))));
    });
  });
}

async function waitFor(check, label, timeout = TIMEOUT) {
  const started = Date.now();
  let cause;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalSmokeError) throw error;
      cause = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  }
  fail(`Timed out waiting for ${label}`, cause instanceof Error ? cause.message : String(cause ?? ""));
}

async function json(response, expected, label) {
  const text = await response.text();
  const status = typeof response.status === "function" ? response.status() : response.status;
  if (status !== expected) fail(`${label} returned ${status}, expected ${expected}`, text);
  return text ? JSON.parse(text) : null;
}

async function ready(origin, path = "/api/health") {
  await waitFor(async () => (await fetch(`${origin}${path}`)).ok, `${origin}${path}`, 120_000);
}

async function triggerScheduled(origin, label) {
  const response = await fetch(`${origin}/__scheduled?cron=*+*+*+*+*`);
  if (!response.ok || response.headers.get("content-type")?.includes("text/html"))
    fatal(`${label} scheduled recovery test endpoint is not reaching the Worker handler`, await response.text());
}

function writeConfig(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function d1Config(name, main, migrationsDir, vars, assets, extra = {}) {
  return {
    name,
    main,
    compatibility_date: "2026-05-07",
    compatibility_flags: ["nodejs_compat"],
    vars,
    assets: {
      binding: "ASSETS",
      directory: assets,
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/.well-known/*", "/skills/*", "/__scheduled"],
    },
    d1_databases: [
      { binding: "DB", database_name: `${name}-db`, database_id: "00000000-0000-0000-0000-000000000099", migrations_dir: migrationsDir },
    ],
    ...extra,
  };
}

async function management(page, rrOrigin, method, path, data, expected = 200) {
  const response = await page.request.fetch(`${rrOrigin}${path}`, { method, ...(data === undefined ? {} : { data }) });
  const text = await response.text();
  if (response.status() !== expected) fail(`${method} Realmroot ${path} returned ${response.status()}`, text);
  return text ? JSON.parse(text) : null;
}

async function amaRequest(origin, token, projectId, method, path, body, expected = 200, key) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-AMA-Project-ID": projectId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return json(response, expected, `${method} AMA ${path}`);
}

async function realAmaRequest(origin, credential, method, path, body, expected = 200, key, projectId = credential.projectId) {
  const response = await realAmaResponse(origin, credential, method, path, body, key, projectId);
  return json(response, expected, `${method} real-OAuth AMA ${path}`);
}

async function realAmaResponse(origin, credential, method, path, body, key, projectId = credential.projectId) {
  const url = `${origin}${path}`;
  return fetch(url, {
    method,
    headers: {
      Authorization: `${credential.tokenType} ${credential.accessToken}`,
      ...(credential.realmrootAccessToken ? { "X-AMA-Realmroot-Authorization": `Bearer ${credential.realmrootAccessToken}` } : {}),
      ...(projectId ? { "X-AMA-Project-ID": projectId } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function addRealmrootManagementCredential(page, rrOrigin, application, credential, resource) {
  const response = await page.request.post(`${rrOrigin}/api/auth/oauth2/token`, {
    headers: { origin: rrOrigin },
    form: {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: application.clientId,
      ...(application.clientSecret ? { client_secret: application.clientSecret } : {}),
      resource,
    },
  });
  const tokenText = await response.text();
  if (response.status() !== 200)
    fail(`Realmroot management token for ${application.clientId} returned ${response.status()}, expected 200`, tokenText);
  const tokens = JSON.parse(tokenText);
  if (tokens.token_type?.toLowerCase() !== "bearer" || !tokens.access_token || !tokens.refresh_token)
    fail("Realmroot did not issue the required User management Bearer", JSON.stringify(tokens));
  credential.refreshToken = tokens.refresh_token;
  credential.realmrootAccessToken = tokens.access_token;
}

async function oauthCredential(page, rrOrigin, application, resource, scopes, contextName = /Realmroot/, additionalResources = []) {
  const state = crypto.randomUUID();
  const verifier = `${state}-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${rrOrigin}/e2e/oauth-callback`;
  const authorization = new URL(`${rrOrigin}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: application.clientId,
    redirect_uri: redirectUri,
    scope: `openid profile email offline_access ${scopes.join(" ")}`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }))
    authorization.searchParams.set(key, value);
  for (const additionalResource of additionalResources) authorization.searchParams.append("resource", additionalResource);
  await page.goto(authorization.toString());
  info(`OAuth authorization for ${application.clientId} reached ${page.url()}`);
  if (page.url().includes("/auth/context")) {
    await page.getByRole("radio", { name: contextName }).last().click();
    await page.getByRole("button", { name: "Continue" }).click();
  }
  if (page.url().includes("/auth/consent")) await page.getByRole("button", { name: "Authorize" }).click();
  const immediateCallback = new URL(page.url());
  if (immediateCallback.pathname === "/e2e/oauth-callback" && immediateCallback.searchParams.has("error"))
    fail(`OAuth authorization for ${application.clientId} failed`, immediateCallback.search);
  await page.waitForURL((url) => url.pathname === "/e2e/oauth-callback" && url.searchParams.has("code"));
  const code = new URL(page.url()).searchParams.get("code");
  const tokenEndpoint = `${rrOrigin}/api/auth/oauth2/token`;
  const response = await page.request.post(tokenEndpoint, {
    headers: { origin: rrOrigin },
    form: {
      grant_type: "authorization_code",
      client_id: application.clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource,
    },
  });
  const tokenText = await response.text();
  if (response.status() !== 200) fail(`OAuth token for ${application.clientId} returned ${response.status()}, expected 200`, tokenText);
  const tokens = JSON.parse(tokenText);
  const tokenType = tokens.token_type?.toLowerCase() === "bearer" ? "Bearer" : tokens.token_type;
  if (tokenType !== "Bearer") fail("Realmroot issued a non-Bearer Application token", JSON.stringify(tokens));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    tokenType,
  };
}

async function akRequest(origin, csrf, cookie, method, path, body, expected = 200, key) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      "API-Version": API_VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return json(response, expected, `${method} AK ${path}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "ak-v2-full-smoke-"));
  const [rrPort, amaPort, akPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const rrOrigin = `http://127.0.0.1:${rrPort}`;
  const amaOrigin = `${DEV ? "http://localhost" : "http://127.0.0.1"}:${amaPort}`;
  // Browsers treat localhost as a potentially trustworthy origin, so AK's
  // production Secure web-session cookie remains testable without weakening it.
  const akOrigin = `http://localhost:${akPort}`;
  const rrState = join(temp, "realmroot-state");
  const amaState = join(temp, "ama-state");
  const akState = join(temp, "ak-state");
  const rrConfig = join(temp, "realmroot.jsonc");
  const amaConfig = join(temp, "ama.jsonc");
  const akConfig = join(temp, "ak.jsonc");
  const runnerBinary = join(temp, "ama-runner");
  const realmrootBinary = join(temp, "realmroot");
  const runId = `ak-v2-${Date.now()}`;

  try {
    writeConfig(
      rrConfig,
      d1Config(
        "realmroot-ak-v2-smoke",
        join(RR_ROOT, "server/worker.ts"),
        join(RR_ROOT, "migrations"),
        {
          BETTER_AUTH_SECRET: "ak-v2-smoke-better-auth-secret-with-enough-entropy",
          BETTER_AUTH_URL: rrOrigin,
          TRUSTED_ORIGINS: rrOrigin,
          CREDENTIAL_ENCRYPTION_KEY: "ak-v2-smoke-credential-encryption-key-32-bytes",
          E2E_OAUTH_CLIENT_SECRET: "e2e-secret",
          EMAIL_FROM: "e2e@example.com",
          EMAIL_FROM_NAME: "Realmroot Smoke",
        },
        join(RR_ROOT, "dist/client"),
        { r2_buckets: [{ binding: "ASSET_BUCKET", bucket_name: "realmroot-ak-v2-smoke-assets" }] },
      ),
    );
    run(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "realmroot-ak-v2-smoke-db", "--local", "--config", rrConfig, "--persist-to", rrState],
      RR_ROOT,
    );
    start("realmroot", "pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", String(rrPort), "--strictPort"], RR_ROOT, {
      ...process.env,
      CF_WRANGLER_CONFIG: rrConfig,
      CF_PERSIST_STATE_PATH: rrState,
    });
    await ready(rrOrigin);
    await json(
      await fetch(`${rrOrigin}/api/onboarding/admin-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ADMIN),
      }),
      201,
      "Realmroot admin bootstrap",
    );

    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${rrOrigin}/auth/sign-in`);
    await page.getByRole("textbox", { name: "Email or username" }).fill(ADMIN.username);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/profile");
    const organizations = await management(page, rrOrigin, "GET", "/api/organizations?limit=100&offset=0");
    const platform = organizations.items.find((item) => item.slug === "realmroot");
    if (!platform) fail("Realmroot platform Organization was not bootstrapped");

    const amaAuthority = await management(
      page,
      rrOrigin,
      "POST",
      "/api/applications",
      {
        name: "AMA smoke management authority",
        slug: `ama-smoke-${runId}`.slice(0, 63),
        clientType: "machine",
        redirectUris: [],
        ownerOrganizationId: platform.id,
        consentRequired: false,
      },
      201,
    );
    const akWeb = await management(
      page,
      rrOrigin,
      "POST",
      "/api/applications",
      {
        name: "Agent Kanban smoke web",
        slug: `ak-smoke-${runId}`.slice(0, 63),
        clientType: "confidential_web",
        redirectUris: [`${akOrigin}/api/auth/callback`],
        ownerOrganizationId: platform.id,
        consentRequired: false,
      },
      201,
    );
    const amaController = await management(
      page,
      rrOrigin,
      "POST",
      "/api/applications",
      {
        name: DEV ? "AMA local console" : "AMA smoke controller",
        slug: `ama-controller-${runId}`.slice(0, 63),
        clientType: DEV ? "confidential_web" : "public_native",
        redirectUris: DEV ? [`${amaOrigin}/api/v1/auth/callback`] : [`${rrOrigin}/e2e/oauth-callback`],
        ownerOrganizationId: platform.id,
        consentRequired: false,
      },
      201,
    );
    const amaRunner = await management(
      page,
      rrOrigin,
      "POST",
      "/api/applications",
      {
        name: "AMA smoke runner",
        slug: `ama-runner-${runId}`.slice(0, 63),
        clientType: "public_native",
        redirectUris: [`${rrOrigin}/e2e/oauth-callback`],
        ownerOrganizationId: platform.id,
        consentRequired: false,
      },
      201,
    );
    if (!amaAuthority.clientSecret || !akWeb.clientSecret) fail("Realmroot did not return one-time Application secrets");
    const rrResources = await management(page, rrOrigin, "GET", "/api/resource-servers?limit=100&offset=0");
    const rrManagement = rrResources.items.find((item) => item.resourceUrl === `${rrOrigin}/api` || item.identifier === "realmroot");
    if (!rrManagement) fail("Realmroot built-in management Resource Server is missing");
    await management(
      page,
      rrOrigin,
      "POST",
      `/api/applications/${amaAuthority.id}/permissions`,
      {
        resourceServerId: rrManagement.id,
        scope: "agents:write",
        mode: "persistent",
      },
      201,
    );
    await management(page, rrOrigin, "PATCH", `/api/applications/${amaAuthority.id}`, {
      resourceScopes: [{ resourceServerId: rrManagement.id, scopes: ["agents:write"] }],
    });

    writeConfig(
      amaConfig,
      d1Config(
        "ama-ak-v2-smoke",
        join(AMA_ROOT, "server/worker.ts"),
        join(AMA_ROOT, "migrations"),
        {
          AMA_DEFAULT_MODEL: "@cf/moonshotai/kimi-k2.6",
          AMA_RUNTIME_MODE: "test",
          AMA_E2E_TEST_AUTH: "true",
          AMA_ALLOWED_ORIGINS: amaOrigin,
          AMA_VAULT_ENCRYPTION_KEY: "ak-v2-smoke-vault-encryption-key-32-bytes",
          ...(DEV
            ? {
                AMA_WEB_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
                OIDC_BROWSER_SCOPES: DEV_AMA_BROWSER_SCOPES,
              }
            : {}),
          OIDC_ISSUER: `${rrOrigin}/api/auth`,
          OIDC_CLIENT_ID: amaController.clientId,
          ...(DEV ? { OIDC_CLIENT_SECRET: amaController.clientSecret } : {}),
          OIDC_TRUSTED_BEARER_CLIENT_IDS: akWeb.clientId,
          OIDC_RESOURCE: `${amaOrigin}/api`,
          OIDC_RUNNER_CLIENT_ID: amaRunner.clientId,
          REALMROOT_MANAGEMENT_CLIENT_ID: amaAuthority.clientId,
          REALMROOT_MANAGEMENT_CLIENT_SECRET: amaAuthority.clientSecret,
          REALMROOT_MANAGEMENT_RESOURCE: `${rrOrigin}/api`,
        },
        join(AMA_ROOT, "dist/client"),
        {
          // The smoke exercises AMA's Worker API only. Omitting SPA assets lets
          // Wrangler's /__scheduled test endpoint reach the scheduled handler.
          ...(DEV ? {} : { assets: undefined }),
          r2_buckets: [{ binding: "SESSION_EVENTS", bucket_name: "ama-ak-v2-smoke-events" }],
          durable_objects: {
            bindings: [
              { name: "SANDBOX", class_name: "Sandbox" },
              { name: "SESSION", class_name: "SessionObject" },
              { name: "RUNNER_POOL", class_name: "RunnerPoolObject" },
            ],
          },
          migrations: [
            { tag: "v1", new_sqlite_classes: ["ManagedAgent"] },
            { tag: "v2", new_sqlite_classes: ["Sandbox"] },
            { tag: "v3", new_sqlite_classes: ["RunnerSessionChannelObject"] },
            { tag: "v4", deleted_classes: ["ManagedAgent"] },
            { tag: "v5", renamed_classes: [{ from: "RunnerSessionChannelObject", to: "SessionObject" }] },
            { tag: "v6", new_sqlite_classes: ["RunnerPoolObject"] },
          ],
        },
      ),
    );
    run(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "ama-ak-v2-smoke-db", "--local", "--config", amaConfig, "--persist-to", amaState],
      AMA_ROOT,
    );
    start(
      "ama",
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        amaConfig,
        "--ip",
        "127.0.0.1",
        "--port",
        String(amaPort),
        "--persist-to",
        amaState,
        "--test-scheduled",
      ],
      AMA_ROOT,
    );
    await ready(amaOrigin, "/api/v1/e2e/ready");
    const amaToken = await json(
      await fetch(`${amaOrigin}/api/v1/e2e/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      }),
      201,
      "AMA e2e controller bootstrap",
    );

    run("pnpm", ["build"], AK_ROOT);
    writeConfig(
      akConfig,
      d1Config(
        "ak-v2-smoke",
        join(AK_ROOT, "apps/web/dist/agent_kanban/index.js"),
        join(AK_ROOT, "apps/web/migrations"),
        {
          AK_API_URL: akOrigin,
          AK_RESOURCE: `${akOrigin}/api`,
          AMA_ORIGIN: amaOrigin,
          AMA_RESOURCE: `${amaOrigin}/api`,
          REALMROOT_ISSUER: `${rrOrigin}/api/auth`,
          REALMROOT_WEB_CLIENT_ID: akWeb.clientId,
          REALMROOT_WEB_CLIENT_SECRET: akWeb.clientSecret,
          REALMROOT_CLI_CLIENT_ID: "realmroot-cli",
          REALMROOT_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
          ALLOWED_HOSTS: `localhost:${akPort}`,
        },
        join(AK_ROOT, "apps/web/dist/client"),
        {
          compatibility_date: "2026-08-23",
          triggers: { crons: ["* * * * *"] },
          limits: { cpu_ms: 1000 },
        },
      ),
    );
    run(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "ak-v2-smoke-db", "--local", "--config", akConfig, "--persist-to", akState],
      AK_ROOT,
    );
    start(
      "ak",
      "pnpm",
      ["exec", "wrangler", "dev", "--config", akConfig, "--ip", "127.0.0.1", "--port", String(akPort), "--persist-to", akState, "--test-scheduled"],
      AK_ROOT,
    );
    await ready(akOrigin);

    const skillIndexResponse = await fetch(`${akOrigin}/.well-known/agent-skills/index.json`);
    const skillDocumentResponse = await fetch(`${akOrigin}/skills/agent-kanban/SKILL.md`);
    const skillIndex = await json(skillIndexResponse, 200, "AK Agent Skills discovery index");
    const skillBytes = Buffer.from(await skillDocumentResponse.arrayBuffer());
    const expectedSkillDigest = `sha256:${createHash("sha256").update(skillBytes).digest("hex")}`;
    if (
      skillIndex.$schema !== "https://schemas.agentskills.io/discovery/0.2.0/schema.json" ||
      skillIndex.skills?.length !== 1 ||
      skillIndex.skills[0]?.name !== "agent-kanban" ||
      skillIndex.skills[0]?.type !== "skill-md" ||
      skillIndex.skills[0]?.url !== `${akOrigin}/skills/agent-kanban/SKILL.md` ||
      skillIndex.skills[0]?.digest !== expectedSkillDigest
    )
      fail("AK Agent Skills discovery index does not match the published SKILL.md bytes", JSON.stringify(skillIndex));

    for (const [origin, paths] of [
      [
        akOrigin,
        ["/.well-known/oauth-protected-resource/api", "/api/openapi.json", "/.well-known/agent-skills/index.json", "/skills/agent-kanban/SKILL.md"],
      ],
      [amaOrigin, ["/.well-known/oauth-protected-resource/api", "/api/v1/openapi.json"]],
    ]) {
      for (const path of paths) {
        const response = await fetch(`${origin}${path}`);
        if (!response.ok) fail(`Discovery failed: ${origin}${path}`, await response.text());
      }
    }

    const amaResource = await management(
      page,
      rrOrigin,
      "POST",
      "/api/resource-servers",
      {
        identifier: `ama-smoke-${runId}`,
        resourceUrl: `${amaOrigin}/api`,
        authorizationModel: "native",
        ownerOrganizationId: platform.id,
        visibility: "public",
        availableToAgents: true,
      },
      201,
    );
    const amaResourceWithScopes = await management(page, rrOrigin, "PUT", `/api/resource-servers/${amaResource.id}/scope-registry`, {});
    await management(page, rrOrigin, "PATCH", `/api/resource-servers/${amaResource.id}`, {
      scopeGrantModes: amaResourceWithScopes.scopes.map(({ value }) => ({ scope: value, grantMode: "automatic" })),
    });
    const akResource = await management(
      page,
      rrOrigin,
      "POST",
      "/api/resource-servers",
      {
        identifier: `ak-smoke-${runId}`,
        resourceUrl: `${akOrigin}/api`,
        authorizationModel: "native",
        ownerOrganizationId: platform.id,
        visibility: "public",
        availableToAgents: true,
      },
      201,
    );
    const akResourceWithScopes = await management(page, rrOrigin, "PUT", `/api/resource-servers/${akResource.id}/scope-registry`, {});
    await management(page, rrOrigin, "PATCH", `/api/resource-servers/${akResource.id}`, {
      scopeGrantModes: akResourceWithScopes.scopes.map(({ value }) => ({ scope: value, grantMode: "automatic" })),
    });

    const controllerScopes = [
      "agents:read",
      "agents:write",
      "environments:read",
      "environments:write",
      "projects:read",
      "projects:write",
      "runners:read",
      "sessions:read",
      "sessions:write",
      "vaults:read",
    ];
    const runnerScopes = ["runners:read", "runners:write", "work-items:read", "work-items:write", "leases:read", "leases:write", "sessions:write"];
    await management(page, rrOrigin, "PATCH", `/api/applications/${amaController.id}`, {
      resourceScopes: [
        {
          resourceServerId: amaResource.id,
          scopes: DEV ? amaResourceWithScopes.scopes.map(({ value }) => value) : controllerScopes,
        },
        { resourceServerId: rrManagement.id, scopes: ["agents:write"] },
      ],
    });
    await management(page, rrOrigin, "PATCH", `/api/applications/${amaRunner.id}`, {
      resourceScopes: [
        { resourceServerId: amaResource.id, scopes: runnerScopes },
        { resourceServerId: rrManagement.id, scopes: ["agents:write"] },
      ],
    });
    await management(page, rrOrigin, "PATCH", `/api/applications/${akWeb.id}`, {
      resourceScopes: [
        { resourceServerId: akResource.id, scopes: akResourceWithScopes.scopes.map(({ value }) => value) },
        {
          resourceServerId: amaResource.id,
          scopes: [
            "agents:read",
            "agents:write",
            "environments:read",
            "environments:write",
            "projects:read",
            "runners:read",
            "sessions:read",
            "sessions:write",
          ],
        },
        { resourceServerId: rrManagement.id, scopes: ["agents:write"] },
      ],
    });

    // Realmroot snapshots registered OAuth audiences when its Worker starts.
    // Restart through the normal process boundary after public Resource registration.
    await stopProcess("realmroot");
    start("realmroot-restarted", "pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", String(rrPort), "--strictPort"], RR_ROOT, {
      ...process.env,
      CF_WRANGLER_CONFIG: rrConfig,
      CF_PERSIST_STATE_PATH: rrState,
    });
    await ready(rrOrigin);

    if (DEV) {
      await browser.close();
      browser = undefined;
      info(`DEV READY: Realmroot=${rrOrigin} AMA=${amaOrigin} AK=${akOrigin}`);
      info(`LOGIN: ${ADMIN.email} / ${ADMIN.password}`);
      info("The local databases are fresh and intentionally contain no smoke Agent or Task. Press Ctrl-C to stop all services.");
      await new Promise((resolveStop) => {
        process.once("SIGINT", resolveStop);
        process.once("SIGTERM", resolveStop);
      });
      return;
    }

    const controllerCredential = await oauthCredential(page, rrOrigin, amaController, `${amaOrigin}/api`, controllerScopes, /Realmroot/, [
      `${rrOrigin}/api`,
    ]);
    const projects = await realAmaRequest(amaOrigin, controllerCredential, "GET", "/api/v1/projects?limit=10", undefined, 200, undefined, null);
    controllerCredential.projectId = projects.data[0]?.id ?? projects.data[0]?.metadata?.uid;
    if (!controllerCredential.projectId) fail("Real Realmroot controller token did not establish an AMA project", JSON.stringify(projects));
    await addRealmrootManagementCredential(page, rrOrigin, amaController, controllerCredential, `${rrOrigin}/api`);
    const runnerCredential = await oauthCredential(page, rrOrigin, amaRunner, `${amaOrigin}/api`, [...runnerScopes, "agents:write"], /Realmroot/, [
      `${rrOrigin}/api`,
    ]);
    runnerCredential.projectId = controllerCredential.projectId;
    await addRealmrootManagementCredential(page, rrOrigin, amaRunner, runnerCredential, `${rrOrigin}/api`);

    await amaRequest(amaOrigin, amaToken.accessToken, amaToken.projectId, "POST", "/api/v1/e2e/catalog/seed", {}, 201);
    const environment = await realAmaRequest(
      amaOrigin,
      controllerCredential,
      "POST",
      "/api/v1/environments",
      {
        metadata: { name: `ak-smoke-env-${runId}` },
        spec: {
          scope: "project",
          type: "self_hosted",
          networking: { type: "open", allowMcpServers: true, allowPackageManagers: true },
          packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
          variables: {},
        },
      },
      201,
    );
    run("pnpm", ["run", "bridge:build"], AMA_ROOT);
    run("go", ["build", "-o", runnerBinary, "."], join(AMA_ROOT, "cmd/ama-runner"));
    run("go", ["build", "-o", realmrootBinary, "."], RR_CLI_ROOT);
    run(realmrootBinary, ["version"]);
    const runnerPath = { ...process.env, PATH: `${temp}:${process.env.PATH ?? ""}` };
    if (run("which", ["realmroot"], AK_ROOT, runnerPath).trim() !== realmrootBinary)
      fatal("ama-runner PATH does not resolve the smoke-built Realmroot CLI");
    const runnerCredentials = join(temp, "runner-credentials.json");
    writeFileSync(
      runnerCredentials,
      JSON.stringify({
        active: `${amaOrigin}#${runId}`,
        profiles: [
          {
            accountId: runId,
            apiServer: amaOrigin,
            accessToken: runnerCredential.accessToken,
            refreshToken: runnerCredential.refreshToken,
            tokenType: "Bearer",
            expiresAt: new Date(Date.now() + Number(runnerCredential.expiresIn ?? 300) * 1000).toISOString(),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const runnerWork = join(temp, "runner-work");
    start(
      "ama-runner",
      runnerBinary,
      [
        "--api-server",
        amaOrigin,
        "--project-id",
        controllerCredential.projectId,
        "--environment-id",
        environment.metadata.uid,
        "--state-dir",
        join(temp, "runner-state"),
        "--work-dir",
        runnerWork,
        "--allow-unsafe-process",
        "--max-concurrent",
        "1",
      ],
      AMA_ROOT,
      {
        ...runnerPath,
        AMA_RUNNER_CREDENTIALS: runnerCredentials,
        AMA_RUNNER_HEARTBEAT_INTERVAL: "2s",
        AMA_RUNNER_LEASE_SECONDS: "30",
        AMA_RUNNER_RENEW_INTERVAL: "10s",
        AMA_RUNTIME_BRIDGE_HOST_HOME: process.env.HOME ?? "",
      },
    );
    const registeredRunner = await waitFor(async () => {
      const runners = await realAmaRequest(
        amaOrigin,
        controllerCredential,
        "GET",
        `/api/v1/runners?environmentId=${environment.metadata.uid}&state=active`,
      );
      return runners.data?.find((runner) => runner.state === "active") ?? false;
    }, "real ama-runner registration");
    const codexRuntime = registeredRunner.runtimes?.find((runtime) => runtime.runtime === "codex" && runtime.state === "ready");
    const requestedModel = process.env.AK_V2_SMOKE_MODEL;
    const selectedModel = requestedModel ?? codexRuntime?.models?.[0];
    if (!selectedModel || !codexRuntime?.models?.includes(selectedModel)) {
      fatal(
        "Real ama-runner does not advertise the requested Codex model",
        JSON.stringify({ runnerId: registeredRunner.id, requestedModel: requestedModel ?? null, runtimes: registeredRunner.runtimes }),
      );
    }

    const agentUsername = `ak-smoke-${Date.now()}`;
    const agentCreateBody = (username, name) => ({
      username,
      metadata: { name },
      spec: {
        runtime: "codex",
        systemPrompt:
          "You are the AK v2 black-box worker. Treat the canonical Task URI in the assigned Session prompt as your only Task; fail rather than discovering another Task. The assigned repository is mounted at /workspace/repository. Use Realmroot Toolbox for every AK operation. Request exactly these Agent scopes and no others: boards:read, boards:write, tasks:read, execution:read, work:write, reviews:read, reviews:write. Use that token to attempt the Board PATCH and prove Agent Kanban rejects it because your Board Membership only grants work capability, then record progress and submit the assigned Task. If review feedback arrives, record resumed progress and submit a corrected result.",
        provider: "workers-ai",
        model: selectedModel,
        skills: [],
        allowedTools: ["bash", "read", "edit", "grep"],
        subagents: [],
        mcpConnectors: [],
      },
    });
    const missingSecondary = await realAmaResponse(
      amaOrigin,
      { ...controllerCredential, realmrootAccessToken: undefined },
      "POST",
      "/api/v1/agents",
      agentCreateBody(`${agentUsername}-missing`, "Missing authority must fail"),
      `agent-missing-secondary-${runId}`,
    );
    const missingSecondaryProblem = await json(missingSecondary, 403, "AMA Agent create without secondary Realmroot authority");
    if (JSON.stringify(missingSecondaryProblem).includes(controllerCredential.realmrootAccessToken))
      fail("AMA leaked the Realmroot management credential in a missing-authority response");
    const mismatchedClient = await realAmaResponse(
      amaOrigin,
      { ...controllerCredential, realmrootAccessToken: runnerCredential.realmrootAccessToken },
      "POST",
      "/api/v1/agents",
      agentCreateBody(`${agentUsername}-wrong-client`, "Wrong client must fail"),
      `agent-wrong-client-${runId}`,
    );
    const mismatchedClientProblem = await json(mismatchedClient, 403, "AMA Agent create with a mismatched secondary client");
    if (JSON.stringify(mismatchedClientProblem).includes(runnerCredential.realmrootAccessToken))
      fail("AMA leaked the mismatched Realmroot management credential in its response");
    const agentResponse = await realAmaResponse(
      amaOrigin,
      controllerCredential,
      "POST",
      "/api/v1/agents",
      agentCreateBody(agentUsername, "AK v2 smoke worker"),
      `agent-${runId}`,
    );
    const agent = await json(agentResponse, 201, "synchronous AMA Agent creation");
    const agentLocation = agentResponse.headers.get("location");
    if (!agentLocation) fail("AMA synchronous Agent creation omitted Location");
    const agentUri = new URL(agentLocation, amaOrigin).toString();
    if (agentUri !== new URL(`/api/v1/agents/${encodeURIComponent(agent.metadata?.uid ?? "")}`, amaOrigin).toString())
      fail("AMA Agent Location is not canonical", JSON.stringify({ agentLocation, agent }));
    if (
      agent.identity.issuer !== `${rrOrigin}/api/auth` ||
      !agent.identity.subject ||
      !agent.status.ready ||
      agent.metadata.projectId !== controllerCredential.projectId
    ) {
      fail("AMA canonical Agent identity is not execution ready", JSON.stringify(agent));
    }
    const rrAgents = await management(page, rrOrigin, "GET", "/api/agents?limit=100&offset=0");
    const matchingRrAgents = rrAgents.items.filter(
      (candidate) => candidate.issuer === agent.identity.issuer && candidate.subject === agent.identity.subject,
    );
    if (matchingRrAgents.length !== 1)
      fail("Realmroot management inventory did not expose exactly one AMA Agent identity", JSON.stringify(matchingRrAgents));
    const rrIdentity = matchingRrAgents[0];
    await management(page, rrOrigin, "GET", `/api/agents/${encodeURIComponent(rrIdentity.id)}`);
    const vaultsBeforeRetirement = await realAmaRequest(amaOrigin, controllerCredential, "GET", "/api/v1/vaults?limit=100");
    const matchingVaults = vaultsBeforeRetirement.data.filter((vault) => vault.metadata.name === `Agent ${agentUsername}`);
    if (matchingVaults.length !== 1) fail("AMA did not expose exactly one managed Realmroot identity Vault", JSON.stringify(matchingVaults));
    const managedVault = matchingVaults[0];
    await realAmaRequest(amaOrigin, controllerCredential, "GET", `/api/v1/vaults/${managedVault.metadata.uid}`);

    await page.goto(`${akOrigin}/api/auth/login?return_to=/`);
    if (page.url().includes("/auth/context")) {
      await page
        .getByRole("radio", { name: /Realmroot/ })
        .last()
        .click();
      await page.getByRole("button", { name: "Continue" }).click();
    }
    if (page.url().includes("/auth/consent")) await page.getByRole("button", { name: "Authorize" }).click();
    await page.waitForURL(`${akOrigin}/`);
    const session = await json(await page.request.get(`${akOrigin}/api/auth/session`), 200, "AK OAuth session");
    const akCookies = await context.cookies(akOrigin);
    const cookie = akCookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const csrf = session.session.csrfToken;

    const connection = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      "/api/ama-connections",
      { resourceUrl: `${amaOrigin}/api`, projectUri: `${amaOrigin}/api/v1/projects/${controllerCredential.projectId}` },
      201,
      "connection",
    );
    const consoleProjects = await akRequest(akOrigin, csrf, cookie, "GET", "/api/console/ama-projects");
    if (!consoleProjects.items?.some((value) => value.id === controllerCredential.projectId))
      fail("AK product BFF did not expose the connected AMA Project", JSON.stringify(consoleProjects));
    const consoleAgents = await akRequest(akOrigin, csrf, cookie, "GET", `/api/console/ama-connections/${connection.id}/agents`);
    if (!consoleAgents.items?.some((value) => value.metadata?.uid === agent.metadata.uid && value.identity?.subject === agent.identity.subject))
      fail("AK Agents product projection did not preserve AMA Agent identity", JSON.stringify(consoleAgents));
    await akRequest(akOrigin, csrf, cookie, "GET", `/api/console/ama-connections/${connection.id}/agents/${agent.metadata.uid}`);
    const consoleMachines = await akRequest(akOrigin, csrf, cookie, "GET", `/api/console/ama-connections/${connection.id}/machines`);
    const consoleMachine = consoleMachines.items?.find((value) => value.environment?.metadata?.uid === environment.metadata.uid);
    if (!consoleMachine?.runners?.some((value) => value.id === registeredRunner.id))
      fail("AK Machines product projection did not aggregate the AMA Environment and Runner", JSON.stringify(consoleMachines));
    await akRequest(akOrigin, csrf, cookie, "GET", `/api/console/ama-connections/${connection.id}/machines/${environment.metadata.uid}`);
    const board = await akRequest(akOrigin, csrf, cookie, "POST", "/api/boards", { name: "V2 full smoke" }, 201, "board");
    const boardBeforeAgent = await akRequest(akOrigin, csrf, cookie, "GET", `/api/boards/${board.id}`);
    const repository = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      "/api/repositories",
      { name: "smoke", url: "https://github.com/octocat/Hello-World.git", defaultBranch: "master" },
      201,
      "repository",
    );
    await akRequest(akOrigin, csrf, cookie, "PUT", `/api/boards/${board.id}/execution-binding`, { amaConnectionId: connection.id }, 201);
    await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      `/api/boards/${board.id}/memberships`,
      { agentId: agent.metadata.uid, capabilities: ["work"] },
      201,
      "membership",
    );
    const task = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      `/api/boards/${board.id}/tasks`,
      {
        title: "Complete real AK lifecycle",
        description:
          "Use the canonical Task URI supplied in this Session prompt; do not list the Board to discover another Task. The assigned repository is mounted at /workspace/repository. Use realmroot toolbox agent-kanban discovery. Request exactly boards:read, boards:write, tasks:read, execution:read, work:write, reviews:read, and reviews:write. Attempt to PATCH the board name to 'FORBIDDEN AGENT MUTATION' with that Agent token and confirm AK returns HTTP 403 because your Board Membership has only work capability. Find this Task's current Run, POST a checkpoint progress entry whose body is exactly 'board patch forbidden 403; real runner started', then POST a submission with summary exactly 'first smoke submission'. After rejection feedback, POST another checkpoint whose body is exactly 'review feedback resumed', then submit again with summary exactly 'corrected smoke submission'.",
        repositoryId: repository.id,
      },
      201,
      "task",
    );
    await akRequest(akOrigin, csrf, cookie, "POST", `/api/tasks/${task.id}/assignments`, { agentId: agent.metadata.uid }, 201, "assignment");
    const runResource = await akRequest(akOrigin, csrf, cookie, "POST", `/api/tasks/${task.id}/runs`, {}, 201, "run");
    const malformedDpop = await fetch(`${akOrigin}/api/boards`, {
      headers: { Authorization: "DPoP invalid.invalid.invalid", DPoP: "invalid.invalid.invalid", "API-Version": API_VERSION },
    });
    if (malformedDpop.status !== 401) fail("AK did not fail closed for malformed DPoP", await malformedDpop.text());
    await triggerScheduled(akOrigin, "AK");
    const running = await waitFor(async () => {
      const value = await akRequest(akOrigin, csrf, cookie, "GET", `/api/task-runs/${runResource.id}`);
      return value.status === "running" && value.amaSessionUri ? value : false;
    }, "unique AMA Session dispatch");
    const sessions = await realAmaRequest(amaOrigin, controllerCredential, "GET", "/api/v1/sessions?limit=50");
    const matchingSessions = sessions.data.filter((value) => value.metadata.uid === new URL(running.amaSessionUri).pathname.split("/").at(-1));
    if (matchingSessions.length !== 1) fail("AK dispatch did not create exactly one AMA Session");
    const dispatchedSession = matchingSessions[0];
    const dispatchLabel = `agent-kanban-run=ak:task-run:${runResource.id}`;
    const reconciledSessions = await realAmaRequest(
      amaOrigin,
      controllerCredential,
      "GET",
      `/api/v1/sessions?labelSelector=${encodeURIComponent(dispatchLabel)}&limit=2`,
    );
    if (reconciledSessions.data?.length !== 1 || reconciledSessions.data[0]?.metadata?.uid !== dispatchedSession.metadata.uid)
      fail("AMA labelSelector did not reconcile the unique AK Session", JSON.stringify(reconciledSessions));
    if (
      dispatchedSession.spec?.agentId !== agent.metadata.uid ||
      dispatchedSession.spec?.runtime !== agent.spec.runtime ||
      dispatchedSession.metadata?.labels?.["agent-kanban-run"] !== `ak:task-run:${runResource.id}` ||
      dispatchedSession.identity !== undefined ||
      dispatchedSession.workload !== undefined ||
      dispatchedSession.vault !== undefined ||
      dispatchedSession.credential !== undefined ||
      dispatchedSession.spec?.task !== undefined ||
      dispatchedSession.spec?.repository !== undefined
    )
      fail("AK did not use the native AMA Session Agent/runtime contract", JSON.stringify(dispatchedSession));
    const repositoryVolume = dispatchedSession.spec?.volumes?.find((volume) => volume.name === "repository");
    const repositoryMount = dispatchedSession.spec?.volumeMounts?.find((mount) => mount.name === "repository");
    if (
      repositoryVolume?.type !== "git_repository" ||
      repositoryVolume?.url !== "https://github.com/octocat/Hello-World.git" ||
      repositoryVolume?.ref !== "master" ||
      repositoryMount?.mountPath !== "/workspace/repository"
    )
      fail("AK did not map the Task Repository to native AMA Session volumes", JSON.stringify(dispatchedSession.spec));

    const projectedSessions = await akRequest(akOrigin, csrf, cookie, "GET", `/api/console/ama-connections/${connection.id}/sessions`);
    const projectedSession = projectedSessions.items?.find((value) => value.metadata?.uid === dispatchedSession.metadata.uid);
    if (projectedSession?.spec?.agentId !== agent.metadata.uid || projectedSession?.spec?.runtime !== agent.spec.runtime)
      fail("AK AMA Session projection did not preserve AMA's resolved placement contract", JSON.stringify(projectedSessions));
    const projectedMachine = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "GET",
      `/api/console/ama-connections/${connection.id}/machines/${environment.metadata.uid}`,
    );
    if (!projectedMachine.sessions?.some((value) => value.metadata?.uid === dispatchedSession.metadata.uid))
      fail("AK Machine projection did not include the running AMA Session", JSON.stringify(projectedMachine));

    const expectedAgentScopes = ["boards:read", "boards:write", "execution:read", "reviews:read", "reviews:write", "tasks:read", "work:write"];
    let lastApprovalPollAt = 0;
    const firstSubmission = await waitFor(async () => {
      if (Date.now() - lastApprovalPollAt >= 2_000) {
        const requests = await json(
          await page.request.get(`${rrOrigin}/api/account/access-requests?limit=100&offset=0`),
          200,
          "Realmroot Agent authority requests",
        );
        for (const request of requests.items ?? []) {
          if (request.status !== "pending") continue;
          if (JSON.stringify([...request.scopes].sort()) !== JSON.stringify(expectedAgentScopes))
            fatal("Agent requested authority outside the smoke task", JSON.stringify({ id: request.id, scopes: request.scopes }));
          if (!Array.isArray(request.authorizationDetails) || request.authorizationDetails.length === 0)
            fatal("Realmroot pending authority omitted its authorization context", JSON.stringify(request));
          await json(
            await page.request.put(`${rrOrigin}/api/account/access-requests/${encodeURIComponent(request.id)}/decision`, {
              headers: { "content-type": "application/json" },
              data: { decision: "approve", mode: "persistent", authorizationDetails: request.authorizationDetails },
            }),
            200,
            "Realmroot Agent authority approval",
          );
        }
        lastApprovalPollAt = Date.now();
      }
      const taskValue = await akRequest(akOrigin, csrf, cookie, "GET", `/api/tasks/${task.id}`);
      if (taskValue.status !== "in_review") return false;
      const collection = await akRequest(akOrigin, csrf, cookie, "GET", `/api/tasks/${task.id}/submissions`);
      return collection.items.find((value) => value.status === "pending_review") ?? false;
    }, "Agent progress and first submission");
    if (firstSubmission.summary !== "first smoke submission")
      fail("First Agent submission summary was not the requested value", JSON.stringify(firstSubmission));
    const firstProgress = await akRequest(akOrigin, csrf, cookie, "GET", `/api/task-runs/${runResource.id}/progress-entries`);
    if (!firstProgress.items.some((entry) => entry.kind === "checkpoint" && entry.body === "board patch forbidden 403; real runner started"))
      fail("Agent did not record the expected first checkpoint and forbidden Board write outcome", JSON.stringify(firstProgress));
    await waitFor(
      async () => {
        const akOutput = processes.find((entry) => entry.name === "ak")?.output.join("") ?? "";
        return akOutput
          .split(/\r?\n/)
          .some(
            (line) =>
              line.includes('"method":"PATCH"') &&
              line.includes(`"path":"/api/boards/${board.id}"`) &&
              line.includes('"status":403') &&
              line.includes('"classification":"board-capability-required"'),
          );
      },
      "Agent-attributed Board capability rejection log",
      5_000,
    );
    const boardAfterAgent = await akRequest(akOrigin, csrf, cookie, "GET", `/api/boards/${board.id}`);
    if (boardAfterAgent.name !== boardBeforeAgent.name || boardAfterAgent.version !== boardBeforeAgent.version)
      fail("Agent-attributed forbidden Board PATCH changed Board state", JSON.stringify({ boardBeforeAgent, boardAfterAgent }));
    const rejection = { decision: "rejected", body: "Add the corrected black-box proof and resubmit." };
    const rejected = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      `/api/task-submissions/${firstSubmission.id}/reviews`,
      rejection,
      201,
      "reject-review",
    );
    const replay = await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      `/api/task-submissions/${firstSubmission.id}/reviews`,
      rejection,
      201,
      "reject-review",
    );
    if (replay.id !== rejected.id) fail("AK review idempotency replay changed the resource");
    await triggerScheduled(akOrigin, "AK");
    const corrected = await waitFor(async () => {
      const collection = await akRequest(akOrigin, csrf, cookie, "GET", `/api/tasks/${task.id}/submissions`);
      return collection.items.find((value) => value.status === "pending_review" && value.id !== firstSubmission.id) ?? false;
    }, "same-Session review feedback and corrected submission");
    if (corrected.summary !== "corrected smoke submission")
      fail("Corrected Agent submission summary was not the requested value", JSON.stringify(corrected));
    const allProgress = await akRequest(akOrigin, csrf, cookie, "GET", `/api/task-runs/${runResource.id}/progress-entries`);
    const checkpoints = allProgress.items.filter((entry) => entry.kind === "checkpoint").map((entry) => entry.body);
    for (const expected of ["board patch forbidden 403; real runner started", "review feedback resumed"])
      if (!checkpoints.includes(expected)) fail(`Missing exact Agent checkpoint: ${expected}`, JSON.stringify(allProgress));
    await akRequest(
      akOrigin,
      csrf,
      cookie,
      "POST",
      `/api/task-submissions/${corrected.id}/reviews`,
      { decision: "accepted", body: "Full chain verified." },
      201,
      "accept-review",
    );
    const done = await akRequest(akOrigin, csrf, cookie, "GET", `/api/tasks/${task.id}`);
    if (done.status !== "done") fail("AK Task did not reach done", JSON.stringify(done));
    const taskRuns = await akRequest(akOrigin, csrf, cookie, "GET", `/api/tasks/${task.id}/runs`);
    if (taskRuns.items.length !== 1) fail("Recoverable rejection created a duplicate TaskRun", JSON.stringify(taskRuns));

    await realAmaRequest(amaOrigin, controllerCredential, "DELETE", new URL(agentUri).pathname, undefined, 204);
    await realAmaRequest(amaOrigin, controllerCredential, "GET", new URL(agentUri).pathname, undefined, 404);
    await realAmaRequest(amaOrigin, controllerCredential, "GET", `/api/v1/vaults/${managedVault.metadata.uid}`, undefined, 404);
    await management(page, rrOrigin, "GET", `/api/agents/${encodeURIComponent(rrIdentity.id)}`, undefined, 404);
    const sessionId = new URL(running.amaSessionUri).pathname.split("/").at(-1);
    const runnerEvents = readFileSync(join(runnerWork, "sessions", sessionId, "events.jsonl"), "utf8");
    if (runnerEvents.includes("Agent Skills discovery error"))
      fail(
        "Real runner still reported an Agent Skills discovery error",
        runnerEvents
          .split(/\r?\n/)
          .filter((line) => line.includes("Agent Skills discovery error"))
          .join("\n"),
      );
    const processLogs = processes.map((entry) => entry.output.join("")).join("\n");
    for (const token of [controllerCredential.realmrootAccessToken, runnerCredential.realmrootAccessToken]) {
      if (token && processLogs.includes(token)) fail("A secondary Realmroot management credential leaked into service logs");
    }
    info(`PASS: real RR=${rrOrigin}, AMA=${amaOrigin}, AK=${akOrigin}; Agent ${agent.identity.subject}; Session ${running.amaSessionUri}`);
  } catch (error) {
    const diagnostics = processes.map(({ name, output }) => `--- ${name} ---\n${output.join("").split(/\r?\n/).slice(-80).join("\n")}`).join("\n");
    fail(error instanceof Error ? error.message : String(error), diagnostics);
  } finally {
    await stopAll();
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
