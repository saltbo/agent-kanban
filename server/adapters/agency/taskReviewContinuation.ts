import { EnborApiError, type EnborClient } from "@realmroot/enbor-sdk";
import type { D1 } from "@server/db";
import { ApplicationError } from "@server/usecases/applicationError";

const path = '$.annotations."agent-kanban.dev/review-delivery"';

export async function deliverTaskReviewContinuation(
  db: D1,
  client: EnborClient,
  input: { ownerId: string; taskId: string; sessionId: string; decisionId: string; content: string },
): Promise<void> {
  const reserved = await db
    .prepare(`UPDATE tasks SET metadata = json_set(metadata, '${path}', ?), version = version + 1, updated_at = ?
    WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
      AND json_extract(metadata, '${path}') IS NOT ?
      AND EXISTS (SELECT 1 FROM task_review_decisions d WHERE d.task_id = tasks.id AND d.action_id = ? AND d.state = 'accepted' AND d.effect_state = 'pending')`)
    .bind(input.decisionId, new Date().toISOString(), input.taskId, input.ownerId, input.decisionId, input.decisionId)
    .run();
  if (reserved.meta.changes !== 1) {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await client.sessions.listMessages(input.sessionId, { limit: 100, cursor });
      if (
        page.data.some(
          (message) =>
            message.sessionId === input.sessionId &&
            message.type === "prompt" &&
            message.content === input.content &&
            ["accepted", "delivered"].includes(message.state),
        )
      )
        return;
      const next = page.pagination.nextCursor ?? undefined;
      if (!next) break;
      if (next === cursor || pageIndex === 99) throw new Error("Session continuation reconciliation did not complete");
      cursor = next;
    }
    throw new ApplicationError(
      "conflict",
      "Review continuation delivery is pending or uncertain. Retry to reconcile the original Session; no duplicate prompt was sent.",
    );
  }
  try {
    await client.sessions.createMessage(input.sessionId, { type: "prompt", requestId: `ak-review-${input.decisionId}`, content: input.content });
  } catch (error) {
    // Explicit rejection did not accept a prompt. Unknown outcomes retain the
    // reservation until Session message history proves acceptance.
    if (error instanceof EnborApiError && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0)) {
      await db
        .prepare(`UPDATE tasks SET metadata = json_remove(metadata, '${path}'), version = version + 1, updated_at = ?
        WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?) AND json_extract(metadata, '${path}') = ?`)
        .bind(new Date().toISOString(), input.taskId, input.ownerId, input.decisionId)
        .run();
    }
    throw error;
  }
}
