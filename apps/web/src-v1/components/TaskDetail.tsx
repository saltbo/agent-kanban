import { useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark-dimmed.min.css";

dayjs.extend(duration);

import { useSSE } from "../hooks/useSSE";
import { api } from "../lib/api";
import { ActivityLog } from "./ActivityLog";
import { AgentIdenticon } from "./AgentIdenticon";
import { LabelChip } from "./LabelChip";
import { SubtaskList } from "./SubtaskList";
import { TaskChatDrawer } from "./TaskChatDrawer";
import { Field, FieldLabel, formatRelative } from "./TaskDetailFields";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

const REVIEW_ACTIONS = {
  reject: { label: "Reject", variant: "outline" as const },
  complete: { label: "Complete", variant: "default" as const },
};

const TASK_DETAIL_SHEET_CLASS = "overflow-hidden p-0 gap-0 !w-[60%] max-md:!w-full";

interface TaskDetailProps {
  taskId: string;
  labels?: { name: string; color: string; description: string }[];
  onClose: () => void;
  onRefresh: () => void;
  onAgentClick?: (agentId: string) => void;
}

function formatElapsed(ms: number): string {
  const d = dayjs.duration(ms);
  const h = Math.floor(d.asHours());
  const m = d.minutes();
  const s = d.seconds();
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatPrLabel(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? `#${match[1]}` : "PR";
}

function LiveDuration({ startedAt, finishedMinutes }: { startedAt: string | null; finishedMinutes: number | null }) {
  const [now, setNow] = useState(Date.now());

  const active = startedAt != null && finishedMinutes == null;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!startedAt) return <span className="text-content-tertiary">—</span>;

  if (active) {
    const elapsed = now - dayjs(startedAt).valueOf();
    return <span className="font-mono text-[13px] tabular-nums">{formatElapsed(elapsed)}</span>;
  }

  return <span className="font-mono text-[13px]">{formatElapsed(finishedMinutes! * 60_000)}</span>;
}

function annotationValue(task: any, key: string): string | null {
  const annotations = task?.metadata?.annotations;
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) return null;
  const value = annotations[key];
  return typeof value === "string" && value ? value : null;
}

