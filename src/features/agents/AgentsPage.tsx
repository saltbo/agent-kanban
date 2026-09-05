import { AGENCY_RUNTIMES } from "@shared";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DEFAULT_PAGE_SIZE, ResourcePagination } from "@/components/resource-pagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentList } from "@/features/agents/AgentProjectionPages";
import { useAgents } from "@/features/agents/useAgents";
import { Header } from "@/features/boards/components/Header";

const RUNTIME_LABELS: Record<(typeof AGENCY_RUNTIMES)[number], string> = {
  enbor: "Enbor",
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
};

export function AgentsPage() {
  const [search, setSearch] = useState("");
  const [runtime, setRuntime] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageTokens, setPageTokens] = useState<(string | undefined)[]>([undefined]);
  function resetPage() {
    setPageIndex(0);
    setPageTokens([undefined]);
  }
  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      runtime: runtime === "all" ? undefined : runtime,
      schedulable: availability === "all" ? undefined : availability === "schedulable",
      pageSize,
      pageToken: pageTokens[pageIndex],
    }),
    [availability, pageIndex, pageSize, pageTokens, runtime, search],
  );
  const { data, isFetching, isLoading, error, refetch } = useAgents(filters);
  const agents = data?.items ?? [];
  const nextPageToken = data?.pagination.nextPageToken ?? undefined;
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-bold text-content-primary">Agents</h1>
            <p className="mt-1 text-sm text-content-tertiary">Agents available for assignment.</p>
          </div>
          <span className="font-mono text-xs text-content-tertiary">{agents.length} on page</span>
        </div>
        <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface-secondary p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-content-tertiary" />
            <Input
              aria-label="Search Agents"
              className="pl-8"
              placeholder="Search name or username"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
            />
          </div>
          <Select
            value={runtime}
            onValueChange={(value) => {
              setRuntime(value ?? "all");
              resetPage();
            }}
          >
            <SelectTrigger aria-label="Runtime" className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All runtimes</SelectItem>
              {AGENCY_RUNTIMES.map((value) => (
                <SelectItem key={value} value={value}>
                  {RUNTIME_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={availability}
            onValueChange={(value) => {
              setAvailability(value ?? "all");
              resetPage();
            }}
          >
            <SelectTrigger aria-label="Availability" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              <SelectItem value="schedulable">Schedulable</SelectItem>
              <SelectItem value="unavailable">Unavailable</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {error ? (
          <div className="space-y-3">
            <p className="text-sm text-error">{error.message}</p>
            <ResourcePagination
              pageNumber={pageIndex + 1}
              pageSize={pageSize}
              hasNextPage={Boolean(nextPageToken)}
              isFetching={isFetching}
              onPreviousPage={() => setPageIndex((value) => Math.max(0, value - 1))}
              onNextPage={() => {
                if (!nextPageToken) return;
                setPageTokens((tokens) => [...tokens.slice(0, pageIndex + 1), nextPageToken]);
                setPageIndex((value) => value + 1);
              }}
              onPageSizeChange={(value) => {
                setPageSize(value);
                resetPage();
              }}
              onRetry={() => void refetch()}
            />
          </div>
        ) : isLoading ? (
          <div className="h-32 animate-pulse rounded-lg border border-border bg-surface-secondary" />
        ) : (
          <>
            <AgentList agents={agents} />
            <ResourcePagination
              pageNumber={pageIndex + 1}
              pageSize={pageSize}
              hasNextPage={Boolean(nextPageToken)}
              isFetching={isFetching}
              onPreviousPage={() => setPageIndex((value) => Math.max(0, value - 1))}
              onNextPage={() => {
                if (!nextPageToken) return;
                setPageTokens((tokens) => [...tokens.slice(0, pageIndex + 1), nextPageToken]);
                setPageIndex((value) => value + 1);
              }}
              onPageSizeChange={(value) => {
                setPageSize(value);
                resetPage();
              }}
            />
          </>
        )}
      </main>
    </div>
  );
}
