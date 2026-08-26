import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useAgent, useAgentSessions, useAgentTasks, useDeleteAgent } from "../hooks/useAgents";
import { agentColor, agentColorRgb, agentFingerprint } from "../lib/agentIdentity";
import { api } from "../lib/api";

const actionStyles: Record<string, string> = {
  claimed: "text-accent",
  assigned: "text-accent",
  completed: "text-success",
  released: "text-warning",
  timed_out: "text-error",
  review_requested: "text-accent",
};

const taskStatusStyles: Record<string, string> = {
  in_progress: "bg-accent/15 text-accent",
  in_review: "bg-yellow-500/15 text-yellow-500",
  done: "bg-green-500/15 text-green-500",
  todo: "bg-zinc-500/15 text-content-tertiary",
  cancelled: "bg-red-500/15 text-red-500",
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

type Tab = "mission" | "activity" | "sessions" | "inbox";

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { agent, loading } = useAgent(id);
  const { sessions } = useAgentSessions(id);
  const { tasks } = useAgentTasks(id);
  const task = tasks[0] ?? null;
  const deleteAgent = useDeleteAgent();

  const [tab, setTab] = useState<Tab>("mission");
  const [showIdentity, setShowIdentity] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="max-w-4xl mx-auto px-8 py-10">
          <div className="h-80 bg-surface-secondary rounded-lg animate-pulse" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-surface-primary">
        <Header />
        <div className="max-w-4xl mx-auto px-8 py-10">
          <p className="text-content-secondary text-sm">Agent not found.</p>
        </div>
      </div>
    );
  }

  const rgb = agent.public_key ? agentColorRgb(agent.public_key) : "34, 211, 238";
  const color = agent.public_key ? agentColor(agent.public_key) : "#22D3EE";
  const fp = agent.fingerprint ? agentFingerprint(agent.fingerprint) : "";
  const isLeader = agent.kind === "leader";
  const schedulable = agent.status.schedulable;
  const taskCounts = agent.status.tasks;
  const totalTokens = (agent.input_tokens || 0) + (agent.output_tokens || 0) + (agent.cache_read_tokens || 0);

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "mission", label: "Mission" },
    { key: "activity", label: "Activity", count: agent.logs?.length },
    { key: "sessions", label: "Sessions", count: sessions.length },
    { key: "inbox", label: "Inbox" },
  ];

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto px-8 py-10">
        <Link to="/agents" className="text-xs text-content-tertiary hover:text-content-secondary transition-colors">
          &larr; Agents
        </Link>

        {/* ─── Identity Hero ─── */}
        <div
          className="mt-6 rounded-lg overflow-hidden"
          style={{
            background: "var(--bg-secondary)",
            boxShadow: schedulable ? `0 8px 40px rgba(${rgb}, 0.12), 0 0 0 1px rgba(${rgb}, 0.1)` : "0 0 0 1px var(--border)",
          }}
        >
          {/* Color bar */}
          <div className="h-1" style={{ background: color }} />

          <div className="px-6 py-12 relative overflow-hidden">
            {/* Settings dropdown — top-right */}
            {!agent.builtin && (
              <div className="absolute top-4 right-4 z-20">
                <DropdownMenu>
                  <DropdownMenuTrigger className="w-8 h-8 flex items-center justify-center rounded-md text-content-tertiary hover:text-content-secondary hover:bg-surface-tertiary transition-colors">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {!isLeader && (
                      <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/edit`)} className="text-xs font-mono cursor-pointer">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="mr-2"
                        >
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        Edit
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => setShowDelete(true)}
                      className="text-xs font-mono text-red-500 focus:text-red-500 cursor-pointer"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="mr-2"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Fingerprint watermark — right side, clickable */}
            <button
              onClick={() => setShowIdentity(true)}
              className="absolute right-12 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-2 cursor-pointer group transition-opacity hover:opacity-100 opacity-100"
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
                <path d="M2 16h.01" />
                <path d="M21.8 16c.2-2 .131-5.354 0-6" />
                <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
                <path d="M8.65 22c.21-.66.45-1.32.57-2" />
                <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
              </svg>
              <span className="font-mono text-[11px] tracking-[0.2em] font-medium text-content-tertiary transition-opacity">{fp}</span>
            </button>

            <div className="flex items-start gap-6 relative">
              <AgentIdenticon publicKey={agent.public_key} size={96} glow={schedulable} crystallize leader={agent.kind === "leader"} />

              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center gap-3">
                  <h1 className="font-mono text-2xl font-bold text-content-primary" style={{ letterSpacing: "-0.02em" }}>
                    {agent.name}
                  </h1>
                  {agent.builtin ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-content-tertiary shrink-0"
                    >
                      <title>Built-in — cannot be modified</title>
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  ) : null}
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${!isLeader && schedulable ? "animate-pulse-glow" : ""}`}
                    style={{ backgroundColor: isLeader || schedulable ? color : "#3f3f46" }}
                  />
                </div>

                <p className="mt-1.5 font-mono text-xs text-content-tertiary">
                  @{agent.username} · {agent.username}@mails.agent-kanban.dev
                </p>

                {agent.bio && <p className="mt-2 text-sm text-content-secondary">{agent.bio}</p>}

                {/* Meta */}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono text-content-tertiary bg-surface-tertiary rounded-full px-2.5 py-0.5">{agent.runtime}</span>
                  {agent.model && (
                    <span className="text-[10px] font-mono text-content-tertiary bg-surface-tertiary rounded-full px-2.5 py-0.5">{agent.model}</span>
                  )}
                  <span className="text-[10px] text-content-tertiary">Created {formatRelative(agent.created_at)}</span>
                  <span className="text-[10px] text-content-tertiary">{isLeader ? "Leader" : schedulable ? "Schedulable" : "Not schedulable"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Telemetry strip — inside hero card */}
          <div className="border-t border-border/50 grid grid-cols-5 divide-x divide-border/50">
            {[
              { label: "TODO", value: String(taskCounts.todo) },
              { label: "PROGRESS", value: String(taskCounts.in_progress) },
              { label: "REVIEW", value: String(taskCounts.in_review) },
              { label: "INPUT", value: formatTokens(agent.input_tokens || 0) },
              { label: "COST", value: formatCost(agent.cost_micro_usd || 0) },
            ].map((stat) => (
              <div key={stat.label} className="py-3 px-4 text-center">
                <div className="text-[9px] font-mono text-content-tertiary uppercase tracking-wider">{stat.label}</div>
                <div className="font-mono text-base text-content-primary mt-0.5">{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Token composition bar */}
          {totalTokens > 0 && (
            <div className="h-1 flex">
              <div style={{ width: `${(agent.input_tokens / totalTokens) * 100}%`, background: color, opacity: 0.8 }} />
              <div style={{ width: `${(agent.output_tokens / totalTokens) * 100}%`, background: color, opacity: 0.35 }} />
              <div style={{ flex: 1, background: color, opacity: 0.1 }} />
            </div>
          )}
        </div>

        {/* ─── Identity Modal ─── */}
        <IdentityModal
          open={showIdentity}
          onOpenChange={setShowIdentity}
          fingerprint={agent.fingerprint}
          publicKey={agent.public_key}
          color={color}
          rgb={rgb}
        />

        {/* ─── Delete Confirmation ─── */}
        <DeleteAgentDialog
          open={showDelete}
          onOpenChange={setShowDelete}
          agentName={agent.name}
          onConfirm={async () => {
            await deleteAgent.mutateAsync(agent.id);
            navigate("/agents");
          }}
          deleting={deleteAgent.isPending}
        />

        {/* ─── Soul ─── */}
        {agent.soul && (
          <div className="mt-6 bg-surface-secondary rounded-lg px-5 py-4" style={{ boxShadow: "0 0 0 1px var(--border)" }}>
            <div className="text-[9px] font-mono text-content-tertiary uppercase tracking-wider mb-2">Soul</div>
            <div className="font-mono text-xs text-content-secondary leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-content-primary [&_h1]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-content-primary [&_h2]:mb-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-content-primary [&_h3]:mb-1.5 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-primary [&_pre]:p-3 [&_code]:rounded [&_code]:bg-surface-primary [&_code]:px-1 [&_code]:text-accent [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-content-secondary [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-tertiary [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {agent.soul}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* ─── Tabs ─── */}
        <div className="mt-10 flex items-center gap-6 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`pb-2.5 text-sm font-medium transition-colors relative ${
                tab === t.key ? "text-content-primary" : "text-content-tertiary hover:text-content-secondary"
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-[10px] font-mono text-content-tertiary">{t.count}</span>}
              {tab === t.key && <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full" style={{ background: color }} />}
            </button>
          ))}
        </div>

        {/* ─── Tab Content ─── */}
        <div className="mt-6 pb-16">
          {tab === "mission" && <MissionTab task={task} color={color} rgb={rgb} />}
          {tab === "activity" && <ActivityTab logs={agent.logs} rgb={rgb} />}
          {tab === "sessions" && <SessionsTab sessions={sessions} color={color} />}
          {tab === "inbox" && <InboxTab agentId={agent.id} email={agent.email} />}
        </div>
      </div>
    </div>
  );
}

function ActivityTab({ logs, rgb }: { logs: any[]; rgb: string }) {
  if (!logs || logs.length === 0) {
    return <p className="text-sm text-content-tertiary">No activity yet.</p>;
  }

  return (
    <div className="space-y-0">
      {logs.map((log: any) => (
        <div key={log.id} className="flex items-center gap-4 py-2.5 group">
          <span className="font-mono text-[11px] text-content-tertiary w-20 shrink-0">{formatRelative(log.created_at)}</span>
          <span className={`font-mono text-[12px] w-32 shrink-0 ${actionStyles[log.action] || "text-content-tertiary"}`}>{log.action}</span>
          {log.task_title && <span className="text-sm text-content-secondary truncate">{log.task_title}</span>}
        </div>
      ))}
    </div>
  );
}

function SessionsTab({ sessions, color }: { sessions: any[]; color: string }) {
  if (sessions.length === 0) {
    return <p className="text-sm text-content-tertiary">No sessions yet.</p>;
  }

  return (
    <div className="relative ml-2">
      <div className="absolute left-[3px] top-3 bottom-3 w-px bg-border" />

      {sessions.map((s: any) => {
        const isActive = s.status === "active";
        return (
          <div key={s.id} className="relative flex items-center gap-4 py-2.5 pl-7">
            <div
              className={`absolute left-0 w-[7px] h-[7px] rounded-full ${isActive ? "animate-pulse-glow" : ""}`}
              style={{ backgroundColor: isActive ? color : "#3f3f46" }}
            />
            <span className="font-mono text-[11px] text-content-tertiary w-20 shrink-0">{formatRelative(s.created_at)}</span>
            <code className="font-mono text-[11px] text-content-secondary">{s.id.slice(0, 12)}</code>
            <span
              className={`text-[10px] font-mono rounded px-1.5 py-0.5 ${
                isActive ? "text-accent bg-accent/10" : "text-content-tertiary bg-surface-tertiary"
              }`}
            >
              {s.status}
            </span>
            {s.machine_name && <span className="text-[11px] text-content-tertiary font-mono ml-auto">{s.machine_name}</span>}
          </div>
        );
      })}
    </div>
  );
}

function IdentityModal({
  open,
  onOpenChange,
  fingerprint,
  publicKey,
  rgb,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fingerprint: string;
  publicKey: string;
  color: string;
  rgb: string;
}) {
  const formatFullFingerprint = (fp: string) => fp.match(/.{2}/g)?.join(":") ?? fp;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" style={{ boxShadow: `0 0 0 1px rgba(${rgb}, 0.15)` }}>
        <DialogHeader>
          <DialogTitle>Cryptographic Identity</DialogTitle>
          <DialogDescription className="sr-only">Agent cryptographic identity details</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-content-tertiary uppercase tracking-wider">Fingerprint</span>
              <button
                onClick={() => navigator.clipboard.writeText(fingerprint)}
                className="text-[10px] text-content-tertiary hover:text-content-secondary transition-colors"
              >
                Copy
              </button>
            </div>
            <div className="bg-surface-primary rounded-md p-4" style={{ border: `1px solid rgba(${rgb}, 0.1)` }}>
              <code
                className="font-mono text-[12px] text-content-secondary break-all leading-relaxed block select-all"
                style={{ wordSpacing: "0.15em" }}
              >
                {formatFullFingerprint(fingerprint)}
              </code>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-content-tertiary uppercase tracking-wider">Ed25519 Public Key</span>
              <button
                onClick={() => navigator.clipboard.writeText(publicKey)}
                className="text-[10px] text-content-tertiary hover:text-content-secondary transition-colors"
              >
                Copy
              </button>
            </div>
            <div className="bg-surface-primary rounded-md p-4" style={{ border: `1px solid rgba(${rgb}, 0.1)` }}>
              <code className="font-mono text-[12px] text-content-secondary break-all leading-relaxed block select-all">{publicKey}</code>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAgentDialog({
  open,
  onOpenChange,
  agentName,
  onConfirm,
  deleting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  onConfirm: () => Promise<void>;
  deleting: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    try {
      await onConfirm();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete agent</DialogTitle>
          <DialogDescription>
            Delete agent <span className="font-mono text-content-primary">{agentName}</span>? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={deleting} className="bg-red-600 hover:bg-red-700 text-white border-0">
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InboxMessage {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  received_at: string;
}

interface InboxMessageDetail extends InboxMessage {
  body_html: string;
  body_text: string;
}

function EmailBody({ html, text }: { html: string; text: string }) {
  return (
    <div
      className="mt-3 text-sm text-content-secondary [&_a]:text-accent [&_a]:underline overflow-auto max-h-[400px]"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html || text || "") }}
    />
  );
}

function InboxTab({ agentId, email }: { agentId: string; email: string }) {
  const [emails, setEmails] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<InboxMessageDetail | null>(null);
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.agents
      .inbox(agentId)
      .then((res) => setEmails(res.emails))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  async function handleViewEmail(emailId: string) {
    if (selectedEmail?.id === emailId) {
      setSelectedEmail(null);
      return;
    }
    setLoadingEmail(true);
    setError(null);
    try {
      const detail = await api.agents.inboxEmail(agentId, emailId);
      setSelectedEmail(detail);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingEmail(false);
    }
  }

  if (loading) return <p className="text-sm text-content-tertiary">Loading inbox...</p>;
  if (error) return <p className="text-sm text-error">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-content-tertiary">{email}</span>
      </div>

      {emails.length === 0 ? (
        <p className="text-sm text-content-tertiary">No emails yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
          {emails.map((msg) => (
            <div key={msg.id}>
              <div
                className="flex items-center gap-4 px-4 py-3 hover:bg-surface-tertiary/50 cursor-pointer transition-colors"
                onClick={() => handleViewEmail(msg.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-content-primary truncate">{msg.subject}</div>
                  <div className="text-xs text-content-tertiary mt-0.5">{msg.from_name || msg.from_address}</div>
                </div>
                <span className="text-xs text-content-tertiary shrink-0">{new Date(msg.received_at).toLocaleDateString()}</span>
              </div>

              {selectedEmail?.id === msg.id && (
                <div className="px-4 pb-4 border-t border-border/50">
                  {loadingEmail ? (
                    <p className="text-xs text-content-tertiary py-3">Loading...</p>
                  ) : (
                    <EmailBody html={selectedEmail.body_html} text={selectedEmail.body_text} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MissionTab({ task, color, rgb }: { task: any; color: string; rgb: string }) {
  if (!task) {
    return <p className="text-sm text-content-tertiary">No active mission.</p>;
  }

  return (
    <Link
      to={`/boards/${task.board_id}`}
      className="flex items-center gap-3 bg-surface-secondary rounded-lg px-5 py-3.5 hover:bg-surface-tertiary/60 transition-colors"
      style={{
        borderLeft: `3px solid ${color}`,
        boxShadow: "0 0 0 1px var(--border)",
      }}
    >
      <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${taskStatusStyles[task.status]}`}>{task.status.replace("_", " ")}</span>
      <span className="text-sm text-content-primary flex-1 truncate">{task.title}</span>
      {task.pr_url && (
        <a
          href={task.pr_url}
          target="_blank"
          rel="noopener"
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] font-mono text-content-tertiary hover:text-content-secondary"
        >
          PR &rarr;
        </a>
      )}
      {task.repository_name && <span className="text-[10px] font-mono text-content-tertiary">{task.repository_name}</span>}
    </Link>
  );
}
