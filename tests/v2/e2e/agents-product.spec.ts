// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 3.1 ama-agent-list-detail-and-sessions
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, provisioningAgent, readyAgent, signIn } from "./product-fixtures";

test("Agents pages are driven by AMA Agent identity, readiness, configuration, and Sessions", async ({ page }) => {
  await signIn(page);
  const pageErrors: string[] = [];
  const agentRequests: string[] = [];
  const agentResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/console/") || request.url().includes("/api/ama-connections")) agentRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/console/") || response.url().includes("/api/ama-connections"))
      agentResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.route(new RegExp(`/api/console/ama-connections/${CONNECTION_ID}/agents(?:/[^/?]+)?(?:\\?.*)?$`), (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/agents/${readyAgent.metadata.uid}`)) return fulfillJson(route, readyAgent);
    return fulfillJson(route, collection([readyAgent, provisioningAgent]));
  });
  await page.route(`**/api/console/ama-connections/${CONNECTION_ID}/sessions*`, (route) =>
    fulfillJson(
      route,
      collection([
        {
          metadata: { uid: "session-agent-ready", projectId: "project-e2e", name: "Release verification" },
          spec: { agentId: readyAgent.metadata.uid },
          status: { phase: "running" },
        },
      ]),
    ),
  );

  await page.goto("/agents?connection=ama-e2e");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  const readyCard = page.getByRole("link", { name: /Release Engineer/ });
  await expect(readyCard).toContainText("Ready");
  await expect(readyCard).toContainText("Codex");
  await expect(readyCard).toContainText("gpt-5.6-sol");
  await expect(page.getByText("Provisioning Agent")).toBeVisible();
  await expect(page.getByText(/\b(?:leader|worker|subagent)\b/i)).toHaveCount(0);

  await readyCard.click();
  await expect(page).toHaveURL(/\/agents\/agent-ready\?connection=ama-e2e$/);
  await expect.poll(() => pageErrors).toEqual([]);
  await expect.poll(() => agentRequests.some((url) => url.includes("/agents/agent-ready")), { message: JSON.stringify(agentRequests) }).toBe(true);
  await expect
    .poll(() => agentResponses.some((value) => value.includes("/agents/agent-ready")), { message: JSON.stringify(agentResponses) })
    .toBe(true);
  await expect
    .poll(() => ({
      requests: agentRequests.filter((url) => url.includes("/agents/agent-ready")).length,
      responses: agentResponses.filter((url) => url.includes("/agents/agent-ready")).length,
    }))
    .toEqual({ requests: 1, responses: 1 });
  await expect(agentResponses.filter((value) => value.includes("/agents/agent-ready"))).toEqual([expect.stringMatching(/^200 /)]);
  await expect(page.getByRole("heading", { name: "Release Engineer", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /agt_release_engineer/ }).click();
  const identity = page.getByRole("dialog", { name: "Realmroot identity" });
  await expect(identity).toContainText("agt_release_engineer");
  await expect(identity).toContainText("https://realmroot.test/api/auth");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Release verification", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/agents\/agent-ready\?connection=ama-e2e$/);
  await expect(page.getByRole("heading", { name: "Release Engineer", level: 1 })).toBeVisible();
});
