import {
  AK_ANNOTATION_KEY_SOURCE_EVENT,
  AK_ANNOTATION_KEY_SOURCE_URL,
  AK_LABEL_KEY_GITHUB_SUBJECT,
  AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS,
  MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS,
} from "@agent-kanban/shared";
import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { closeAmaSession, dispatchAmaHttpTriggerRun, listAmaSessions, reopenAmaSession } from "./amaRuntime";
import { listActiveBoardMaintainersForRepository } from "./boardMaintainerRepo";
import type { D1 } from "./db";
import {
  addInstallationRepositories,
  deleteInstallation,
  removeInstallationRepositories,
  replaceInstallationRepositories,
  setInstallationSuspended,
  upsertInstallation,
} from "./githubInstallations";
import { createLogger } from "./logger";
import { ensureMaintainerHttpTriggerSerial } from "./maintainerTriggerConcurrency";
import { releaseTaskRuntimeBinding } from "./taskDispatch";
import { cancelTask, completeTask, getTask } from "./taskRepo";
import type { Env } from "./types";

const logger = createLogger("githubWebhook");
const MAINTAINER_SAFE_CLOSE_GRACE_MS = 30_000;

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
  env: Env,
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
      WHERE t.pr_url = ? AND t.status IN ('in_review', 'in_progress')
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
      await releaseTaskRuntimeBinding(db, env, row.owner_id, fresh);
      const task = await completeTask(db, row.id, "machine", "github", "machine");
      if (!task) continue;
    } else {
      await releaseTaskRuntimeBinding(db, env, row.owner_id, fresh);
      const task = await cancelTask(db, row.id, "machine", "github", "machine");
      if (!task) continue;
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
type MaintainerWebhookPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: {
    id?: number;
    full_name?: string;
    html_url?: string;
    default_branch?: string;
  };
  issue?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  review?: Record<string, unknown>;
  sender?: Record<string, unknown>;
};

const MAINTAINER_GITHUB_EVENTS = new Set(["issues", "pull_request", "issue_comment", "pull_request_review", "pull_request_review_comment"]);

function toRepoInputs(repos: WebhookRepo[] | undefined): { fullName: string; repoId: number | null }[] {
  return (repos ?? [])
    .filter((repo): repo is { id?: number; full_name: string } => Boolean(repo.full_name))
    .map((repo) => ({ fullName: repo.full_name, repoId: repo.id ?? null }));
}

export async function handleGithubMaintainerEvent(
  db: D1,
  env: Env,
  input: { event: string; deliveryId?: string | null; payload: MaintainerWebhookPayload },
): Promise<{ handled: boolean; maintainers: string[] }> {
  if (!MAINTAINER_GITHUB_EVENTS.has(input.event)) return { handled: false, maintainers: [] };
  if (isOwnGithubAppBotEvent(env, input)) return { handled: false, maintainers: [] };
  const fullName = input.payload.repository?.full_name?.toLowerCase();
  const installationId = input.payload.installation?.id;
  if (!fullName || !installationId) return { handled: false, maintainers: [] };
  const sessionKey = githubMaintainerSessionKey(input);
  const lifecycle = githubMaintainerSessionLifecycle(input);
  if (!lifecycle.dispatchToAgent && !lifecycle.closeWithoutDispatch && !lifecycle.reopenWithoutDispatch) {
    return { handled: false, maintainers: [] };
  }
  const body = githubMaintainerRunBody(input, sessionKey);

  const maintainers = await listActiveBoardMaintainersForRepository(db, installationId, fullName);
  if (maintainers.length === 0) return { handled: false, maintainers: [] };

  const processed: string[] = [];
  for (const maintainer of maintainers) {
    if (!maintainer.ama_http_trigger_id) continue;
    await ensureMaintainerHttpTriggerSerial(db, env, maintainer);
    const projectId = await getAmaProjectId(db, maintainer.owner_id);
    if (!projectId) {
      throw new Error(`No AMA project for maintainer owner ${maintainer.owner_id}`);
    }
    if (sessionKey && lifecycle.closeWithoutDispatch) {
      const session = await findAmaMaintainerSessionByKey(env, maintainer.owner_id, projectId, maintainer.id, sessionKey);
      if (session && canCloseMaintainerSession(session)) {
        await closeAmaSession(env, maintainer.owner_id, projectId, session.id, "user_requested");
      }
      processed.push(maintainer.id);
      continue;
    }
    if (sessionKey && lifecycle.reopenWithoutDispatch) {
      const session = await findAmaMaintainerSessionByKey(env, maintainer.owner_id, projectId, maintainer.id, sessionKey);
      if (session?.state === "closed") {
        await reopenAmaSession(env, maintainer.owner_id, projectId, session.id, maintainerSessionIdleTimeoutMetadata());
      }
      processed.push(maintainer.id);
      continue;
    }
    if (sessionKey && lifecycle.reopenBeforeDispatch) {
      const session = await findAmaMaintainerSessionByKey(env, maintainer.owner_id, projectId, maintainer.id, sessionKey);
      if (session?.state === "closed") {
        await reopenAmaSession(env, maintainer.owner_id, projectId, session.id, maintainerSessionIdleTimeoutMetadata());
      }
    }
    await dispatchAmaHttpTriggerRun(env, maintainer.owner_id, {
      projectId,
      triggerId: maintainer.ama_http_trigger_id,
      idempotencyKey: input.deliveryId ?? `${input.event}:${input.payload.action ?? "unknown"}:${fullName}`,
      body,
    });
    processed.push(maintainer.id);
  }
  return { handled: processed.length > 0, maintainers: processed };
}