export function TaskDetail({ taskId, labels = [], onClose, onRefresh, onAgentClick: _onAgentClick }: TaskDetailProps) {
  const queryClient = useQueryClient();
  const [chatOpen, setChatOpen] = useState(false);
  const { notes: sseNotes, reconnecting } = useSSE({ taskId, enabled: true });
  const labelByName = new Map(labels.map((label) => [label.name, label]));

  const { data: task, isLoading: loading } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.tasks.get(taskId),
  });

  const { data: repositories = [] } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.repositories.list(),
    staleTime: 60_000,
  });

  const dependsOn: string[] = task?.depends_on || [];

  const { data: depTitles = {} } = useQuery({
    queryKey: ["dep-titles", dependsOn],
    queryFn: async () => {
      const entries = await Promise.all(dependsOn.map((id) => api.tasks.get(id).then((t: any) => [id, t.title] as const)));
      return Object.fromEntries(entries);
    },
    enabled: dependsOn.length > 0,
  });

  async function reload() {
    await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
  }

  async function handleReviewAction(action: "reject" | "complete") {
    if (action === "reject") await api.tasks.reject(taskId);
    else await api.tasks.complete(taskId);
    await reload();
    onRefresh();
  }

  const content = loading ? (
    <div className="p-6 space-y-4">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-20 w-full" />
    </div>
  ) : !task ? (
    <div className="p-6">
      <p className="text-content-secondary">Task not found.</p>
      <Button variant="link" onClick={onClose} className="mt-4">
        Back to board
      </Button>
    </div>
  ) : null;

  if (content) {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent showCloseButton={false} className={TASK_DETAIL_SHEET_CLASS}>
          <SheetTitle className="sr-only">Task</SheetTitle>
          <SheetDescription className="sr-only">Task details</SheetDescription>
          <div className="h-full overflow-y-auto overscroll-contain">{content}</div>
        </SheetContent>
      </Sheet>
    );
  }

  const repo = repositories.find((r: any) => r.id === task.repository_id);

  const agentDisplay = task.agent_name ? (
    <button className="flex items-center gap-1.5 cursor-pointer group" onClick={() => setChatOpen(true)} type="button">
      {task.agent_public_key && <AgentIdenticon publicKey={task.agent_public_key} size={20} />}
      <span className="font-mono text-[13px] text-accent group-hover:underline">{task.agent_name}</span>
    </button>
  ) : (
    <span className="text-content-tertiary">—</span>
  );

  const detailsContent = (
    <div className="p-5 space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div>
          <FieldLabel>Status</FieldLabel>
          <span className="text-sm font-medium text-accent">{TASK_STATUS_LABELS[task.status] || task.status}</span>
        </div>
        <Field label="Assigned to" value={agentDisplay} />
        <Field
          label="PR"
          value={
            task.pr_url ? (
              <a href={task.pr_url} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] text-accent hover:underline">
                {formatPrLabel(task.pr_url)}
              </a>
            ) : (
              <span className="text-content-tertiary">—</span>
            )
          }
        />
        {task.scheduled_at && (
          <Field
            label="Scheduled"
            value={
              <span className="font-mono text-[13px]" title={dayjs(task.scheduled_at).format("YYYY-MM-DD HH:mm:ss Z")}>
                {new Date(task.scheduled_at).getTime() > Date.now()
                  ? dayjs(task.scheduled_at).format("MM-DD HH:mm")
                  : formatRelative(task.scheduled_at)}
              </span>
            }
          />
        )}
        <Field
          label="Duration"
          value={
            <LiveDuration
              startedAt={task.notes?.find((n: any) => n.action === "claimed")?.created_at ?? null}
              finishedMinutes={task.duration_minutes}
            />
          }
        />
      </div>

      {task.status === "in_review" && (
        <div className="flex gap-2">
          {(Object.entries(REVIEW_ACTIONS) as [keyof typeof REVIEW_ACTIONS, (typeof REVIEW_ACTIONS)[keyof typeof REVIEW_ACTIONS]][]).map(
            ([action, config]) => (
              <Button key={action} variant={config.variant} size="sm" onClick={() => handleReviewAction(action)}>
                {config.label}
              </Button>
            ),
          )}
        </div>
      )}

      {dependsOn.length > 0 && (
        <div>
          <FieldLabel>Depends on</FieldLabel>
          <div className="flex gap-1.5 flex-wrap">
            {dependsOn.map((depId) => (
              <Badge key={depId} variant="secondary" className="text-[11px] font-mono">
                {depTitles[depId] || depId}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <FieldLabel>Description</FieldLabel>
        {task.description ? (
          <div className="overflow-x-auto prose-sm text-[13px] text-content-secondary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-content-primary [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-content-primary [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-content-primary [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:mb-2 [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:mb-0.5 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_pre]:bg-surface-primary [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-[12px] [&_code]:font-mono [&_code]:text-accent [&_code]:bg-surface-primary [&_code]:px-1 [&_code]:rounded [&_code]:text-[12px] [&_pre_code]:bg-transparent [&_pre_code]:text-content-secondary [&_pre_code]:p-0 [&_table]:w-full [&_table]:border-collapse [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-content-tertiary [&_th]:uppercase [&_th]:tracking-wide [&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-tertiary [&_hr]:border-border">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {task.description}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-[13px] text-content-tertiary">No description.</p>
        )}
      </div>

      {task.input && (
        <div>
          <FieldLabel>Input</FieldLabel>
          <pre className="text-xs font-mono bg-surface-primary border border-border rounded-md p-3 text-content-secondary overflow-x-auto">
            {JSON.stringify(task.input, null, 2)}
          </pre>
        </div>
      )}

      {task.subtask_count > 0 && (
        <>
          <Separator />
          <div>
            <FieldLabel>Subtasks ({task.subtask_count})</FieldLabel>
            <SubtaskList
              parentId={taskId}
              onTaskClick={(_id) => {
                /* navigate to subtask */
              }}
            />
          </div>
        </>
      )}

      <Separator />

      <div>
        <FieldLabel>Activity</FieldLabel>
        <ActivityLog initialNotes={task.notes || []} sseNotes={sseNotes} reconnecting={reconnecting} />
      </div>

      <Separator />
    </div>
  );

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent showCloseButton={false} className={`${TASK_DETAIL_SHEET_CLASS} ${chatOpen ? "!w-[calc(60%+3rem)]" : ""}`}>
          <SheetTitle className="sr-only">{task.title}</SheetTitle>
          <SheetDescription className="sr-only">Task detail panel</SheetDescription>

          <div className="overflow-y-auto overscroll-contain h-full">
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-border">
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-content-tertiary">#{task.seq}</span>
                  <span className="text-lg font-semibold text-content-primary">{task.title}</span>
                  {task.blocked && (
                    <Badge variant="destructive" className="text-[10px] font-mono font-semibold uppercase">
                      Blocked
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {repo && (
                    <Badge variant="secondary" className="rounded-[4px] text-[11px] font-mono">
                      {repo.name}
                    </Badge>
                  )}
                  {task.labels?.map((name: string) => {
                    const label = labelByName.get(name);
                    return <LabelChip key={name} name={name} color={label?.color ?? "#71717A"} description={label?.description} />;
                  })}
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                ✕
              </Button>
            </div>

            {detailsContent}
          </div>

          {/* Dim mask when chat drawer is open */}
          {chatOpen && (
            <div
              className="absolute inset-0 bg-black/10 backdrop-blur-xs z-10 transition-opacity duration-200 cursor-pointer"
              onClick={() => setChatOpen(false)}
            />
          )}
        </SheetContent>
      </Sheet>

      {task.assigned_to && (
        <TaskChatDrawer
          open={chatOpen}
          onOpenChange={setChatOpen}
          taskId={taskId}
          task={task}
          showOverlay={false}
          className="z-[60] !w-[50%] max-md:!w-full"
        />
      )}
    </>
  );
}
