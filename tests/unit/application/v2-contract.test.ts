import { describe, expect, it } from "vitest";
import { isPublishedV2Operation } from "../../../server/http/middleware/v2Contract";

describe("isPublishedV2Operation", () => {
  it.each([
    ["GET", "/api/tasks"],
    ["POST", "/api/tasks"],
    ["GET", "/api/tasks/task-1"],
    ["PATCH", "/api/tasks/task-1"],
    ["DELETE", "/api/tasks/task-1"],
    ["GET", "/api/tasks/task-1/notes"],
    ["POST", "/api/tasks/task-1/notes"],
    ["GET", "/api/tasks/task-1/notes/note-1"],
    ["GET", "/api/tasks/task-1/session"],
    ["GET", "/api/tasks/task-1/session/ws"],
    ["GET", "/api/tasks/task-1/stream"],
    ["POST", "/api/tasks/task-1/claims"],
    ["GET", "/api/tasks/task-1/events"],
  ])("recognizes the published Task operation %s %s", (method, path) => {
    expect(isPublishedV2Operation(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/api/task-assignments/task-1"],
    ["PUT", "/api/task-assignments/task-1"],
    ["GET", "/api/task-claims/task-1"],
    ["PUT", "/api/task-claims/task-1"],
    ["DELETE", "/api/task-claims/task-1"],
    ["DELETE", "/api/task-cancellations/task-1"],
    ["PUT", "/api/task-cancellations/task-1"],
    ["GET", "/api/task-review-submissions/task-1"],
    ["PUT", "/api/task-review-submissions/task-1"],
    ["GET", "/api/task-events"],
    ["GET", "/api/task-events?taskId=task-1"],
    ["POST", "/api/task-events/foo"],
    ["POST", "/api/task-review-submissions/task-1"],
    ["GET", "/api/task-review-rejections/task-1"],
    ["PUT", "/api/task-review-rejections/task-1"],
    ["GET", "/api/task-review-completions/task-1"],
    ["PUT", "/api/task-review-completions/task-1"],
    ["GET", "/api/tasks/task-1/notes/note-1/extra"],
    ["GET", "/api/tasks/task-1/claims"],
    ["PUT", "/api/tasks/task-1/claims"],
    ["GET", "/api/tasks/task-1/claims/claim-1"],
    ["DELETE", "/api/tasks/task-1/claims/claim-1"],
    ["POST", "/api/tasks/task-1/claims/claim-1"],
    ["GET", "/api/tasks/task-1/claims/claim-1/extra"],
    ["POST", "/api/tasks/task-1/events"],
    ["GET", "/api/tasks/task-1/events/extra"],
    ["GET", "/api/tasks//stream"],
  ])("rejects the non-operation Task shape %s %s", (method, path) => {
    expect(isPublishedV2Operation(method, path)).toBe(false);
  });

  it.each([
    ["GET", "/api/github-app/config"],
    ["GET", "/api/github-app/repositories"],
    ["PUT", "/api/repository-installations/123"],
  ])("recognizes the published GitHub operation %s %s", (method, path) => {
    expect(isPublishedV2Operation(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/api/github-app/setup"],
    ["POST", "/api/github-app/config"],
    ["POST", "/api/github-app/repositories"],
    ["GET", "/api/repository-installations/123"],
    ["PUT", "/api/repository-installations/"],
    ["GET", "/api/docs/openapi.json"],
  ])("rejects the non-business operation %s %s", (method, path) => {
    expect(isPublishedV2Operation(method, path)).toBe(false);
  });
});
