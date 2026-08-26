// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.3 machine-child-source-partial-failure
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, localMachine, signIn } from "./product-fixtures";

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
  await page.route(`**/api/console/ama-connections/${CONNECTION_ID}/machines`, (route) => fulfillJson(route, collection([partialMachine])));

  await page.goto("/machines");

  await expect(page.getByRole("link", { name: "Build Mac" })).toContainText("offline");
  await expect(page.getByRole("status")).toContainText("AMA Runners are temporarily unavailable.");
  await expect(page.getByRole("status")).toContainText("Available Environment data is still shown.");
});
