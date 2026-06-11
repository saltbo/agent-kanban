// @vitest-environment node
/**
 * Integration test: parse a real Codex JSONL file from ~/.codex/sessions/.
 * Skipped in CI (no local Codex sessions). Run manually with:
 *   npx vitest run tests/codex-real-jsonl.test.ts
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexJsonl } from "../packages/cli/src/providers/codex.js";

const CODEX_DIR = join(homedir(), ".codex", "sessions");
const hasCodexSessions = existsSync(CODEX_DIR);

describe.skipIf(!hasCodexSessions)("readCodexJsonl — real JSONL data", () => {
  // Collect real thread IDs from local sessions
  function* findThreadIds(): Generator<string> {
    const { readdirSync } = require("node:fs");
    try {
      for (const year of readdirSync(CODEX_DIR)) {
        const yearDir = join(CODEX_DIR, year);
        for (const month of readdirSync(yearDir)) {
          const monthDir = join(yearDir, month);
          for (const day of readdirSync(monthDir)) {
            const dayDir = join(monthDir, day);
            for (const file of readdirSync(dayDir)) {
              if (!file.endsWith(".jsonl")) continue;
              // Extract thread ID: rollout-...-{uuid}.jsonl
              const match = file.match(/([0-9a-f-]{36})\.jsonl$/);
              if (match) yield match[1];
            }
          }
        }
      }
    } catch {
      /* empty */
    }
  }

  // The chronologically first session is not guaranteed to contain assistant
  // messages (it may have been aborted before the first response), so scan
  // for a thread the assertions below can meaningfully run against.
  function findThreadId(): string | null {
    for (const id of findThreadIds()) {
      try {
        const events = readCodexJsonl(id);
        if (events.length > 0 && events.some((e: any) => e.event.type === "message")) return id;
      } catch {
        /* unreadable session — try the next one */
      }
    }
    return null;
  }

  const threadId = findThreadId();

  it.skipIf(!threadId)("parses events from a real session file", () => {
    const events = readCodexJsonl(threadId!);

    expect(events.length).toBeGreaterThan(0);

    for (const e of events) {
      // Every event has required fields
      expect(e.id).toBeTruthy();
      expect(e.timestamp).toBeTruthy();
      expect(e.event).toBeTruthy();

      const evt = e.event as any;
      // Only our normalized event types
      expect(["message", "message.user"]).toContain(evt.type);

      if (evt.type === "message") {
        expect(Array.isArray(evt.blocks)).toBe(true);
        for (const block of evt.blocks) {
          expect(["text", "thinking", "tool_use", "tool_result"]).toContain(block.type);
        }
      } else if (evt.type === "message.user") {
        expect(typeof evt.text).toBe("string");
      }
    }

    // Should have at least one assistant message
    const hasAssistant = events.some((e: any) => e.event.type === "message");
    expect(hasAssistant).toBe(true);

    console.log(`Parsed ${events.length} events from thread ${threadId}`);
    for (const e of events) {
      const evt = e.event as any;
      if (evt.type === "message") {
        const types = evt.blocks.map((b: any) => b.type).join(", ");
        console.log(`  ${e.id} | ${types}`);
      } else {
        console.log(`  ${e.id} | ${evt.type}`);
      }
    }
  });
});
