import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKER_AUTH_SESSION_FILE } from "../paths.js";

export interface WorkerAuthSession {
  agentId: string;
  sessionId: string;
  apiUrl: string;
  privateKeyJwk: JsonWebKey;
  boardId?: string;
  maintainerId?: string;
  createdAt: number;
}

export function readWorkerAuthSession(): WorkerAuthSession | null {
  try {
    return JSON.parse(readFileSync(WORKER_AUTH_SESSION_FILE, "utf-8")) as WorkerAuthSession;
  } catch {
    return null;
  }
}

export function writeWorkerAuthSession(session: WorkerAuthSession): void {
  const directory = dirname(WORKER_AUTH_SESSION_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.worker-auth-session-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, WORKER_AUTH_SESSION_FILE);
  chmodSync(WORKER_AUTH_SESSION_FILE, 0o600);
}

export function clearWorkerAuthSession(): void {
  rmSync(WORKER_AUTH_SESSION_FILE, { force: true });
}
