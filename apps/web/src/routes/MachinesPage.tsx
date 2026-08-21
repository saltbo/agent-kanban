import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { MachineRuntimeBadges } from "../components/MachineRuntimes";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useMachines } from "../hooks/useMachines";
import { api } from "../lib/api";

const statusDotColors: Record<string, string> = {
  online: "bg-success",
  offline: "bg-content-tertiary",
};

type DialogStep = "choose" | "cloud" | "local";

export function MachinesPage() {
  const { machines, loading, refresh } = useMachines();
  const [showDialog, setShowDialog] = useState(false);
  const [dialogStep, setDialogStep] = useState<DialogStep>("choose");
  const [creatingCloud, setCreatingCloud] = useState(false);
  const [cloudName, setCloudName] = useState("");

  function handleChooseLocal() {
    setDialogStep("local");
  }

  function handleChooseCloud() {
    setCloudName("");
    setDialogStep("cloud");
  }

  async function handleCreateCloud() {
    const name = cloudName.trim();
    if (!name) return;
    setCreatingCloud(true);
    try {
      await api.machines.createCloud({ name });
      toast.success("Cloud sandbox added");
      resetDialog();
      refresh();
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast.error(status === 403 ? "AMA resources are not available for this tenant" : (err as Error).message || "Failed to add cloud sandbox");
    } finally {
      setCreatingCloud(false);
    }
  }

  function resetDialog() {
    setShowDialog(false);
    setDialogStep("choose");
    setCloudName("");
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-content-primary">Machines</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{machines.filter((m) => m.status === "online").length} online</span>
            <button
              onClick={() => setShowDialog(true)}
              className="bg-accent text-[#09090B] font-medium text-xs px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              Add Machine
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 bg-surface-secondary border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : machines.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <p className="text-content-secondary text-sm">No machines registered.</p>
            <p className="text-content-tertiary text-xs">
              Click{" "}
              <button onClick={() => setShowDialog(true)} className="text-accent hover:underline">
                Add Machine
              </button>{" "}
              to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {machines.map((machine) => (
              <Link
                key={machine.id}
                to={`/machines/${machine.id}`}
                className="block bg-surface-secondary border border-border rounded-lg px-5 py-4 hover:border-accent/30 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${statusDotColors[machine.status]}`} />
                    <div>
                      <span className="font-mono text-sm text-content-primary font-medium">{machine.name}</span>
                      {machine.os && <span className="text-[11px] text-content-tertiary ml-2">{machine.os}</span>}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-content-tertiary uppercase tracking-wide">{machine.status}</span>
                </div>

                <div className="mt-3 flex items-center gap-6 text-xs text-content-secondary">
                  <div>
                    <span className="text-content-tertiary">Sessions: </span>
                    <span className="font-mono text-content-primary">{machine.session_count}</span>
                  </div>
                  <div>
                    <span className="text-content-tertiary">Active: </span>
                    <span className="font-mono text-accent">{machine.active_session_count}</span>
                  </div>
                  <div>
                    <span className="text-content-tertiary">Heartbeat: </span>
                    <span className="font-mono text-content-primary">
                      {machine.last_heartbeat_at ? formatRelative(machine.last_heartbeat_at) : "—"}
                    </span>
                  </div>
                  <div className="ml-auto max-w-[45%]">
                    <MachineRuntimeBadges runtimes={machine.runtimes ?? []} maxVisible={3} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Add Machine Dialog */}
      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) resetDialog();
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Add Machine</DialogTitle>
            <DialogDescription className="sr-only">Add a new machine to run agents</DialogDescription>
          </DialogHeader>

          {dialogStep === "choose" && (
            <div className="space-y-2">
              <p className="text-xs text-content-secondary">Where will this machine run?</p>
              <button
                onClick={handleChooseLocal}
                className="w-full flex items-center gap-3 bg-surface-primary border border-border rounded-lg px-4 py-3 hover:border-accent/50 transition-colors text-left"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-content-secondary shrink-0"
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <div>
                  <div className="text-sm font-medium text-content-primary">Your Computer</div>
                  <div className="text-[11px] text-content-tertiary">Run the daemon on this machine</div>
                </div>
              </button>
              <button
                onClick={handleChooseCloud}
                disabled={creatingCloud}
                className="w-full flex items-center gap-3 bg-surface-primary border border-border rounded-lg px-4 py-3 hover:border-accent/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-content-secondary shrink-0"
                >
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
                <div>
                  <div className="text-sm font-medium text-content-primary">Cloud Sandbox</div>
                  <div className="text-[11px] text-content-tertiary">{creatingCloud ? "Creating..." : "Run on an AMA-managed sandbox"}</div>
                </div>
              </button>
            </div>
          )}

          {dialogStep === "cloud" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="cloud-sandbox-name" className="text-xs text-content-secondary">
                  Sandbox name
                </label>
                <Input
                  id="cloud-sandbox-name"
                  autoFocus
                  value={cloudName}
                  onChange={(e) => setCloudName(e.target.value)}
                  placeholder="e.g. my-sandbox"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateCloud();
                  }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialogStep("choose")} disabled={creatingCloud}>
                  Back
                </Button>
                <Button size="sm" onClick={handleCreateCloud} disabled={!cloudName.trim() || creatingCloud}>
                  {creatingCloud ? "Creating..." : "Add sandbox"}
                </Button>
              </div>
            </div>
          )}

          {dialogStep === "local" && (
            <div className="space-y-4">
              <p className="text-xs text-content-secondary">Authenticate this machine through Realmroot, then start the runtime.</p>
              <pre className="overflow-x-auto rounded-md bg-surface-primary p-3 font-mono text-xs text-content-primary">{`npx agent-kanban auth login --api-url ${window.location.origin}\nnpx agent-kanban start`}</pre>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialogStep("choose")}>
                  Back
                </Button>
                <Button size="sm" onClick={resetDialog}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
