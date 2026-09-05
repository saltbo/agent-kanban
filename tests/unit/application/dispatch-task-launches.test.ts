import { dispatchTaskLaunches, type TaskLaunchLease, type TaskLaunchStore } from "@server/usecases/tasks/dispatchTaskLaunches";
import { describe, expect, it, vi } from "vitest";

const lease: TaskLaunchLease = {
  id: "launch-1",
  task_id: "task-1",
  owner_id: "tenant-1",
  assignee_actor_id: "agent-1",
  repository_id: null,
  repository_url: null,
  lease_token: "lease-1",
  lease_expires_at: "2030-01-01T00:01:00Z",
  attempts: 1,
};
const prepared = { projectId: "project-1", request: { spec: { agentId: "agent-1" } } };

describe("Task launch dispatch failure isolation", () => {
  it.each(["preparation", "creation"] as const)(
    "[spec: tasks/launch-request-binding] drains other launches when %s and failure recording both fail",
    async (phase) => {
      const operationError = new Error("Remote service unavailable");
      const persistenceError = new Error("Database unavailable");
      const session = Promise.withResolvers<{ uid: string }>();
      const store: TaskLaunchStore = {
        acquireRequested: vi.fn().mockResolvedValue(phase === "creation" ? [lease, { ...lease, id: "launch-2" }] : []),
        acquireRunnable: vi.fn().mockResolvedValue(phase === "preparation" ? [lease, { ...lease, id: "launch-2" }] : []),
        saveRequest: vi.fn().mockResolvedValue(true),
        findRequested: vi.fn().mockResolvedValue({ ...prepared, sessionId: null }),
        recordSession: vi.fn().mockResolvedValue(true),
        recordFailure: vi.fn().mockRejectedValue(persistenceError),
      };
      let settled = false;
      const result = dispatchTaskLaunches(store, {
        prepare: async (item) => {
          if (item.id === "launch-1") throw operationError;
          return prepared;
        },
        create: async (_owner, _input, key) => {
          if (key === "launch-1") throw operationError;
          return session.promise;
        },
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await vi.waitFor(() => expect(store.recordFailure).toHaveBeenCalled());
        expect(settled).toBe(false);
      } finally {
        session.resolve({ uid: "session-2" });
        await result;
      }
      expect(store.recordSession).toHaveBeenCalledWith(expect.objectContaining({ id: "launch-2" }), "session-2", expect.any(Date));
      expect(await result).toBeInstanceOf(AggregateError);
      expect(((await result) as AggregateError).errors).toEqual([operationError, persistenceError]);
    },
  );
});

it.each([false, true])(
  "[spec: tasks/bootstrap-refresh] refreshes before replay and preserves the stored request (failure: %s)",
  async (failRefresh) => {
    const store: TaskLaunchStore = {
      acquireRequested: vi.fn().mockResolvedValue([lease]),
      acquireRunnable: vi.fn().mockResolvedValue([]),
      saveRequest: vi.fn(),
      findRequested: vi.fn().mockResolvedValue({ ...prepared, sessionId: null }),
      recordSession: vi.fn().mockResolvedValue(true),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const order: string[] = [];
    const failure = new Error("Credential rotation rejected");
    const create = vi.fn(async () => {
      order.push("create");
      return { uid: "session-1" };
    });
    const operation = dispatchTaskLaunches(store, {
      prepare: vi.fn(),
      beforeCreate: async (current, saved) => {
        expect(current).toBe(lease);
        expect(saved).toMatchObject(prepared);
        order.push("refresh");
        if (failRefresh) throw failure;
      },
      create,
    });
    if (failRefresh) {
      await expect(operation).rejects.toMatchObject({ errors: [failure] });
      expect(create).not.toHaveBeenCalled();
      expect(store.recordSession).not.toHaveBeenCalled();
    } else {
      await operation;
      expect(order).toEqual(["refresh", "create"]);
      expect(create).toHaveBeenCalledWith(lease.owner_id, { ...prepared, sessionId: null }, lease.id);
    }
    expect(store.saveRequest).not.toHaveBeenCalled();
  },
);
