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
  subject: "0198f1b4-70c0-7a3b-8d21-5c4e8a9b1234",
  schedulable: true,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

test("[spec: agents/read-only-browser] Agent list and detail expose identity and scheduling without management controls", async ({ page }) => {
  const agentQueries: URLSearchParams[] = [];
  const profileName = "Flint Backend";
  const profileUsername = "flint-backend";
  const profilePicture = "https://profiles.example/avatars/flint-backend.svg";
  await page.route("**/.well-known/oauth-protected-resource", (route) =>
    route.fulfill({ json: { authorization_servers: ["https://identity.example"] } }),
  );
  await page.route("https://identity.example/.well-known/oauth-authorization-server", (route) =>
    route.fulfill({
      json: {
        issuer: "https://identity.example",
        agent_profile_uri_template: "https://identity.example/agent-profiles/{subject}",
      },
    }),
  );
  await page.route(/https:\/\/identity\.example\/agent-profiles\/.*$/, (route) => {
    const url = new URL(route.request().url());
    expect(decodeURIComponent(url.pathname.split("/").at(-1)!)).toBe(agent.subject);
    expect(url.searchParams.get("view")).toBe("summary");
    return route.fulfill({
      json: {
        issuer: "https://identity.example",
        type: "agent",
        view: "summary",
        subject: agent.subject,
        name: profileName,
        username: profileUsername,
        picture: profilePicture,
        runtime: "codex",
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:00.000Z",
      },
    });
  });
  await page.route(profilePicture, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#7c3aed"/></svg>',
    }),
  );
  await page.route(/\/api\/agents(?:\?.*)?$/, (route) => {
    agentQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { items: [agent], pagination: { pageSize: 1, nextPageToken: null } } });
  });
  await page.route(/\/api\/agents\/agent-backend$/, (route) => route.fulfill({ json: agent }));
  await page.route(/\/api\/tasks\?.*$/, (route) => {
    expect(new URL(route.request().url()).searchParams.get("assignedTo")).toBe(agent.subject);
    return route.fulfill({
      json: {
        items: [{ id: "task-backend", boardId: "board-platform", title: "Harden the API boundary", status: "in-progress" }],
        pagination: { pageSize: 1 },
      },
    });
  });
  await signInWithRealmrootSession(page, `agent_projection_${Date.now()}@example.com`);

  await page.goto("/agents");

  const list = page.getByRole("main");
  await expect(list.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(list.getByText(profileName, { exact: true })).toBeVisible();
  await expect(list.getByText(`@${profileUsername}`, { exact: true })).toBeVisible();
  const listAvatar = list.getByRole("img", { name: `${profileName} avatar` });
  await expect(listAvatar).toBeVisible();
  await expect(listAvatar).toHaveAttribute("src", profilePicture);
  await expect(list.getByText("Schedulable", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: /new agent/i })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /create|edit|archive|delete/i })).toHaveCount(0);

  await list.getByRole("textbox", { name: "Search Agents" }).fill("backend");
  await list.getByRole("combobox", { name: "Runtime" }).click();
  const runtimeOptions = page.getByRole("option");
  await expect(runtimeOptions).toHaveText(["All runtimes", "Enbor", "Claude Code", "Codex", "Copilot"]);
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

  await list.getByRole("link", { name: new RegExp(profileName) }).click();
  await expect(page).toHaveURL(/\/agents\/agent-backend$/);

  const detail = page.getByRole("main");
  await expect(detail.getByRole("heading", { name: profileName })).toBeVisible();
  await expect(detail.getByRole("img", { name: `${profileName} avatar` })).toHaveAttribute("src", profilePicture);
  await expect(detail.getByText(agent.subject, { exact: true })).toBeVisible();
  await expect(detail.getByText("best-engineering-practice", { exact: true })).toBeVisible();
  await expect(detail.getByText("Schedulable", { exact: true })).toBeVisible();
  await expect(detail.getByText("Assigned tasks", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: /Harden the API boundary/ })).toHaveAttribute("href", "/boards/board-platform");
  await expect(detail.getByRole("button", { name: /create|edit|archive|delete/i })).toHaveCount(0);
});

test("[spec: agents/read-only-browser] Agent without a bound identity remains visible without loading assigned tasks", async ({ page }) => {
  const unboundAgent = {
    ...agent,
    id: "agent-unbound",
    name: "Unbound Builder",
    username: null,
    runtime: null,
    model: null,
    subject: null,
    schedulable: false,
  };
  const taskRequests: string[] = [];
  await page.route(/\/api\/agents(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [unboundAgent], pagination: { pageSize: 1, nextPageToken: null } } }),
  );
  await page.route(/\/api\/agents\/agent-unbound$/, (route) => route.fulfill({ json: unboundAgent }));
  await page.route(/\/api\/tasks(?:\?.*)?$/, (route) => {
    taskRequests.push(route.request().url());
    return route.fulfill({ json: [] });
  });
  await signInWithRealmrootSession(page, `agent_unbound_${Date.now()}@example.com`);

  await page.goto("/agents");

  const list = page.getByRole("main");
  await expect(list.getByText("Unbound Builder", { exact: true })).toBeVisible();
  await expect(list.getByText("Identity not bound", { exact: true })).toBeVisible();
  await expect(list.getByText("Unavailable", { exact: true })).toBeVisible();

  await list.getByRole("link", { name: /Unbound Builder/ }).click();
  await expect(page).toHaveURL(/\/agents\/agent-unbound$/);

  const detail = page.getByRole("main");
  await expect(detail.getByRole("heading", { name: "Unbound Builder" })).toBeVisible();
  await expect(detail.getByText("Identity not bound", { exact: true })).toBeVisible();
  await expect(detail.getByText("Bind an identity before assigning tasks to this Agent.", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: /create|edit|archive|delete/i })).toHaveCount(0);
  expect(taskRequests).toEqual([]);
});

test("[spec: agents/read-only-browser] Agent list uses server cursors and resets pagination when filters change", async ({ page }) => {
  const requests: URL[] = [];
  await page.route(/\/api\/agents(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const agentPage = url.searchParams.get("pageToken") === "agent-page-2" ? { ...agent, id: "agent-page-two", name: "Second Agent" } : agent;
    return route.fulfill({
      json: {
        items: [agentPage],
        pagination: url.searchParams.get("pageToken") === "agent-page-2" ? { pageSize: 20 } : { pageSize: 20, nextPageToken: "agent-page-2" },
      },
    });
  });
  await signInWithRealmrootSession(page, `agent_pagination_${Date.now()}@example.com`);

  await page.goto("/agents");

  const main = page.getByRole("main");
  await expect(main.getByText("Backend Engineer", { exact: true })).toBeVisible();
  await expect(main.getByText("Page 1", { exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: /Previous/ })).toBeDisabled();
  await main.getByRole("button", { name: /Next/ }).click();
  await expect(main.getByText("Second Agent", { exact: true })).toBeVisible();
  await expect(main.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: /Next/ })).toBeDisabled();

  await main.getByRole("textbox", { name: "Search Agents" }).fill("backend");
  await expect(main.getByText("Page 1", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      requests.some(
        (url) => url.searchParams.get("search") === "backend" && url.searchParams.get("pageSize") === "20" && !url.searchParams.has("pageToken"),
      ),
    )
    .toBe(true);
  expect(requests.filter((url) => url.searchParams.get("pageToken") === "agent-page-2")).toHaveLength(1);
});
