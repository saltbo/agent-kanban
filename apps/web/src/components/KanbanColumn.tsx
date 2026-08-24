import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { Ban, CheckCircle2, Circle, Clock3, RotateCw } from "lucide-react";
import { TaskCard } from "./TaskCard";

interface KanbanColumnProps {
  column: any;
  labels?: { name: string; color: string; description: string }[];
  onTaskClick: (taskId: string) => void;
  onAgentClick?: (task: any) => void;
}

const COLUMN_ICONS: Record<string, typeof Circle> = {
  todo: Circle,
  in_progress: RotateCw,
  in_review: Clock3,
  done: CheckCircle2,
  cancelled: Ban,
};

/**
 * Group a column's tasks into dependency layers. Tasks whose dependencies all
 * live outside the column (or are done) sit in layer 0; a task that depends on
 * another task in the same column sits one layer below it. Tasks in the same
 * layer can run in parallel and are rendered as one module.
 */
export function groupByDependencyLayer(tasks: any[]): any[][] {
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();

  const compute = (task: any, visiting: Set<string>): number => {
    const cached = depth.get(task.id);
    if (cached !== undefined) return cached;
    let level = 0;
    const deps: string[] = Array.isArray(task.depends_on) ? task.depends_on : [];
    for (const depId of deps) {
      const dep = byId.get(depId);
      if (!dep || visiting.has(depId)) continue;
      visiting.add(depId);
      level = Math.max(level, compute(dep, visiting) + 1);
      visiting.delete(depId);
    }
    depth.set(task.id, level);
    return level;
  };

  for (const task of tasks) compute(task, new Set([task.id]));

  const groups: any[][] = [];
  for (const task of tasks) {
    const level = depth.get(task.id) ?? 0;
    (groups[level] ??= []).push(task);
  }
  return groups.filter(Boolean);
}

export function KanbanColumn({ column, labels = [], onTaskClick, onAgentClick }: KanbanColumnProps) {
  const Icon = COLUMN_ICONS[column.status] ?? Circle;
  const groups = groupByDependencyLayer(column.tasks);
  const layered = groups.length > 1;

  return (
    <div data-column-status={column.status} className="min-w-0 min-h-0 border-r border-border last:border-r-0 flex flex-col h-full">
      <div className="flex items-center justify-between flex-shrink-0 px-4 pt-4 pb-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-content-tertiary">
          <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
          {column.name}
        </span>
        <span className="font-mono text-[11px] text-content-tertiary bg-surface-tertiary px-1.5 py-0.5 rounded">{column.tasks.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-column px-4 pb-4">
        <LayoutGroup>
          <div className={layered ? "space-y-5" : undefined}>
            {groups.map((group, groupIndex) => (
              <div
                key={group.map((t: any) => t.id).join(",")}
                data-dependency-layer={groupIndex}
                className={layered ? "relative pl-4" : undefined}
              >
                {layered && (
                  <>
                    <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-px bg-border" />
                    <span aria-hidden="true" className="absolute left-[-2.5px] top-3 size-1.5 rounded-full bg-content-tertiary" />
                  </>
                )}
                <AnimatePresence initial={false} mode="popLayout">
                  {group.map((task: any) => (
                    <motion.div
                      key={task.id}
                      layout
                      initial={{ opacity: 0, scale: 0.95, y: -8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.25, layout: { duration: 0.3 } }}
                      className="mb-2 last:mb-0"
                    >
                      <TaskCard task={task} labels={labels} onClick={() => onTaskClick(task.id)} onAgentClick={onAgentClick} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </LayoutGroup>
      </div>
    </div>
  );
}
