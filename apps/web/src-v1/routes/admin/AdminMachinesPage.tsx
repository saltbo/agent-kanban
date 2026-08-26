import type { MachineRuntime } from "@agent-kanban/shared";
import { useEffect, useState } from "react";
import { formatRelative } from "../../components/TaskDetailFields";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

interface MachineMetrics {
  qps: number;
  error_rate: number;
  avg_latency_ms: number;
  total_requests: number;
}

interface AdminMachine {
  id: string;
  name: string;
  status: string;
  os: string;
  version: string;
  runtimes: MachineRuntime[];
  owner_name: string | null;
  owner_email: string | null;
  session_count: number;
  active_session_count: number;
  last_heartbeat_at: string | null;
  metrics: MachineMetrics | null;
}

const statusDotColors: Record<string, string> = {
  online: "bg-success",
  offline: "bg-content-tertiary",
};

function MetricCell({ value, unit, muted }: { value: string; unit?: string; muted?: boolean }) {
  return (
    <span className={`font-mono text-xs ${muted ? "text-content-tertiary" : "text-content-primary"}`}>
      {value}
      {unit && <span className="text-content-tertiary ml-0.5">{unit}</span>}
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i} className="border-b border-border">
          {Array.from({ length: 8 }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <Skeleton className="h-4 w-16" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function AdminMachinesPage() {
  const [machines, setMachines] = useState<AdminMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      api.admin
        .getMachines()
        .then((data) => {
          if (!mounted) return;
          setMachines(data);
          setError(null);
        })
        .catch((err) => mounted && setError(err.message ?? "Failed to load machines"))
        .finally(() => mounted && setLoading(false));
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const onlineCount = machines.filter((m) => m.status === "online").length;

  return (
    <div className="px-8 py-10 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-content-primary tracking-tight">Machines</h1>
        <span className="text-xs font-mono text-content-tertiary">
          {onlineCount} online / {machines.length} total
        </span>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="px-4 py-3 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">Machine</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">Owner</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">Agents</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-content-tertiary uppercase tracking-wider">QPS</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-content-tertiary uppercase tracking-wider">Err %</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-content-tertiary uppercase tracking-wider">Latency</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-content-tertiary uppercase tracking-wider">Reqs (5m)</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows />
            ) : error ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-destructive text-sm">
                  {error}
                </td>
              </tr>
            ) : machines.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-content-tertiary text-sm">
                  No machines registered
                </td>
              </tr>
            ) : (
              machines.map((m) => (
                <tr key={m.id} className="border-b border-border bg-surface-secondary hover:bg-surface-tertiary transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotColors[m.status]}`} />
                      <div>
                        <p className="font-mono text-sm text-content-primary font-medium leading-tight">{m.name}</p>
                        <p className="text-[11px] text-content-tertiary leading-tight">{[m.os, m.version].filter(Boolean).join(" · ") || "—"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm text-content-primary leading-tight">{m.owner_name || "—"}</p>
                      <p className="font-mono text-[11px] text-content-tertiary leading-tight">{m.owner_email || ""}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-accent">{m.active_session_count}</span>
                    <span className="text-content-tertiary text-xs"> / {m.session_count}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MetricCell value={m.metrics?.qps?.toFixed(1) ?? "—"} muted={!m.metrics} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.metrics ? (
                      <span
                        className={`font-mono text-xs ${m.metrics.error_rate > 5 ? "text-destructive" : m.metrics.error_rate > 0 ? "text-warning" : "text-content-primary"}`}
                      >
                        {m.metrics.error_rate}%
                      </span>
                    ) : (
                      <MetricCell value="—" muted />
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MetricCell value={m.metrics ? `${m.metrics.avg_latency_ms}` : "—"} unit={m.metrics ? "ms" : undefined} muted={!m.metrics} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MetricCell value={m.metrics?.total_requests?.toLocaleString() ?? "—"} muted={!m.metrics} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-content-tertiary">{m.last_heartbeat_at ? formatRelative(m.last_heartbeat_at) : "—"}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
