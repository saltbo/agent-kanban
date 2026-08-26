import type {
  AskUserQuestionArgs,
  BashArgs,
  EditArgs,
  ExitPlanModeArgs,
  GlobArgs,
  GrepArgs,
  MultiEditArgs,
  NotebookEditArgs,
  ReadArgs,
  SlashCommandArgs,
  TaskArgs,
  TodoArgs,
  WebFetchArgs,
  WebSearchArgs,
  WebSearchResult,
  WriteArgs,
} from "@agent-kanban/shared";
import { ToolName } from "@agent-kanban/shared";
import { makeAssistantToolUI } from "@assistant-ui/react";
import type { FC } from "react";
import type { TaskToolResult } from "../../RelayRuntimeProvider";
import {
  AskUserQuestionToolView,
  BashToolView,
  EditToolView,
  ExitPlanModeToolView,
  GlobToolView,
  GrepToolView,
  MultiEditToolView,
  NotebookEditToolView,
  ReadToolView,
  SlashCommandToolView,
  TaskToolView,
  TodoWriteToolView,
  WebFetchToolView,
  WebSearchToolView,
  WriteToolView,
} from "./views";

// ─── makeAssistantToolUI wrappers ───────────────────────────────────────────
// Thin delegates. All per-tool rendering lives in ./views so SubtaskChildren
// can reuse the same components for subagent tool calls.

export const BashToolUI = makeAssistantToolUI<BashArgs, string>({
  toolName: ToolName.Bash,
  render: (p) => <BashToolView {...p} />,
});

export const ReadToolUI = makeAssistantToolUI<ReadArgs, string>({
  toolName: ToolName.Read,
  render: (p) => <ReadToolView {...p} />,
});

export const EditToolUI = makeAssistantToolUI<EditArgs, string>({
  toolName: ToolName.Edit,
  render: (p) => <EditToolView {...p} />,
});

export const MultiEditToolUI = makeAssistantToolUI<MultiEditArgs, string>({
  toolName: ToolName.MultiEdit,
  render: (p) => <MultiEditToolView {...p} />,
});

export const WriteToolUI = makeAssistantToolUI<WriteArgs, string>({
  toolName: ToolName.Write,
  render: (p) => <WriteToolView {...p} />,
});

export const GrepToolUI = makeAssistantToolUI<GrepArgs, string>({
  toolName: ToolName.Grep,
  render: (p) => <GrepToolView {...p} />,
});

export const GlobToolUI = makeAssistantToolUI<GlobArgs, string>({
  toolName: ToolName.Glob,
  render: (p) => <GlobToolView {...p} />,
});

export const TaskToolUI = makeAssistantToolUI<TaskArgs, Partial<TaskToolResult> | string>({
  toolName: ToolName.Agent,
  render: (p) => <TaskToolView {...p} />,
});

export const TodoWriteToolUI = makeAssistantToolUI<TodoArgs, string>({
  toolName: ToolName.TodoWrite,
  render: (p) => <TodoWriteToolView {...p} />,
});

export const WebFetchToolUI = makeAssistantToolUI<WebFetchArgs, string>({
  toolName: ToolName.WebFetch,
  render: (p) => <WebFetchToolView {...p} />,
});

export const WebSearchToolUI = makeAssistantToolUI<WebSearchArgs, WebSearchResult>({
  toolName: ToolName.WebSearch,
  render: (p) => <WebSearchToolView {...p} />,
});

export const AskUserQuestionToolUI = makeAssistantToolUI<AskUserQuestionArgs, string>({
  toolName: ToolName.AskUserQuestion,
  render: (p) => <AskUserQuestionToolView {...p} />,
});

export const ExitPlanModeToolUI = makeAssistantToolUI<ExitPlanModeArgs, string>({
  toolName: ToolName.ExitPlanMode,
  render: (p) => <ExitPlanModeToolView {...p} />,
});

export const SlashCommandToolUI = makeAssistantToolUI<SlashCommandArgs, string>({
  toolName: ToolName.SlashCommand,
  render: (p) => <SlashCommandToolView {...p} />,
});

export const NotebookEditToolUI = makeAssistantToolUI<NotebookEditArgs, string>({
  toolName: ToolName.NotebookEdit,
  render: (p) => <NotebookEditToolView {...p} />,
});

// ─── Mount ───────────────────────────────────────────────────────────────────
// Drop this inside an AssistantRuntimeProvider to register every per-tool UI.
// Any tool_call whose name matches routes to its renderer; unmatched calls
// fall through to ChatToolFallback.

export const ChatToolUIs: FC = () => (
  <>
    <BashToolUI />
    <ReadToolUI />
    <EditToolUI />
    <MultiEditToolUI />
    <WriteToolUI />
    <GrepToolUI />
    <GlobToolUI />
    <TaskToolUI />
    <TodoWriteToolUI />
    <WebFetchToolUI />
    <WebSearchToolUI />
    <AskUserQuestionToolUI />
    <ExitPlanModeToolUI />
    <SlashCommandToolUI />
    <NotebookEditToolUI />
  </>
);

// ─── Re-exports ─────────────────────────────────────────────────────────────
// Preserve the external API: `import { ToolShell, Mono, parseMcpToolName, langFromPath } from "./tool-uis"`.

export { CodeBlock, FileDiff, langFromPath, Markdown, Mono, parseMcpToolName, resultText, ToolShell } from "./primitives";
export { SubtaskChildren, TOOL_VIEWS, type ToolViewProps } from "./views";
