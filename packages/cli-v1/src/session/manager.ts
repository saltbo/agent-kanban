/**
 * SessionManager — the single writer for session files.
 *
 * All mutations to session files go through this class. Per-sessionId async
 * mutex serializes all writes keyed by session id, eliminating the races that
 * plagued the old design (7 independent callers racing on the same file).
 *
 * Public API intentionally exposes **intents**, not raw updates. A caller
 * cannot "set status to X" — it applies an event through the state machine,
 * which either advances the session legally or throws. This is the mechanism
 * that makes the state machine authoritative.
 *
 * Reads are NOT mutexed — they return the last committed on-disk state.
 * Writes inside the mutex always re-read before applying, so the state
 * machine sees the fresh state.
 */

import { createLogger } from "../logger.js";
import { applyTransition, type SessionEvent, type SessionState } from "./stateMachine.js";
import {
  listSessions as rawListSessions,
  readSession as rawReadSession,
  removeSession as rawRemoveSession,
  writeSession as rawWriteSession,
} from "./store.js";
import type { SessionFile, SessionFilter, SessionStatus } from "./types.js";

const logger = createLogger("session-manager");

type Mutation<T> = () => Promise<T>;

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(mutation: Mutation<T>): Promise<T> {
    const prev = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await mutation();
    } finally {
      release();
    }
  }
}

export class SessionManager {
  private mutexes = new Map<string, AsyncMutex>();
  private globalMutex = new AsyncMutex();

  private mutexFor(sessionId: string): AsyncMutex {
    let m = this.mutexes.get(sessionId);
    if (!m) {
      m = new AsyncMutex();
      this.mutexes.set(sessionId, m);
    }
    return m;
  }

  // ---- Read API (no mutex) ----

  /** Read the latest committed state for a session. Null if missing or corrupt. */
  read(sessionId: string): SessionFile | null {
    return rawReadSession(sessionId);
  }

  list(filter?: SessionFilter): SessionFile[] {
    return rawListSessions(filter);
  }

  // ---- Write API (mutex) ----

  /**
   * Create a brand-new worker session. The state starts at "active".
   * Fails if a file already exists at this sessionId.
   */
  async create(file: SessionFile): Promise<void> {
    if (file.type === "worker" && !file.status) file.status = "active";
    return this.mutexFor(file.sessionId).run(async () => {
      const existing = rawReadSession(file.sessionId);
      if (existing) {
        throw new Error(`Session ${file.sessionId} already exists`);
      }
      rawWriteSession(file);
    });
  }

  /**
   * Apply a state-machine event to a worker session.
   *
   * Reads the session inside the mutex, asks the state machine for the next
   * state, writes the result atomically. Returns the resulting SessionFile,
   * or null if the session was missing.
   *
   * Throws TransitionError if the event is illegal for the current state —
   * this is a programmer bug, not a runtime condition, and should crash the
   * calling code loudly.
   */
  async applyEvent(sessionId: string, event: SessionEvent, patch?: Partial<SessionFile>): Promise<SessionFile | null> {
    return this.mutexFor(sessionId).run(async () => {
      const current = rawReadSession(sessionId);
      if (!current) return null;
      if (current.type !== "worker") {
        throw new Error(`applyEvent called on non-worker session ${sessionId}`);
      }
      const currentState: SessionState = (current.status ?? "active") as SessionState;
      const nextState = applyTransition(currentState, event);
      if (nextState === "terminal") {
        rawRemoveSession(sessionId);
        this.mutexes.delete(sessionId);
        return null;
      }
      const next: SessionFile = {
        ...current,
        ...patch,
        status: nextState as SessionStatus,
      };
      rawWriteSession(next);
      return next;
    });
  }

  /**
   * Patch non-status fields on a session (backoff, cleanup_pending, etc.).
   * Does NOT invoke the state machine. Use sparingly — prefer applyEvent.
   */
  async patch(sessionId: string, patch: Partial<SessionFile>): Promise<SessionFile | null> {
    return this.mutexFor(sessionId).run(async () => {
      const current = rawReadSession(sessionId);
      if (!current) return null;
      // Defensive: never let patch() change the status. All status changes
      // go through applyEvent() so the state machine is authoritative.
      if ("status" in patch && patch.status !== current.status) {
        throw new Error(`SessionManager.patch refused: status change from ${current.status} → ${patch.status} must go through applyEvent()`);
      }
      const next: SessionFile = { ...current, ...patch };
      rawWriteSession(next);
      return next;
    });
  }

  /**
   * Remove a session file. Only legal for sessions in the "completing" state
   * (after cleanup_done has been processed). Other callers should use
   * applyEvent({type:"cleanup_done"}) which triggers terminal removal.
   *
   * One exception: leader session cleanup calls forceRemove.
   */
  async forceRemove(sessionId: string): Promise<void> {
    return this.mutexFor(sessionId).run(async () => {
      rawRemoveSession(sessionId);
      this.mutexes.delete(sessionId);
    });
  }

  /**
   * For tests: reset internal state. Does not touch the filesystem.
   */
  _resetForTest(): void {
    this.mutexes.clear();
  }

  /**
   * Scan for sessions matching a predicate under the global lock. Used by
   * OrphanReaper and resume scanners where the caller needs a consistent
   * snapshot across multiple session files.
   */
  async listUnderGlobalLock(filter?: SessionFilter): Promise<SessionFile[]> {
    return this.globalMutex.run(async () => rawListSessions(filter));
  }
}

/** Singleton — wired up in daemon/index.ts boot. */
let _singleton: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!_singleton) _singleton = new SessionManager();
  return _singleton;
}

export function _setSessionManagerForTest(m: SessionManager | null): void {
  _singleton = m;
  if (m === null) logger.debug("SessionManager singleton cleared (test)");
}
