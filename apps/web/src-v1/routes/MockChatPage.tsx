/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixture contains literal ${taskId} backticks as source code strings */
import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { useCallback } from "react";
import { AgentThread, ChatToolUIs } from "@/components/chat";

// Mock messages shaped EXACTLY like what RelayRuntimeProvider's `convertEvents`
// produces — text / reasoning / tool-call parts. Any tool_call whose toolName
// matches a registered ChatToolUI renders through that UI; unmatched ones use
// ChatToolFallback. Editing tool-uis.tsx changes both this page and the real
// ChatPanel simultaneously.

const MOCK_MESSAGES: ThreadMessageLike[] = [
  {
    id: "m1",
    role: "user",
    content: [
      {
        type: "text",
        text: "Add a `--dry-run` flag to the `ak assign` command so operators can preview assignments before committing.",
      },
    ],
    createdAt: new Date("2026-04-08T10:00:00Z"),
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "The user wants a preview mode for `ak assign`. I should find the command handler, understand the assignment flow, then thread a flag through without mutating DB state when set.",
      },
      { type: "text", text: "I'll start by locating the `assign` command handler." },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "Grep",
        args: { pattern: '"assign"', path: "packages/cli/src", glob: "*.ts" },
        result: "packages/cli/src/commands/assign.ts:14\npackages/cli/src/index.ts:42",
      },
      {
        type: "tool-call",
        toolCallId: "tc2",
        toolName: "Read",
        args: { file_path: "packages/cli/src/commands/assign.ts", offset: 1, limit: 40 },
        result:
          "import { Command } from 'commander';\nimport { api } from '../api';\n\nexport const assignCmd = new Command('assign')\n  .argument('<taskId>')\n  .argument('<agentId>')\n  .action(async (taskId, agentId) => {\n    const res = await api.post(`/tasks/${taskId}/assign`, { agentId });\n    console.log('assigned', res.id);\n  });",
      },
      {
        type: "text",
        text: "Found it. I'll add the flag and branch on it. When set, we route to a new `/assign/preview` endpoint instead:\n\n```ts\n.option('--dry-run', 'preview without mutating')\n```",
      },
      {
        type: "tool-call",
        toolCallId: "tc3",
        toolName: "Edit",
        args: {
          file_path: "packages/cli/src/commands/assign.ts",
          old_string:
            ".argument('<agentId>')\n  .action(async (taskId, agentId) => {\n    const res = await api.post(`/tasks/${taskId}/assign`, { agentId });",
          new_string:
            ".argument('<agentId>')\n  .option('--dry-run', 'preview without committing')\n  .action(async (taskId, agentId, opts) => {\n    const path = opts.dryRun ? `/tasks/${taskId}/assign/preview` : `/tasks/${taskId}/assign`;\n    const res = await api.post(path, { agentId });",
        },
        result: "Applied 1 edit to packages/cli/src/commands/assign.ts",
      },
      {
        type: "tool-call",
        toolCallId: "tc4",
        toolName: "TodoWrite",
        args: {
          todos: [
            { content: "Add --dry-run flag to CLI", status: "completed" },
            { content: "Add /assign/preview API route", status: "in_progress" },
            { content: "Write tests for preview mode", status: "pending" },
          ],
        },
        result: "Todos updated",
      },
      {
        type: "tool-call",
        toolCallId: "tc5",
        toolName: "Bash",
        args: { command: "cd packages/cli && pnpm tsc --noEmit", description: "Type-check CLI" },
        result: "✓ no errors",
      },
      {
        type: "tool-call",
        toolCallId: "tc6",
        toolName: "Bash",
        args: { command: "npx vitest run packages/cli/tests/assign.test.ts" },
        result:
          "RUN  v1.6.0\n ✓ tests/assign.test.ts (3)\n   ✓ assigns task\n   ✓ --dry-run skips mutation\n   ✓ --dry-run prints preview\n\nTest Files  1 passed (1)\n     Tests  3 passed (3)\n  Duration  412ms",
      },
      {
        type: "tool-call",
        toolCallId: "tc-multi",
        toolName: "MultiEdit",
        args: {
          file_path: "packages/cli/src/scheduler.ts",
          edits: [
            {
              old_string: "const POLL_INTERVAL = 5000;",
              new_string: "const POLL_INTERVAL = 2000;",
            },
            {
              old_string: "function assign(task) {\n  return api.post('/assign', task);\n}",
              new_string:
                "function assign(task, opts = {}) {\n  const path = opts.dryRun ? '/assign/preview' : '/assign';\n  return api.post(path, task);\n}",
            },
          ],
        },
        result: "Applied 2 edits",
      },
      {
        type: "tool-call",
        toolCallId: "tc-webfetch",
        toolName: "WebFetch",
        args: {
          url: "https://www.assistant-ui.com/docs/guides/tools",
          prompt: "How to register per-tool UI renderers",
        },
        result:
          "Use `makeAssistantToolUI({ toolName, render })` to register a renderer for a specific tool name. The render function receives `{ args, argsText, result, status, toolCallId, toolName, addResult }` and returns JSX. Drop the returned FC inside any `AssistantRuntimeProvider` scope.",
      },
      {
        type: "tool-call",
        toolCallId: "tc-websearch",
        toolName: "WebSearch",
        args: { query: "assistant-ui tool call rendering" },
        result: [
          {
            title: "assistant-ui — Tool UI guide",
            url: "https://www.assistant-ui.com/docs/guides/tools",
            snippet: "Learn how to render custom UIs for tool calls using makeAssistantToolUI.",
          },
          {
            title: "GitHub - Yonom/assistant-ui",
            url: "https://github.com/Yonom/assistant-ui",
            snippet: "React components for AI chat with full streaming, tool use, and more.",
          },
        ],
      },
      {
        type: "tool-call",
        toolCallId: "tc-ask",
        toolName: "AskUserQuestion",
        args: {
          questions: [
            {
              header: "Deployment target",
              question: "Which environment should I deploy the preview to?",
              options: [
                { label: "staging", description: "preview.example.com" },
                { label: "production", description: "example.com — requires approval" },
                { label: "skip", description: "don't deploy" },
              ],
            },
          ],
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc-task-typed",
        toolName: "Agent",
        args: {
          description: "Review changed code for quality",
          prompt:
            "Review the Edit to packages/cli/src/commands/assign.ts for logic errors, naming, and security issues. Report PASS or REVISE with specific line-level feedback.",
          subagent_type: "clean-code-reviewer",
        },
        result: {
          text: "PASS — the dry-run branch is clean. One minor note: consider extracting the preview URL to a constant.",
          children: [
            { kind: "thinking", text: "Starting review. I'll read the changed file and look at its test coverage before judging." },
            { kind: "text", text: "Reading the modified command handler first." },
            {
              kind: "tool_use",
              id: "sub-tu-1",
              name: "Read",
              input: { filePath: "packages/cli/src/commands/assign.ts", offset: 1, limit: 30 },
            },
            {
              kind: "tool_result",
              tool_use_id: "sub-tu-1",
              output:
                "import { Command } from 'commander';\nimport { api } from '../api';\n\nexport const assignCmd = new Command('assign')\n  .argument('<taskId>')\n  .argument('<agentId>')\n  .option('--dry-run', 'preview without committing')\n  .action(async (taskId, agentId, opts) => {\n    const path = opts.dryRun ? `/tasks/${taskId}/assign/preview` : `/tasks/${taskId}/assign`;\n    const res = await api.post(path, { agentId });\n    console.log('assigned', res.id);\n  });",
            },
            {
              kind: "tool_use",
              id: "sub-tu-2",
              name: "Grep",
              input: { pattern: "assign/preview", path: "packages/cli/src" },
            },
            {
              kind: "tool_result",
              tool_use_id: "sub-tu-2",
              output: "packages/cli/src/commands/assign.ts:9",
            },
            {
              kind: "tool_use",
              id: "sub-tu-3",
              name: "Bash",
              input: { command: "cd packages/cli && pnpm tsc --noEmit", description: "Type-check the package" },
            },
            {
              kind: "tool_result",
              tool_use_id: "sub-tu-3",
              output: "✓ no errors",
            },
            {
              kind: "tool_use",
              id: "sub-tu-4",
              name: "mcp__context7__resolve-library-id",
              input: { libraryName: "commander" },
            },
            {
              kind: "tool_result",
              tool_use_id: "sub-tu-4",
              output: "commander → /commanderjs/commander",
            },
            { kind: "text", text: "Verdict: PASS with a minor style note." },
          ],
          meta: { tokens: 1840, duration_ms: 12400, last_tool: "Read" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc-task-generic",
        toolName: "Agent",
        args: {
          description: "Search for all assign-related test files",
          prompt: "Find all test files that reference the assign command or assign endpoint. Report file paths and what each tests.",
        },
        result: {
          text: "Found 2 test files:\n- `tests/assign.test.ts` — unit tests for assignCmd\n- `tests/api/assign.test.ts` — integration tests for /assign endpoint",
          children: [],
          meta: { tokens: 920, duration_ms: 4200, last_tool: "Glob" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc-plan",
        toolName: "ExitPlanMode",
        args: {
          plan: "## Plan\n\n1. **Add `--dry-run` flag** to `ak assign` command\n2. **Create `/assign/preview` route** that skips DB writes\n3. **Write tests** covering both normal and preview paths\n\n> Risk: low — preview route is additive, no existing code paths touched.",
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc-slash",
        toolName: "SlashCommand",
        args: { command: "/commit" },
        result: "Staged 3 files. Commit: feat(cli): add --dry-run to assign",
      },
      {
        type: "tool-call",
        toolCallId: "tc-mcp",
        toolName: "mcp__chrome_devtools__take_snapshot",
        args: { selector: "body" },
        result: "<html>...snapshot data truncated...</html>",
      },
      {
        type: "tool-call",
        toolCallId: "tc-unknown",
        toolName: "UnknownCustomTool",
        args: { foo: "bar", nested: { n: 42 } },
        result: "falls back to ChatToolFallback",
      },
      {
        type: "text",
        text: "Done. Summary:\n\n- Added `--dry-run` flag on `ak assign`\n- Routes through `/assign/preview` when set — **no DB writes**\n- 3 new tests pass\n\n> Try it: `ak assign task_123 agent_abc --dry-run`",
      },
    ],
    createdAt: new Date("2026-04-08T10:00:05Z"),
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "m3",
    role: "user",
    content: [{ type: "text", text: "Now deploy the preview to staging and tail the logs." }],
    createdAt: new Date("2026-04-08T10:01:00Z"),
  },
  {
    id: "m4",
    role: "assistant",
    content: [
      { type: "reasoning", text: "Running deploy; will poll logs once the worker reports healthy." },
      { type: "text", text: "Deploying to staging now…" },
      {
        type: "tool-call",
        toolCallId: "rtc1",
        toolName: "Bash",
        args: { command: "wrangler deploy --env=staging", description: "Deploy worker to staging" },
        // no result → assistant-ui renders as running
      },
      {
        type: "tool-call",
        toolCallId: "rtc2",
        toolName: "Read",
        args: { file_path: "apps/web/wrangler.toml" },
      },
      {
        type: "tool-call",
        toolCallId: "rtc3",
        toolName: "WebFetch",
        args: {
          url: "https://staging.agent-kanban.dev/api/health",
          prompt: "Parse the health check response and report status",
        },
      },
    ],
    createdAt: new Date("2026-04-08T10:01:02Z"),
    status: { type: "running" },
  },
];

function MockRuntimeProvider({ children }: { children: React.ReactNode }) {
  const convertMessage = useCallback((m: ThreadMessageLike): ThreadMessageLike => m, []);
  const onNew = useCallback(async () => {
    // no-op: mock page is read-only
  }, []);
  const runtime = useExternalStoreRuntime({
    isRunning: true, // so the trailing assistant message + its tool-calls render as "running"
    messages: MOCK_MESSAGES,
    convertMessage,
    onNew,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function MockChatPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex h-screen max-w-3xl flex-col px-6 py-8">
        <header className="mb-6 flex items-center justify-between border-b border-border pb-4">
          <div>
            <h1 className="text-sm font-semibold text-content-primary">Chat UI Mock</h1>
            <p className="text-xs text-content-tertiary">
              Real ChatPanel components + useExternalStoreRuntime. Edit <code className="font-mono">components/chat/tool-uis.tsx</code> to iterate.
            </p>
          </div>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-content-tertiary">
            mock
          </span>
        </header>
        <div className="flex-1 min-h-0">
          <MockRuntimeProvider>
            <ChatToolUIs />
            <AgentThread taskDone={true} />
          </MockRuntimeProvider>
        </div>
      </div>
    </div>
  );
}
