// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 1.3 connection-selection-is-url-addressable
import { expect, test } from "@playwright/test";
import { amaCollection, collection, fulfillJson, readyAgent, signIn } from "./product-fixtures";

test("the connection query selects the matching AMA Project and scopes every product request", async ({ page }) => {
  await signIn(page);
  await page.route(/\/api\/ama-connections(?:\?.*)?$/, (route) =>
    fulfillJson(
      route,
      collection([
        {
          id: "ama-primary",
          resourceUrl: "https://ama.test/api",
          projectUri: "https://ama.test/api/v1/projects/project-primary",
          status: "active",
        },
        {
          id: "ama-secondary",
          resourceUrl: "https://ama.test/api",
          projectUri: "https://ama.test/api/v1/projects/project-secondary",
          status: "active",
        },
      ]),
    ),
  );
  const requestedConnections: string[] = [];
  await page.route(/\/api\/v1\/agents(?:\?.*)?$/, (route) => {
    requestedConnections.push(route.request().headers()["x-ama-project-id"] ?? "missing");
    return fulfillJson(
      route,
      amaCollection([
        {
          ...readyAgent,
          metadata: { ...readyAgent.metadata, uid: "agent-secondary", name: "Secondary Agent", projectId: "project-secondary" },
        },
      ]),
    );
  });
  await page.route(/\/api\/v1\/sessions(?:\?.*)?$/, (route) => {
    requestedConnections.push(route.request().headers()["x-ama-project-id"] ?? "missing");
    return fulfillJson(route, amaCollection([]));
  });

  await page.goto("/agents?connection=ama-secondary");

  await expect(page.getByRole("link", { name: "Secondary Agent" })).toBeVisible();
  expect(requestedConnections.length).toBeGreaterThanOrEqual(1);
  expect(new Set(requestedConnections)).toEqual(new Set(["project-secondary"]));
  await expect(page).toHaveURL(/\/agents\?connection=ama-secondary$/);

  await page.getByRole("link", { name: "Machines" }).click();
  await expect(page).toHaveURL(/\/machines\?connection=ama-secondary$/);

  const requestsBeforeUnknownBookmark = requestedConnections.length;
  await page.goto("/agents/agent-secondary?connection=ama-unknown");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("is not available");
  await expect(alert).toContainText("ama-unknown");
  await expect(page).toHaveURL(/\/agents\/agent-secondary\?connection=ama-unknown$/);
  expect(requestedConnections).toHaveLength(requestsBeforeUnknownBookmark);
});
