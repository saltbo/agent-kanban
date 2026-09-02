import { expect, test } from "@playwright/test";
import { signInWithRealmrootSession } from "../../helpers/auth";

const agent = {
  id: "agent-backend",
  name: "Backend Engineer",
  description: "Implements backend tasks.",
  username: "backend-engineer",
  runtime: "codex",
  model: "gpt-5.6",
  skills: ["best-engineering-practice"],
  subject: "realmroot:agent:backend-engineer",
  schedulable: true,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

test("[spec: agents/read-only-browser] Agent list and detail expose identity and scheduling without management controls", async ({ page }) => {
  const agentQueries: URLSearchParams[] = [];
  await page.route(/\/api\/agents(?:\?.*)?$/, (route) => {
    agentQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { items: [agent], pagination: { pageSize: 1, nextPageToken: null } } });
  });
  await page.route(/\/api\/agents\/agent-backend$/, (route) => route.fulfill({ json: agent }));
  await page.route(/\/api\/tasks\?.*$/, (route) => {
    expect(new URL(route.request().url()).searchParams.get("assigned_to")).toBe(agent.subject);
    return route.fulfill({
      json: [{ id: "task-backend", board_id: "board-platform", title: "Harden the API boundary", status: "in_progress" }],
    });
  });
  await signInWithRealmrootSession(page, `agent_projection_${Date.now()}@example.com`);

  await page.goto("/agents");

  const list = page.getByRole("main");
  await expect(list.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(list.getByText("Backend Engineer", { exact: true })).toBeVisible();
  await expect(list.getByText("@backend-engineer", { exact: true })).toBeVisible();
  await expect(list.getByText("Schedulable", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: /new agent/i })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /create|edit|archive|delete/i })).toHaveCount(0);

  await list.getByRole("textbox", { name: "Search Agents" }).fill("backend");
  await list.getByRole("combobox", { name: "Runtime" }).click();
  const runtimeOptions = page.getByRole("option");
  await expect(runtimeOptions).toHaveText(["All runtimes", "AMA", "Claude Code", "Codex", "Copilot"]);
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  await list.getByRole("combobox", { name: "Availability" }).click();
  await page.getByRole("option", { name: "Schedulable" }).click();
  await expect
    .poll(() =>
      agentQueries.some(
        (query) => query.get("search") === "backend" && query.get("runtime") === "claude-code" && query.get("schedulable") === "true",
      ),
    )
    .toBe(true);

  await list.getByRole("link", { name: /Backend Engineer/ }).click();
  await expect(page).toHaveURL(/\/agents\/agent-backend$/);

  const detail = page.getByRole("main");
  await expect(detail.getByRole("heading", { name: "Backend Engineer" })).toBeVisible();
  await expect(detail.getByText("realmroot:agent:backend-engineer", { exact: true })).toBeVisible();
  await expect(detail.getByText("best-engineering-practice", { exact: true })).toBeVisible();
  await expect(detail.getByText("Schedulable", { exact: true })).toBeVisible();
  await expect(detail.getByText("Assigned tasks", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: /Harden the API boundary/ })).toHaveAttribute("href", "/boards/board-platform");
  await expect(detail.getByRole("button", { name: /create|edit|archive|delete/i })).toHaveCount(0);
});
