import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface SubtaskListProps {
  parentId: string;
  onTaskClick: (taskId: string) => void;
}

export function SubtaskList({ parentId, onTaskClick }: SubtaskListProps) {
  const { data: subtasks = [] } = useQuery({
    queryKey: ["subtasks", parentId],
    queryFn: () => api.tasks.list({ parent: parentId }),
  });

  if (subtasks.length === 0) return null;

  return (
    <div className="space-y-1 pl-6 md:pl-4">
      {subtasks.map((task: any) => (
        <button
          key={task.id}
          onClick={() => onTaskClick(task.id)}
          className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-tertiary transition-colors"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${task.status === "done" ? "bg-success" : task.assigned_to ? "bg-accent" : "bg-content-tertiary"}`}
          />
          <span className="text-sm text-content-secondary truncate">{task.title}</span>
          <span className="font-mono text-[10px] text-content-tertiary ml-auto">{task.id}</span>
        </button>
      ))}
    </div>
  );
}
