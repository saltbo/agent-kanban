import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPanel } from "@/features/tasks/components/ChatPanel";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { tasks: { sessionWs: vi.fn() } } }));
vi.mock("@/features/tasks/components/chat", () => ({ AgentThread: () => null, ChatToolUIs: () => null }));
vi.mock("@/features/tasks/components/RelayRuntimeProvider", () => ({ SessionRuntimeProvider: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("[spec: tasks/human-review] explains a missing execution binding without attempting a Session connection", () => {
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);

  render(<ChatPanel taskId="historical-task" agentId="assigned-agent" taskDone={false} runtimeSessionId={null} />);

  expect(screen.getByText("No execution session is linked to this task. Task notes and review are still available in task details.")).toBeTruthy();
  expect(api.tasks.sessionWs).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});
