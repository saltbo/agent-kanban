// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.1 machine-detail-refreshes-without-navigation
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, localMachine, signIn } from "./product-fixtures";

test("a slow Machine detail poll completes before the next non-overlapping refresh is scheduled", async ({ page }) => {
  await signIn(page);
  await page.clock.install();
  let refreshed = false;
  let detailRequests = 0;
  let holdingInitialDetails = true;
  let releaseFirstDetail!: () => void;
  const firstDetail = new Promise<void>((resolve) => {
    releaseFirstDetail = resolve;
  });
  const initial = {
    ...localMachine,
    id: "env-local",
    name: "Build Mac",
    status: "offline",
    lastHeartbeatAt: "2026-08-23T00:00:00.000Z",
    sessionCount: 1,
    activeSessionCount: 1,
    runners: [{ ...localMachine.runners[0], state: "offline", currentLoad: 0 }],
  };
  const updated = {
    ...initial,
    status: "online",
    lastHeartbeatAt: "2099-01-02T03:04:05.000Z",
    sessionCount: 2,
    activeSessionCount: 2,
    runners: [{ ...localMachine.runners[0], state: "active", currentLoad: 2, maxConcurrent: 2 }],
    sessions: [
      ...localMachine.sessions,
      { metadata: { uid: "session-second", name: "Second run" }, status: { phase: "running" }, spec: { agentId: "agent-ready" } },
    ],
  };
  await page.route(new RegExp(`/api/console/ama-connections/${CONNECTION_ID}/machines(?:/env-local)?(?:\\?.*)?$`), async (route) => {
    const detail = new URL(route.request().url()).pathname.endsWith("/machines/env-local");
    if (detail) detailRequests += 1;
    if (detail && holdingInitialDetails) await firstDetail;
    const machine = refreshed ? updated : initial;
    return fulfillJson(route, detail ? machine : collection([machine]));
  });

  await page.goto("/machines/env-local?connection=ama-e2e");
  await expect.poll(() => detailRequests).toBe(1);
  const initialDetailRequests = detailRequests;
  await page.clock.fastForward(6_000);
  expect(detailRequests).toBe(initialDetailRequests);

  holdingInitialDetails = false;
  releaseFirstDetail();
  await expect(page.getByRole("heading", { name: "Build Mac" })).toBeVisible();
  await expect(page.getByText("offline", { exact: true })).toBeVisible();
  await expect(page.getByText("Machine is offline")).toBeVisible();

  refreshed = true;
  await page.clock.fastForward(4_999);
  expect(detailRequests).toBe(initialDetailRequests);
  await page.clock.fastForward(1);
  await expect.poll(() => detailRequests).toBe(initialDetailRequests + 1);

  await expect(page.getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Second run", { exact: true })).toBeVisible();
  await expect(page.getByText(/2099/)).toBeVisible();
  expect(detailRequests).toBe(initialDetailRequests + 1);
  await expect(page).toHaveURL(/\/machines\/env-local\?connection=ama-e2e$/);
});