function githubMaintainerSessionLifecycle(input: { event: string; payload: MaintainerWebhookPayload }) {
  const action = input.payload.action ?? "";
  const { subject } = githubMaintainerSubject(input);
  const subjectState = typeof subject?.state === "string" ? subject.state : null;
  const subjectClosed = subjectState === "closed";
  const subjectCloseEvent = (input.event === "issues" || input.event === "pull_request") && action === "closed";
  const subjectReopenEvent = (input.event === "issues" || input.event === "pull_request") && action === "reopened";
  const subjectDraftEvent = input.event === "pull_request" && action === "converted_to_draft";
  return {
    dispatchToAgent: githubMaintainerShouldDispatch(input),
    closeWithoutDispatch: subjectCloseEvent || subjectDraftEvent,
    reopenWithoutDispatch: subjectReopenEvent,
    reopenBeforeDispatch: subjectReopenEvent || (subjectClosed && !subjectCloseEvent && !subjectDraftEvent),
  };
}

function githubMaintainerShouldDispatch(input: { event: string; payload: MaintainerWebhookPayload }): boolean {
  const action = input.payload.action ?? "";
  if (input.event === "issues") return action === "opened";
  if (input.event === "pull_request") {
    if (action === "ready_for_review") return true;
    if (action === "opened" || action === "synchronize") return input.payload.pull_request?.draft !== true;
    return false;
  }
  if (input.event === "issue_comment") return (action === "created" || action === "edited") && !githubMaintainerIsDraftPullRequest(input);
  if (input.event === "pull_request_review") {
    return (action === "submitted" || action === "edited") && !githubMaintainerIsDraftPullRequest(input);
  }
  if (input.event === "pull_request_review_comment") {
    return (action === "created" || action === "edited") && !githubMaintainerIsDraftPullRequest(input);
  }
  return false;
}

function githubMaintainerIsDraftPullRequest(input: { event: string; payload: MaintainerWebhookPayload }): boolean {
  const { subject, type } = githubMaintainerSubject(input);
  if (type !== "pull_request") return false;

  const pullRequest = input.payload.pull_request;
  if (typeof pullRequest?.draft === "boolean") return pullRequest.draft;
  if (typeof subject?.draft === "boolean") return subject.draft;
  return false;
}

async function findAmaMaintainerSessionByKey(
  env: Env,
  ownerId: string,
  projectId: string,
  maintainerId: string,
  key: string,
): Promise<{ id: string; state: string | null; updatedAt: string | null } | null> {
  const page = await listAmaSessions(env, ownerId, projectId, {
    limit: 1,
    archived: false,
    labelSelector: `maintainerId=${maintainerId},${AK_LABEL_KEY_GITHUB_SUBJECT}=${key}`,
  });
  const session = page.data[0];
  const id = typeof session?.id === "string" ? session.id : null;
  return id ? { id, state: sessionState(session), updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : null } : null;
}

function canCloseMaintainerSession(session: { state: string | null; updatedAt?: string | null }): boolean {
  if (session.state !== "idle") return false;
  if (!session.updatedAt) return true;
  const updatedAt = Date.parse(session.updatedAt);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt >= MAINTAINER_SAFE_CLOSE_GRACE_MS;
}

