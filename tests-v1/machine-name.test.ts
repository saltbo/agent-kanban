import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  hostname: vi.fn(),
  platform: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: { execFileSync: mocks.execFileSync },
  execFileSync: mocks.execFileSync,
}));

vi.mock("node:os", () => ({
  default: { hostname: mocks.hostname, platform: mocks.platform },
  hostname: mocks.hostname,
  platform: mocks.platform,
}));

describe("resolveMachineName", () => {
  it("uses macOS LocalHostName as the display name", async () => {
    mocks.platform.mockReturnValue("darwin");
    mocks.execFileSync.mockReturnValue("Jaspers-MacBook-Air\n");

    const { resolveMachineName } = await import("../packages/cli/src/machineName");

    expect(resolveMachineName()).toBe("Jaspers-MacBook-Air.local");
    expect(mocks.execFileSync).toHaveBeenCalledWith("scutil", ["--get", "LocalHostName"], { encoding: "utf-8" });
  });

  it("uses os hostname outside macOS", async () => {
    vi.resetModules();
    mocks.platform.mockReturnValue("linux");
    mocks.hostname.mockReturnValue("runner");

    const { resolveMachineName } = await import("../packages/cli/src/machineName");

    expect(resolveMachineName()).toBe("runner");
  });
});
