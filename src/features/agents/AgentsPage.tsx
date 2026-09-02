import { AGENCY_RUNTIMES } from "@shared";
import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentList } from "@/features/agents/AgentProjectionPages";
import { useAgents } from "@/features/agents/useAgents";
import { Header } from "@/features/boards/components/Header";

const RUNTIME_LABELS: Record<(typeof AGENCY_RUNTIMES)[number], string> = {
  ama: "AMA",
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
};

export function AgentsPage() {
  const [search, setSearch] = useState("");
  const [runtime, setRuntime] = useState("all");
  const [availability, setAvailability] = useState("all");
  const filters = {
    search: search.trim() || undefined,
    runtime: runtime === "all" ? undefined : runtime,
    schedulable: availability === "all" ? undefined : availability === "schedulable",
  };
  const { data = [], isLoading, error } = useAgents(filters);
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-bold text-content-primary">Agents</h1>
            <p className="mt-1 text-sm text-content-tertiary">Agents available for assignment.</p>
          </div>
          <span className="font-mono text-xs text-content-tertiary">{data.length} total</span>
        </div>
        <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface-secondary p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-content-tertiary" />
            <Input
              aria-label="Search Agents"
              className="pl-8"
              placeholder="Search name or username"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={runtime} onValueChange={(value) => setRuntime(value ?? "all")}>
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
          <Select value={availability} onValueChange={(value) => setAvailability(value ?? "all")}>
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
          <p className="text-sm text-error">{error.message}</p>
        ) : isLoading ? (
          <div className="h-32 animate-pulse rounded-lg border border-border bg-surface-secondary" />
        ) : (
          <AgentList agents={data} />
        )}
      </main>
    </div>
  );
}
