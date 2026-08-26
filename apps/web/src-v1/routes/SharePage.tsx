import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { AgentAvatarOverlay } from "../components/FloatingAvatar";
import { KanbanColumn } from "../components/KanbanColumn";
import { useAgentPresenceFromEvents } from "../hooks/useAgentPresence";
import { usePublicBoardSSE } from "../hooks/usePublicBoardSSE";
import { api } from "../lib/api";

const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function SharePage() {
  const { slug } = useParams<{ slug: string }>();

  const {
    data: board,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["share", slug],
    queryFn: () => api.share.getBoard(slug!),
    enabled: !!slug,
    refetchInterval: 60_000,
  });

  const { events } = usePublicBoardSSE(slug);
  const avatars = useAgentPresenceFromEvents(events, board?.id);

  const columns = useMemo(() => {
    if (!board?.tasks) return [];
    return TASK_STATUSES.map((status) => ({
      status,
      name: TASK_STATUS_LABELS[status],
      tasks: board.tasks.filter((t: any) => t.status === status),
    }));
  }, [board]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-primary flex flex-col">
        <div className="px-5 py-3 border-b border-border bg-surface-secondary">
          <span className="text-[15px] font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </span>
        </div>
        <div className="grid gap-0 p-4" style={{ gridTemplateColumns: `repeat(5, minmax(0, 1fr))` }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="p-4 space-y-3">
              <div className="h-4 w-20 bg-surface-tertiary rounded animate-pulse" />
              {[0, 1].map((j) => (
                <div key={j} className="h-20 bg-surface-secondary border border-border rounded-lg animate-pulse" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isError || !board) {
    return (
      <div className="min-h-screen bg-surface-primary flex flex-col">
        <div className="px-5 py-3 border-b border-border bg-surface-secondary">
          <span className="text-[15px] font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </span>
        </div>
        <div className="flex items-center justify-center flex-1 text-content-tertiary">Board not found or not public</div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-surface-primary flex flex-col">
      {/* Minimal header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </span>
          <span className="text-content-tertiary text-xs">/</span>
          <span className="text-sm font-medium text-content-primary">{board.name}</span>
        </div>
        <a href="/" className="text-xs font-medium text-accent hover:text-accent/80 transition-colors">
          Get Your Agent Team →
        </a>
      </header>

      {board.description && <div className="px-5 py-2.5 border-b border-border text-sm text-content-secondary">{board.description}</div>}

      {/* Desktop: 5-column kanban */}
      <div className="hidden md:grid flex-1 overflow-hidden" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col) => (
          <KanbanColumn key={col.status} column={col} onTaskClick={() => {}} />
        ))}
      </div>

      {/* Mobile: stacked columns */}
      <div className="md:hidden flex-1 overflow-y-auto">
        {columns.map((col) => (
          <div key={col.status}>
            <KanbanColumn column={col} onTaskClick={() => {}} />
          </div>
        ))}
      </div>

      <AgentAvatarOverlay avatars={avatars} />

      {/* Footer */}
      <footer className="flex-shrink-0 py-3 text-center border-t border-border bg-surface-secondary">
        <a
          href="https://agent-kanban.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-content-tertiary hover:text-accent transition-colors"
        >
          Powered by Agent Kanban
        </a>
      </footer>
    </div>
  );
}
