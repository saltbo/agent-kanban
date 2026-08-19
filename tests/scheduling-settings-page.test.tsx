import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulingSettingsPage } from "../apps/web/src/routes/SchedulingSettingsPage";

const getScheduling = vi.fn();
const putScheduling = vi.fn();

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    settings: {
      getScheduling: (...args: unknown[]) => getScheduling(...args),
      putScheduling: (...args: unknown[]) => putScheduling(...args),
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

const SAVED = {
  peak_windows: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
  timezone: "Asia/Shanghai",
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(SchedulingSettingsPage)));
}

async function waitForLoaded() {
  // The draft populates from the GET response via useEffect.
  await waitFor(() => expect(screen.getByLabelText("Window 1 start")).toHaveValue("09:00"));
}

describe("SchedulingSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScheduling.mockResolvedValue(structuredClone(SAVED));
    putScheduling.mockImplementation(async (body: unknown) => body);
  });

  it("renders the saved windows and timezone from the GET response", async () => {
    renderPage();
    await waitForLoaded();

    expect(screen.getByLabelText("Window 1 end")).toHaveValue("12:00");
    expect(screen.getByLabelText("Window 2 start")).toHaveValue("14:00");
    expect(screen.getByLabelText("Window 2 end")).toHaveValue("18:00");
    expect(screen.getByLabelText("Timezone")).toHaveValue("Asia/Shanghai");
    // Nothing changed yet — save stays disabled.
    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("adds a window row with the 09:00–12:00 template", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Add window" }));

    expect(screen.getByLabelText("Window 3 start")).toHaveValue("09:00");
    expect(screen.getByLabelText("Window 3 end")).toHaveValue("12:00");
  });

  it("removes a window row", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Remove window 1" }));

    expect(screen.queryByLabelText("Window 2 start")).not.toBeInTheDocument();
    // The old second window shifts up to index 1.
    expect(screen.getByLabelText("Window 1 start")).toHaveValue("14:00");
  });

  it("disables save and shows the validation error when start >= end", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText("Window 1 start"), { target: { value: "13:00" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("must start before it ends");
    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save scheduling" }));
    expect(putScheduling).not.toHaveBeenCalled();
  });

  it("shows the timezone error and blocks save for a non-IANA timezone", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Not/AZone" } });

    expect(await screen.findByText("Enter a valid IANA timezone, e.g. Asia/Shanghai.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeDisabled();
  });

  it("keeps Save disabled while the saved settings are still loading", async () => {
    // isDirty is gated on the saved settings having loaded — a fast click on
    // the initial empty draft must not be able to clobber stored windows.
    getScheduling.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();

    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(putScheduling).not.toHaveBeenCalled();
  });

  it("disables Save again when an edit is reverted back to the saved values", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText("Window 1 end"), { target: { value: "11:30" } });
    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeEnabled();
    expect(screen.queryByText("No unsaved changes")).not.toBeInTheDocument();

    // Reverting to the saved value is structurally equal — not dirty.
    fireEvent.change(screen.getByLabelText("Window 1 end"), { target: { value: "12:00" } });
    expect(screen.getByRole("button", { name: "Save scheduling" })).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("saves the draft via PUT and toasts success", async () => {
    renderPage();
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText("Window 1 end"), { target: { value: "11:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scheduling" }));

    const expected = {
      peak_windows: [
        { start: "09:00", end: "11:30" },
        { start: "14:00", end: "18:00" },
      ],
      timezone: "Asia/Shanghai",
    };
    await waitFor(() => expect(putScheduling).toHaveBeenCalledWith(expected));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Scheduling settings saved"));
    expect(toastError).not.toHaveBeenCalled();
  });
});
