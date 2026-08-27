import { expect, test } from "@playwright/test";
import { signIn } from "./product-fixtures";

test("unauthenticated visitors get the Realmroot sign-in boundary", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Orchestrate AI Coding Agents on a Kanban Board" })).toBeVisible();
  await page.getByRole("link", { name: "Start Building" }).click();
  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Realmroot" })).toBeVisible();
  await expect(page.getByText(/leader|worker|subagent|daemon|ak start|GitHub App|maintainer/i)).toHaveCount(0);
});

test("signed-in controller observes Board and Task detail without management interactions", async ({ page }) => {
  await signIn(page);
  let detailRequests = 0;
  let progressPolls = 0;
  let messagePolls = 0;
  await page.route(/\/api\/task-runs\/run-working\/progress-entries(?:\?.*)?$/, (route) => {
    progressPolls += 1;
    const items = [
      {
        id: "progress-working",
        runId: "run-working",
        kind: "checkpoint",
        body: "Vitest and Playwright are green.",
        createdAt: "2026-08-23T00:00:00Z",
      },
      ...(progressPolls > 1
        ? [
            {
              id: "progress-refreshed",
              runId: "run-working",
              kind: "checkpoint",
              body: "Progress refreshed without status change.",
              createdAt: "2026-08-23T00:00:01Z",
            },
          ]
        : []),
    ];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items, pagination: { pageSize: 100 } }) });
  });
  await page.route(/\/api\/tasks\/task-working\/messages(?:\?.*)?$/, (route) => {
    messagePolls += 1;
    const items = [
      {
        id: "message-working",
        senderSubject: "agent-e2e",
        body: "Verification is running.",
        deliveryStatus: "delivered",
        createdAt: "2026-08-23T00:00:00Z",
      },
      ...(messagePolls > 1
        ? [
            {
              id: "message-refreshed",
              senderSubject: "agent-e2e",
              body: "Message refreshed without status change.",
              deliveryStatus: "delivered",
              createdAt: "2026-08-23T00:00:01Z",
            },
          ]
        : []),
    ];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items, pagination: { pageSize: 100 } }) });
  });
  page.on("request", (request) => {
    if (/\/api\/(?:tasks\/[^/]+\/(?:runs|messages|submissions)|task-runs\/[^/]+\/progress-entries)/.test(new URL(request.url()).pathname))
      detailRequests += 1;
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "V2 Delivery" })).toBeVisible();
  for (const column of ["Todo", "Queued", "In Progress", "In Review", "Done"]) {
    await expect(page.getByText(column, { exact: true }).filter({ visible: true })).toHaveCount(1);
  }
  expect(detailRequests).toBe(0);
  const taskCard = page.getByRole("button", { name: /Run verification/ });
  await taskCard.click();
  const detail = page.getByRole("dialog", { name: "Run verification" });
  await expect(detail).toContainText("Run verification");
  await expect(detail).toContainText("Execute all gates.");
  for (const heading of ["Status", "Assigned to", "Description", "Activity"]) await expect(detail).toContainText(heading);
  await expect(detail).toContainText("agent-e2e");
  await expect(detail).toContainText("Vitest and Playwright are green.");
  await expect(detail).toContainText("Verification is running.");
  expect(detailRequests).toBeGreaterThan(0);
  await expect(detail).toContainText("Progress refreshed without status change.", { timeout: 7_000 });
  await expect(detail).toContainText("Message refreshed without status change.");
  await expect(detail).toContainText("In Progress");
  await expect(page.getByRole("button", { name: /^(create|assign|claim|release|cancel|status)(\s|$)/i })).toHaveCount(0);
  await expect(page.locator("[draggable='true']")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(taskCard).toBeFocused();
  await expect.poll(() => taskCard.evaluate((element) => element.matches(":focus-visible"))).toBe(true);

  await taskCard.click();
  await detail.getByRole("button", { name: "✕" }).click();
  await expect(detail).toHaveCount(0);
  await expect(taskCard).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => taskCard.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
});

