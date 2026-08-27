// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.1 machine-detail-refreshes-without-navigation
import { expect, test } from "@playwright/test";
import { amaCollection, fulfillJson, localMachine, signIn } from "./product-fixtures";

test("Machine detail refreshes AMA Environment, Runner, Session, and Agent projections without navigation", async ({ page }) => {
  await signIn(page);
  await page.clock.install();
  let refreshed = false;
  const requests = { environments: 0, runners: 0, sessions: 0, agents: 0 };
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
    runners: [
      {
        ...localMachine.runners[0],
        state: "active",
        currentLoad: 2,
        maxConcurrent: 2,
        lastHeartbeatAt: "2099-01-02T03:04:05.000Z",
      },
    ],
    sessions: [
      ...localMachine.sessions,
      {
        metadata: { uid: "session-second", name: "Second run" },
        status: { phase: "running" },
        spec: { agentId: "agent-ready", environmentId: "env-local" },
      },
    ],
  };
  await page.route(/\/api\/v1\/environments(?:\?.*)?$/, async (route) => {
    requests.environments += 1;
    const machine = refreshed ? updated : initial;
    return fulfillJson(route, amaCollection([machine.environment]));
  });
  await page.route(/\/api\/v1\/runners(?:\?.*)?$/, (route) => {
    requests.runners += 1;
    return fulfillJson(route, amaCollection((refreshed ? updated : initial).runners));
  });
  await page.route(/\/api\/v1\/sessions(?:\?.*)?$/, (route) => {
    requests.sessions += 1;
    return fulfillJson(route, amaCollection((refreshed ? updated : initial).sessions));
  });
  await page.route(/\/api\/v1\/agents(?:\?.*)?$/, (route) => {
    requests.agents += 1;
    return fulfillJson(route, amaCollection((refreshed ? updated : initial).agents));
  });

  await page.goto("/machines/env-local?connection=ama-e2e");
  await expect.poll(() => Object.values(requests)).toEqual([1, 1, 1, 1]);
  await expect(page.getByRole("heading", { name: "Build Mac" })).toBeVisible();
  await expect(page.getByText("offline", { exact: true })).toBeVisible();
  await expect(page.getByText("Machine is offline")).toBeVisible();

  refreshed = true;
  await page.clock.fastForward(4_999);
  expect(Object.values(requests)).toEqual([1, 1, 1, 1]);
  await page.clock.fastForward(1);
  await expect.poll(() => Object.values(requests)).toEqual([2, 2, 2, 2]);

  await expect(page.getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByText("2/2 · active", { exact: true })).toBeVisible();
  await expect(page.getByText("Second run", { exact: true })).toBeVisible();
  await expect(page.getByText(/2099/)).toBeVisible();
  expect(Object.values(requests)).toEqual([2, 2, 2, 2]);
  await expect(page).toHaveURL(/\/machines\/env-local\?connection=ama-e2e$/);
});
