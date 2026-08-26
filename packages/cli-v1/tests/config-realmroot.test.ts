// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMocks);

const { getCredentials, readConfig, saveEnvironment } = await import("../src/config.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Realmroot CLI environment config", () => {
  it("ignores legacy static API-key credentials", () => {
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        current: "legacy.example.test",
        credentials: {
          "legacy.example.test": { "api-url": "https://legacy.example.test", "api-key": "ak_secret" },
        },
      }),
    );

    expect(readConfig()).toEqual({ current: "legacy.example.test", environments: {} });
    expect(() => getCredentials()).toThrow("No AK environment for legacy.example.test");
  });

  it("persists only the Realmroot issuer, resource, client id, and API URL", () => {
    fsMocks.readFileSync.mockImplementation(() => {
      const error = new Error("missing config") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    saveEnvironment({
      apiUrl: "https://ak.example.test/",
      issuer: "https://id.realmroot.dev/api/auth/",
      resource: "https://ak.example.test/api/",
      clientId: "ak-cli",
    });

    expect(fsMocks.writeFileSync).toHaveBeenCalledOnce();
    const serialized = fsMocks.writeFileSync.mock.calls[0][1] as string;
    expect(JSON.parse(serialized)).toEqual({
      current: "ak.example.test",
      environments: {
        "ak.example.test": {
          "api-url": "https://ak.example.test",
          issuer: "https://id.realmroot.dev/api/auth",
          resource: "https://ak.example.test/api",
          "client-id": "ak-cli",
        },
      },
    });
    expect(serialized).not.toContain("api-key");
    expect(fsMocks.writeFileSync.mock.calls[0][2]).toEqual({ mode: 0o600 });
  });

  it("reports corrupt JSON instead of treating it as a logged-out environment", () => {
    fsMocks.readFileSync.mockReturnValue('{"current":');

    expect(() => readConfig()).toThrow(/Invalid AK configuration/);
  });

  it("returns the selected Realmroot environment", () => {
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        current: "ak.example.test",
        environments: {
          "ak.example.test": {
            "api-url": "https://ak.example.test",
            issuer: "https://id.realmroot.dev/api/auth",
            resource: "https://ak.example.test/api",
            "client-id": "ak-cli",
          },
        },
      }),
    );

    expect(getCredentials()).toEqual({
      apiUrl: "https://ak.example.test",
      issuer: "https://id.realmroot.dev/api/auth",
      resource: "https://ak.example.test/api",
      clientId: "ak-cli",
    });
  });
});
