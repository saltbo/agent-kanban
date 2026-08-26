import { MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS, MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS } from "@agent-kanban/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useCreateBoardMaintainer, useUpdateBoardMaintainer } from "../hooks/useBoard";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

interface BoardMaintainer {
  id: string;
  agent_id?: string;
  interval_seconds: number;
  heartbeat_enabled?: boolean;
}

interface MaintainerAgent {
  id: string;
  name?: string;
  username?: string;
  role?: string;
}

interface BoardMaintainerDialogProps {
  boardId: string;
  maintainer?: BoardMaintainer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BoardMaintainerDialog({ boardId, maintainer, open, onOpenChange }: BoardMaintainerDialogProps) {
  const isEditing = !!maintainer;
  const createMaintainer = useCreateBoardMaintainer(boardId);
  const updateMaintainer = useUpdateBoardMaintainer(boardId);
  const agentQuery = useQuery({
    queryKey: ["agents", { kind: "worker", maintainer: true }],
    queryFn: () => api.agents.list({ kind: "worker", maintainer: "true" }),
    enabled: open && !isEditing,
  });
  const [agentId, setAgentId] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(String(MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS));
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setAgentId(maintainer?.agent_id ?? "");
    setIntervalSeconds(String(maintainer?.interval_seconds ?? MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS));
    setHeartbeatEnabled(maintainer?.heartbeat_enabled ?? true);
  }, [open, maintainer?.id]);

  const agents = (agentQuery.data ?? []) as MaintainerAgent[];
  const pending = createMaintainer.isPending || updateMaintainer.isPending;

  async function save() {
    const seconds = Number.parseInt(intervalSeconds, 10);
    if (!Number.isInteger(seconds) || seconds < MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS) {
      toast.error("Interval must be at least 3600 seconds");
      return;
    }
    try {
      if (maintainer) {
        await updateMaintainer.mutateAsync({
          maintainerId: maintainer.id,
          body: { interval_seconds: seconds, heartbeat_enabled: heartbeatEnabled },
        });
        toast.success("Maintainer updated");
      } else {
        if (!agentId) {
          toast.error("Agent is required");
          return;
        }
        await createMaintainer.mutateAsync({
          agent_id: agentId,
          interval_seconds: seconds,
          heartbeat_enabled: heartbeatEnabled,
        });
        toast.success("Maintainer created");
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save maintainer");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit maintainer" : "Add maintainer"}</DialogTitle>
          <DialogDescription>Maintainers run on a schedule and use AK commands to inspect and operate this board.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="maintainer-agent">Agent</Label>
              <select
                id="maintainer-agent"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm text-content-primary"
              >
                <option value="">Select an agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name ?? agent.username ?? agent.id}
                    {agent.role ? ` (${agent.role})` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="maintainer-interval">Interval seconds</Label>
            <Input
              id="maintainer-interval"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              inputMode="numeric"
            />
            <p className="text-xs text-content-tertiary">Minimum {MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS} seconds.</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-primary px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="maintainer-heartbeat">Scheduled heartbeat</Label>
              <p className="mt-0.5 text-xs text-content-tertiary">GitHub events stay active when this is off.</p>
            </div>
            <Switch id="maintainer-heartbeat" checked={heartbeatEnabled} onCheckedChange={setHeartbeatEnabled} disabled={pending} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving..." : isEditing ? "Save changes" : "Create maintainer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
