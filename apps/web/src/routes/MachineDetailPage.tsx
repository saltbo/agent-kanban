import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { MachineRuntimeAvailability } from "../components/MachineRuntimes";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useDeleteMachine, useMachine } from "../hooks/useMachines";
import { api } from "../lib/api";

const statusDotColors: Record<string, string> = {
  online: "bg-success",
  offline: "bg-content-tertiary",
};

export function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { machine, loading, error } = useMachine(id);
  const deleteMachine = useDeleteMachine();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showReconnect, setShowReconnect] = useState(false);
  const [runnerCommand, setRunnerCommand] = useState("ama-runner");

  useEffect(() => {
    if (!id || !machine?.environment) return;
    void api.machines
      .runnerCommand(id)
      .then(setRunnerCommand)
      .catch((error) => toast.error((error as Error).message));
  }, [id, machine?.environment]);

  async function handleDelete() {
    if (!id) return;
    try {
      await deleteMachine.mutateAsync(id);
      navigate(`/machines${window.location.search}`);
    } catch (error) {
      toast.error((error as Error).message || "Failed to delete machine");
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="max-w-4xl mx-auto p-8 space-y-6">
          <div className="h-6 w-48 bg-surface-tertiary rounded animate-pulse" />
          <div className="h-32 bg-surface-secondary border border-border rounded-lg animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="max-w-4xl mx-auto p-8">
          <p role="alert" className="text-error text-sm">
            {(error as Error).message}
          </p>
        </div>
      </div>
    );
  }

  if (!machine) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="max-w-4xl mx-auto p-8">
          <p className="text-content-secondary text-sm">Machine not found.</p>
        </div>
      </div>
    );
  }

  const isOffline = machine.status === "offline";
  const runtimes = machine.runtimes || [];
  const usageWindows = machine.usage_info?.windows ?? [];

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-content-tertiary">
          <Link to={`/machines${window.location.search}`} className="hover:text-content-secondary transition-colors">
            Machines
          </Link>
          <span>/</span>
          <span className="text-content-secondary">{machine.name}</span>
        </div>

        {/* Machine header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${statusDotColors[machine.status]}`} />
            <h1 className="font-mono text-xl font-bold text-content-primary">{machine.name}</h1>
            <span className="text-[11px] font-mono text-content-tertiary uppercase tracking-wide">{machine.status}</span>
          </div>
        </div>

        {/* Machine summary */}
        <div className="bg-surface-secondary border border-border rounded-lg px-5 py-4 space-y-3">
          <div className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">OS</span>
              <span className="font-mono text-xs text-content-primary">{machine.os || "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">Version</span>
              <span className="font-mono text-xs text-content-primary">{machine.version || "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">Last Heartbeat</span>
              <span className="font-mono text-xs text-content-primary">
                {machine.last_heartbeat_at ? (
                  <span title={machine.last_heartbeat_at}>
                    {formatRelative(machine.last_heartbeat_at)} · {machine.last_heartbeat_at.slice(0, 10)}
                  </span>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">Created</span>
              <span className="font-mono text-xs text-content-primary">{formatRelative(machine.created_at)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">Sessions</span>
              <span className="font-mono text-xs text-content-primary">{machine.session_count}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-content-tertiary uppercase tracking-wide">Active</span>
              <span className="font-mono text-xs text-accent">{machine.active_session_count}</span>
            </div>
          </div>
        </div>

        {/* Offline reconnect */}
        {isOffline && (
          <div className="bg-warning/5 border border-warning/20 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-warning">Machine is offline</div>
              <p className="text-xs text-content-secondary mt-0.5">Restart AMA Runner on this machine to bring it back online.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowReconnect(true)}>
              Reconnect
            </Button>
          </div>
        )}

        {/* Runtime availability */}
        <div className="bg-surface-secondary border border-border rounded-lg px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-content-tertiary uppercase tracking-wide">Runtime Availability</span>
            <span className="text-[11px] font-mono text-content-tertiary">
              {machine.usage_info?.updated_at ? `Usage updated ${formatRelative(machine.usage_info.updated_at)}` : ""}
            </span>
          </div>
          <MachineRuntimeAvailability runtimes={runtimes} windows={usageWindows} />
        </div>

        {/* Agents on this machine */}
        <div>
          <div className="text-[11px] font-medium text-content-tertiary uppercase tracking-wide mb-3">Agents ({(machine.agents || []).length})</div>
          {(machine.agents || []).length === 0 ? (
            <p className="text-sm text-content-tertiary">No agents registered on this machine.</p>
          ) : (
            <div className="space-y-2">
              {(machine.agents || []).map((agent: any) => (
                <Link
                  key={agent.id}
                  to={`/agents/${agent.id}${window.location.search}`}
                  className={`flex items-center justify-between bg-surface-secondary border rounded-lg px-4 py-3 hover:border-accent/30 transition-colors ${
                    agent.active_session_count > 0 ? "border-accent/30 shadow-[0_0_16px_rgba(34,211,238,0.06)]" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center">
                      <span className="font-mono text-accent text-[10px] font-bold">{agent.name.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div>
                      <span className="font-mono text-sm text-accent">{agent.name}</span>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${agent.active_session_count > 0 ? "bg-accent animate-pulse-glow" : "bg-content-tertiary"}`}
                        />
                        <span className="text-[11px] text-content-tertiary">{agent.active_session_count || 0} active sessions</span>
                      </div>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-content-tertiary">
                    {agent.last_session_at ? formatRelative(agent.last_session_at) : "—"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-surface-secondary border border-border rounded-lg px-5 py-4">
            <div className="text-[11px] font-medium text-content-tertiary uppercase tracking-wide mb-3">Runners</div>
            {(machine.runners ?? []).length === 0 ? (
              <p className="text-sm text-content-tertiary">No active runners.</p>
            ) : (
              <div className="space-y-2">
                {(machine.runners ?? []).map((runner: any) => (
                  <div key={runner.id} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-content-primary">{runner.name}</span>
                    <span className="font-mono text-content-tertiary">
                      {runner.currentLoad ?? 0}/{runner.maxConcurrent ?? 0} · {runner.state}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-surface-secondary border border-border rounded-lg px-5 py-4">
            <div className="text-[11px] font-medium text-content-tertiary uppercase tracking-wide mb-3">Sessions</div>
            {(machine.sessions ?? []).length === 0 ? (
              <p className="text-sm text-content-tertiary">No sessions on this machine.</p>
            ) : (
              <div className="space-y-2">
                {(machine.sessions ?? []).map((session: any) => (
                  <div key={session.metadata?.uid ?? session.id} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-content-primary">{session.metadata?.name ?? session.metadata?.uid ?? session.id}</span>
                    <span className="font-mono text-content-tertiary">{session.status?.phase ?? "unknown"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Danger zone */}
        <div className="border-t border-border pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] font-medium text-error uppercase tracking-wide">Danger Zone</div>
              <p className="mt-1 text-xs text-content-tertiary">Delete this AMA Environment. Realmroot identity and grants are not changed.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={machine.runner_only}
              className="border-error/30 text-error hover:bg-error/10"
              onClick={() => setShowDeleteDialog(true)}
            >
              {machine.runner_only ? "Runner managed by AMA" : "Delete Machine"}
            </Button>
          </div>
        </div>
      </div>

      {/* Reconnect dialog */}
      <Dialog open={showReconnect} onOpenChange={setShowReconnect}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reconnect {machine?.name}</DialogTitle>
            <DialogDescription>Run this command to reconnect:</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <pre className="bg-surface-primary border border-border rounded-lg p-3 text-xs font-mono text-content-secondary overflow-x-auto whitespace-pre-wrap break-all">
              {runnerCommand}
            </pre>
            <Button variant="outline" className="w-full" onClick={() => navigator.clipboard.writeText(runnerCommand)}>
              Copy to clipboard
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete AMA Environment</DialogTitle>
            <DialogDescription>
              This permanently deletes <span className="font-mono text-content-primary">{machine.name}</span> from AMA. Attached Runners must be moved
              or stopped first, and AMA may reject deletion while Sessions are active.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMachine.isPending}>
              {deleteMachine.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
