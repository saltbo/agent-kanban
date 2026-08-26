import { AGENT_RUNTIMES, type AnyAgentRuntime, findInvalidSkillRef, RUNTIME_LABELS } from "@agent-kanban/shared";
import React, { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useAgent, useUpdateAgent } from "../hooks/useAgents";
import { agentColor } from "../lib/agentIdentity";

export function AgentEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { agent, loading } = useAgent(id);
  const updateAgent = useUpdateAgent();

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [soul, setSoul] = useState("");
  const [role, setRole] = useState("");
  const [runtime, setRuntime] = useState<AnyAgentRuntime>("claude");
  const [model, setModel] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (agent && !initialized) {
      setName(agent.name ?? "");
      setBio(agent.bio ?? "");
      setSoul(agent.soul ?? "");
      setRole(agent.role ?? "");
      setRuntime(agent.runtime ?? "claude");
      setModel(agent.model ?? "");
      setSkills(agent.skills ?? []);
      setInitialized(true);
    }
  }, [agent, initialized]);

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

  if (agent.kind === "leader") {
    return <Navigate to={`/agents/${agent.id}`} replace />;
  }

  const previewColor = agentColor(agent.public_key || name.trim() || "preview");

  async function handleSave() {
    if (!name.trim()) return;
    setError(null);
    const invalidSkill = findInvalidSkillRef(skills);
    if (invalidSkill) {
      setError(`Invalid skill "${invalidSkill}". Use source/repo[#ref]@skill-name format.`);
      return;
    }
    try {
      await updateAgent.mutateAsync({
        id: agent!.id,
        body: {
          name: name.trim(),
          bio: bio.trim() || undefined,
          soul: soul.trim() || undefined,
          role: role.trim() || undefined,
          runtime,
          model: model.trim() || undefined,
          skills: skills.length ? skills : undefined,
        },
      });
      navigate(`/agents/${agent!.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto px-8 py-10">
        <Link
          to={`/agents/${agent.id}`}
          className="flex items-center gap-1.5 text-sm text-content-tertiary hover:text-content-secondary transition-colors mb-6"
        >
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
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to {agent.name}
        </Link>

        <h1 className="text-2xl font-bold text-content-primary mb-8" style={{ letterSpacing: "-0.02em" }}>
          Edit agent
        </h1>

        <div className="grid grid-cols-[1fr_280px] gap-10 items-start">
          <div className="space-y-6">
            {/* Identity */}
            <fieldset className="space-y-4">
              <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Identity</legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-agent-name">Name</Label>
                  <Input id="edit-agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bolt" className="font-mono" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-agent-role">Role</Label>
                  <Input
                    id="edit-agent-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="e.g. backend-developer"
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-agent-bio">Bio</Label>
                <Input id="edit-agent-bio" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Short description" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-agent-soul">Soul</Label>
                <Textarea
                  id="edit-agent-soul"
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                  placeholder="Personality prompt..."
                  rows={4}
                  className="resize-none"
                />
              </div>
            </fieldset>

            {/* Runtime */}
            <fieldset className="space-y-4">
              <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Runtime</legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Runtime</Label>
                  <Select
                    value={runtime}
                    onValueChange={(v) => {
                      if (v) setRuntime(v as AnyAgentRuntime);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{(v: string) => RUNTIME_LABELS[v as AnyAgentRuntime] ?? v}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_RUNTIMES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {RUNTIME_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-agent-model">Model</Label>
                  <Input id="edit-agent-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4-6" />
                </div>
              </div>
            </fieldset>

            {/* Workflow */}
            <fieldset className="space-y-4">
              <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Workflow</legend>
              <div className="space-y-1.5">
                <Label>Skills</Label>
                <TagInput tags={skills} onChange={setSkills} placeholder="owner/repo[#ref]@skill-name" />
              </div>
            </fieldset>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center gap-3 pt-2">
              <Button variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!name.trim() || updateAgent.isPending}>
                {updateAgent.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>

          {/* Right: live preview card */}
          <div className="sticky top-24">
            <p className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Preview</p>
            <div className="rounded-lg overflow-hidden border border-border bg-surface-secondary">
              <div className="h-[3px]" style={{ background: previewColor }} />
              <div className="flex flex-col items-center pt-6 pb-4 px-5">
                <AgentIdenticon publicKey={agent.public_key} size={64} />
                <h2 className="mt-3 font-mono text-base font-bold tracking-tight text-content-primary">{name.trim() || "Agent"}</h2>
                {role && <span className="mt-1 text-[10px] font-mono text-content-tertiary bg-surface-tertiary px-1.5 py-0.5 rounded">{role}</span>}
                {bio && <p className="mt-3 text-xs text-content-secondary text-center leading-relaxed">{bio}</p>}
              </div>
              <div className="border-t border-border/50 px-5 py-3 flex items-center justify-between text-[10px] font-mono text-content-tertiary">
                <span>{agent.status.tasks.todo + agent.status.tasks.in_progress + agent.status.tasks.in_review} open tasks</span>
                <span>{formatTokens((agent.input_tokens || 0) + (agent.output_tokens || 0))} tok</span>
                <span>{formatCost(agent.cost_micro_usd || 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

function TagInput({ tags, onChange, placeholder }: { tags: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function add() {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-input px-3 py-1.5 min-h-9 cursor-text shadow-xs focus-within:ring-1 focus-within:ring-ring"
    >
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 bg-secondary text-secondary-foreground font-mono text-xs px-2 py-0.5 rounded">
          {tag}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onChange(tags.filter((t) => t !== tag));
            }}
            className="hover:opacity-70"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={add}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none"
      />
    </div>
  );
}
