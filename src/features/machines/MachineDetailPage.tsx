import dayjs from "dayjs";
import { ChevronLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/features/boards/components/Header";
import { type MachineRunnerProjection, type MachineRuntimeUsageWindow, useMachine } from "@/features/machines/useMachines";
import { cn } from "@/lib/utils";

export function MachineDetailPage() {
  const { machineId } = useParams<{ machineId: string }>();
  const { data, isLoading, error } = useMachine(machineId);
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8">
        <Link to="/machines" className="inline-flex items-center gap-1 text-xs text-content-tertiary hover:text-accent">
          <ChevronLeft aria-hidden="true" className="size-3.5" />
          Machines
        </Link>
        {error ? (
          <p className="text-sm text-error">{error.message}</p>
        ) : isLoading || !data ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold text-content-primary">{data.name}</h1>
                <p className="mt-1 font-mono text-xs text-content-tertiary">{data.id}</p>
              </div>
              <Badge variant="outline" className={cn(data.status === "online" ? "border-success/30 text-success" : "text-content-tertiary")}>
                {data.status}
              </Badge>
            </div>
            <Card className="rounded-lg border-border bg-surface-secondary">
              <CardHeader>
                <CardTitle>Capacity</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <Metric label="Current load" value={String(data.currentLoad)} />
                <Metric label="Maximum" value={String(data.maxLoad)} />
                <Metric label="Runners" value={String(data.runnerCount)} />
              </CardContent>
            </Card>
            <Card className="rounded-lg border-border bg-surface-secondary">
              <CardHeader>
                <CardTitle>Runners</CardTitle>
                <CardDescription>Runtime availability and usage are reported independently by each Runner.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.runners.length === 0 ? (
                  <p className="text-sm text-content-tertiary">No Runners reported yet.</p>
                ) : (
                  <div className="flex flex-col gap-5">
                    {data.runners.map((runner, index) => (
                      <div key={runner.id} className="flex flex-col gap-5">
                        {index > 0 && <Separator />}
                        <RunnerSection runner={runner} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function RunnerSection({ runner }: { runner: MachineRunnerProjection }) {
  const usageByRuntime = new Map(runner.runtimeUsage.map((usage) => [usage.runtime, usage.windows]));
  const runtimeByName = new Map(runner.runtimes.map((runtime) => [runtime.runtime, runtime]));
  const runtimeNames = [...new Set([...runtimeByName.keys(), ...usageByRuntime.keys()])];
  const headingId = `runner-${runner.id}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h2 id={headingId} className="truncate font-mono text-sm font-medium text-content-primary">
            {runner.name}
          </h2>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-content-tertiary">
            <span className="break-all">{runner.id}</span>
            <span>
              Load {runner.currentLoad}/{runner.maxLoad}
            </span>
            {runner.lastHeartbeatAt && (
              <time dateTime={runner.lastHeartbeatAt} title={dayjs(runner.lastHeartbeatAt).format("YYYY-MM-DD HH:mm:ss Z")}>
                Heartbeat {dayjs(runner.lastHeartbeatAt).format("MMM D, HH:mm")}
              </time>
            )}
          </div>
        </div>
        <Badge variant="outline">{runner.status}</Badge>
      </div>

      {runtimeNames.length === 0 ? (
        <p className="text-sm text-content-tertiary">No runtimes reported by this Runner.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {runtimeNames.map((runtimeName) => {
            const runtime = runtimeByName.get(runtimeName);
            return (
              <div key={runtimeName} className="rounded-md bg-surface-tertiary p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-mono text-sm text-content-primary">{runtimeName}</h3>
                    <p className="mt-1 truncate text-xs text-content-tertiary">
                      {runtime ? runtime.models.join(", ") || runtime.detail || "No models" : "Runtime inventory not reported"}
                    </p>
                  </div>
                  {runtime && <Badge variant="outline">{runtime.state}</Badge>}
                </div>
                <RuntimeUsage windows={usageByRuntime.get(runtimeName) ?? []} runtime={runtimeName} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RuntimeUsage({ runtime, windows }: { runtime: string; windows: MachineRuntimeUsageWindow[] }) {
  if (windows.length === 0) {
    return <p className="mt-3 text-xs text-content-tertiary">Usage not reported.</p>;
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {windows.map((window) => {
        const used = clampPercent(window.utilization);
        const remaining = 100 - used;
        return (
          <div key={`${window.label}-${window.resetsAt}`} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
              <span className="text-content-secondary">{window.label}</span>
              <span className="font-mono text-content-primary">
                {formatPercent(used)} used · {formatPercent(remaining)} remaining
              </span>
            </div>
            <div
              aria-label={`${runtime} ${window.label} usage`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={used}
              className="h-1.5 overflow-hidden rounded-full bg-surface-secondary"
              role="progressbar"
            >
              <div className="h-full rounded-full bg-accent" style={{ width: `${used}%` }} />
            </div>
            <time className="text-[11px] text-content-tertiary" dateTime={window.resetsAt}>
              Resets {dayjs(window.resetsAt).format("MMM D, YYYY HH:mm")}
            </time>
          </div>
        );
      })}
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-content-tertiary">{label}</div>
      <div className="mt-1 font-mono text-lg text-content-primary">{value}</div>
    </div>
  );
}
