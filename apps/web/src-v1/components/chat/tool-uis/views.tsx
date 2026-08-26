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
  WebSearchResultItem,
  WriteArgs,
} from "@agent-kanban/shared";
import { ToolName } from "@agent-kanban/shared";
import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import {
  Brain,
  ChevronRight,
  ClipboardList,
  FileSearch,
  FileText,
  Globe,
  HelpCircle,
  Notebook,
  Pencil,
  Plug,
  Search,
  SlashSquare,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ComponentType, FC } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { SubtaskChild, TaskToolResult } from "../../RelayRuntimeProvider";
import { CodeBlock, FileDiff, langFromPath, Markdown, Mono, parseMcpToolName, resultText, ToolShell } from "./primitives";

// ─── View contract ───────────────────────────────────────────────────────────
// Each View is a stateless FC that takes the same shape the makeAssistantToolUI
// render prop receives: { args, result, status }. This lets SubtaskChildren
// render subagent tool calls with the same UI the main agent uses.

export interface ToolViewProps<A, R> {
  args?: A;
  result?: R;
  status?: ToolCallMessagePartStatus;
}

// ─── Bash ────────────────────────────────────────────────────────────────────

export const BashToolView: FC<ToolViewProps<BashArgs, unknown>> = ({ args, result, status }) => {
  const cmd = args?.command ?? "";
  const out = resultText(result);
  return (
    <ToolShell icon={<Terminal className="size-3.5" />} label="bash" status={status} summary={<span className="text-accent">$ {cmd}</span>}>
      {args?.description && <div className="mb-1 text-[11px] text-content-tertiary italic">{args.description}</div>}
      <CodeBlock lang="bash">{`$ ${cmd}${out ? `\n${out}` : ""}`}</CodeBlock>
    </ToolShell>
  );
};

// ─── Read ────────────────────────────────────────────────────────────────────

export const ReadToolView: FC<ToolViewProps<ReadArgs, unknown>> = ({ args, result, status }) => {
  const range = args?.offset ? `:${args.offset}${args.limit ? `-${args.offset + args.limit}` : ""}` : "";
  const out = resultText(result);
  return (
    <ToolShell
      icon={<FileText className="size-3.5" />}
      label="read"
      status={status}
      summary={
        <>
          {args?.filePath}
          <span className="text-content-tertiary">{range}</span>
        </>
      }
    >
      {out && <CodeBlock lang={langFromPath(args?.filePath)}>{out}</CodeBlock>}
    </ToolShell>
  );
};

// ─── Edit ────────────────────────────────────────────────────────────────────

export const EditToolView: FC<ToolViewProps<EditArgs, unknown>> = ({ args, result, status }) => {
  const oldCount = (args?.oldString ?? "").split("\n").length;
  const newCount = (args?.newString ?? "").split("\n").length;
  const out = resultText(result);
  return (
    <ToolShell
      icon={<Pencil className="size-3.5" />}
      label="edit"
      status={status}
      summary={
        <>
          {args?.filePath}{" "}
          <span className="text-content-tertiary">
            −{oldCount} +{newCount}
          </span>
        </>
      }
    >
      <FileDiff oldStr={args?.oldString ?? ""} newStr={args?.newString ?? ""} />
      {out && <div className="mt-1 text-[11px] text-content-tertiary">{out}</div>}
    </ToolShell>
  );
};

// ─── MultiEdit ───────────────────────────────────────────────────────────────

export const MultiEditToolView: FC<ToolViewProps<MultiEditArgs, unknown>> = ({ args, result, status }) => {
  const edits = args?.edits ?? [];
  const out = resultText(result);
  return (
    <ToolShell
      icon={<Pencil className="size-3.5" />}
      label="multi-edit"
      status={status}
      summary={
        <>
          {args?.filePath} <span className="text-content-tertiary">{edits.length} edits</span>
        </>
      }
    >
      <div className="space-y-2">
        {edits.map((e, i) => (
          <div key={i}>
            <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">edit {i + 1}</div>
            <FileDiff oldStr={e.oldString} newStr={e.newString} />
          </div>
        ))}
      </div>
      {out && <div className="mt-1 text-[11px] text-content-tertiary">{out}</div>}
    </ToolShell>
  );
};

// ─── Write ───────────────────────────────────────────────────────────────────

