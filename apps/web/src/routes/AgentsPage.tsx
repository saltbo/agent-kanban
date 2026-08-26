import { type AgentWithActivity, type AnyAgentRuntime, RUNTIME_LABELS } from "@agent-kanban/shared";
import { Bot, Cloud, Code2, Github, type LucideIcon, Sparkles, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { useAgents } from "../hooks/useAgents";
import { agentColor, agentColorRgb } from "../lib/agentIdentity";
import { cn } from "../lib/utils";

const runtimeMeta: Partial<Record<AnyAgentRuntime, { icon: LucideIcon; tone: string }>> = {
  claude: { icon: Bot, tone: "text-content-secondary" },
  codex: { icon: Terminal, tone: "text-accent" },
  gemini: { icon: Sparkles, tone: "text-warning" },
  copilot: { icon: Github, tone: "text-success" },
  hermes: { icon: Code2, tone: "text-content-tertiary" },
  ama: { icon: Cloud, tone: "text-accent" },
};

export function AgentsPage() {
  const { agents, loading: agentsLoading, error, refresh } = useAgents();
  const latestAgents = (agents as AgentWithActivity[]).filter((agent) => agent.version === "latest");
  const ready = latestAgents.filter((agent) => agent.status.ready).length;

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-8 sm:py-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-content-primary">Agents</h1>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-content-tertiary">
              <span>
                {ready}/{latestAgents.length} ready
              </span>
            </div>
          </div>
          <Link
            to={`/agents/new${window.location.search}`}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-surface-primary transition-opacity hover:opacity-90"
          >
            New agent
          </Link>
        </div>

        {error ? (
          <AgentErrorState error={error as Error & { code?: string; requestId?: string }} onRetry={() => void refresh()} />
        ) : agentsLoading ? (
          <AgentGridSkeleton />
        ) : latestAgents.length === 0 ? (
          <EmptyState label="No agents yet." action="Create your first agent" href={`/agents/new${window.location.search}`} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {latestAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentErrorState({ error, onRetry }: { error: Error & { code?: string; requestId?: string }; onRetry: () => void }) {
  const code = error.code?.split("/").at(-1);
  const action =
    code === "ama-connection-required"
      ? "CONNECT AMA"
      : code === "ama-grant-required"
        ? "REAUTHORIZE AMA"
        : code === "ama-forbidden"
          ? "REQUEST ACCESS"
          : code === "ama-invalid-response"
            ? "REPORT CONTRACT ISSUE"
            : "RETRY";
  return (
    <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
      <p>{error.message}</p>
      {error.requestId ? <p className="mt-1 font-mono text-[11px] text-content-tertiary">Request ID: {error.requestId}</p> : null}
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        {action}
      </Button>
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
          title={available ? "Ready" : "Not ready"}
          className={cn("ml-0.5 size-1.5 shrink-0 rounded-full", available ? "bg-success" : "bg-warning")}
        />
      )}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentWithActivity }) {
  const ready = agent.status.ready;
  const color = agentColor(agent.identity_key);
  const rgb = agentColorRgb(agent.identity_key);
  const identitySubject = agent.identity?.subject ?? "";
  const identity = agent.identity;

  return (
    <Link
      to={`/agents/${agent.id}${window.location.search}`}
      className="group relative block overflow-hidden rounded-lg border border-border bg-surface-secondary transition-all hover:-translate-y-px hover:border-accent/35"
      style={{
        boxShadow: ready ? `0 4px 20px rgba(${rgb}, 0.12)` : undefined,
      }}
    >
      <div className="h-[3px]" style={{ background: color }} />
      <div className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-primary/80 px-2 py-0.5">
        <span className={cn("size-1.5 rounded-full", ready ? "bg-success" : "bg-content-tertiary")} />
        <span className="font-mono text-[10px] text-content-tertiary">{ready ? "Ready" : "Not ready"}</span>
      </div>

      <div className="flex flex-col items-center px-5 pb-4 pt-7 text-center">
        <AgentIdenticon publicKey={agent.identity_key} size={60} glow={ready} />

        <div className="mt-3 flex max-w-full items-center gap-1.5">
          <h2 className="truncate font-mono text-base font-bold text-content-primary">{agent.name}</h2>
        </div>

        <span className="mt-0.5 max-w-full truncate font-mono text-[10px] text-content-tertiary">@{agent.username}</span>

        <div className="mt-4 flex h-5 max-w-full items-center justify-center">
          {identitySubject && (
            <div className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-primary/60 px-2 py-0.5">
              <span className="size-1 rounded-full" style={{ backgroundColor: color }} />
              <span className="truncate font-mono text-[10px] text-content-tertiary">{identitySubject}</span>
            </div>
          )}
        </div>

        <div className="mt-2 flex max-w-full justify-center">
          <RuntimeMeta runtime={agent.runtime} model={agent.model} available={ready} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3 font-mono text-[10px] text-content-tertiary">
        <span className="truncate" title={identity?.issuer}>
          Realmroot
        </span>
        <span className="truncate text-content-secondary" title={identity?.subject}>
          {identity?.subject ?? "Identity pending"}
        </span>
      </div>
    </Link>
  );
}