test("empty and protocol-error states remain explicit", async ({ page }) => {
  await signIn(page);
  await page.goto("/boards/board-empty");
  await expect(page.getByRole("button", { name: "Empty Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^#/ })).toHaveCount(0);

  const errorPage = await page.context().newPage();
  await errorPage.route("**/api/boards*", (route) =>
    route.fulfill({ status: 503, contentType: "application/problem+json", body: JSON.stringify({ detail: "Board service is unavailable." }) }),
  );
  await errorPage.goto("/");
  await expect(errorPage.getByRole("alert")).toHaveText("Board service is unavailable.");

  const paginationPage = await page.context().newPage();
  await paginationPage.route(/\/api\/boards(?:\?.*)?$/, (route) => {
    const second = new URL(route.request().url()).searchParams.has("pageToken");
    const items = second
      ? [
          { id: "board-empty", name: "Empty Board", description: "" },
          { id: "board-overflow", name: "Overflow Board", description: "" },
        ]
      : [
          { id: "board-main", name: "V2 Delivery", description: "" },
          ...Array.from({ length: 49 }, (_, index) => ({ id: `board-page-${index}`, name: `Board ${index}`, description: "" })),
        ];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items, pagination: { pageSize: 50, ...(second ? {} : { nextPageToken: "boards-page-2" }) } }),
    });
  });
  await paginationPage.route(/\/api\/boards\/board-main\/tasks(?:\?.*)?$/, (route) => {
    const second = new URL(route.request().url()).searchParams.has("pageToken");
    const offset = second ? 50 : 0;
    const count = second ? 2 : 50;
    const items = Array.from({ length: count }, (_, index) => ({
      id: `task-page-${offset + index}`,
      title: `Paged task ${offset + index}`,
      description: "",
      status: "todo",
      blocked: false,
      priority: 0,
      links: { self: `/api/tasks/task-page-${offset + index}` },
    }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items, pagination: { pageSize: 50, ...(second ? {} : { nextPageToken: "tasks-page-2" }) } }),
    });
  });
  await paginationPage.route(/\/api\/tasks\/task-page-\d+\/(?:labels|assignments)(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], pagination: { pageSize: 100 } }) }),
  );
  await paginationPage.goto("/boards/board-main");
  await paginationPage.getByRole("button", { name: "V2 Delivery" }).click();
  await expect(paginationPage.getByRole("dialog", { name: "Switch Board" }).getByRole("button")).toHaveCount(53);
  await paginationPage.keyboard.press("Escape");
  await expect(paginationPage.getByRole("button", { name: /Paged task/ })).toHaveCount(52);
});

test("review dialog rejects and completes submissions with keyboard-safe cancellation", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  const rejectionTask = page.getByRole("button", { name: /Review rejection/ });
  await rejectionTask.click();
  const openReview = page.getByRole("button", { name: "OPEN REVIEW" });
  await expect(openReview).toBeEnabled();
  await openReview.click();
  const dialog = page.getByRole("dialog", { name: "REVIEW SUBMISSION" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(openReview).toBeFocused();

  await openReview.click();
  await dialog.getByLabel("Review feedback").fill("Add the missing failure proof.");
  const rejectionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/api\/task-submissions\/[^/]+\/reviews$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: "REJECT" }).click();
  const rejected = await rejectionResponse;
  expect(rejected.status(), await rejected.text()).toBe(201);
  await expect(page.getByRole("dialog", { name: "Review rejection" })).toHaveCount(0);
  await expect(page.locator('[data-column-status="in_progress"]:visible')).toContainText("Review rejection");

  await page.getByRole("button", { name: /Review acceptance/ }).click();
  const acceptanceDetail = page.getByRole("dialog", { name: "Review acceptance" });
  await expect(acceptanceDetail).toContainText("Earlier review attempt.");
  await expect(acceptanceDetail).toContainText("Historical proof verified.");
  await expect(acceptanceDetail.getByRole("link", { name: "https://example.test/artifacts/verification.txt" })).toBeVisible();
  await page.getByRole("button", { name: "OPEN REVIEW" }).click();
  const acceptDialog = page.getByRole("dialog", { name: "REVIEW SUBMISSION" });
  await page.keyboard.press("Escape");
  await expect(acceptDialog).not.toBeVisible();
  await page.getByRole("button", { name: "OPEN REVIEW" }).click();
  await acceptDialog.getByLabel("Review feedback").fill("Verified locally.");
  await acceptDialog.getByRole("button", { name: "COMPLETE" }).click();
  await expect(page.getByRole("dialog", { name: "Review acceptance" })).toHaveCount(0);
  await expect(page.locator('[data-column-status="done"]:visible')).toContainText("Review acceptance");
});
