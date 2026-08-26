import dayjs from "dayjs";

import { agentColor } from "../lib/agentIdentity";
import { AgentIdenticon } from "./AgentIdenticon";
import { LabelChip } from "./LabelChip";
import { Badge } from "./ui/badge";

interface TaskCardProps {
  task: any;
  labels?: { name: string; color: string; description: string }[];
  onClick: () => void;
  onAgentClick?: (task: any) => void;
  isNew?: boolean;
}

export function TaskCard({ task, labels = [], onClick, onAgentClick, isNew }: TaskCardProps) {
  const isAssigned = !!task.assigned_to;
  const isWorking = isAssigned && !!task.agent_public_key && task.status === "in_progress" && !task.glow_suppressed;
  const labelByName = new Map(labels.map((label) => [label.name, label]));

  return (
    <div
      data-task-id={task.id}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className={`
        w-full text-left bg-surface-card border rounded-lg p-3 outline-none
        transition-[border-color,box-shadow,filter,color] duration-150 cursor-pointer
        focus-visible:ring-2 focus-visible:ring-accent/40
        ${
          isWorking
            ? "border-accent/30 shadow-[0_0_20px_var(--accent-glow),0_0_40px_rgba(34,211,238,0.05)]"
            : "border-border hover:border-content-tertiary"
        }
        ${isNew ? "animate-card-highlight" : ""}
      `}
      style={
        isWorking && task.agent_public_key
          ? {
              borderColor: `color-mix(in srgb, ${agentColor(task.agent_public_key)} 30%, transparent)`,
              boxShadow: `0 0 20px color-mix(in srgb, ${agentColor(task.agent_public_key)} 12%, transparent)`,
            }
          : undefined
      }
    >
      <div className="w-full min-w-0 text-left">
        <div className="flex items-start gap-1.5">
          <span className="font-mono text-[11px] leading-snug text-content-tertiary shrink-0">#{task.seq}</span>
          <div className="line-clamp-2 text-[13px] font-medium leading-snug text-content-primary flex-1 min-w-0" title={task.title}>
            {task.title}
          </div>
          {task.blocked && (
            <Badge variant="destructive" className="text-[10px] font-mono font-semibold uppercase shrink-0">
              Blocked
            </Badge>
          )}
        </div>

        {task.labels?.length > 0 && (
          <div className="mt-2 flex gap-1.5 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {task.labels.map((name: string) => {
              const label = labelByName.get(name);
              return <LabelChip key={name} name={name} color={label?.color ?? "#71717A"} description={label?.description} />;
            })}
          </div>
        )}

        {task.scheduled_at && new Date(task.scheduled_at).getTime() > Date.now() && (
          <div className="mt-1.5">
            <span className="font-mono text-[11px] text-content-tertiary shrink-0" title={task.scheduled_at}>
              {dayjs(task.scheduled_at).format("MM-DD HH:mm")}
            </span>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0 max-w-[50%] flex items-center gap-2">
          {isAssigned && (
            <button
              type="button"
              data-agent-section
              className={`min-w-0 max-w-full flex cursor-pointer items-center gap-1.5 transition-colors duration-500 ${
                isWorking ? "text-accent" : "text-content-tertiary"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onAgentClick?.(task);
              }}
              aria-label={`Open chat with ${task.agent_name || task.assigned_to}`}
            >
              {task.agent_public_key && (
                <div className="shrink-0 transition-[filter] duration-500" style={{ filter: isWorking ? "none" : "grayscale(1) opacity(0.5)" }}>
                  <AgentIdenticon publicKey={task.agent_public_key} size={12} />
                </div>
              )}
              {isWorking && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-glow shrink-0" />}
              <span className="min-w-0 truncate font-mono text-[11px] hover:underline" title={task.agent_name || task.assigned_to}>
                {task.agent_name || task.assigned_to}
              </span>
            </button>
          )}
        </div>

        {task.repository_name && (
          <Badge
            variant="secondary"
            className="min-w-0 max-w-[50%] truncate rounded-[4px] border-none bg-surface-tertiary px-1.5 py-0.5 text-right font-mono text-[11px] text-content-tertiary"
            title={task.repository_name}
          >
            {task.repository_name}
          </Badge>
        )}
      </div>
    </div>
  );
}
