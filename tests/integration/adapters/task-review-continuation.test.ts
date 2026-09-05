import type { EnborClient } from "@realmroot/enbor-sdk";
import { deliverTaskReviewContinuation } from "@server/adapters/agency/taskReviewContinuation";
import { createBoard } from "@server/adapters/d1/boardRepo";
import { createTask } from "@server/adapters/d1/taskRepo";
import { d1TaskReviewDecisionRepository } from "@server/adapters/d1/tasks/d1TaskReviewDecisions";
import { d1TaskReviewSubmissionRepository } from "@server/adapters/d1/tasks/d1TaskReviewSubmissions";
import { replaceTaskReviewRejection } from "@server/usecases/tasks/replaceTaskReviewDecision";
import { replaceTaskReviewSubmission } from "@server/usecases/tasks/replaceTaskReviewSubmission";
import { expect, it, vi } from "vitest";
import { seedUser, setupMiniflare } from "../../helpers/db";

it("[spec: tasks/reject-review] admits one sender and refuses blind replay while acceptance is unknown", async () => {
  const { mf, db } = await setupMiniflare();
  const response = Promise.withResolvers<unknown>();
  let pending: Promise<unknown> | undefined;
  try {
    await seedUser(db, "owner", "owner@test.local");
    const board = await createBoard(db, "owner", "Review", "ops");
    const task = await createTask(db, "owner", { title: "Review", board_id: board.id });
    await db
      .prepare("UPDATE tasks SET status = 'in_progress', assigned_to = 'agent', assignee_identity_type = 'realmroot_actor' WHERE id = ?")
      .bind(task.id)
      .run();
    const submission = await replaceTaskReviewSubmission(d1TaskReviewSubmissionRepository(db), {
      ownerId: "owner",
      taskId: task.id,
      agentActorId: "agent",
      pullRequestUrl: null,
    });
    const entered = Promise.withResolvers<Parameters<typeof deliverTaskReviewContinuation>[2]>();
    const createMessage = vi.fn(() => response.promise);
    const client = {
      sessions: { createMessage, listMessages: vi.fn().mockResolvedValue({ data: [], pagination: { nextCursor: null } }) },
    } as unknown as EnborClient;
    pending = replaceTaskReviewRejection(
      d1TaskReviewDecisionRepository(db),
      { ownerId: "owner", taskId: task.id, reviewSubmissionVersion: submission.version, actor: { type: "human", id: "reviewer" }, reason: "Fix" },
      async (decision) => {
        const input = { ownerId: "owner", taskId: task.id, sessionId: "session", decisionId: decision.actionId!, content: "Exact feedback" };
        entered.resolve(input);
        await deliverTaskReviewContinuation(db, client, input);
      },
    );
    const input = await entered.promise;
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    await expect(deliverTaskReviewContinuation(db, client, input)).rejects.toMatchObject({ kind: "conflict" });
    expect(createMessage).toHaveBeenCalledOnce();
    response.resolve({});
    await pending;
    const receipt = await db.prepare("SELECT effect_state FROM task_review_decisions WHERE task_id = ?").bind(task.id).first();
    expect(receipt).toEqual({ effect_state: "delivered" });
  } finally {
    response.resolve({});
    await pending;
    await mf.dispose();
  }
});
