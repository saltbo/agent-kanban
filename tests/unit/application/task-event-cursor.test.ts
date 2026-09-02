// @vitest-environment node

import { describe, expect, it } from "vitest";
import { assertSigningKey } from "../../../server/http/resource-server/signedToken";
import { decodeTaskEventCursor, encodeTaskEventCursor, type TaskEventCursorBinding } from "../../../server/http/resource-server/taskEventCursor";

const secret = btoa("01234567890123456789012345678901");
const now = Date.UTC(2026, 7, 31, 12);
const binding: TaskEventCursorBinding = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  apiVersion: "2026-08-29",
  taskIds: ["task-b", "task-a"],
  until: "done",
};

describe("Task Event public cursor", () => {
  it("[spec: tasks/wait] rejects missing, malformed, or short signing keys and accepts one canonical 32-byte Base64 key", async () => {
    expect(() => assertSigningKey(secret)).not.toThrow();
    for (const invalid of [undefined, "not-base64", btoa("short")]) {
      expect(() => assertSigningKey(invalid as string)).toThrow("AK_SIGNING_KEY must be a canonical Base64-encoded 32-byte key");
    }

    const cursor = await encodeTaskEventCursor("v1:42:internal-hash", binding, secret, now);
    await expect(decodeTaskEventCursor(cursor, binding, btoa("short"), now)).rejects.toThrow(
      "AK_SIGNING_KEY must be a canonical Base64-encoded 32-byte key",
    );
  });

  it("[spec: tasks/wait] signs an opaque continuation and rejects tamper, expiry, or caller and query rebinding", async () => {
    const cursor = await encodeTaskEventCursor("v1:42:internal-hash", binding, secret, now);

    expect(cursor).toMatch(/^v2:[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("internal-hash");
    await expect(decodeTaskEventCursor(cursor, { ...binding, taskIds: ["task-a", "task-b"] }, secret, now)).resolves.toBe("v1:42:internal-hash");

    const last = cursor.at(-1)!;
    const tampered = `${cursor.slice(0, -1)}${last === "a" ? "b" : "a"}`;
    await expect(decodeTaskEventCursor(tampered, binding, secret, now)).resolves.toBeNull();
    await expect(decodeTaskEventCursor(cursor, binding, secret, now + 15 * 60_000)).resolves.toBeNull();

    for (const rebound of [
      { ...binding, tenantId: "tenant-b" },
      { ...binding, actorId: "actor-b" },
      { ...binding, apiVersion: "2026-09-01" },
      { ...binding, taskIds: ["task-a"] },
      { ...binding, until: "cancelled" as const },
    ]) {
      await expect(decodeTaskEventCursor(cursor, rebound, secret, now)).resolves.toBeNull();
    }
  });
});
