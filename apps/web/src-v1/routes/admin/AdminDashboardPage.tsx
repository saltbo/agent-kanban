import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

interface TasksByStatus {
  todo: number;
  in_progress: number;
  in_review: number;
  done: number;
  cancelled: number;
}

interface AdminStats {
  agents: { total: number; online: number };
  machines: { total: number; online: number };
  tasks: TasksByStatus;
  boards: { total: number };
  runtime_sessions: { total: number; active: number };
}

const STATUS_BAR_CLASS: Record<string, string> = {
  todo: "bg-zinc-500",
  in_progress: "bg-accent",
  in_review: "bg-warning",
  done: "bg-success",
  cancelled: "bg-zinc-700",
};

const STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

function StatCard({ label, value, subtitle }: { label: string; value: number; subtitle: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-medium text-content-tertiary uppercase tracking-wider">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-4xl font-semibold font-mono text-content-primary leading-none">{value}</p>
        {subtitle && <p className="text-xs text-content-tertiary mt-2">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-3 w-20" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-3 w-28" />
      </CardContent>
    </Card>
  );
}

type StatusKey = keyof TasksByStatus;

function TaskStatusBar({ byStatus }: { byStatus: TasksByStatus }) {
  const statuses: StatusKey[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
  const total = statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);

  if (total === 0) return null;

  return (
    <div className="mt-8">
      <p className="text-xs font-medium text-content-tertiary uppercase tracking-wider mb-3">Task Status Breakdown</p>
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {statuses.map((status) => {
          const count = byStatus[status] || 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          return <div key={status} className={STATUS_BAR_CLASS[status]} style={{ width: `${pct}%` }} title={`${STATUS_LABELS[status]}: ${count}`} />;
        })}
      </div>
      <div className="flex flex-wrap gap-4 mt-3">
        {statuses.map((status) => {
          const count = byStatus[status] || 0;
          return (
            <div key={status} className="flex items-center gap-1.5">
              <span className={`inline-block w-2.5 h-2.5 rounded-sm ${STATUS_BAR_CLASS[status]}`} />
              <span className="text-xs text-content-tertiary">{STATUS_LABELS[status]}</span>
              <span className="text-xs font-mono text-content-secondary">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.admin
      .getStats()
      .then(setStats)
      .finally(() => setLoading(false));
  }, []);

  const tasksByStatus: TasksByStatus = stats?.tasks ?? { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 };
  const taskTotal = Object.values(tasksByStatus).reduce((sum, n) => sum + n, 0);
  const activeTaskCount = (tasksByStatus.in_progress || 0) + (tasksByStatus.in_review || 0);

  return (
    <div className="px-8 py-10 max-w-5xl">
      <h1 className="text-2xl font-semibold text-content-primary tracking-tight mb-8">Dashboard</h1>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard label="Agents" value={stats.agents.total} subtitle={`${stats.agents.online} online`} />
            <StatCard label="Machines" value={stats.machines.total} subtitle={`${stats.machines.online} online`} />
            <StatCard label="Tasks" value={taskTotal} subtitle={`${activeTaskCount} active`} />
            <StatCard label="Sessions" value={stats.runtime_sessions.total} subtitle={`${stats.runtime_sessions.active} active`} />
            <StatCard label="Boards" value={stats.boards.total} subtitle="" />
          </div>
          <TaskStatusBar byStatus={tasksByStatus} />
        </>
      ) : (
        <p className="text-content-tertiary text-sm">Failed to load stats.</p>
      )}
    </div>
  );
}
