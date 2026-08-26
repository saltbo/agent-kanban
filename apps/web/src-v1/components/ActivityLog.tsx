import { User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { AgentIdenticon } from "./AgentIdenticon";
import { formatRelative } from "./TaskDetailFields";

interface ActivityLogProps {
  initialNotes: any[];
  sseNotes: any[];
  reconnecting: boolean;
}

const actionStyles: Record<string, string> = {
  claimed: "text-accent",
  assigned: "text-accent",
  completed: "text-success",
  released: "text-warning",
  timed_out: "text-error",
  cancelled: "text-error",
  rejected: "text-warning",
  review_requested: "text-accent",
  dispatched: "text-content-tertiary",
  dispatch_failed: "text-error",
};

const dotColors: Record<string, string> = {
  claimed: "bg-accent border-accent/30",
  assigned: "bg-accent border-accent/30",
  completed: "bg-success border-success/30",
  released: "bg-warning border-warning/30",
  timed_out: "bg-error border-error/30",
  cancelled: "bg-error border-error/30",
  rejected: "bg-warning border-warning/30",
  review_requested: "bg-accent border-accent/30",
  commented: "bg-zinc-500 border-zinc-500/30",
  created: "bg-zinc-500 border-zinc-500/30",
  moved: "bg-zinc-500 border-zinc-500/30",
  dispatched: "bg-zinc-500 border-zinc-500/30",
  dispatch_failed: "bg-error border-error/30",
};

const bodyActions = new Set(["commented", "rejected", "completed", "cancelled"]);

const markdownClass =
  "overflow-x-auto text-[13px] text-content-secondary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-content-primary [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-content-primary [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-content-primary [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:mb-2 [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:mb-0.5 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_pre]:bg-surface-primary [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-[12px] [&_code]:font-mono [&_code]:text-accent [&_code]:bg-surface-primary [&_code]:px-1 [&_code]:rounded [&_code]:text-[12px] [&_pre_code]:bg-transparent [&_pre_code]:text-content-secondary [&_pre_code]:p-0 [&_table]:w-full [&_table]:border-collapse [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-content-tertiary [&_th]:uppercase [&_th]:tracking-wide [&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-tertiary [&_hr]:border-border";

function actorLabel(log: any): string {
  if (log.actor_name) return log.actor_name;
  if (log.actor_type?.startsWith("agent:")) return "Agent";
  if (log.actor_type === "user") return "User";
  return "System";
}

function buildSentence(log: any): { actionText: string; suffix: string } {
  switch (log.action) {
    case "claimed":
      return { actionText: "claimed this task", suffix: "" };
    case "assigned":
      return { actionText: "assigned to", suffix: log.detail ?? "agent" };
    case "completed":
      return { actionText: "completed this task", suffix: "" };
    case "released":
      return { actionText: "released this task", suffix: "" };
    case "timed_out":
      return { actionText: "timed out", suffix: "" };
    case "cancelled":
      return { actionText: "cancelled this task", suffix: "" };
    case "rejected":
      return { actionText: "rejected this task", suffix: "" };
    case "review_requested":
      return { actionText: "submitted for review", suffix: "" };
    case "created":
      return { actionText: "created this task", suffix: "" };
    case "moved":
      return { actionText: "moved", suffix: log.detail ?? "" };
    case "commented":
      return { actionText: "commented", suffix: "" };
    case "dispatched":
      return { actionText: "dispatched this task to the runtime", suffix: "" };
    case "dispatch_failed":
      return { actionText: "couldn't dispatch this task", suffix: log.detail ? `— ${log.detail}` : "" };
    default:
      return { actionText: log.action, suffix: bodyActions.has(log.action) ? "" : (log.detail ?? "") };
  }
}

function NoteAvatar({ log }: { log: any }) {
  if (log.actor_type?.startsWith("agent:") && log.actor_public_key) {
    return <AgentIdenticon publicKey={log.actor_public_key} size={28} />;
  }

  return (
    <span className="flex-shrink-0 w-7 h-7 rounded-full bg-zinc-500/10 border border-zinc-500/20 flex items-center justify-center">
      <User className="w-3.5 h-3.5 text-content-tertiary" />
    </span>
  );
}

function MarkdownBody({ children }: { children: string }) {
  return (
    <div className={markdownClass}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function hasBody(log: any): boolean {
  return bodyActions.has(log.action) && !!log.detail;
}

export function ActivityLog({ initialNotes, sseNotes, reconnecting }: ActivityLogProps) {
  const displayed = (() => {
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const note of [...initialNotes, ...sseNotes]) {
      if (!seen.has(note.id)) {
        seen.add(note.id);
        merged.push(note);
      }
    }
    return merged.sort((a, b) => a.created_at.localeCompare(b.created_at));
  })();

  if (displayed.length === 0) {
    return <p className="text-sm text-content-tertiary">No activity yet. Assign an agent to see notes.</p>;
  }

  return (
    <div className="relative">
      {reconnecting && <div className="text-[10px] text-warning mb-1">Reconnecting...</div>}

      <div className="mt-2 pr-1" aria-live="polite">
        <div className="relative">
          <div className="absolute left-3.5 top-0 bottom-0 w-px bg-border" />

          {displayed.map((log: any) => {
            const actor = actorLabel(log);
            const { actionText, suffix } = buildSentence(log);
            const isAgent = log.actor_type?.startsWith("agent:");
            const dot = dotColors[log.action] || "bg-zinc-500 border-zinc-500/30";
            const actionColor = actionStyles[log.action] || "text-content-secondary";
            const body = hasBody(log);

            return (
              <div key={log.id} className="relative flex gap-3 pb-4">
                <div className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center">
                  {body ? <NoteAvatar log={log} /> : <span className={`w-2.5 h-2.5 rounded-full border ${dot}`} />}
                </div>

                <div className="min-w-0 flex-1">
                  {body ? (
                    <div className="overflow-hidden rounded-md border border-border bg-surface-secondary">
                      <div className="flex items-center gap-1.5 border-b border-border bg-surface-tertiary px-3 py-2 text-[12px]">
                        <span className={isAgent ? "font-mono text-accent" : "font-medium text-content-primary"}>{actor}</span>
                        <span className={actionColor}>{actionText}</span>
                        <span className="ml-auto font-mono text-[10px] text-content-tertiary whitespace-nowrap">
                          {formatRelative(log.created_at)}
                        </span>
                      </div>
                      <div className="px-3 py-2.5">
                        <MarkdownBody>{log.detail}</MarkdownBody>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 min-h-7 text-[12px] leading-snug">
                      <span className={isAgent ? "font-mono text-accent" : "text-content-tertiary"}>{actor}</span>
                      <span className={actionColor}>{actionText}</span>
                      {suffix && <span className="text-content-tertiary">{suffix}</span>}
                      <span className="ml-auto font-mono text-[10px] text-content-tertiary whitespace-nowrap">{formatRelative(log.created_at)}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
