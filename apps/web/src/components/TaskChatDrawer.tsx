import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { AgentIdenticon } from "./AgentIdenticon";
import { ChatPanel } from "./ChatPanel";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";

interface TaskChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string | null;
  task?: any;
  showOverlay?: boolean;
  className?: string;
}

export function TaskChatDrawer({ open, onOpenChange, taskId, task, showOverlay = true, className }: TaskChatDrawerProps) {
  const requiresFetch = open && !!taskId && !task;
  const {
    data: fetchedTask,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.tasks.get(taskId!),
    enabled: requiresFetch,
  });

  if (!taskId) return null;

  const currentTask = fetchedTask ?? task;
  const agentName = currentTask?.agent_name ?? "agent";

  const amaSessionId = currentTask?.runs?.find((run: { amaSessionUri?: unknown }) => typeof run.amaSessionUri === "string")?.amaSessionUri ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent showCloseButton={false} showOverlay={showOverlay} className={`flex flex-col p-0 gap-0 shadow-2xl ${className ?? ""}`}>
        <SheetTitle className="sr-only">Chat with {agentName}</SheetTitle>
        <SheetDescription className="sr-only">Chat panel</SheetDescription>

        <div className="flex items-center gap-3 p-4 border-b border-border shrink-0">
          {currentTask?.agent_public_key ? (
            <AgentIdenticon publicKey={currentTask.agent_public_key} size={28} />
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
              amaSessionId={amaSessionId}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
