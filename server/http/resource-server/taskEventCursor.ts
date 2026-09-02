import { assertSigningKey, base64UrlDecode, base64UrlEncode, constantTimeEqual, signTokenPayload } from "@server/http/resource-server/signedToken";
import type { TaskStatus } from "@shared";

const CURSOR_TTL_MS = 15 * 60_000;

export type TaskEventCursorBinding = {
  tenantId: string;
  actorId: string;
  apiVersion: string;
  taskIds: string[];
  until: TaskStatus;
};

export async function encodeTaskEventCursor(innerCursor: string, binding: TaskEventCursorBinding, secret: string, now = Date.now()): Promise<string> {
  const payload = `v2:${now + CURSOR_TTL_MS}:${base64UrlEncode(new TextEncoder().encode(innerCursor))}`;
  return `${payload}:${await signature(payload, binding, secret)}`;
}

export async function decodeTaskEventCursor(
  cursor: string,
  binding: TaskEventCursorBinding,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  assertSigningKey(secret);
  try {
    const match = /^(v2:[0-9]+:([A-Za-z0-9_-]+)):([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match) return null;
    const expiresAt = Number(match[1].split(":")[1]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
    if (!constantTimeEqual(match[3], await signature(match[1], binding, secret))) return null;
    return new TextDecoder().decode(base64UrlDecode(match[2]));
  } catch {
    return null;
  }
}

async function signature(payload: string, binding: TaskEventCursorBinding, secret: string): Promise<string> {
  const context = [payload, binding.tenantId, binding.actorId, binding.apiVersion, [...binding.taskIds].sort().join("\u001f"), binding.until].join(
    "\u001e",
  );
  return signTokenPayload(context, secret);
}
