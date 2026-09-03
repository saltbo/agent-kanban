import { CheckCircle2, CircleSlash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentAvatar, type AgentProfile, useAgentProfile } from "@/features/agent-identity";
import type { AgentProjection } from "@/features/agents/useAgents";

export function AgentList({ agents }: { agents: AgentProjection[] }) {
  if (agents.length === 0) {
    return <div className="border border-dashed border-border rounded-lg py-16 text-center text-sm text-content-tertiary">No Agents available.</div>;
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {agents.map((agent) => (
        <AgentListItem key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

function AgentListItem({ agent }: { agent: AgentProjection }) {
  const profile = useAgentProfile(agent.subject).data;
  const name = profile?.name || agent.name;
  const username = profile?.username || agent.username;
  const identityBound = Boolean(agent.subject);
  return (
    <Link to={`/agents/${encodeURIComponent(agent.id)}`} className="group focus-visible:outline-none">
      <Card className="h-full rounded-lg border-border bg-surface-secondary group-hover:border-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-accent">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar subject={agent.subject ?? agent.id} profile={profile} fallbackName={agent.name} size={36} />
              <div className="min-w-0">
                <CardTitle className="truncate text-content-primary">{name}</CardTitle>
                {username ? <CardDescription className="font-mono text-xs">@{username}</CardDescription> : <IdentityNotBound />}
              </div>
            </div>
            <Schedulable value={agent.schedulable} />
          </div>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-xs text-content-tertiary">
          {agent.runtime && (
            <Badge variant="outline" className="font-mono">
              {agent.runtime}
            </Badge>
          )}
          {!identityBound && <span className="sr-only">This Agent cannot be assigned until an identity is bound.</span>}
          {agent.model && <span className="truncate font-mono">{agent.model}</span>}
        </CardContent>
      </Card>
    </Link>
  );
}

export function AgentDetail({ agent, profile }: { agent: AgentProjection; profile?: AgentProfile }) {
  const name = profile?.name || agent.name;
  const username = profile?.username || agent.username;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar subject={agent.subject ?? agent.id} profile={profile} fallbackName={agent.name} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-content-primary">{name}</h1>
            {username ? <p className="mt-1 truncate font-mono text-xs text-content-tertiary">@{username}</p> : <IdentityNotBound />}
          </div>
        </div>
        <Schedulable value={agent.schedulable} />
      </div>
      <Card className="rounded-lg border-border bg-surface-secondary">
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Identity subject" value={agent.subject ?? "Not bound"} mono />
          <Field label="Runtime" value={agent.runtime ?? "Not bound"} mono />
          <Field label="Model" value={agent.model ?? "Default"} mono />
          <Field label="Skills" value={agent.skills.length ? agent.skills.join(", ") : "None"} />
        </CardContent>
      </Card>
      {agent.description && <p className="text-sm leading-6 text-content-secondary">{agent.description}</p>}
    </div>
  );
}

function IdentityNotBound() {
  return (
    <Badge variant="outline" className="mt-1 whitespace-nowrap border-warning/30 bg-warning/10 text-warning">
      Identity not bound
    </Badge>
  );
}

function Schedulable({ value }: { value: boolean }) {
  return (
    <Badge variant="outline" className={value ? "border-success/30 text-success" : "text-content-tertiary"}>
      {value ? <CheckCircle2 className="size-3" /> : <CircleSlash2 className="size-3" />}
      {value ? "Schedulable" : "Unavailable"}
    </Badge>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{label}</div>
      <div className={`mt-1 break-all text-sm text-content-primary ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
