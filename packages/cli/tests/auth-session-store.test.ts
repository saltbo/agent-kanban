// @vitest-environment node

import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateDirectory = join(tmpdir(), `ak-worker-auth-${crypto.randomUUID()}`);
const sessionFile = join(stateDirectory, "worker-auth-session.json");

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return { ...actual, WORKER_AUTH_SESSION_FILE: sessionFile };
});

const { readWorkerAuthSession, writeWorkerAuthSession } = await import("../src/auth/session.js");

const session = {
  agentId: "agent-1",
  sessionId: "session-1",
  apiUrl: "https://ak.example.test",
  privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
  createdAt: 1,
};

beforeEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("worker Agent auth session storage", () => {
  it("creates a private session directory and atomically stores the private key file", () => {
    writeWorkerAuthSession(session);

    expect(readWorkerAuthSession()).toEqual(session);
    expectPosixMode(stateDirectory, 0o700);
    expectPosixMode(sessionFile, 0o600);
    expect(readdirSync(stateDirectory)).toEqual(["worker-auth-session.json"]);
  });

  it("repairs broad permissions on an existing directory and auth file", () => {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o777 });
    writeWorkerAuthSession(session);
    chmodSync(stateDirectory, 0o777);
    chmodSync(sessionFile, 0o666);

    writeWorkerAuthSession({ ...session, createdAt: 2 });

    expectPosixMode(stateDirectory, 0o700);
    expectPosixMode(sessionFile, 0o600);
    expect(readWorkerAuthSession()).toMatchObject({ createdAt: 2 });
  });
});

function expectPosixMode(path: string, expected: number): void {
  const stats = statSync(path);
  if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(expected);
}
