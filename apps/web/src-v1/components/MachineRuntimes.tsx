import { type MachineRuntime, RUNTIME_LABELS, type UsageWindow } from "@agent-kanban/shared";
import dayjs from "dayjs";
import { cn } from "../lib/utils";

const runtimeStatusStyles: Record<MachineRuntime["status"], { dot: string; label: string }> = {
  ready: {
    dot: "bg-success",
    label: "Ready",
  },
  limited: {
    dot: "bg-warning",
    label: "Limited",
  },
  unauthorized: {
    dot: "bg-error",
    label: "Unauthorized",
  },
  unhealthy: {
    dot: "bg-error",
    label: "Unhealthy",
  },
  missing: {
    dot: "bg-content-tertiary",
    label: "Missing",
  },
};

const RUNTIME_SHORT_LABELS: Record<MachineRuntime["name"], string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  copilot: "Copilot",
  hermes: "Hermes",
  ama: "AMA",
};

const runtimeBadgeStyles: Record<MachineRuntime["status"], string> = {
  ready: "text-content-secondary",
  limited: "bg-warning/10 text-warning",
  unauthorized: "bg-error/10 text-error",
  unhealthy: "bg-error/10 text-error",
  missing: "text-content-tertiary",
};

function RuntimeStatus({ runtime }: { runtime: MachineRuntime }) {
  const style = runtimeStatusStyles[runtime.status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-content-secondary">
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
}

function runtimeTooltip(runtime: MachineRuntime): string {
  const status = runtimeStatusStyles[runtime.status].label;
  const label = RUNTIME_LABELS[runtime.name] ?? runtime.name;
  return runtime.detail ? `${label} · ${status} · ${runtime.detail}` : `${label} · ${status}`;
}

function usageBarColor(pct: number): string {
  if (pct >= 75) return "bg-error";
  if (pct >= 40) return "bg-warning";
  return "bg-success";
}

function usagePercent(window: UsageWindow): number {
  return Math.round(window.utilization < 1 ? window.utilization * 100 : window.utilization);
}

function formatResetTime(resetsAt: string): string {
  return dayjs(resetsAt).format("MMM D, YYYY h:mm A");
}

function isPendingReset(window: UsageWindow): boolean {
  return new Date(window.resets_at).getTime() > Date.now();
}

export function MachineRuntimeBadges({ runtimes, maxVisible = runtimes.length }: { runtimes: MachineRuntime[]; maxVisible?: number }) {
  if (runtimes.length === 0) {
    return <span className="text-[10px] font-mono text-content-tertiary">No runtimes</span>;
  }

  const visible = runtimes.slice(0, maxVisible);
  const hiddenCount = runtimes.length - visible.length;

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {visible.map((runtime) => (
        <span
          key={runtime.name}
          title={runtimeTooltip(runtime)}
          className={cn("inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]", runtimeBadgeStyles[runtime.status])}
        >
          <span>{RUNTIME_SHORT_LABELS[runtime.name] ?? runtime.name}</span>
          <span className={cn("size-1.5 rounded-full", runtimeStatusStyles[runtime.status].dot)} />
        </span>
      ))}
      {hiddenCount > 0 && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary">+{hiddenCount}</span>
      )}
    </div>
  );
}

export function MachineRuntimeList({ runtimes }: { runtimes: MachineRuntime[] }) {
  if (runtimes.length === 0) {
    return <span className="text-[11px] font-mono text-content-tertiary">No runtimes detected</span>;
  }

  return (
    <div className="divide-y divide-border">
      {runtimes.map((runtime) => (
        <div key={runtime.name} className="grid gap-2 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="min-w-0">
            <div className="font-mono text-xs text-content-primary">{RUNTIME_LABELS[runtime.name] ?? runtime.name}</div>
            {runtime.detail && <div className="mt-0.5 truncate text-[11px] text-content-tertiary">{runtime.detail}</div>}
          </div>
          <RuntimeStatus runtime={runtime} />
        </div>
      ))}
    </div>
  );
}

function RuntimeUsageWindows({ windows }: { windows: UsageWindow[] }) {
  return (
    <div className="space-y-2">
      {windows.map((window) => {
        const pct = usagePercent(window);
        return (
          <div key={`${window.runtime}-${window.label}-${window.resets_at}`} className="grid gap-2 sm:grid-cols-[96px_1fr_auto] sm:items-center">
            <span className="text-[11px] text-content-tertiary">{window.label}</span>
            <div className="h-1 overflow-hidden rounded-full bg-surface-tertiary">
              <div className={cn("h-full rounded-full transition-all", usageBarColor(pct))} style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            <div className="flex shrink-0 items-center justify-between gap-1.5 sm:justify-end">
              <span className="font-mono text-[11px] text-content-primary">{pct}%</span>
              <span className="text-content-tertiary">·</span>
              <span className="text-[11px] text-content-tertiary">{formatResetTime(window.resets_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MachineRuntimeAvailability({ runtimes, windows }: { runtimes: MachineRuntime[]; windows: UsageWindow[] }) {
  if (runtimes.length === 0) {
    return <span className="text-[11px] font-mono text-content-tertiary">No runtimes detected</span>;
  }

  const activeWindows = windows.filter(isPendingReset);

  return (
    <div className="divide-y divide-border">
      {runtimes.map((runtime) => {
        const runtimeWindows = activeWindows.filter((window) => window.runtime === runtime.name);
        return (
          <div key={runtime.name} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <div className="font-mono text-xs text-content-primary">{RUNTIME_LABELS[runtime.name] ?? runtime.name}</div>
                {runtime.detail && <div className="truncate text-[11px] text-content-tertiary">{runtime.detail}</div>}
              </div>
              <RuntimeStatus runtime={runtime} />
            </div>
            {runtimeWindows.length > 0 && (
              <div className="mt-2">
                <RuntimeUsageWindows windows={runtimeWindows} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
