import { Bot, CheckCircle2, CircleSlash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentProjection } from "@/features/agents/useAgents";

export function AgentList({ agents }: { agents: AgentProjection[] }) {
  if (agents.length === 0) {
    return <div className="border border-dashed border-border rounded-lg py-16 text-center text-sm text-content-tertiary">No Agents available.</div>;
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {agents.map((agent) => (
        <Link key={agent.id} to={`/agents/${encodeURIComponent(agent.id)}`} className="group focus-visible:outline-none">
          <Card className="h-full rounded-lg border-border bg-surface-secondary group-hover:border-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-accent">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface-primary text-accent">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-content-primary">{agent.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">@{agent.username}</CardDescription>
                  </div>
                </div>
                <Schedulable value={agent.schedulable} />
              </div>
            </CardHeader>
            <CardContent className="flex items-center gap-2 text-xs text-content-tertiary">
              <Badge variant="outline" className="font-mono">
                {agent.runtime}
              </Badge>
              {agent.model && <span className="truncate font-mono">{agent.model}</span>}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export function AgentDetail({ agent }: { agent: AgentProjection }) {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content-primary">{agent.name}</h1>
          <p className="mt-1 font-mono text-xs text-content-tertiary">@{agent.username}</p>
        </div>
        <Schedulable value={agent.schedulable} />
      </div>
      <Card className="rounded-lg border-border bg-surface-secondary">
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Realmroot subject" value={agent.subject} mono />
          <Field label="Runtime" value={agent.runtime} mono />
          <Field label="Model" value={agent.model ?? "Default"} mono />
          <Field label="Skills" value={agent.skills.length ? agent.skills.join(", ") : "None"} />
        </CardContent>
      </Card>
      {agent.description && <p className="text-sm leading-6 text-content-secondary">{agent.description}</p>}
    </div>
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