export const WriteToolView: FC<ToolViewProps<WriteArgs, unknown>> = ({ args, status }) => {
  const content = args?.content ?? "";
  const lineCount = content.split("\n").length;
  return (
    <ToolShell
      icon={<Pencil className="size-3.5" />}
      label="write"
      status={status}
      summary={
        <>
          {args?.filePath} <span className="text-content-tertiary">+{lineCount}</span>
        </>
      }
    >
      <CodeBlock lang={langFromPath(args?.filePath)}>{content}</CodeBlock>
    </ToolShell>
  );
};

// ─── Grep ────────────────────────────────────────────────────────────────────

export const GrepToolView: FC<ToolViewProps<GrepArgs, unknown>> = ({ args, result, status }) => {
  const out = resultText(result);
  return (
    <ToolShell
      icon={<Search className="size-3.5" />}
      label="grep"
      status={status}
      summary={
        <>
          <span className="text-accent">/{args?.pattern}/</span>
          {args?.path && <span className="text-content-tertiary"> in {args.path}</span>}
          {args?.glob && <span className="text-content-tertiary"> ({args.glob})</span>}
        </>
      }
    >
      {out && <Mono>{out}</Mono>}
    </ToolShell>
  );
};

// ─── Glob ────────────────────────────────────────────────────────────────────

export const GlobToolView: FC<ToolViewProps<GlobArgs, unknown>> = ({ args, result, status }) => {
  const out = resultText(result);
  return (
    <ToolShell
      icon={<FileSearch className="size-3.5" />}
      label="glob"
      status={status}
      summary={
        <>
          {args?.pattern}
          {args?.path && <span className="text-content-tertiary"> in {args.path}</span>}
        </>
      }
    >
      {out && <Mono>{out}</Mono>}
    </ToolShell>
  );
};

// ─── TodoWrite ───────────────────────────────────────────────────────────────

export const TodoWriteToolView: FC<ToolViewProps<TodoArgs, unknown>> = ({ args, status }) => {
  const todos = args?.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <ToolShell
      icon={<Wrench className="size-3.5" />}
      label="todos"
      status={status}
      summary={
        <span className="text-content-tertiary">
          {done}/{todos.length} done
        </span>
      }
    >
      <ul className="space-y-0.5 text-[11px]">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 font-mono",
                t.status === "completed" && "text-emerald-600",
                t.status === "in_progress" && "text-accent",
                t.status === "pending" && "text-content-tertiary",
              )}
            >
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"}
            </span>
            <span className={cn(t.status === "completed" && "text-content-tertiary line-through")}>{t.content}</span>
          </li>
        ))}
      </ul>
    </ToolShell>
  );
};

// ─── WebFetch ────────────────────────────────────────────────────────────────

export const WebFetchToolView: FC<ToolViewProps<WebFetchArgs, unknown>> = ({ args, result, status }) => {
  const out = resultText(result);
  let host = "";
  try {
    host = new URL(args?.url ?? "").host;
  } catch {
    host = args?.url ?? "";
  }
  return (
    <ToolShell icon={<Globe className="size-3.5" />} label="web-fetch" status={status} summary={<span className="text-accent">{host}</span>}>
      <div className="mb-1 break-all text-[11px] text-content-tertiary">{args?.url}</div>
      {args?.prompt && (
        <>
          <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">prompt</div>
          <div className="mb-2 text-[11px] text-content-secondary italic">{args.prompt}</div>
        </>
      )}
      {out && (
        <>
          <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">response</div>
          <Markdown text={out} />
        </>
      )}
    </ToolShell>
  );
};

// ─── WebSearch ───────────────────────────────────────────────────────────────

export const WebSearchToolView: FC<ToolViewProps<WebSearchArgs, WebSearchResult | unknown>> = ({ args, result, status }) => {
  const results: WebSearchResultItem[] | null = Array.isArray(result) ? (result as WebSearchResultItem[]) : null;
  return (
    <ToolShell icon={<Search className="size-3.5" />} label="web-search" status={status} summary={<span className="text-accent">{args?.query}</span>}>
      {results ? (
        <ul className="space-y-1.5 text-[11px]">
          {results.map((r, i) => (
            <li key={i} className="border-l-2 border-border/60 pl-2">
              {r.title && <div className="font-medium text-content-primary">{r.title}</div>}
              {r.url && <div className="break-all text-accent text-[10px]">{r.url}</div>}
              {r.snippet && <div className="text-content-secondary">{r.snippet}</div>}
            </li>
          ))}
        </ul>
      ) : (
        result != null && <Mono>{resultText(result) ?? ""}</Mono>
      )}
    </ToolShell>
  );
};

