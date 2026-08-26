import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { AgentProfile } from "../components/AgentProfile";
import { FilterBar } from "../components/FilterBar";
import { AgentAvatarOverlay } from "../components/FloatingAvatar";
import { Header } from "../components/Header";
import { KanbanColumn } from "../components/KanbanColumn";
import { TaskChatDrawer } from "../components/TaskChatDrawer";
import { TaskDetail } from "../components/TaskDetail";
import { useAgentPresence } from "../hooks/useAgentPresence";
import { useBoard } from "../hooks/useBoard";

const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { board, loading, error, refresh } = useBoard(boardId);
  const avatars = useAgentPresence(boardId);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [chatTask, setChatTask] = useState<any | null>(null);
  const [activeRepository, setActiveRepository] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState(0);

  const repositories = useMemo(() => {
    if (!board?.tasks) return [];
    const map = new Map<string, string>();
    for (const task of board.tasks) {
      if (task.repository_id && task.repository_name) {
        map.set(task.repository_id, task.repository_name);
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [board]);

  const columns = useMemo(() => {
    if (!board?.tasks) return [];
    const tasks = board.tasks.filter((t: any) => {
      if (activeRepository && t.repository_id !== activeRepository) return false;
      if (activeLabel && !t.labels?.includes(activeLabel)) return false;
      return true;
    });
    return TASK_STATUSES.map((status) => ({
      status,
      name: TASK_STATUS_LABELS[status],
      tasks: tasks.filter((t: any) => t.status === status),
    }));
  }, [board, activeRepository, activeLabel]);

  if (error === "NOT_AUTHENTICATED") {
    window.location.href = "/auth";
    return null;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
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

  if (!board) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="flex items-center justify-center min-h-[60vh] text-content-tertiary">Board not found</div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-surface-primary flex flex-col">
      <Header />
      <FilterBar
        repositories={repositories}
        labels={board.labels ?? []}
        activeRepository={activeRepository}
        activeLabel={activeLabel}
        onRepositoryChange={setActiveRepository}
        onLabelChange={setActiveLabel}
      />

      {error && (
        <div className="mx-5 mt-3 px-4 py-2 bg-error/10 border-l-2 border-error text-error text-sm rounded">
          {error}
          <button onClick={() => refresh()} className="ml-2 underline">
            Retry
          </button>
        </div>
      )}

      {/* Mobile tab switcher */}
      <div className="flex md:hidden border-b border-border">
        {columns.map((col, i) => (
          <button
            key={col.status}
            onClick={() => setMobileTab(i)}
            className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wide text-center transition-colors ${
              mobileTab === i ? "text-accent border-b-2 border-accent" : "text-content-tertiary"
            }`}
          >
            {col.name} ({col.tasks.length})
          </button>
        ))}
      </div>

      {/* Desktop: 5-column grid */}
      <div className="hidden md:grid flex-1 overflow-hidden" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col) => (
          <KanbanColumn key={col.status} column={col} labels={board.labels ?? []} onTaskClick={setSelectedTask} onAgentClick={setChatTask} />
        ))}
      </div>

      {/* Mobile: single column based on tab */}
      <div className="md:hidden flex-1 overflow-hidden">
        {columns
          .filter((_, i) => i === mobileTab)
          .map((col) => (
            <KanbanColumn key={col.status} column={col} labels={board.labels ?? []} onTaskClick={setSelectedTask} onAgentClick={setChatTask} />
          ))}
      </div>

      <AgentAvatarOverlay avatars={avatars} />

      {selectedTask && (
        <TaskDetail
          taskId={selectedTask}
          labels={board.labels ?? []}
          onClose={() => setSelectedTask(null)}
          onRefresh={refresh}
          onAgentClick={(agentId) => {
            setSelectedTask(null);
            setSelectedAgent(agentId);
          }}
        />
      )}

      <TaskChatDrawer
        open={!!chatTask}
        onOpenChange={(open) => {
          if (!open) setChatTask(null);
        }}
        taskId={chatTask?.id ?? null}
        task={chatTask}
        className="!w-[50%] max-md:!w-full"
      />

      {selectedAgent && (
        <AgentProfile
          agentId={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onTaskClick={(taskId) => {
            setSelectedAgent(null);
            setSelectedTask(taskId);
          }}
        />
      )}
    </div>
  );
}
