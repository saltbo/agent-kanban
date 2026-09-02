import { getTask } from "@server/adapters/d1/taskRepo";
import { d1TaskCancellationRepository } from "@server/adapters/d1/tasks/d1TaskCancellations";
import { d1TaskReviewDecisionRepository } from "@server/adapters/d1/tasks/d1TaskReviewDecisions";
import {
  addInstallationRepositories,
  deleteInstallation,
  removeInstallationRepositories,
  replaceInstallationRepositories,
  setInstallationSuspended,
  upsertInstallation,
} from "@server/adapters/github/githubInstallations";
import type { D1 } from "@server/db";
import type { Env } from "@server/env";
import { createLogger } from "@server/observability/logger";
import { replaceTaskCancellation } from "@server/usecases/tasks/replaceTaskCancellation";
import { replaceTaskReviewCompletion } from "@server/usecases/tasks/replaceTaskReviewDecision";

const logger = createLogger("githubWebhook");

// PR state sync comes through a platform GitHub App: users install the app on
// their repositories (one click, no secrets) and GitHub delivers all
// installations' pull_request events to one endpoint, signed with the app
// webhook secret. The secret never leaves the platform; tenant routing is by
// pr_url, which only ever matches tasks inside the PR owner's own boards.

// GitHub signs the raw body with HMAC-SHA256: X-Hub-Signature-256: sha256=<hex>
export async function verifyGithubSignature(secret: string, body: string, signatureHeader: string): Promise<boolean> {
  const expected = signatureHeader.replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Constant-time comparison
  const expectedLower = expected.toLowerCase();
  if (actual.length !== expectedLower.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedLower.charCodeAt(i);
  }
  return diff === 0;
}

// PR merged → task done; PR closed without merge → task cancelled.
// Replaces the old daemon's 30s gh-CLI poll with real-time delivery.
export async function handleGithubPullRequestEvent(
  db: D1,
  _env: Env,
  payload: { action?: string; pull_request?: { html_url?: string; merged?: boolean } },
): Promise<{ handled: boolean; tasks: string[] }> {
  if (payload.action !== "closed") return { handled: false, tasks: [] };
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return { handled: false, tasks: [] };
  const merged = payload.pull_request?.merged === true;

  const rows = await db
    .prepare(`
      SELECT t.id, t.status, b.owner_id FROM tasks t
      JOIN boards b ON t.board_id = b.id
      WHERE t.pr_url = ?
        AND t.status IN ('in_review', 'in_progress')
    `)
    .bind(prUrl)
    .all<{ id: string; status: string; owner_id: string }>();

  const transitioned: string[] = [];
  for (const row of rows.results) {
    const fresh = await getTask(db, row.id, row.owner_id);
    if (!fresh) continue;
    if (merged) {
      if (row.status !== "in_review") {
        // PR merged while the task is still in_progress: the agent has not
        // submitted for review yet, and the state machine has no
        // machine-driven path from in_progress to done. Leave it to the agent.
        logger.warn(`PR merged for task ${row.id} while ${row.status}; skipping`);
        continue;
      }
      if (fresh.assignee_identity_type !== "realmroot_actor") {
        logger.warn(`PR merged for Task ${row.id} without a v2 Realmroot assignee; skipping`);
        continue;
      }
      const repository = d1TaskReviewDecisionRepository(db);
      const target = await repository.findCurrentTarget(row.owner_id, row.id);
      if (!target?.activeReviewSubmissionVersion) {
        logger.warn(`PR merged for Realmroot-assigned task ${row.id} without a current Review Submission; skipping`);
        continue;
      }
      await replaceTaskReviewCompletion(repository, {
        ownerId: row.owner_id,
        taskId: row.id,
        reviewSubmissionVersion: target.activeReviewSubmissionVersion,
        actor: { type: "system", id: "github" },
      });
    } else {
      await replaceTaskCancellation(d1TaskCancellationRepository(db), {
        ownerId: row.owner_id,
        taskId: row.id,
        actor: { type: "system", id: "github" },
      });
    }
    transitioned.push(row.id);
  }
  return { handled: true, tasks: transitioned };
}