function maintainerSessionIdleTimeoutMetadata() {
  return {
    annotations: {
      [AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS]: String(MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS),
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sessionState(session: Record<string, unknown> | null): string | null {
  if (!session) return null;
  if (typeof session.state === "string") return session.state;
  if (typeof session.status === "string") return session.status;
  const status = recordValue(session.status);
  return typeof status?.phase === "string" ? status.phase : null;
}

function isOwnGithubAppBotEvent(env: Env, input: { event: string; payload: MaintainerWebhookPayload }): boolean {
  const slug = env.GITHUB_APP_SLUG;
  if (!slug) return false;
  if (input.payload.sender?.type !== "Bot" || input.payload.sender?.login !== `${slug}[bot]`) return false;
  return input.event === "issue_comment" || input.event === "pull_request_review" || input.event === "pull_request_review_comment";
}

function subjectNumber(subject: Record<string, unknown> | undefined): number | null {
  return typeof subject?.number === "number" ? subject.number : null;
}

function githubMaintainerSubject(input: { event: string; payload: MaintainerWebhookPayload }): {
  subject: Record<string, unknown> | undefined;
  type: "issue" | "pull_request";
} {
  if (input.event === "issues") return { subject: input.payload.issue, type: "issue" };
  if (input.event === "issue_comment") {
    return { subject: input.payload.issue, type: input.payload.issue?.pull_request ? "pull_request" : "issue" };
  }
  return { subject: input.payload.pull_request, type: "pull_request" };
}

function githubMaintainerSessionKey(input: { event: string; payload: MaintainerWebhookPayload }): string | null {
  const fullName = input.payload.repository?.full_name?.toLowerCase();
  const { subject, type } = githubMaintainerSubject(input);
  const number = subjectNumber(subject);
  const keyType = type === "pull_request" ? "pull" : type;
  return fullName && number !== null ? `github:${fullName}:${keyType}:${number}` : null;
}

function githubMaintainerSourceUrl(input: { event: string; payload: MaintainerWebhookPayload }): string | null {
  if (input.event === "issue_comment" || input.event === "pull_request_review_comment") {
    return typeof input.payload.comment?.html_url === "string" ? input.payload.comment.html_url : null;
  }
  if (input.event === "pull_request_review") {
    return typeof input.payload.review?.html_url === "string" ? input.payload.review.html_url : null;
  }
  return null;
}

function githubMaintainerMetadata(input: { event: string; deliveryId?: string | null; payload: MaintainerWebhookPayload }, key: string | null) {
  const action = input.payload.action;
  const sourceEvent = typeof action === "string" && action.length > 0 ? `${input.event}.${action}` : input.event;
  const sourceUrl = githubMaintainerSourceUrl(input);
  return {
    ...(key ? { labels: { [AK_LABEL_KEY_GITHUB_SUBJECT]: key } } : {}),
    annotations: {
      [AK_ANNOTATION_KEY_SOURCE_EVENT]: sourceEvent,
      ...(sourceUrl ? { [AK_ANNOTATION_KEY_SOURCE_URL]: sourceUrl } : {}),
    },
  };
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const item = value?.[key];
  return item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
}

function compactActor(actor: Record<string, unknown> | undefined) {
  return {
    login: typeof actor?.login === "string" ? actor.login : null,
    type: typeof actor?.type === "string" ? actor.type : null,
    html_url: typeof actor?.html_url === "string" ? actor.html_url : null,
  };
}

function compactRepository(repository: MaintainerWebhookPayload["repository"]) {
  return {
    id: typeof repository?.id === "number" ? repository.id : null,
    full_name: repository?.full_name ?? null,
    html_url: repository?.html_url ?? null,
    default_branch: repository?.default_branch ?? null,
  };
}

function compactSubject(subject: Record<string, unknown> | undefined, type: "issue" | "pull_request") {
  return {
    type,
    id: typeof subject?.id === "number" ? subject.id : null,
    node_id: typeof subject?.node_id === "string" ? subject.node_id : null,
    number: typeof subject?.number === "number" ? subject.number : null,
    html_url: typeof subject?.html_url === "string" ? subject.html_url : null,
    state: typeof subject?.state === "string" ? subject.state : null,
    draft: typeof subject?.draft === "boolean" ? subject.draft : null,
    merged: typeof subject?.merged === "boolean" ? subject.merged : null,
  };
}

function compactComment(comment: Record<string, unknown> | undefined) {
  return {
    id: typeof comment?.id === "number" ? comment.id : null,
    node_id: typeof comment?.node_id === "string" ? comment.node_id : null,
    html_url: typeof comment?.html_url === "string" ? comment.html_url : null,
    path: typeof comment?.path === "string" ? comment.path : null,
    line: typeof comment?.line === "number" ? comment.line : null,
    start_line: typeof comment?.start_line === "number" ? comment.start_line : null,
    user: compactActor(recordField(comment, "user")),
  };
}

function compactReview(review: Record<string, unknown> | undefined) {
  return {
    id: typeof review?.id === "number" ? review.id : null,
    node_id: typeof review?.node_id === "string" ? review.node_id : null,
    state: typeof review?.state === "string" ? review.state : null,
    html_url: typeof review?.html_url === "string" ? review.html_url : null,
    submitted_at: typeof review?.submitted_at === "string" ? review.submitted_at : null,
    user: compactActor(recordField(review, "user")),
  };
}

function githubMaintainerRunBody(
  input: { event: string; deliveryId?: string | null; payload: MaintainerWebhookPayload },
  key: string | null,
): Record<string, unknown> {
  const { subject, type } = githubMaintainerSubject(input);
  const body = {
    event: input.event,
    action: input.payload.action ?? "",
    delivery_id: input.deliveryId ?? null,
    routing_key: key,
    repository: compactRepository(input.payload.repository),
    subject: compactSubject(subject, type),
    comment: compactComment(input.payload.comment),
    review: compactReview(input.payload.review),
    sender: compactActor(input.payload.sender),
    metadata: githubMaintainerMetadata(input, key),
  };
  return body;
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
