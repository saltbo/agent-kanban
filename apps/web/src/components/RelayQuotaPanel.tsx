/**
 * Agents → 配额 tab — CC-Switch-style quota cards for the owner's configured
 * Kimi/DeepSeek relays. Each card live-probes its relay through the server
 * (GET /api/relays/:id/usage), auto-refreshing every 60s, with a manual
 * refresh button and per-card config/delete actions.
 */
import type { RelayEndpointConfig, RelayUsageResponse } from "@agent-kanban/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { RelayEndpointDialog } from "./RelayEndpointDialog";
import { formatResetCountdown, isPendingReset, UsageWindowsList } from "./UsageBars";
import { Button } from "./ui/button";

const USAGE_REFETCH_INTERVAL_MS = 60_000;

/** "updated 12s ago"-style relative time without pulling in a dayjs plugin. */
function updatedAgo(fetchedAt: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(fetchedAt).getTime()) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

export function RelayQuotaPanel() {
  const { data: relays = [], isLoading } = useQuery({ queryKey: ["relays"], queryFn: () => api.relays.list() });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RelayEndpointConfig | undefined>(undefined);

  function openCreate() {
    setEditing(undefined);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-content-tertiary">
          Live quota for Claude Code relay endpoints (Kimi / DeepSeek). Probes run server-side; tokens never leave it.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3.5" />
          Add relay
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-lg border border-border bg-surface-secondary" />
          ))}
        </div>
      ) : relays.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-sm text-content-tertiary">No relay endpoints configured.</p>
          <button type="button" onClick={openCreate} className="mt-2 inline-block text-sm text-accent hover:underline">
            Add your first relay
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {relays.map((relay) => (
            <RelayQuotaCard
              key={relay.id}
              endpoint={relay}
              onEdit={() => {
                setEditing(relay);
                setDialogOpen(true);
              }}
            />
          ))}
        </div>
      )}

      <RelayEndpointDialog open={dialogOpen} onOpenChange={setDialogOpen} endpoint={editing} />
    </div>
  );
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function RelayQuotaCard({ endpoint, onEdit }: { endpoint: RelayEndpointConfig; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const usageQuery = useQuery({
    queryKey: ["relays", endpoint.id, "usage"],
    queryFn: () => api.relays.usage(endpoint.id),
    refetchInterval: USAGE_REFETCH_INTERVAL_MS,
    retry: false,
  });
  const usage = usageQuery.data;

  async function remove() {
    setDeleting(true);
    try {
      await api.relays.delete(endpoint.id);
      await queryClient.invalidateQueries({ queryKey: ["relays"] });
      toast.success(`Deleted relay "${endpoint.name}"`);
    } catch (err) {
      toast.error((err as Error).message);
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface-secondary">
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-content-primary">{endpoint.name}</h3>
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-content-secondary">{endpoint.kind}</span>
          </div>
          <p className="truncate font-mono text-[10px] text-content-tertiary">{hostOf(endpoint.base_url)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={`Refresh ${endpoint.name} quota`}
            onClick={() => void usageQuery.refetch()}
            className="rounded p-1.5 text-content-tertiary hover:text-content-primary"
          >
            <RefreshCw className={cn("size-3.5", usageQuery.isFetching && "animate-spin")} />
          </button>
          <button
            type="button"
            aria-label={`Configure ${endpoint.name}`}
            onClick={onEdit}
            className="rounded p-1.5 text-content-tertiary hover:text-content-primary"
          >
            <Settings2 className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${endpoint.name}`}
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1.5 text-content-tertiary hover:text-error"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2.5 px-4 py-3">
        {confirmingDelete ? (
          <div className="space-y-2 rounded-md border border-error/40 bg-error/10 px-3 py-2.5">
            <p className="text-[11px] text-content-primary">Delete this relay? Its stored token is removed.</p>
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Keep
              </Button>
              <Button size="xs" onClick={() => void remove()} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        ) : usageQuery.isError ? (
          <ErrorBanner tone="warning" message={(usageQuery.error as Error).message} />
        ) : !usage ? (
          <div className="space-y-2">
            <div className="h-3 animate-pulse rounded bg-surface-tertiary" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-tertiary" />
          </div>
        ) : (
          <CardBody endpoint={endpoint} usage={usage} />
        )}
      </div>

      <div className="border-t border-border/60 px-4 py-2 font-mono text-[10px] text-content-tertiary">
        {usage ? updatedAgo(usage.fetched_at) : "probing…"}
      </div>
    </article>
  );
}

function CardBody({ endpoint, usage }: { endpoint: RelayEndpointConfig; usage: RelayUsageResponse }) {
  if (!usage.ok) {
    return (
      <ErrorBanner
        tone={usage.error?.kind === "unauthorized" ? "error" : "warning"}
        message={usage.error?.kind === "unauthorized" ? "Session expired — update the token" : (usage.error?.message ?? "Probe failed")}
      />
    );
  }

  const activeWindows = usage.windows.filter(isPendingReset);
  return (
    <>
      {endpoint.kind === "deepseek" && (
        <div className="space-y-1">
          {usage.balance && (
            <p className={cn("font-mono text-xs", usage.balance.available ? "text-content-primary" : "text-error")}>
              {usage.balance.currency === "CNY" ? "¥" : `${usage.balance.currency} `}
              {usage.balance.total.toFixed(2)} remaining
            </p>
          )}
          {usage.peak &&
            (usage.peak.active ? (
              <p className="text-[11px] text-warning">
                Peak pricing{usage.peak.ends_at ? ` until ${dayjs(usage.peak.ends_at).format("HH:mm")}` : ""}
              </p>
            ) : (
              <p className="text-[11px] text-success">Off-peak</p>
            ))}
        </div>
      )}
      {activeWindows.length > 0 ? (
        <div className="space-y-1.5">
          <UsageWindowsList windows={activeWindows} />
          <p className="font-mono text-[10px] text-content-tertiary">{formatResetCountdown(activeWindows.map((w) => w.resets_at).sort()[0])}</p>
        </div>
      ) : (
        endpoint.kind === "kimi" && <p className="text-[11px] text-content-tertiary">No quota limits in effect.</p>
      )}
    </>
  );
}

function ErrorBanner({ tone, message }: { tone: "warning" | "error"; message: string }) {
  return (
    <p className={cn("rounded-md px-3 py-2 text-[11px]", tone === "error" ? "bg-error/10 text-error" : "bg-warning/10 text-warning")}>{message}</p>
  );
}