// ─── AskUserQuestion ─────────────────────────────────────────────────────────

export const AskUserQuestionToolView: FC<ToolViewProps<AskUserQuestionArgs, unknown>> = ({ args, status }) => {
  const questions = args?.questions ?? [];
  return (
    <ToolShell
      icon={<HelpCircle className="size-3.5" />}
      label="ask"
      status={status}
      summary={<span className="text-content-primary">{questions[0]?.question ?? (questions.length > 0 ? "question" : "")}</span>}
    >
      <div className="space-y-3">
        {questions.map((q, qi) => (
          <div key={qi} className="rounded border border-accent/30 bg-accent/5 p-2">
            {q.header && <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">{q.header}</div>}
            <div className="mb-2 text-[12px] font-medium text-content-primary">{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt, oi) => (
                  <span
                    key={oi}
                    className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] text-content-secondary"
                    title={opt.description}
                  >
                    {opt.label ?? opt.description}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </ToolShell>
  );
};

// ─── ExitPlanMode ────────────────────────────────────────────────────────────

export const ExitPlanModeToolView: FC<ToolViewProps<ExitPlanModeArgs, unknown>> = ({ args, status }) => (
  <ToolShell
    icon={<ClipboardList className="size-3.5" />}
    label="plan"
    status={status}
    summary={<span className="text-content-tertiary">proposed plan</span>}
  >
    <Markdown text={args?.plan ?? ""} />
  </ToolShell>
);

// ─── SlashCommand ────────────────────────────────────────────────────────────

export const SlashCommandToolView: FC<ToolViewProps<SlashCommandArgs, unknown>> = ({ args, result, status }) => {
  const out = resultText(result);
  return (
    <ToolShell
      icon={<SlashSquare className="size-3.5" />}
      label="slash"
      status={status}
      summary={<span className="text-accent">/{args?.command?.replace(/^\//, "")}</span>}
    >
      {out && <Mono>{out}</Mono>}
    </ToolShell>
  );
};

// ─── NotebookEdit ────────────────────────────────────────────────────────────

export const NotebookEditToolView: FC<ToolViewProps<NotebookEditArgs, unknown>> = ({ args, status }) => {
  const mode = args?.editMode ?? "replace";
  return (
    <ToolShell
      icon={<Notebook className="size-3.5" />}
      label={`nb:${mode}`}
      status={status}
      summary={
        <>
          {args?.notebookPath}
          {args?.cellId && <span className="text-content-tertiary"> #{args.cellId}</span>}
        </>
      }
    >
      <CodeBlock lang={args?.cellType === "markdown" ? "markdown" : "python"}>{args?.newSource ?? ""}</CodeBlock>
    </ToolShell>
  );
};

// ─── Task (sub-agent) ────────────────────────────────────────────────────────

type TaskToolResultShape = Partial<TaskToolResult>;

// Normalize result: may be legacy string or rich TaskToolResult.
function coerceTaskResult(result: unknown): TaskToolResultShape {
  if (result == null) return {};
  if (typeof result === "string") return { text: result };
  if (typeof result === "object") return result as TaskToolResultShape;
  return {};
}

export const TaskToolView: FC<ToolViewProps<TaskArgs, TaskToolResultShape | string>> = ({ args, result, status }) => {
  const r = coerceTaskResult(result);
  const metaParts: string[] = [];
  if (r.meta?.tokens != null) metaParts.push(`${r.meta.tokens} tok`);
  if (r.meta?.duration_ms != null) metaParts.push(`${Math.round(r.meta.duration_ms / 1000)}s`);
  if (r.meta?.last_tool) metaParts.push(r.meta.last_tool);
  const agentLabel = args?.subagentType || "agent";
  return (
    <ToolShell icon={<Brain className="size-3.5" />} label={agentLabel} status={status} summary={args?.description}>
      <div className="mb-1 text-[11px] text-content-tertiary">prompt:</div>
      <Mono>{args?.prompt ?? ""}</Mono>
      {r.children && r.children.length > 0 && <SubtaskChildren items={r.children} />}
      {r.text && (
        <>
          <div className="mt-2 mb-1 text-[11px] text-content-tertiary">report:</div>
          <Markdown text={r.text} />
        </>
      )}
      {metaParts.length > 0 && <div className="mt-2 text-[10px] font-mono text-content-tertiary">{metaParts.join(" · ")}</div>}
    </ToolShell>
  );
};

// ─── Per-tool view registry ──────────────────────────────────────────────────
// Used by SubtaskChildren to render subagent tool calls with the same UI as
// the main agent. Keyed on the canonical tool name (matches block.name from
// the agent event stream). Fallback to SubtaskFallback for unknown tools.

export const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps<any, any>>> = {
  [ToolName.Bash]: BashToolView,
  [ToolName.Read]: ReadToolView,
  [ToolName.Edit]: EditToolView,
  [ToolName.MultiEdit]: MultiEditToolView,
  [ToolName.Write]: WriteToolView,
  [ToolName.Grep]: GrepToolView,
  [ToolName.Glob]: GlobToolView,
  [ToolName.Agent]: TaskToolView,
  [ToolName.TodoWrite]: TodoWriteToolView,
  [ToolName.WebFetch]: WebFetchToolView,
  [ToolName.WebSearch]: WebSearchToolView,
  [ToolName.AskUserQuestion]: AskUserQuestionToolView,
  [ToolName.ExitPlanMode]: ExitPlanModeToolView,
  [ToolName.SlashCommand]: SlashCommandToolView,
  [ToolName.NotebookEdit]: NotebookEditToolView,
};

// ─── Fallback for unknown / MCP tools ────────────────────────────────────────

const SubtaskFallback: FC<{ toolName: string; input?: Record<string, unknown>; result?: unknown; status?: ToolCallMessagePartStatus }> = ({
  toolName,
  input,
  result,
  status,
}) => {
  const mcp = parseMcpToolName(toolName);
  const icon = mcp ? <Plug className="size-3.5" /> : <Wrench className="size-3.5" />;
  const label = mcp ? `mcp:${mcp.ns}` : "tool";
  const summary = mcp ? mcp.name : toolName;
  const argsText = input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : "";
  const out = resultText(result);
  return (
    <ToolShell icon={icon} label={label} status={status} summary={summary}>
      {argsText && (
        <>
          <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">args</div>
          <Mono>{argsText}</Mono>
        </>
      )}
      {out != null && (
        <>
          <div className="mt-1.5 mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">result</div>
          <Mono>{out}</Mono>
        </>
      )}
    </ToolShell>
  );
};

// ─── SubtaskChildren ─────────────────────────────────────────────────────────
// Renders subagent event stream (children of a Task tool_call) with the same
// per-tool UIs used by the main agent. Pairs tool_use with its tool_result by
// id and dispatches to TOOL_VIEWS. Text/thinking blocks render in-line.
//
// Note: nested subagents (Agent spawned by Agent) are flattened into the outer
// Task's children list by RelayRuntimeProvider, so inner steps appear as
// siblings to the nested Agent tool_use. The nested Agent renders via the same
// TaskToolView with no inner children — its steps are shown alongside.

function statusFor(result?: Extract<SubtaskChild, { kind: "tool_result" }>): ToolCallMessagePartStatus {
  if (!result) return { type: "running" };
  if (result.error) return { type: "incomplete", reason: "error", error: result.output ?? "tool error" };
  return { type: "complete" };
}

export const SubtaskChildren: FC<{ items: SubtaskChild[] }> = ({ items: children }) => {
  if (!children.length) return null;

  // Pair tool_use with its tool_result by id. Tool results are skipped during
  // the render walk — they're consumed as siblings of their tool_use.
  const resultById = new Map<string, Extract<SubtaskChild, { kind: "tool_result" }>>();
  let stepCount = 0;
  for (const c of children) {
    if (c.kind === "tool_result") resultById.set(c.tool_use_id, c);
    else stepCount += 1;
  }

  return (
    <Collapsible className="group/subchildren mt-2">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-content-tertiary transition-colors hover:text-content-secondary">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]/subchildren:rotate-90" />
        <span>subagent steps ({stepCount})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="mt-1 flex flex-col gap-1 border-l border-border/60 pl-2">
          {children.map((c, i) => {
            if (c.kind === "text") return <Markdown key={i} text={c.text} />;
            if (c.kind === "thinking")
              return (
                <div key={i} className="italic text-content-tertiary text-[11px]">
                  {c.text}
                </div>
              );
            if (c.kind === "tool_use") {
              const paired = resultById.get(c.id);
              const status = statusFor(paired);
              const View = TOOL_VIEWS[c.name];
              if (View) return <View key={i} args={c.input} result={paired?.output} status={status} />;
              return <SubtaskFallback key={i} toolName={c.name} input={c.input} result={paired?.output} status={status} />;
            }
            // tool_result — rendered with its paired tool_use
            return null;
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
