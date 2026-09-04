import { d1TaskReviewDecisionRepository } from "@server/adapters/d1/tasks/d1TaskReviewDecisions";
import { d1TaskReviewSubmissionRepository } from "@server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { inboxTaskLifecycleNotifier } from "@server/adapters/realmroot/inboxTaskLifecycleNotifier";
import type { Env } from "@server/env";
import { v2Problem } from "@server/http/middleware/v2Contract";
import {
  actorRequired,
  agentActorRequired,
  mediaType,
  resourceLocation,
  type TaskContext,
  taskNotFound,
  taskWorkflowActor,
  verifiedAgentActorId,
} from "@server/http/tasks/workflowSupport";
import { replaceTaskReviewCompletion, replaceTaskReviewRejection, TaskReviewDecisionFailure } from "@server/usecases/tasks/replaceTaskReviewDecision";
import {
  readTaskReviewSubmission,
  replaceTaskReviewSubmission,
  TaskReviewSubmissionFailure,
} from "@server/usecases/tasks/replaceTaskReviewSubmission";
import { notifyTaskLifecycle } from "@server/usecases/tasks/taskLifecycleNotifications";
import type { Hono } from "hono";

export function registerTaskReviewRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/task-review-submissions/:taskId", getReviewSubmission);
  api.put("/api/task-review-submissions/:taskId", replaceReviewSubmission);
  api.put("/api/task-review-rejections/:taskId", replaceReviewRejection);
  api.put("/api/task-review-completions/:taskId", replaceReviewCompletion);
}

async function getReviewSubmission(c: TaskContext): Promise<Response> {
  try {
    const result = await readTaskReviewSubmission(d1TaskReviewSubmissionRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
    });
    c.header("ETag", `"${result.version}"`);
    return c.json(result.submission);
  } catch (error) {
    if (!(error instanceof TaskReviewSubmissionFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    if (error.code === "TASK_REVIEW_SUBMISSION_NOT_FOUND") {
      return v2Problem(c, 404, "task-review-submission-not-found", "Task review submission not found", error.message);
    }
    throw error;
  }
}

async function replaceReviewSubmission(c: TaskContext): Promise<Response> {
  const agentActorId = verifiedAgentActorId(c);
  if (!agentActorId) return agentActorRequired(c);
  const parsedInput = await readReviewSubmissionInput(c);
  if (parsedInput instanceof Response) return parsedInput;
  try {
    const result = await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      agentActorId,
      pullRequestUrl: parsedInput.pullRequestUrl,
    });
    c.header("Location", resourceLocation(c, "task-review-submissions", result.submission.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.submission, result.created ? 201 : 200);
  } catch (error) {
    if (!(error instanceof TaskReviewSubmissionFailure)) throw error;
    if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
    if (error.code === "TASK_REVIEW_FORBIDDEN") return v2Problem(c, 403, "task-review-forbidden", "Task review forbidden", error.message);
    return v2Problem(c, 409, "task-review-conflict", "Task review conflict", error.message);
  }
}

async function replaceReviewRejection(c: TaskContext): Promise<Response> {
  const actor = taskWorkflowActor(c);
  if (!actor) return actorRequired(c);
  const input = await readReviewRejectionInput(c);
  if (input instanceof Response) return input;
  try {
    const result = await replaceTaskReviewRejection(d1TaskReviewDecisionRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      reviewSubmissionVersion: input.reviewSubmissionVersion,
      actor,
      reason: input.reason,
    });
    await notifyTaskLifecycle(inboxTaskLifecycleNotifier(c.env), {
      taskId: result.rejection.taskId,
      assigneeActorId: result.assigneeActorId,
      contextId: c.get("ownerId"),
      event: "review_rejected",
      version: result.version,
      reason: result.rejection.reason,
    });
    c.header("Location", resourceLocation(c, "task-review-rejections", result.rejection.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.rejection, result.created ? 201 : 200);
  } catch (error) {
    return mapReviewDecisionFailure(c, error);
  }
}

async function replaceReviewCompletion(c: TaskContext): Promise<Response> {
  const actor = taskWorkflowActor(c);
  if (!actor) return actorRequired(c);
  const input = await readReviewCompletionInput(c);
  if (input instanceof Response) return input;
  try {
    const result = await replaceTaskReviewCompletion(d1TaskReviewDecisionRepository(c.env.DB), {
      ownerId: c.get("ownerId"),
      taskId: c.req.param("taskId")!,
      reviewSubmissionVersion: input.reviewSubmissionVersion,
      actor,
    });
    c.header("Location", resourceLocation(c, "task-review-completions", result.completion.taskId));
    c.header("ETag", `"${result.version}"`);
    return c.json(result.completion, result.created ? 201 : 200);
  } catch (error) {
    return mapReviewDecisionFailure(c, error);
  }
}

