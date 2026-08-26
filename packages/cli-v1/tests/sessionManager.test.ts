// @vitest-environment node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the paths module at an isolated temp dir BEFORE importing any session code.
const { tmpRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return { tmpRoot: mkdtempSync(join(tmpdir(), "ak-sm-test-")) };
});
vi.mock("../src/paths.js", async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  const { join } = await import("node:path");
  return {
    ...mod,
    SESSIONS_DIR: join(tmpRoot, "sessions"),
  };
});

import { SessionManager } from "../src/session/manager.js";
import { TransitionError } from "../src/session/stateMachine.js";
import type { SessionFile } from "../src/session/types.js";

function makeWorkerFile(sessionId: string, overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId,
    runtime: "claude",
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: { kty: "OKP" } as JsonWebKey,
    taskId: "task-1",
    workspace: { type: "temp", cwd: "/tmp/x" },
    status: "active",
    ...overrides,
  };
}

describe("SessionManager — create + read", () => {
  let sm: SessionManager;
  beforeEach(() => {
    sm = new SessionManager();
  });
  afterEach(() => {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  });

  it("creates a new session and reads it back", async () => {
    const file = makeWorkerFile("s-1");
    await sm.create(file);
    const read = sm.read("s-1");
    expect(read).toBeTruthy();
    expect(read?.taskId).toBe("task-1");
    expect(read?.status).toBe("active");
  });

  it("throws when creating a duplicate", async () => {
    await sm.create(makeWorkerFile("s-dup"));
    await expect(sm.create(makeWorkerFile("s-dup"))).rejects.toThrow(/already exists/);
  });

  it("returns null for missing session", () => {
    expect(sm.read("missing")).toBeNull();
  });
});

describe("SessionManager — applyEvent (state transitions)", () => {
  let sm: SessionManager;
  beforeEach(async () => {
    sm = new SessionManager();
  });
  afterEach(() => {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  });

  it("active + iterator_done_with_result(true) → in_review", async () => {
    await sm.create(makeWorkerFile("s-a"));
    const next = await sm.applyEvent("s-a", { type: "iterator_done_with_result", taskInReview: true });
    expect(next?.status).toBe("in_review");
  });

  it("active + iterator_done_with_result(false) → completing (intermediate)", async () => {
    await sm.create(makeWorkerFile("s-b"));
    const next = await sm.applyEvent("s-b", { type: "iterator_done_with_result", taskInReview: false });
    expect(next?.status).toBe("completing");
  });

  it("completing + cleanup_done → closed (file retained)", async () => {
    await sm.create(makeWorkerFile("s-c"));
    await sm.applyEvent("s-c", { type: "iterator_done_normal" });
    await sm.applyEvent("s-c", { type: "cleanup_done" });
    expect(sm.read("s-c")?.status).toBe("closed");
  });

  it("in_review + rejected_by_reviewer → active", async () => {
    await sm.create(makeWorkerFile("s-r", { status: "in_review" }));
    const next = await sm.applyEvent("s-r", { type: "rejected_by_reviewer" });
    expect(next?.status).toBe("active");
  });

  it("rate_limited + resume_started → active", async () => {
    await sm.create(makeWorkerFile("s-rl", { status: "rate_limited" }));
    const next = await sm.applyEvent("s-rl", { type: "resume_started" });
    expect(next?.status).toBe("active");
  });

  it("throws TransitionError on illegal event", async () => {
    await sm.create(makeWorkerFile("s-illegal"));
    await expect(sm.applyEvent("s-illegal", { type: "cleanup_done" })).rejects.toThrow(TransitionError);
  });

  it("returns null when session is missing", async () => {
    const res = await sm.applyEvent("nowhere", { type: "iterator_done_normal" });
    expect(res).toBeNull();
  });
});

describe("SessionManager — concurrent mutations are serialized", () => {
  let sm: SessionManager;
  beforeEach(() => {
    sm = new SessionManager();
  });
  afterEach(() => {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  });

  it("serializes parallel applyEvent calls per sessionId", async () => {
    await sm.create(makeWorkerFile("s-race"));

    // Fire two competing transitions at the same time:
    //   1) iterator_done_normal (active → completing)
    //   2) iterator_done_normal (which would be ILLEGAL from completing)
    // If the mutex works, the second call sees "completing" and throws
    // TransitionError. If the mutex fails, both see "active" and the
    // second one silently "succeeds" against a stale snapshot.
    const first = sm.applyEvent("s-race", { type: "iterator_done_normal" });
    const second = sm.applyEvent("s-race", { type: "iterator_done_normal" });

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionError);
  });

  it("applyEvent then cleanup_done results in closed state", async () => {
    await sm.create(makeWorkerFile("s-seq"));
    await sm.applyEvent("s-seq", { type: "iterator_done_normal" });
    const closed = await sm.applyEvent("s-seq", { type: "cleanup_done" });
    expect(closed?.status).toBe("closed");
    expect(sm.read("s-seq")?.status).toBe("closed");
  });
});

describe("SessionManager — patch", () => {
  let sm: SessionManager;
  beforeEach(() => {
    sm = new SessionManager();
  });
  afterEach(() => {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  });

  it("patches non-status fields", async () => {
    await sm.create(makeWorkerFile("s-p"));
    const next = await sm.patch("s-p", { resumeBackoffMs: 5000, resumeAfter: 123 });
    expect(next?.resumeBackoffMs).toBe(5000);
    expect(next?.resumeAfter).toBe(123);
    expect(next?.status).toBe("active");
  });

  it("refuses to change status via patch", async () => {
    await sm.create(makeWorkerFile("s-p2"));
    await expect(sm.patch("s-p2", { status: "in_review" })).rejects.toThrow(/status change/);
  });

  it("patch with matching status is a no-op", async () => {
    await sm.create(makeWorkerFile("s-p3"));
    const next = await sm.patch("s-p3", { status: "active", resumeBackoffMs: 100 });
    expect(next?.status).toBe("active");
    expect(next?.resumeBackoffMs).toBe(100);
  });
});

describe("SessionManager — list / filter", () => {
  let sm: SessionManager;
  beforeEach(() => {
    sm = new SessionManager();
  });
  afterEach(() => {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  });

  it("list with no filter returns all sessions", async () => {
    await sm.create(makeWorkerFile("s-l1"));
    await sm.create(makeWorkerFile("s-l2", { status: "in_review" }));
    const all = sm.list();
    expect(all.length).toBe(2);
  });

  it("list with status filter", async () => {
    await sm.create(makeWorkerFile("s-l3"));
    await sm.create(makeWorkerFile("s-l4", { status: "in_review" }));
    const inReview = sm.list({ type: "worker", status: "in_review" });
    expect(inReview.length).toBe(1);
    expect(inReview[0]?.sessionId).toBe("s-l4");
  });
});
