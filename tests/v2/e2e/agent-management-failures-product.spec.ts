// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 3.2 agent-edit-and-retire-preserve-pending-and-errors
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, readyAgent, signIn } from "./product-fixtures";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("Agent edit and retirement stay pending and preserve their owning error surface", async ({ page }) => {
  await signIn(page);
  const patchGate = deferred();
  const retireGate = deferred();
  await page.route(new RegExp(`/api/console/ama-connections/${CONNECTION_ID}/agents(?:/[^/?]+)?(?:\\?.*)?$`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH") {
      await patchGate.promise;
      return fulfillJson(route, { detail: "AMA rejected the Agent edit." }, 503);
    }
    if (method === "DELETE") {
      await retireGate.promise;
      return fulfillJson(route, { detail: "AMA could not retire the Agent." }, 503);
    }
    if (pathname.endsWith(`/agents/${readyAgent.metadata.uid}`)) return fulfillJson(route, readyAgent);
    return fulfillJson(route, collection([readyAgent]));
  });
  await page.route(`**/api/console/ama-connections/${CONNECTION_ID}/sessions`, (route) => fulfillJson(route, collection([])));

  await page.goto("/agents/agent-ready?connection=ama-e2e");
  await page.getByRole("button", { name: "•••" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/agents\/agent-ready\/edit\?connection=ama-e2e$/);
  await page.getByLabel("Name", { exact: true }).fill("Renamed Agent");
  await page.getByRole("button", { name: "Save changes" }).click();
  const saving = page.getByRole("button", { name: "Saving..." });
  await expect(saving).toBeDisabled();
  patchGate.release();
  await expect(page.getByText("AMA rejected the Agent edit.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/agent-ready\/edit\?connection=ama-e2e$/);
  await page.getByRole("link", { name: /Back to Release Engineer/ }).click();

  await page.getByRole("button", { name: "•••" }).click();
  await page.getByRole("menuitem", { name: "Retire" }).click();
  const dialog = page.getByRole("dialog", { name: "Retire Agent" });
  await dialog.getByRole("button", { name: "Retire Agent" }).click();
  const retiring = page.getByRole("button", { name: "Retiring…" });
  await expect(retiring).toBeDisabled();
  retireGate.release();
  await expect(page.getByText("AMA could not retire the Agent.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator("h1").filter({ hasText: "Release Engineer" })).toBeAttached();
});
