import { ChevronLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Header } from "@/features/boards/components/Header";
import { useMachine } from "@/features/machines/useMachines";

export function MachineDetailPage() {
  const { machineId } = useParams<{ machineId: string }>();
  const { data, isLoading, error } = useMachine(machineId);
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-4xl space-y-6 p-8">
        <Link to="/machines" className="inline-flex items-center gap-1 text-xs text-content-tertiary hover:text-accent">
          <ChevronLeft className="size-3.5" />
          Machines
        </Link>
        {error ? (
          <p className="text-sm text-error">{error.message}</p>
        ) : isLoading || !data ? (
          <div className="h-40 animate-pulse rounded-lg border border-border bg-surface-secondary" />
        ) : (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-xl font-bold text-content-primary">{data.name}</h1>
                <p className="mt-1 font-mono text-xs text-content-tertiary">{data.id}</p>
              </div>
              <Badge variant="outline" className={data.status === "online" ? "border-success/30 text-success" : "text-content-tertiary"}>
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
                <CardTitle>Runtime inventory</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.runtimes.length === 0 ? (
                  <p className="text-sm text-content-tertiary">No runtimes reported yet.</p>
                ) : (
                  data.runtimes.map((runtime) => (
                    <div
                      key={runtime.runtime}
                      className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-0 last:pb-0"
                    >
                      <div>
                        <div className="font-mono text-sm text-content-primary">{runtime.runtime}</div>
                        <div className="mt-1 text-xs text-content-tertiary">{runtime.models.join(", ") || "No models"}</div>
                      </div>
                      <Badge variant="outline">{runtime.state}</Badge>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-content-tertiary">{label}</div>
      <div className="mt-1 font-mono text-lg text-content-primary">{value}</div>
    </div>
  );
}
