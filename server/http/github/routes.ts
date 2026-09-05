import { listRepositories, normalizeGitUrl } from "@server/adapters/d1/repositoryRepo";
import { isGithubAppConfigured, listInstallationRepositories, recordInstallationFromSetup } from "@server/adapters/github/githubApp";
import { getInstallationsForOwner } from "@server/adapters/github/githubInstallations";
import {
  handleGithubInstallationEvent,
  handleGithubInstallationRepositoriesEvent,
  handleGithubPullRequestEvent,
  verifyGithubSignature,
} from "@server/adapters/github/githubWebhook";
import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { finishWebhookTask } from "@server/http/tasks/dispatchAssignedTask";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerGithubWebhookRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/webhooks/github-app", async (c) => {
    const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) throw new HTTPException(503, { message: "GitHub App webhook is not configured" });
    const signature = c.req.header("x-hub-signature-256");
    const body = await c.req.text();
    if (!signature || !(await verifyGithubSignature(secret, body, signature))) {
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }
    const event = c.req.header("x-github-event");
    const payload = JSON.parse(body);
    if (event === "pull_request")
      return c.json({
        ok: true,
        ...(await handleGithubPullRequestEvent(c.env.DB, c.env, payload, (ownerId, taskId) =>
          finishWebhookTask(c.env, ownerId, taskId, c.get("traceparent")),
        )),
      });
    if (event === "installation") return c.json({ ok: true, ...(await handleGithubInstallationEvent(c.env.DB, payload)) });
    if (event === "installation_repositories") {
      return c.json({ ok: true, ...(await handleGithubInstallationRepositoriesEvent(c.env.DB, payload)) });
    }
    return c.json({ ok: true, handled: false });
  });
}

export function registerGithubSetupRedirectRoute(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/github-app/setup", (c) => {
    const installationId = Number(c.req.query("installation_id"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new HTTPException(400, { message: "installation_id is required" });
    }
    return c.redirect(`/repositories?installation_id=${installationId}`);
  });
}

export function registerGithubApplicationRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/github-app/config", authorizeScope("repository:read"), async (c) => {
    const slug = c.env.GITHUB_APP_SLUG ?? null;
    const active = (await getInstallationsForOwner(c.env.DB, c.get("ownerId"))).filter((installation) => installation.suspendedAt === null);
    return c.json({
      configured: isGithubAppConfigured(c.env),
      slug,
      installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : null,
      installed: active.length > 0,
      accounts: active.map((installation) => installation.accountLogin),
    });
  });

  api.put("/api/repository-installations/:installationId", authorizeScope("repository:write"), async (c) => {
    if (!isGithubAppConfigured(c.env)) throw new HTTPException(503, { message: "GitHub App is not configured" });
    const installationId = Number(c.req.param("installationId"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new HTTPException(400, { message: "installationId must be a positive integer" });
    }
    await recordInstallationFromSetup(c.env.DB, c.env, c.get("ownerId"), installationId);
    return c.body(null, 204);
  });

  api.get("/api/github-app/repositories", authorizeScope("repository:read"), async (c) => {
    const ownerId = c.get("ownerId");
    const installations = (await getInstallationsForOwner(c.env.DB, ownerId)).filter((installation) => installation.suspendedAt === null);
    if (installations.length === 0) return c.json({ installed: false, repositories: [] });

    const existingUrls = new Set((await listRepositories(c.env.DB, ownerId)).map((repository) => repository.url));
    const remoteRepositories = await Promise.all(
      installations.map((installation) => listInstallationRepositories(c.env, installation.installationId)),
    );
    const seen = new Set<string>();
    const repositories: Array<{ fullName: string; name: string; cloneUrl: string; private: boolean; alreadyAdded: boolean }> = [];
    for (const repository of remoteRepositories.flat()) {
      const key = repository.full_name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repositories.push({
        fullName: repository.full_name,
        name: repository.name,
        cloneUrl: repository.clone_url,
        private: repository.private,
        alreadyAdded: existingUrls.has(normalizeGitUrl(repository.clone_url)),
      });
    }
    repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
    return c.json({ installed: true, repositories });
  });
}
