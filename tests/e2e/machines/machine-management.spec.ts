import { expect, test } from "@playwright/test";
import { signInWithRealmrootSession } from "../../helpers/auth";

const machine = {
  id: "environment-build-01",
  name: "mac-mini-build",
  description: "Local build runner",
  status: "online",
  currentLoad: 3,
  maxLoad: 5,
  runnerCount: 1,
  runtimes: [{ runtime: "codex", models: ["gpt-5.6"], detail: "codex", state: "ready" }],
  runners: [
    {
      id: "runner-build-01",
      name: "mac-mini-runner",
      status: "active",
      currentLoad: 3,
      maxLoad: 5,
      runtimes: [{ runtime: "codex", models: ["gpt-5.6"], detail: "codex", state: "ready" }],
      runtimeUsage: [],
      lastHeartbeatAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  lastHeartbeatAt: "2026-09-01T12:00:00.000Z",
  createdAt: "2026-09-01T11:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

const installCommand = "brew install realmroot/tap/enbor-runner";
const authCommand = 'enbor-runner auth login --api-server "https://enbor.example.test"';
const startCommand =
  'enbor-runner start --api-server "https://enbor.example.test" --project-id "project-123" --environment-id "environment-build-01" --allow-unsafe-process';

test("[spec: machines/create-runner-setup] Add Machine offers a local computer and copies its setup commands", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => sessionStorage.setItem("e2e-copied-command", value),
        readText: async () => sessionStorage.getItem("e2e-copied-command") ?? "",
      },
    });
  });
  await page.route(/\/api\/machines$/, async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postData()).toBeNull();
      await route.fulfill({ status: 201, json: { machine, authCommand, startCommand } });
      return;
    }
    await route.fulfill({ json: { items: [], pagination: { pageSize: 0, nextPageToken: null } } });
  });
  await signInWithRealmrootSession(page, `machine_setup_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Add Machine" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add Machine" });
  const computer = createDialog.getByRole("button", { name: /Your Computer/ });
  const cloudSandbox = createDialog.getByRole("button", { name: /Cloud Sandbox/ });
  await expect(computer).toBeEnabled();
  await expect(cloudSandbox).toBeDisabled();
  await expect(createDialog.getByText("Coming soon", { exact: true })).toBeVisible();
  await expect(createDialog.getByLabel("Machine name")).toHaveCount(0);
  await computer.click();

  const setupDialog = page.getByRole("dialog", { name: "Start Enbor Runner" });
  await expect(setupDialog.getByText(installCommand, { exact: true })).toBeVisible();
  await expect(setupDialog.getByText(authCommand, { exact: true })).toBeVisible();
  await expect(setupDialog.getByText(startCommand, { exact: true })).toBeVisible();
  const homebrewCopy = setupDialog.getByRole("button", {
    name: "Copy 1. Install with Homebrew (macOS/Linux)",
  });
  await expect(homebrewCopy).toBeVisible();
  await expect(setupDialog.getByRole("link", { name: "Enbor Runner releases" })).toHaveAttribute(
    "href",
    "https://github.com/realmroot/agency/releases",
  );
  await expect(setupDialog.getByRole("link", { name: "Enbor Runner Docker guide" })).toHaveAttribute(
    "href",
    "https://github.com/realmroot/agency/blob/main/docs/infra/self-hosted-runner.md#docker",
  );

  await homebrewCopy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(installCommand);
  await setupDialog.getByRole("button", { name: "Copy 2. Authenticate" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(authCommand);
  await setupDialog.getByRole("button", { name: "Copy 3. Start this Machine" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(startCommand);
});

test("[spec: machines/create-runner-setup] Offline Machine detail keeps setup commands available after the create dialog closes", async ({
  page,
}) => {
  const offlineMachine = {
    ...machine,
    name: "Waiting for computer",
    status: "offline",
    currentLoad: 0,
    maxLoad: 0,
    runnerCount: 0,
    runtimes: [],
    runners: [],
  };
  let created = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => sessionStorage.setItem("e2e-copied-command", value),
        readText: async () => sessionStorage.getItem("e2e-copied-command") ?? "",
      },
    });
  });
  await page.route(/\/api\/machines$/, async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postData()).toBeNull();
      created = true;
      await route.fulfill({ status: 201, json: { machine: offlineMachine, authCommand, startCommand } });
      return;
    }
    await route.fulfill({
      json: { items: created ? [offlineMachine] : [], pagination: { pageSize: created ? 1 : 0, nextPageToken: null } },
    });
  });
  await page.route(/\/api\/machines\/environment-build-01$/, (route) => route.fulfill({ json: { ...offlineMachine, authCommand, startCommand } }));
  await signInWithRealmrootSession(page, `machine_setup_recovery_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Add Machine" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add Machine" });
  await createDialog.getByRole("button", { name: /Your Computer/ }).click();

  const setupDialog = page.getByRole("dialog", { name: "Start Enbor Runner" });
  await setupDialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(setupDialog).not.toBeVisible();
  await page.getByRole("link", { name: /Waiting for computer/ }).click();

  await expect(page).toHaveURL(/\/machines\/environment-build-01$/);
  await expect(page.getByText(authCommand, { exact: true })).toBeVisible();
  await expect(page.getByText(startCommand, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy 2. Authenticate" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(authCommand);
  await page.getByRole("button", { name: "Copy 3. Start this Machine" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(startCommand);
});

test("[spec: machines/create-runner-setup] Retrying an uncertain create reuses its Idempotency-Key", async ({ page }) => {
  const idempotencyKeys: string[] = [];
  await page.route(/\/api\/machines$/, async (route) => {
    if (route.request().method() === "POST") {
      idempotencyKeys.push((await route.request().headerValue("idempotency-key")) ?? "");
      if (idempotencyKeys.length === 1) {
        await route.fulfill({ status: 503, json: { detail: "Enbor Project binding is unavailable" } });
        return;
      }
      await route.fulfill({ status: 201, json: { machine, authCommand, startCommand } });
      return;
    }
    await route.fulfill({ json: { items: [], pagination: { pageSize: 0, nextPageToken: null } } });
  });
  await signInWithRealmrootSession(page, `machine_create_error_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Add Machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Machine" });
  await dialog.getByRole("button", { name: /Your Computer/ }).click();

  await expect(dialog.getByRole("alert")).toHaveText("Enbor Project binding is unavailable");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Your Computer/ }).click();
  await expect(page.getByRole("dialog", { name: "Start Enbor Runner" })).toBeVisible();
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toMatch(/^"[A-Za-z0-9._:-]{8,200}"$/);
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});

test("[spec: machines/create-runner-setup] Changing Machine data cannot extend the bounded status follow-up", async ({ page }) => {
  await page.clock.install();
  let created = false;
  let listRequests = 0;
  const offlineMachine = { ...machine, status: "offline" };
  await page.route(/\/api\/machines$/, async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ status: 201, json: { machine: offlineMachine, authCommand, startCommand } });
      return;
    }
    listRequests += 1;
    const changingOfflineMachine = {
      ...offlineMachine,
      currentLoad: listRequests,
      updatedAt: `2026-09-01T12:00:${String(listRequests).padStart(2, "0")}.000Z`,
    };
    await route.fulfill({
      json: { items: created ? [changingOfflineMachine] : [], pagination: { pageSize: created ? 1 : 0, nextPageToken: null } },
    });
  });
  await signInWithRealmrootSession(page, `machine_status_wait_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Add Machine" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add Machine" });
  await createDialog.getByRole("button", { name: /Your Computer/ }).click();

  const setupDialog = page.getByRole("dialog", { name: "Start Enbor Runner" });
  const waiting = setupDialog.getByText("Waiting up to 30 seconds for this Machine to report online…", { exact: true });
  await expect(waiting).toBeVisible();
  await page.clock.fastForward(29_000);
  await expect(waiting).toBeVisible();
  expect(listRequests).toBeGreaterThan(2);
  await page.clock.fastForward(1_001);
  await expect(waiting).toBeHidden();
  await expect(setupDialog.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
  const requestsAtTimeout = listRequests;
  await page.clock.fastForward(6_000);
  expect(listRequests).toBe(requestsAtTimeout);
});

test("[spec: machines/archive-machine-ui] Archive requires confirmation naming the Machine and its current load", async ({ page }) => {
  let deleteRequests = 0;
  await page.route(/\/api\/machines$/, (route) => route.fulfill({ json: { items: [machine], pagination: { pageSize: 1, nextPageToken: null } } }));
  await page.route(/\/api\/machines\/environment-build-01$/, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    deleteRequests += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  await signInWithRealmrootSession(page, `machine_archive_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Delete mac-mini-build" }).click();

  const dialog = page.getByRole("dialog", { name: "Archive Machine" });
  await expect(dialog.getByText("mac-mini-build", { exact: true })).toBeVisible();
  await expect(dialog.getByText("3/5 active", { exact: false })).toBeVisible();
  expect(deleteRequests).toBe(0);

  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(() => deleteRequests).toBe(1);
  await expect(dialog).not.toBeVisible();
});

test("[spec: machines/archive-machine-ui] Archive failure remains actionable in the confirmation dialog", async ({ page }) => {
  await page.route(/\/api\/machines$/, (route) => route.fulfill({ json: { items: [machine], pagination: { pageSize: 1, nextPageToken: null } } }));
  await page.route(/\/api\/machines\/environment-build-01$/, (route) =>
    route.fulfill({ status: 502, json: { detail: "Enbor Environment could not be archived" } }),
  );
  await signInWithRealmrootSession(page, `machine_archive_error_${Date.now()}@example.com`);
  await page.goto("/machines");

  await page.getByRole("button", { name: "Delete mac-mini-build" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive Machine" });
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();

  await expect(dialog.getByRole("alert")).toHaveText("Enbor Environment could not be archived");
  await expect(dialog).toBeVisible();
});
