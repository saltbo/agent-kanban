import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useAgent, useAgentSessions, useDeleteAgent } from "../hooks/useAgents";
import { agentColor, agentColorRgb } from "../lib/agentIdentity";

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { agent, loading, error } = useAgent(id);
  const { sessions } = useAgentSessions(id);
  const deleteAgent = useDeleteAgent();
  const [showIdentity, setShowIdentity] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const query = window.location.search;

  if (loading)
    return (
      <Page>
        <div className="max-w-4xl mx-auto px-8 py-10">
          <div className="h-80 bg-surface-secondary rounded-lg animate-pulse" />
        </div>
      </Page>
    );
  if (error)
    return (
      <Page>
        <div className="max-w-4xl mx-auto px-8 py-10">
          <p role="alert" className="text-error text-sm">
            {(error as Error).message}
          </p>
        </div>
      </Page>
    );
  if (!agent)
    return (
      <Page>
        <div className="max-w-4xl mx-auto px-8 py-10">
          <p className="text-content-secondary text-sm">Agent not found.</p>
        </div>
      </Page>
    );

  const identity = agent.identity as { issuer?: string; subject?: string } | undefined;
  const ready = agent.status.ready;
  const color = agentColor(agent.identity_key);
  const rgb = agentColorRgb(agent.identity_key);

  async function handleDelete() {
    try {
      await deleteAgent.mutateAsync(agent.id);
      navigate(`/agents${query}`);
    } catch (cause) {
      toast.error((cause as Error).message || "Failed to retire agent");
    }
  }

  return (
    <Page>
      <div className="max-w-4xl mx-auto px-8 py-10">
        <Link to={`/agents${query}`} className="text-xs text-content-tertiary hover:text-content-secondary transition-colors">
          ← Agents
        </Link>

        <div
          className="mt-6 rounded-lg overflow-hidden"
          style={{
            background: "var(--bg-secondary)",
            boxShadow: ready ? `0 8px 40px rgba(${rgb}, 0.12), 0 0 0 1px rgba(${rgb}, 0.1)` : "0 0 0 1px var(--border)",
          }}
        >
          <div className="h-1" style={{ background: color }} />
          <div className="px-6 py-10 relative overflow-hidden">
            <div className="absolute top-4 right-4 z-20">
              <DropdownMenu>
                <DropdownMenuTrigger className="w-8 h-8 flex items-center justify-center rounded-md text-content-tertiary hover:text-content-secondary hover:bg-surface-tertiary transition-colors">
                  •••
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/edit${query}`)} className="text-xs font-mono cursor-pointer">
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowDelete(true)} className="text-xs font-mono text-red-500 focus:text-red-500 cursor-pointer">
                    Retire
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <button
              onClick={() => setShowIdentity(true)}
              className="absolute right-12 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-2 cursor-pointer group"
            >
              <svg
                width="128"
                height="128"
                viewBox="0 0 24 24"
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="opacity-15 group-hover:opacity-30 transition-opacity"
              >
                <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
                <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
                <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
                <path d="M2 12a10 10 0 0 1 18-6" />
                <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
                <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
              </svg>
              <span className="max-w-44 truncate font-mono text-[11px] tracking-[0.12em] text-content-tertiary">{identity?.subject}</span>
            </button>

            <div className="flex items-start gap-6 relative">
              <AgentIdenticon publicKey={agent.identity_key} size={96} glow={ready} crystallize />
              <div className="flex-1 min-w-0 pt-1 pr-48">
                <div className="flex items-center gap-3">
                  <h1 className="font-mono text-2xl font-bold text-content-primary">{agent.name}</h1>
                  <span className={`w-2.5 h-2.5 rounded-full ${ready ? "bg-success animate-pulse-glow" : "bg-content-tertiary"}`} />
                </div>
                <p className="mt-1.5 font-mono text-xs text-content-tertiary">@{agent.username}</p>
                {agent.bio && <p className="mt-2 text-sm text-content-secondary">{agent.bio}</p>}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono text-content-tertiary bg-surface-tertiary rounded-full px-2.5 py-0.5">{agent.runtime}</span>
                  {agent.model && (
                    <span className="text-[10px] font-mono text-content-tertiary bg-surface-tertiary rounded-full px-2.5 py-0.5">{agent.model}</span>
                  )}
                  <span className="text-[10px] text-content-tertiary">Created {formatRelative(agent.created_at)}</span>
                  <span className="text-[10px] text-content-tertiary">{ready ? "Ready" : (agent.phase ?? "Provisioning")}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-border/50 grid grid-cols-3 divide-x divide-border/50">
            <Stat label="RUNTIME" value={agent.runtime} />
            <Stat label="SESSIONS" value={String(sessions.length)} />
            <Stat label="IDENTITY" value={ready ? "ENROLLED" : "PENDING"} />
          </div>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <section className="rounded-lg border border-border bg-surface-secondary p-5">
            <h2 className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-wide">Mission</h2>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-content-secondary">{agent.soul || "No system prompt configured."}</p>
            {agent.skills?.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {agent.skills.map((skill: string) => (
                  <span key={skill} className="rounded border border-border px-2 py-1 font-mono text-[10px] text-content-tertiary">
                    {skill}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
          <section className="rounded-lg border border-border bg-surface-secondary p-5">
            <h2 className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-wide">Recent sessions</h2>
            {sessions.length === 0 ? (
              <p className="mt-4 text-sm text-content-tertiary">No sessions yet.</p>
            ) : (
              <div className="mt-3 divide-y divide-border">
                {sessions.slice(0, 8).map((session: any) => (
                  <div key={session.metadata?.uid} className="flex items-center justify-between py-3">
                    <span className="truncate font-mono text-xs text-content-primary">{session.metadata?.name || session.metadata?.uid}</span>
                    <span className="ml-3 text-[10px] uppercase text-content-tertiary">{session.status?.phase}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <Dialog open={showIdentity} onOpenChange={setShowIdentity}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Realmroot identity</DialogTitle>
            <DialogDescription>AMA created and manages this Agent's stable Realmroot identity.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg border border-border bg-surface-primary p-4 font-mono text-xs">
            <div>
              <div className="text-content-tertiary">Issuer</div>
              <div className="mt-1 break-all text-content-primary">{identity?.issuer || "Pending"}</div>
            </div>
            <div>
              <div className="text-content-tertiary">Subject</div>
              <div className="mt-1 break-all text-content-primary">{identity?.subject || "Pending"}</div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Retire Agent</DialogTitle>
            <DialogDescription>
              AMA will retire <span className="font-mono text-content-primary">{agent.name}</span> and its Realmroot identity.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteAgent.isPending}>
              {deleteAgent.isPending ? "Retiring…" : "Retire Agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3 px-4 text-center">
      <div className="text-[9px] font-mono text-content-tertiary uppercase tracking-wider">{label}</div>
      <div className="truncate font-mono text-sm text-content-primary mt-0.5">{value}</div>
    </div>
  );
}
