import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelayQuotaPanel } from "../apps/web/src/components/RelayQuotaPanel";

const relaysList = vi.fn();
const relaysUsage = vi.fn();
const relaysCreate = vi.fn();
const relaysUpdate = vi.fn();
const relaysDelete = vi.fn();

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    relays: {
      list: (...args: unknown[]) => relaysList(...args),
      usage: (...args: unknown[]) => relaysUsage(...args),
      create: (...args: unknown[]) => relaysCreate(...args),
      update: (...args: unknown[]) => relaysUpdate(...args),
      delete: (...args: unknown[]) => relaysDelete(...args),
    },
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
// "sonner" isn't resolvable from tests/ (it lives in apps/web/node_modules), so
// the mock must target the resolved path to intercept the component's import.
vi.mock("../apps/web/node_modules/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const FAKE_TOKEN = "sk-test-relay-token-1234";

function relay(id: string, kind: "kimi" | "deepseek", name: string) {
  return {
    id,
    name,
    kind,
    base_url: `https://api.${kind}.com/anthropic`,
    masked_token: "sk-...1234",
    model_map: {},
    extra_env: {},
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const FUTURE = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

function okUsage(overrides: Record<string, unknown> = {}) {
  return { fetched_at: new Date().toISOString(), ok: true, windows: [], balance: null, peak: null, ...overrides };
}

function kimiUsage(utilization: number) {
  return okUsage({ windows: [{ runtime: "claude", label: "5-Hour", utilization, resets_at: FUTURE }] });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(RelayQuotaPanel)));
}

// Base UI commits an item on click only while it is highlighted; mousemove
// sets the active index (same as a real pointer hover).
async function chooseOption(dialog: HTMLElement, optionName: string) {
  fireEvent.click(within(dialog).getByRole("combobox"));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
  await waitFor(() => expect(screen.queryByRole("option", { name: optionName })).not.toBeInTheDocument());
}

describe("RelayQuotaPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relaysList.mockResolvedValue([]);
    relaysUsage.mockResolvedValue(okUsage());
    relaysCreate.mockResolvedValue({});
    relaysUpdate.mockResolvedValue({});
    relaysDelete.mockResolvedValue(undefined);
  });

  it("lists a card per relay with kind badge and host", async () => {
    relaysList.mockResolvedValue([relay("r-kimi", "kimi", "Kimi relay"), relay("r-ds", "deepseek", "DeepSeek relay")]);
    renderPanel();

    expect(await screen.findByText("Kimi relay")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek relay")).toBeInTheDocument();
    expect(screen.getByText("kimi")).toBeInTheDocument();
    expect(screen.getByText("deepseek")).toBeInTheDocument();
    expect(screen.getByText("api.kimi.com")).toBeInTheDocument();
    expect(screen.getByText("api.deepseek.com")).toBeInTheDocument();
    expect(relaysUsage).toHaveBeenCalledWith("r-kimi");
    expect(relaysUsage).toHaveBeenCalledWith("r-ds");
  });

  it("colors the kimi usage bar by utilization threshold", async () => {
    relaysList.mockResolvedValue([relay("r-80", "kimi", "Kimi 80"), relay("r-50", "kimi", "Kimi 50"), relay("r-30", "kimi", "Kimi 30")]);
    relaysUsage.mockImplementation((id: string) => {
      const pct = { "r-80": 80, "r-50": 50, "r-30": 30 }[id] ?? 0;
      return Promise.resolve(kimiUsage(pct));
    });
    const { container } = renderPanel();

    expect(await screen.findByText("80%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(container.querySelector(".bg-error")).not.toBeNull();
    expect(container.querySelector(".bg-warning")).not.toBeNull();
    expect(container.querySelector(".bg-success")).not.toBeNull();
  });

  it("shows the session-expired error state for an unauthorized probe", async () => {
    relaysList.mockResolvedValue([relay("r-kimi", "kimi", "Kimi relay")]);
    relaysUsage.mockResolvedValue({
      fetched_at: new Date().toISOString(),
      ok: false,
      error: { kind: "unauthorized", message: "Relay authentication failed — update the token" },
      windows: [],
      balance: null,
      peak: null,
    });
    renderPanel();

    const banner = await screen.findByText("Session expired — update the token");
    expect(banner.className).toContain("bg-error/10");
  });

  it("renders the deepseek balance and off-peak state", async () => {
    relaysList.mockResolvedValue([relay("r-ds", "deepseek", "DeepSeek relay")]);
    relaysUsage.mockResolvedValue(okUsage({ balance: { available: true, total: 12.34, currency: "CNY" }, peak: { active: false } }));
    renderPanel();

    expect(await screen.findByText(/¥12\.34 remaining/)).toBeInTheDocument();
    expect(screen.getByText("Off-peak")).toBeInTheDocument();
  });

  it("opens the edit dialog with the masked token placeholder and omits an empty token from the update", async () => {
    relaysList.mockResolvedValue([relay("r-kimi", "kimi", "Kimi relay")]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Configure Kimi relay" }));
    const dialog = await screen.findByRole("dialog");

    const tokenInput = within(dialog).getByLabelText(/Token/);
    expect(tokenInput).toHaveAttribute("placeholder", "sk-...1234");

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(relaysUpdate).toHaveBeenCalledTimes(1));
    const [id, body] = relaysUpdate.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("r-kimi");
    expect(body).toMatchObject({ name: "Kimi relay", kind: "kimi", base_url: "https://api.kimi.com/anthropic" });
    expect(body).not.toHaveProperty("token");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Updated relay "Kimi relay"'));
  });

  it("deletes a relay through the inline confirm", async () => {
    relaysList.mockResolvedValue([relay("r-kimi", "kimi", "Kimi relay")]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Delete Kimi relay" }));
    expect(await screen.findByText(/Delete this relay\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(relaysDelete).toHaveBeenCalledWith("r-kimi"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Deleted relay "Kimi relay"'));
    // The list query is invalidated and refetched after the delete.
    await waitFor(() => expect(relaysList.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("creates a relay from the Add relay dialog", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add relay" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My Kimi" } });
    await chooseOption(dialog, "Kimi");
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://api.kimi.com/anthropic" } });
    fireEvent.change(within(dialog).getByLabelText(/Token/), { target: { value: FAKE_TOKEN } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add relay" }));

    await waitFor(() => expect(relaysCreate).toHaveBeenCalledTimes(1));
    expect(relaysCreate).toHaveBeenCalledWith({
      name: "My Kimi",
      kind: "kimi",
      base_url: "https://api.kimi.com/anthropic",
      token: FAKE_TOKEN,
      model_map: {},
      extra_env: {},
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Added relay "My Kimi"'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the server error inline when create fails", async () => {
    relaysCreate.mockRejectedValue(new Error("Relay authentication failed — check the token"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add relay" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My Kimi" } });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://api.kimi.com/anthropic" } });
    fireEvent.change(within(dialog).getByLabelText(/Token/), { target: { value: FAKE_TOKEN } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add relay" }));

    expect(await within(dialog).findByText("Relay authentication failed — check the token")).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
