// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.3 machine-child-source-partial-failure
import { expect, test } from "@playwright/test";
import { amaCollection, fulfillJson, localMachine, signIn } from "./product-fixtures";

test("Machines keeps authoritative Environment data visible with a scoped child-source warning", async ({ page }) => {
  await signIn(page);
  const partialMachine = {
    ...localMachine,
    id: "env-local",
    name: "Build Mac",
    status: "offline",
    runners: [],
    sessions: [],
    agents: [],
    warnings: ["AMA Runners are temporarily unavailable."],
  };
  await page.route(/\/api\/v1\/environments(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection([partialMachine.environment])));
  await page.route(/\/api\/v1\/runners(?:\?.*)?$/, (route) => fulfillJson(route, { detail: "Runners unavailable" }, 503));
  for (const resource of ["sessions", "agents"])
    await page.route(new RegExp(`/api/v1/${resource}(?:\\?.*)?$`), (route) => fulfillJson(route, amaCollection([])));

  await page.goto("/machines");

  await expect(page.getByRole("link", { name: "Build Mac" })).toContainText("offline");
  await expect(page.getByRole("status")).toContainText("AMA Runners are temporarily unavailable.");
  await expect(page.getByRole("status")).toContainText("Available Environment data is still shown.");
});
