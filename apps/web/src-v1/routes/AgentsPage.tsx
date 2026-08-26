import { type AgentRuntime, type AgentWithActivity, type AnyAgentRuntime, RUNTIME_LABELS, type Subagent } from "@agent-kanban/shared";
import { Bot, Cloud, Code2, Github, type LucideIcon, Sparkles, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useAgents, useSubagents } from "../hooks/useAgents";
import { agentColor, agentColorRgb, agentFingerprint } from "../lib/agentIdentity";
import { cn } from "../lib/utils";

const runtimeMeta: Partial<Record<AnyAgentRuntime, { icon: LucideIcon; tone: string }>> = {
  claude: { icon: Bot, tone: "text-content-secondary" },
  codex: { icon: Terminal, tone: "text-accent" },
  gemini: { icon: Sparkles, tone: "text-warning" },
  copilot: { icon: Github, tone: "text-success" },
  hermes: { icon: Code2, tone: "text-content-tertiary" },
  ama: { icon: Cloud, tone: "text-accent" },
};

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(microUsd: number): string {
  if (!microUsd) return "$0.00";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

export function AgentsPage() {
  const { agents, loading: agentsLoading } = useAgents();
  const { subagents, loading: subagentsLoading } = useSubagents();
  const latestAgents = (agents as AgentWithActivity[]).filter((agent) => agent.version === "latest");
  const workers = latestAgents.filter((agent) => agent.kind === "worker");
  const schedulable = workers.filter((agent) => agent.status.schedulable).length;

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-8 sm:py-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-content-primary">Agents</h1>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-content-tertiary">
              <span>
                {schedulable}/{workers.length} workers schedulable
              </span>
              <span>{subagents.length} sub-agents</span>
            </div>
          </div>
          <Link
            to="/agents/new"
            className="inline-flex h-8 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90"
          >
            New agent
          </Link>
        </div>

        <Tabs defaultValue="agents" className="gap-5">
          <TabsList variant="line" aria-label="Agent lists" className="border-b border-border">
            <TabsTrigger value="agents" className="px-3 font-mono text-xs">
              Agents
              <span className="text-content-tertiary">{latestAgents.length}</span>
            </TabsTrigger>
            <TabsTrigger value="subagents" className="px-3 font-mono text-xs">
              Sub-agents
              <span className="text-content-tertiary">{subagents.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="agents">
            {agentsLoading ? (
              <AgentGridSkeleton />
            ) : latestAgents.length === 0 ? (
              <EmptyState label="No latest agents yet." action="Create your first agent" href="/agents/new" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {latestAgents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="subagents">
            {subagentsLoading ? (
              <AgentGridSkeleton />
            ) : subagents.length === 0 ? (
              <EmptyState label="No sub-agents registered." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(subagents as Subagent[]).map((subagent) => (
                  <SubagentCard key={subagent.id} subagent={subagent} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function AgentGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-56 animate-pulse rounded-lg border border-border bg-surface-secondary" />
      ))}
    </div>
  );
}

function EmptyState({ label, action, href }: { label: string; action?: string; href?: string }) {
  return (
    <div className="py-20 text-center">
      <p className="text-sm text-content-tertiary">{label}</p>
      {action && href && (
        <Link to={href} className="mt-2 inline-block text-sm text-accent hover:underline">
          {action}
        </Link>
      )}
    </div>
  );
}

function RuntimeMeta({ runtime, model, available }: { runtime: AnyAgentRuntime; model: string | null; available?: boolean }) {
  const meta = runtimeMeta[runtime] ?? { icon: Terminal, tone: "text-content-tertiary" };
  const Icon = meta.icon;

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-2.5 py-1 font-mono text-[10px] text-content-tertiary">
      <Icon className={cn("size-3 shrink-0", meta.tone)} />
      <span className="shrink-0 text-content-primary">{RUNTIME_LABELS[runtime]}</span>
      <span className="text-content-tertiary/70">·</span>
      <span className="truncate">{model || "default"}</span>
      {available !== undefined && (
        <span
          title={available ? "Schedulable" : "Not schedulable"}
          className={cn("ml-0.5 size-1.5 shrink-0 rounded-full", available ? "bg-success" : "bg-warning")}
        />
      )}
    </span>
  );
}

function RuntimeChip({ runtime, model }: { runtime: AnyAgentRuntime; model: string }) {
  const meta = runtimeMeta[runtime] ?? { icon: Terminal, tone: "text-content-tertiary" };
  const Icon = meta.icon;

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-primary/70 px-2 py-0.5 font-mono text-[10px] text-content-tertiary">
      <Icon className={cn("size-3 shrink-0", meta.tone)} />
      <span className="shrink-0 text-content-secondary">{RUNTIME_LABELS[runtime]}</span>
      <span className="truncate">{model}</span>
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentWithActivity }) {
  const isLeader = agent.kind === "leader";
  const schedulable = agent.status.schedulable;
  const tasks = agent.status.tasks;
  const color = agent.public_key ? agentColor(agent.public_key) : "#22D3EE";
  const rgb = agent.public_key ? agentColorRgb(agent.public_key) : "34, 211, 238";
  const fp = agent.fingerprint ? agentFingerprint(agent.fingerprint) : "";
  const tokenCount = (agent.input_tokens || 0) + (agent.output_tokens || 0);

  return (
    <Link
      to={`/agents/${agent.id}`}
      className="group relative block overflow-hidden rounded-lg border border-border bg-surface-secondary transition-all hover:-translate-y-px hover:border-accent/35"
      style={{
        boxShadow: schedulable ? `0 4px 20px rgba(${rgb}, 0.12)` : undefined,
      }}
    >
      <div className="h-[3px]" style={{ background: color }} />
      <div className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-primary/80 px-2 py-0.5">
        <span className={cn("size-1.5 rounded-full", isLeader ? "bg-accent" : schedulable ? "bg-success" : "bg-content-tertiary")} />
        <span className="font-mono text-[10px] text-content-tertiary">{isLeader ? "Leader" : schedulable ? "Schedulable" : "Not schedulable"}</span>
      </div>

      <div className="flex flex-col items-center px-5 pb-4 pt-7 text-center">
        <AgentIdenticon publicKey={agent.public_key} size={60} glow={schedulable} leader={agent.kind === "leader"} />

        <div className="mt-3 flex max-w-full items-center gap-1.5">
          <h2 className="truncate font-mono text-base font-bold text-content-primary">{agent.name}</h2>
          {agent.builtin ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-content-tertiary">built-in</span>
          ) : null}
        </div>

        <span className="mt-0.5 max-w-full truncate font-mono text-[10px] text-content-tertiary">@{agent.username}</span>

        {agent.role && (
          <div className="mt-2 flex max-w-full flex-wrap justify-center gap-1.5">
            {agent.role && (
              <span className="max-w-full truncate rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary">
                {agent.role}
              </span>
            )}
          </div>
        )}

        <div className="mt-4 flex h-5 max-w-full items-center justify-center">
          {fp && (
            <div className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-primary/60 px-2 py-0.5">
              <span className="size-1 rounded-full" style={{ backgroundColor: color }} />
              <span className="truncate font-mono text-[10px] tracking-[0.12em] text-content-tertiary">{fp}</span>
            </div>
          )}
        </div>

        <div className="mt-2 flex max-w-full justify-center">
          <RuntimeMeta runtime={agent.runtime} model={agent.model} available={isLeader ? undefined : schedulable} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3 font-mono text-[10px] text-content-tertiary">
        <span>{tasks.todo} todo</span>
        <span>{tasks.in_progress} progress</span>
        <span>{tasks.in_review} review</span>
        <span>{formatTokens(tokenCount)} tok</span>
        <span>{formatCost(agent.cost_micro_usd)}</span>
      </div>
    </Link>
  );
}

function SubagentCard({ subagent }: { subagent: Subagent }) {
  const models = Object.entries(subagent.models ?? {}) as [AgentRuntime, string][];

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
      <div className="h-[3px] bg-accent/40" />
      <div className="flex flex-col items-center px-5 pb-4 pt-5 text-center">
        <span className="flex size-[60px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-primary">
          <Bot className="size-6 text-content-secondary" />
        </span>

        <h2 className="mt-3 max-w-full truncate font-mono text-base font-bold text-content-primary">{subagent.name}</h2>
        <div className="mt-0.5 max-w-full truncate font-mono text-[10px] text-content-tertiary">@{subagent.username}</div>

        <div className="mt-2 flex max-w-full flex-wrap justify-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-content-secondary">sub-agent</span>
          {subagent.role && (
            <span className="max-w-full truncate rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary">
              {subagent.role}
            </span>
          )}
        </div>

        {subagent.bio && <p className="mt-3 line-clamp-2 text-xs leading-5 text-content-secondary">{subagent.bio}</p>}

        <div className="mt-3 flex max-w-full flex-wrap justify-center gap-1.5">
          {models.length > 0 ? (
            models.map(([runtime, model]) => <RuntimeChip key={runtime} runtime={runtime} model={model} />)
          ) : (
            <span className="font-mono text-[10px] text-content-tertiary">No models configured</span>
          )}
        </div>
      </div>
      <div className="border-t border-border/60 px-4 py-3 text-center font-mono text-[10px] text-content-tertiary">
        {(subagent.skills?.length ?? 0) > 0 ? `${subagent.skills!.length} skills` : "No skills"}
      </div>
    </article>
  );
}
