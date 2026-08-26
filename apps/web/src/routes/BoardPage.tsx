import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterBar } from "../components/FilterBar";
import { Header } from "../components/Header";
import { KanbanColumn } from "../components/KanbanColumn";
import { TaskDetail } from "../components/TaskDetail";
import { useBoard } from "../hooks/useBoard";

const TASK_STATUSES = ["todo", "queued", "in_progress", "in_review", "done"] as const;

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  queued: "Queued",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

export function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { board, loading, error, refresh } = useBoard(boardId);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
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

  if (error) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div role="alert" className="mx-auto mt-8 max-w-4xl rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
          {error}
          <button onClick={() => void refresh()} className="ml-2 underline">
            Retry
          </button>
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
          <KanbanColumn key={col.status} column={col} labels={board.labels ?? []} onTaskClick={setSelectedTask} />
        ))}
      </div>

      {/* Mobile: single column based on tab */}
      <div className="md:hidden flex-1 overflow-hidden">
        {columns
          .filter((_, i) => i === mobileTab)
          .map((col) => (
            <KanbanColumn key={col.status} column={col} labels={board.labels ?? []} onTaskClick={setSelectedTask} />
          ))}
      </div>

      {selectedTask && <TaskDetail taskId={selectedTask} labels={board.labels ?? []} onClose={() => setSelectedTask(null)} onRefresh={refresh} />}
    </div>
  );
}
