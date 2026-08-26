import { AuiIf, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ArrowDownIcon, Bot, Plug, UserRound, Wrench } from "lucide-react";
import { type FC, useRef } from "react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningGroup } from "@/components/assistant-ui/reasoning";
import { Mono, parseMcpToolName, ToolShell } from "./tool-uis";

// ─── Props ───

interface AgentThreadProps {
  taskDone: boolean;
}

// ─── Thread Root ───

export const AgentThread: FC<AgentThreadProps> = ({ taskDone }) => {
  const viewportRef = useRef<HTMLDivElement>(null);

  return (
    <ThreadPrimitive.Root className="aui-root aui-thread-root flex h-full flex-col">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className="aui-thread-viewport flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden scroll-smooth pr-3"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-content-tertiary">{taskDone ? "No activity recorded." : "Waiting for agent activity..."}</p>
          </div>
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{
            AssistantMessage: AgentMessage,
            UserMessage: HumanMessage,
          }}
        />

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex w-full flex-col gap-2 bg-background pt-2">
          <ScrollToBottom />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

// ─── Generic Tool Fallback ──────────────────────────────────────────────────
// Routes through the same ToolShell as per-tool UIs. For MCP tools it parses
// the `mcp__namespace__name` convention and renders a cleaner header.

export const ChatToolFallback: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const mcp = parseMcpToolName(toolName);
  const icon = mcp ? <Plug className="size-3.5" /> : <Wrench className="size-3.5" />;
  const label = mcp ? `mcp:${mcp.ns}` : "tool";
  const summary = mcp ? mcp.name : toolName;
  const resultText = result == null ? null : typeof result === "string" ? result : JSON.stringify(result, null, 2);

  return (
    <ToolShell icon={icon} label={label} status={status} summary={summary}>
      {argsText && (
        <>
          <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">args</div>
          <Mono>{argsText}</Mono>
        </>
      )}
      {resultText != null && (
        <>
          <div className="mt-1.5 mb-1 text-[10px] font-mono uppercase tracking-wide text-content-tertiary">result</div>
          <Mono>{resultText}</Mono>
        </>
      )}
    </ToolShell>
  );
};

// ─── Assistant Message ───

const AgentMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative w-full py-2">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-accent">
        <Bot className="size-3" />
        <span>Agent</span>
      </div>
      <div className="border-l-2 border-accent/60 bg-surface-secondary/60 px-3 py-2">
        <div className="flex flex-col gap-2 text-sm text-content-primary leading-relaxed [&_.aui-reasoning-root]:mb-1 [&_.aui-reasoning-root]:border-0 [&_.aui-reasoning-root]:px-0 [&_.aui-reasoning-root]:py-0">
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              Reasoning: Reasoning,
              ReasoningGroup: ReasoningGroup,
              tools: { Fallback: ChatToolFallback },
            }}
          />
          <MessagePrimitive.Error>
            <ErrorPrimitive.Root className="mt-1 rounded-md border border-destructive bg-destructive/10 p-2 text-destructive text-xs">
              <ErrorPrimitive.Message className="line-clamp-2" />
            </ErrorPrimitive.Root>
          </MessagePrimitive.Error>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// ─── User Message ───

const HumanMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-user-message-root flex w-full justify-end py-2">
      <div className="flex max-w-[80%] flex-col items-end">
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-content-tertiary">
          <UserRound className="size-3" />
          <span>You</span>
        </div>
        <div className="rounded-md border border-border bg-surface-tertiary px-3 py-2 text-sm text-content-primary">
          <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// ─── Scroll to Bottom ───

const ScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom className="absolute -top-10 z-10 self-center rounded-full border p-2 disabled:invisible">
      <ArrowDownIcon className="size-4" />
    </ThreadPrimitive.ScrollToBottom>
  );
};