type InstallationPayload = {
  id?: number;
  account?: { login?: string; id?: number; type?: string };
  repository_selection?: string;
  suspended_at?: string | null;
};

type WebhookRepo = { id?: number; full_name?: string };
function toRepoInputs(repos: WebhookRepo[] | undefined): { fullName: string; repoId: number | null }[] {
  return (repos ?? [])
    .filter((repo): repo is { id?: number; full_name: string } => Boolean(repo.full_name))
    .map((repo) => ({ fullName: repo.full_name, repoId: repo.id ?? null }));
}
// installation events: keep the installation row + its selected-repo snapshot in
// sync with GitHub. created/uninstalled/suspended drive App coverage for the
// repo read model. No GitHub API calls — the payload is self-sufficient.
export async function handleGithubInstallationEvent(
  db: D1,
  payload: { action?: string; installation?: InstallationPayload; repositories?: WebhookRepo[] },
): Promise<{ handled: boolean; action: string }> {
  const installation = payload.installation;
  const installationId = installation?.id;
  const action = payload.action ?? "";
  if (!installationId) return { handled: false, action };

  if (action === "deleted") {
    await deleteInstallation(db, installationId);
    return { handled: true, action };
  }
  if (action === "suspend") {
    // GitHub always sends suspended_at on a suspend event; trust it rather than inventing one.
    await setInstallationSuspended(db, installationId, installation?.suspended_at ?? null);
    return { handled: true, action };
  }
  if (action === "unsuspend") {
    await setInstallationSuspended(db, installationId, null);
    return { handled: true, action };
  }

  // created / new_permissions_accepted / etc: upsert the row and snapshot repos.
  const account = installation?.account;
  if (!account?.login || account.id === undefined || !account.type || !installation?.repository_selection) {
    logger.warn(`installation ${action} for ${installationId} missing account/selection; skipping`);
    return { handled: false, action };
  }
  await upsertInstallation(db, {
    installationId,
    accountLogin: account.login,
    accountId: account.id,
    accountType: account.type,
    repositorySelection: installation.repository_selection,
    suspendedAt: installation.suspended_at ?? null,
  });
  if (installation.repository_selection === "selected") {
    await replaceInstallationRepositories(db, installationId, toRepoInputs(payload.repositories));
  } else {
    await replaceInstallationRepositories(db, installationId, []);
  }
  return { handled: true, action };
}

// installation_repositories events: a repo was added to / removed from a
// 'selected' installation. Flips per-repo App coverage on the next read.
export async function handleGithubInstallationRepositoriesEvent(
  db: D1,
  payload: {
    action?: string;
    installation?: InstallationPayload;
    repository_selection?: string;
    repositories_added?: WebhookRepo[];
    repositories_removed?: WebhookRepo[];
  },
): Promise<{ handled: boolean; action: string }> {
  const installation = payload.installation;
  const installationId = installation?.id;
  const action = payload.action ?? "";
  if (!installationId) return { handled: false, action };

  const account = installation?.account;
  const selection = payload.repository_selection ?? installation?.repository_selection;
  if (account?.login && account.id !== undefined && account.type && selection) {
    await upsertInstallation(db, {
      installationId,
      accountLogin: account.login,
      accountId: account.id,
      accountType: account.type,
      repositorySelection: selection,
      suspendedAt: installation?.suspended_at ?? null,
    });
  }

  // 'all' covers everything by account login; the selected-repo rows are moot.
  if (selection === "all") {
    await replaceInstallationRepositories(db, installationId, []);
    return { handled: true, action };
  }

  await addInstallationRepositories(db, installationId, toRepoInputs(payload.repositories_added));
  await removeInstallationRepositories(
    db,
    installationId,
    (payload.repositories_removed ?? []).map((repo) => repo.full_name).filter((name): name is string => Boolean(name)),
  );
  return { handled: true, action };
}
