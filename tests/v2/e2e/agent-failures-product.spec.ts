// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 3.3 ama-agent-boundary-failures
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, signIn } from "./product-fixtures";

const failures = [
  {
    status: 404,
    type: "https://agent-kanban.dev/problems/ama-connection-required",
    title: "AMA connection required",
    detail: "Connect an AMA project to browse Agents.",
    action: "CONNECT AMA",
  },
  {
    status: 401,
    type: "https://agent-kanban.dev/problems/ama-grant-required",
    title: "AMA authorization required",
    detail: "The AMA authorization is missing or expired.",
    action: "REAUTHORIZE AMA",
  },
  {
    status: 403,
    type: "https://agent-kanban.dev/problems/ama-forbidden",
    title: "AMA access denied",
    detail: "This account cannot read AMA Agents.",
    action: "REQUEST ACCESS",
  },
  {
    status: 503,
    type: "https://agent-kanban.dev/problems/ama-unavailable",
    title: "AMA unavailable",
    detail: "AMA did not respond before the request deadline.",
    action: "RETRY",
  },
  {
    status: 502,
    type: "https://agent-kanban.dev/problems/ama-invalid-response",
    title: "AMA contract mismatch",
    detail: "AMA returned an invalid Agent representation.",
    action: "REPORT CONTRACT ISSUE",
  },
] as const;

for (const failure of failures) {
  test(`Agents renders a distinct ${failure.type.split("/").at(-1)} recovery state`, async ({ page }) => {
    await signIn(page);
    await page.route(`**/api/console/ama-connections/${CONNECTION_ID}/agents*`, (route) =>
      route.fulfill({
        status: failure.status,
        contentType: "application/problem+json",
        headers: { "Request-Id": "request-ama-boundary" },
        body: JSON.stringify({ ...failure, instance: "urn:request:request-ama-boundary" }),
      }),
    );

    await page.goto("/agents");

    const alert = page.getByRole("alert");
    await expect(alert).toContainText(failure.detail);
    await expect(alert.getByRole("button", { name: failure.action }).or(alert.getByRole("link", { name: failure.action }))).toBeVisible();
    await expect(alert).toContainText("request-ama-boundary");
    await expect(page.getByText(/leader|worker/i)).toHaveCount(0);
  });
}
