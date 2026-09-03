import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentAvatar, useAgentProfile } from "@/features/agent-identity";
import { api } from "@/lib/api";
import { ChatPanel } from "./ChatPanel";

interface TaskChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string | null;
  task?: any;
  showOverlay?: boolean;
  className?: string;
}

export function TaskChatDrawer({ open, onOpenChange, taskId, task, showOverlay = true, className }: TaskChatDrawerProps) {
  const requiresFetch = open && !!taskId;
  const {
    data: fetchedTask,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.tasks.get(taskId!),
    enabled: requiresFetch,
  });
  const currentTask = fetchedTask ?? task;
  const profile = useAgentProfile(currentTask?.assigned_to).data;
  const agentName = profile?.name ?? currentTask?.assignee_name ?? currentTask?.assigned_to ?? "agent";

  if (!taskId) return null;

  // The bound runtime Session is the sole source for task chat.
  const hasRuntimeSession = !!currentTask?.session_binding;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent showCloseButton={false} showOverlay={showOverlay} className={`flex flex-col p-0 gap-0 shadow-2xl ${className ?? ""}`}>
        <SheetTitle className="sr-only">Chat with {agentName}</SheetTitle>
        <SheetDescription className="sr-only">Chat panel</SheetDescription>

        <div className="flex items-center gap-3 p-4 border-b border-border shrink-0">
          {currentTask?.assigned_to ? (
            <AgentAvatar subject={currentTask.assigned_to} profile={profile} fallbackName={currentTask.assignee_name} size={28} />
          ) : (
            <Skeleton className="size-7 rounded-full" />
          )}
          <span className="font-mono text-[13px] text-accent flex-1">{agentName}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)}>
            ✕
          </Button>
        </div>

        <div className="flex flex-col flex-1 min-h-0 pl-4 pb-4">
          {isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-error">Unable to load task chat.</div>
          ) : (
            <ChatPanel
              taskId={taskId}
              agentId={currentTask?.assigned_to ?? null}
              taskDone={currentTask?.status === "done" || currentTask?.status === "cancelled"}
              runtimeSessionId={hasRuntimeSession ? "available" : null}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
