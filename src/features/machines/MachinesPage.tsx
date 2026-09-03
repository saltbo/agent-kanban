import { Cloud, Cpu, Monitor, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Header } from "@/features/boards/components/Header";
import { MachineRunnerSetup } from "@/features/machines/MachineRunnerSetup";
import { type MachineCreateResult, type MachineProjection, useCreateMachine, useDeleteMachine, useMachines } from "@/features/machines/useMachines";

export function MachinesPage() {
  const { data = [], isLoading, error, refetch } = useMachines();
  const create = useCreateMachine();
  const remove = useDeleteMachine();
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState<MachineCreateResult | null>(null);
  const [deleting, setDeleting] = useState<MachineProjection | null>(null);
  const [tracking, setTracking] = useState<{ machineId: string; deadline: number } | null>(null);
  const [trackingTimedOut, setTrackingTimedOut] = useState<string | null>(null);
  const createAttempt = useRef<{ key: string } | null>(null);

  useEffect(() => {
    if (!tracking) return;
    if (data.some((machine) => machine.id === tracking.machineId && machine.status === "online")) {
      setTracking(null);
      setTrackingTimedOut(null);
      return;
    }
    const remaining = tracking.deadline - Date.now();
    if (remaining <= 0) {
      setTrackingTimedOut(tracking.machineId);
      setTracking(null);
      return;
    }
    const interval = window.setInterval(() => void refetch(), 2_000);
    const timeout = window.setTimeout(() => {
      setTrackingTimedOut(tracking.machineId);
      setTracking(null);
    }, remaining);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [data, refetch, tracking]);

  async function addMachine() {
    createAttempt.current ??= { key: crypto.randomUUID() };
    try {
      const result = await create.mutateAsync({ idempotencyKey: createAttempt.current.key });
      createAttempt.current = null;
      setAdding(false);
      setSetup(result);
      setTrackingTimedOut(null);
      setTracking({ machineId: result.machine.id, deadline: Date.now() + 30_000 });
    } catch {
      // The mutation exposes the actionable API error in the dialog.
    }
  }

  function setAddDialogOpen(open: boolean) {
    setAdding(open);
    if (!open) {
      createAttempt.current = null;
      create.reset();
    }
  }

  async function deleteMachine() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch {
      // The mutation exposes the actionable API error in the dialog.
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-content-primary">Machines</h1>
            <p className="mt-1 text-sm text-content-tertiary">Computers available to run agent work.</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              create.reset();
              setAdding(true);
            }}
          >
            <Plus className="size-3.5" />
            Add Machine
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-error">{error.message}</p>
        ) : isLoading ? (
          <div className="h-32 animate-pulse rounded-lg border border-border bg-surface-secondary" />
        ) : data.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-content-tertiary">No Machines registered.</div>
        ) : (
          <div className="space-y-3">
            {data.map((machine) => (
              <div key={machine.id} className="flex items-center gap-4 rounded-lg border border-border bg-surface-secondary px-5 py-4">
                <div className="grid size-9 place-items-center rounded-md border border-border bg-surface-primary text-accent">
                  <Cpu className="size-4" />
                </div>
                <Link to={`/machines/${encodeURIComponent(machine.id)}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-content-primary">{machine.name}</span>
                    <Status value={machine.status} />
                  </div>
                  <div className="mt-1 text-xs text-content-tertiary">
                    {machine.runnerCount} runner{machine.runnerCount === 1 ? "" : "s"} · {machine.currentLoad}/{machine.maxLoad} active
                  </div>
                </Link>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${machine.name}`} onClick={() => setDeleting(machine)}>
                  <Trash2 className="size-3.5 text-content-tertiary" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </main>

      <Dialog open={adding} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Machine</DialogTitle>
            <DialogDescription>Where will this machine run?</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Button
              variant="outline"
              className="h-auto min-h-20 justify-start whitespace-normal p-4 text-left"
              disabled={create.isPending}
              onClick={addMachine}
            >
              <Monitor data-icon="inline-start" />
              <span className="flex flex-col items-start gap-1">
                <span>{create.isPending ? "Creating…" : "Your Computer"}</span>
                <span className="font-normal text-muted-foreground">Run AMA Runner on this computer</span>
              </span>
            </Button>
            <Button variant="outline" className="h-auto min-h-20 justify-start whitespace-normal p-4 text-left" disabled>
              <Cloud data-icon="inline-start" />
              <span className="flex flex-1 flex-col items-start gap-1">
                <span className="flex w-full items-center justify-between gap-3">
                  Cloud Sandbox
                  <Badge variant="secondary">Coming soon</Badge>
                </span>
                <span className="font-normal text-muted-foreground">Run in a managed cloud sandbox</span>
              </span>
            </Button>
            {create.error && (
              <p role="alert" className="text-sm text-error">
                {create.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(setup)} onOpenChange={(open) => !open && setSetup(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start AMA Runner</DialogTitle>
            <DialogDescription>Run these commands on the machine. Project and Environment are already selected.</DialogDescription>
          </DialogHeader>
          {setup && (
            <div className="flex flex-col gap-3">
              <MachineRunnerSetup authCommand={setup.authCommand} startCommand={setup.startCommand} />
              {tracking?.machineId === setup.machine.id && (
                <p className="text-xs text-content-tertiary">Waiting up to 30 seconds for this Machine to report online…</p>
              )}
              {trackingTimedOut === setup.machine.id && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-primary p-3">
                  <p className="text-xs leading-5 text-content-tertiary">Still offline. Check AMA Runner output, then try another status check.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTrackingTimedOut(null);
                      setTracking({ machineId: setup.machine.id, deadline: Date.now() + 30_000 });
                      void refetch();
                    }}
                  >
                    Check again
                  </Button>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSetup(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive Machine</DialogTitle>
            <DialogDescription>
              Archive <span className="font-mono text-content-primary">{deleting?.name}</span>. Its Runner stops receiving work; local Runner files
              remain until you remove them on that machine. Current capacity is {deleting?.currentLoad}/{deleting?.maxLoad} active.
            </DialogDescription>
            {remove.error && (
              <p role="alert" className="mt-3 text-sm text-error">
                {remove.error.message}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={deleteMachine}>
              {remove.isPending ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Status({ value }: { value: MachineProjection["status"] }) {
  return (
    <Badge variant="outline" className={value === "online" ? "border-success/30 text-success" : "text-content-tertiary"}>
      {value}
    </Badge>
  );
}
