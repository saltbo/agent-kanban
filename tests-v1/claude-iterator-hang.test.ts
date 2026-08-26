// @vitest-environment node
/**
 * Reproduce the SDK iterator hang: query()'s async iterator yields a result
 * message but never terminates afterward (transport stays open due to MCP
 * servers or other long-lived resources). The events generator in claude.ts
 * must break + q.close() after the final result to avoid hanging forever.
 */
import { describe, expect, it } from "vitest";
import { mapSDKMessageStream } from "../packages/cli/src/providers/claude.js";

/**
 * Simulate SDK query() that yields messages and a result, but never
 * terminates the iterator (transport stays open). Only resolves when
 * the consumer calls .return() (triggered by break) or .close() is called.
 */
function makeSdkIteratorThatHangsAfterResult(messages: Array<{ type: string; [k: string]: any }>) {
  let closed = false;
  const close = () => {
    closed = true;
  };

  const iterator = (async function* () {
    for (const msg of messages) {
      yield msg;
    }
    // Simulate transport that never closes — hang forever
    // (like a real SDK query with MCP servers keeping transport alive)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (closed) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  })();

  return { iterator, close };
}

describe("claude.ts events generator — iterator termination", () => {
  it("hangs WITHOUT break+close when SDK iterator doesn't terminate after result", async () => {
    const sdkMessages = [
      { type: "system", subtype: "init", session_id: "test-session" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] }, parent_tool_use_id: null },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, usage: {} },
    ];

    const { iterator, close } = makeSdkIteratorThatHangsAfterResult(sdkMessages);

    // Old code: no break, just for-await — this hangs
    const oldEvents = (async function* () {
      const turnOpen = { value: false };
      const rateLimitSeen = { value: false };
      for await (const msg of iterator) {
        yield* mapSDKMessageStream(msg as any, turnOpen, rateLimitSeen);
      }
    })();

    const collected: string[] = [];
    // Race: consume events vs 1s timeout
    const finished = await Promise.race([
      (async () => {
        for await (const event of oldEvents) {
          collected.push(event.type);
        }
        return "completed";
      })(),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 1000)),
    ]);

    close(); // cleanup so test doesn't leak

    expect(collected).toContain("turn.end"); // result was received
    expect(finished).toBe("timeout"); // but the loop never exited
  });

  it("terminates correctly WITH break+close when SDK iterator doesn't terminate after result", async () => {
    const sdkMessages = [
      { type: "system", subtype: "init", session_id: "test-session" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] }, parent_tool_use_id: null },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, usage: {} },
    ];

    const { iterator, close } = makeSdkIteratorThatHangsAfterResult(sdkMessages);

    // New code: break after result + close
    const newEvents = (async function* () {
      const turnOpen = { value: false };
      const rateLimitSeen = { value: false };
      let activeSubtasks = 0;
      let resultSeen = false;
      for await (const msg of iterator) {
        if (msg.type === "system" && (msg as any).subtype === "task_started") activeSubtasks++;
        if (msg.type === "system" && (msg as any).subtype === "task_notification") activeSubtasks = Math.max(0, activeSubtasks - 1);
        yield* mapSDKMessageStream(msg as any, turnOpen, rateLimitSeen);
        if (msg.type === "result") resultSeen = true;
        if (resultSeen && activeSubtasks <= 0) break;
      }
      close();
    })();

    const collected: string[] = [];
    for await (const event of newEvents) {
      collected.push(event.type);
    }

    expect(collected).toContain("turn.end");
    // Loop exits cleanly — no timeout needed
  });

  it("waits for active subtasks to finish before breaking", async () => {
    const sdkMessages = [
      { type: "system", subtype: "init", session_id: "test-session" },
      { type: "system", subtype: "task_started", tool_use_id: "bg1", description: "background" },
      { type: "result", subtype: "success", result: "main done", total_cost_usd: 0.005, usage: {} },
      // subtask finishes after first result
      { type: "system", subtype: "task_notification", tool_use_id: "bg1", status: "completed", summary: "bg done" },
      // second result after subtask completes
      { type: "result", subtype: "success", result: "all done", total_cost_usd: 0.01, usage: {} },
    ];

    const { iterator, close } = makeSdkIteratorThatHangsAfterResult(sdkMessages);

    const newEvents = (async function* () {
      const turnOpen = { value: false };
      const rateLimitSeen = { value: false };
      let activeSubtasks = 0;
      let resultSeen = false;
      for await (const msg of iterator) {
        if (msg.type === "system" && (msg as any).subtype === "task_started") activeSubtasks++;
        if (msg.type === "system" && (msg as any).subtype === "task_notification") activeSubtasks = Math.max(0, activeSubtasks - 1);
        yield* mapSDKMessageStream(msg as any, turnOpen, rateLimitSeen);
        if (msg.type === "result") resultSeen = true;
        if (resultSeen && activeSubtasks <= 0) break;
      }
      close();
    })();

    const collected: string[] = [];
    for await (const event of newEvents) {
      collected.push(event.type);
    }

    // First result's turn.end is consumed, then subtask ends, then break.
    // Second result is never reached — break fires when activeSubtasks hits 0.
    const turnEnds = collected.filter((t) => t === "turn.end");
    expect(turnEnds).toHaveLength(1);
    // Subtask events were consumed before break
    expect(collected).toContain("subtask.start");
  });
});