async function readReviewSubmissionInput(c: TaskContext): Promise<{ pullRequestUrl: string | null } | Response> {
  if (c.req.raw.body === null) return { pullRequestUrl: null };
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "pullRequestUrl")) {
    return v2Problem(c, 422, "invalid-task-review-submission", "Invalid Task review submission", "Only pullRequestUrl may be supplied");
  }
  const suppliedUrl = (body as { pullRequestUrl?: unknown }).pullRequestUrl;
  if (suppliedUrl === undefined) return { pullRequestUrl: null };
  if (typeof suppliedUrl !== "string" || suppliedUrl.length > 2048 || suppliedUrl.trim() !== suppliedUrl || !/^https?:\/\//i.test(suppliedUrl)) {
    return invalidPullRequestUrl(c);
  }
  try {
    const parsed = new URL(suppliedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalidPullRequestUrl(c);
    return { pullRequestUrl: parsed.toString() };
  } catch {
    return invalidPullRequestUrl(c);
  }
}

async function readReviewRejectionInput(c: TaskContext): Promise<{ reviewSubmissionVersion: string; reason: string | null } | Response> {
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "reason" && key !== "reviewSubmissionVersion")
  ) {
    return v2Problem(
      c,
      422,
      "invalid-task-review-rejection",
      "Invalid Task Review Rejection",
      "reviewSubmissionVersion is required; reason is optional",
    );
  }
  const reviewSubmissionVersion = readReviewSubmissionVersion(body, c, "invalid-task-review-rejection", "Invalid Task Review Rejection");
  if (reviewSubmissionVersion instanceof Response) return reviewSubmissionVersion;
  const reason = (body as { reason?: unknown }).reason;
  if (reason === undefined || reason === "") return { reviewSubmissionVersion, reason: null };
  if (typeof reason !== "string" || reason.length > 4000) {
    return v2Problem(c, 422, "invalid-task-review-rejection", "Invalid Task Review Rejection", "reason must be a string of at most 4000 characters");
  }
  return { reviewSubmissionVersion, reason };
}

async function readReviewCompletionInput(c: TaskContext): Promise<{ reviewSubmissionVersion: string } | Response> {
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "reviewSubmissionVersion")) {
    return v2Problem(c, 422, "invalid-task-review-completion", "Invalid Task Review Completion", "reviewSubmissionVersion must be the only property");
  }
  const version = readReviewSubmissionVersion(body, c, "invalid-task-review-completion", "Invalid Task Review Completion");
  return version instanceof Response ? version : { reviewSubmissionVersion: version };
}

async function readJson(c: TaskContext): Promise<unknown | Response> {
  if (mediaType(c) !== "application/json") {
    return v2Problem(c, 415, "unsupported-media-type", "Unsupported media type", "Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return v2Problem(c, 400, "invalid-json", "Invalid JSON", "The request body must be valid JSON");
  }
  return body;
}

function readReviewSubmissionVersion(body: object, c: TaskContext, type: string, title: string): string | Response {
  const version = (body as { reviewSubmissionVersion?: unknown }).reviewSubmissionVersion;
  if (typeof version !== "string" || !version || version.length > 200) {
    return v2Problem(c, 422, type, title, "reviewSubmissionVersion must be a non-empty string of at most 200 characters");
  }
  return version;
}

function mapReviewDecisionFailure(c: TaskContext, error: unknown): Response {
  if (!(error instanceof TaskReviewDecisionFailure)) throw error;
  if (error.code === "TASK_NOT_FOUND") return taskNotFound(c, error.message);
  if (error.code === "TASK_REVIEW_DECISION_FORBIDDEN") {
    return v2Problem(c, 403, "task-review-decision-forbidden", "Task review decision forbidden", error.message);
  }
  if (error.code === "TASK_REVIEW_PRECONDITION_FAILED") {
    return v2Problem(c, 412, "task-review-precondition-failed", "Task review precondition failed", error.message);
  }
  return v2Problem(c, 409, "task-review-decision-conflict", "Task review decision conflict", error.message);
}

function invalidPullRequestUrl(c: TaskContext): Response {
  return v2Problem(
    c,
    422,
    "invalid-task-review-submission",
    "Invalid Task review submission",
    "pullRequestUrl must be an absolute HTTP or HTTPS URL",
  );
}
