// spec: specs/agent-kanban.plan.md
// seed: tests/helpers/auth.ts

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const maintainerId = "maintainer-serial-activity";

test.describe("Maintainer activity", () => {
  test("queued and dispatching runs render status badges without session actions", async ({ page }) => {
    await signUpAndGetBoard(page, `maintainer_activity_${Date.now()}@example.com`);
    const boardId = new URL(page.url()).pathname.split("/")[2];

    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}`, (route) =>
      route.fulfill({
        json: {
          id: maintainerId,
          agent_id: "maintainer-agent",
          status: "active",
          heartbeat_enabled: true,
          interval_seconds: 300,
          last_run_at: "2026-07-20T12:00:00.000Z",
          last_session_id: null,
          last_error_message: null,
        },
      }),
    );
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/runs?*`, (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: "run-queued",
              scheduled_for: null,
              heartbeat_at: null,
              triggered_at: "2026-07-20T12:00:00.000Z",
              status: "queued",
              session_id: null,
              error_message: null,
              metadata: {},
            },
            {
              id: "run-dispatching",
              scheduled_for: null,
              heartbeat_at: null,
              triggered_at: "2026-07-20T12:00:01.000Z",
              status: "dispatching",
              session_id: null,
              error_message: null,
              metadata: {},
            },
          ],
          pagination: { limit: 100, hasMore: false },
        },
      }),
    );
    await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { data: [], pagination: { limit: 100, hasMore: false } } }));
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/memories?*`, (route) =>
      route.fulfill({ json: { data: [], pagination: { limit: 100, hasMore: false } } }),
    );
    await page.route(`**/api/boards/${boardId}/maintainers/${maintainerId}/variables`, (route) =>
      route.fulfill({ json: { data: [], credential_id: null, updated_at: null } }),
    );

    await page.goto(`/boards/${boardId}/maintainers/${maintainerId}`);
    await page.getByRole("tab", { name: /Activity/ }).click();

    const queuedRow = page.getByRole("row").filter({ hasText: "run-queued" });
    await expect(queuedRow.locator('[data-slot="badge"]')).toHaveText("queued");
    await expect(queuedRow.getByText("none", { exact: true })).toBeVisible();
    await expect(queuedRow.getByRole("button")).toHaveCount(0);

    const dispatchingRow = page.getByRole("row").filter({ hasText: "run-dispatching" });
    await expect(dispatchingRow.locator('[data-slot="badge"]')).toHaveText("dispatching");
    await expect(dispatchingRow.getByText("none", { exact: true })).toBeVisible();
    await expect(dispatchingRow.getByRole("button")).toHaveCount(0);
  });
});
