import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentThread } from "@/features/tasks/components/chat/AgentThread";
import { SessionRuntimeProvider } from "@/features/tasks/components/RelayRuntimeProvider";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assistant UI runtime compatibility", () => {
  it("renders the Agent thread through the installed assistant UI dependency graph", () => {
    render(
      <SessionRuntimeProvider events={[]} taskDone>
        <AgentThread taskDone />
      </SessionRuntimeProvider>,
    );

    expect(screen.getByText("No activity recorded.")).toBeTruthy();
  });
});
