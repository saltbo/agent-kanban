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

export function KanbanColumn({ column, labels = [], onTaskClick, onAgentClick }: KanbanColumnProps) {
  const Icon = COLUMN_ICONS[column.status] ?? Circle;

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
          <AnimatePresence initial={false} mode="popLayout">
            {column.tasks.map((task: any) => (
              <motion.div
                key={task.id}
                layout
                initial={{ opacity: 0, scale: 0.95, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, layout: { duration: 0.3 } }}
                className="mb-2"
              >
                <TaskCard task={task} labels={labels} onClick={() => onTaskClick(task.id)} onAgentClick={onAgentClick} />
              </motion.div>
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </div>
  );
}
