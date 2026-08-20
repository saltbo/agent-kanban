/**
 * Shared usage-window rendering — extracted from MachineRuntimes so the
 * Agents → 配额 relay cards and the machine availability views render quota
 * bars with identical thresholds and styling.
 */
import type { UsageWindow } from "@agent-kanban/shared";
import dayjs from "dayjs";
import { cn } from "../lib/utils";

export function usageBarColor(pct: number): string {
  if (pct >= 75) return "bg-error";
  if (pct >= 40) return "bg-warning";
  return "bg-success";
}

export function usagePercent(window: UsageWindow): number {
  return Math.round(window.utilization < 1 ? window.utilization * 100 : window.utilization);
}

export function formatResetTime(resetsAt: string): string {
  return dayjs(resetsAt).format("MMM D, YYYY h:mm A");
}

/** Compact countdown for the quota cards, e.g. "resets in 4h 23m" / "reset due". */
export function formatResetCountdown(resetsAt: string, now: number = Date.now()): string {
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return "reset due";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export function isPendingReset(window: UsageWindow): boolean {
  return new Date(window.resets_at).getTime() > Date.now();
}

export function UsageWindowsList({ windows }: { windows: UsageWindow[] }) {
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
