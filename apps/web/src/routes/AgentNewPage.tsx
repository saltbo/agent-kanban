import { AGENT_RUNTIMES, type AgentRuntime, RUNTIME_LABELS } from "@agent-kanban/shared";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useCreateAgent } from "../hooks/useAgents";
import { agentColor } from "../lib/agentIdentity";

export function AgentNewPage() {
  const navigate = useNavigate();
  const createAgent = useCreateAgent();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntime>("codex");
  const [model, setModel] = useState("");
  const [skillsText, setSkillsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const previewSeed = username.trim() || name.trim() || "new-agent";
  const previewColor = agentColor(previewSeed);

  async function handleCreate() {
    if (!name.trim() || !username.trim() || !systemPrompt.trim()) return;
    setError(null);
    try {
      await createAgent.mutateAsync({
        name: name.trim(),
        username: username.trim(),
        bio: description.trim() || undefined,
        soul: systemPrompt.trim(),
        runtime,
        model: model.trim() || undefined,
        skills: skillsText
          .split("\n")
          .map((skill) => skill.trim())
          .filter(Boolean),
      });
      navigate(`/agents${window.location.search}`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto px-8 py-10">
        <Link
          to={`/agents${window.location.search}`}
          className="flex items-center gap-1.5 text-sm text-content-tertiary hover:text-content-secondary transition-colors mb-6"
        >
          <span aria-hidden>←</span> Back to agents
        </Link>
        <h1 className="text-2xl font-bold text-content-primary mb-2" style={{ letterSpacing: "-0.02em" }}>
          New agent
        </h1>
        <p className="text-sm text-content-tertiary mb-8">Create and configure an AMA Agent. Its Realmroot identity is managed automatically.</p>

        <div className="grid grid-cols-[1fr_280px] gap-10 items-start">
          <div className="space-y-6">
            <fieldset className="space-y-4">
              <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Identity</legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Release Engineer" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agent-username">Username</Label>
                  <Input
                    id="agent-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    placeholder="release-engineer"
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-description">Description</Label>
                <Input
                  id="agent-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Owns release verification."
                />
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Runtime profile</legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Runtime</Label>
                  <Select value={runtime} onValueChange={(value) => value && setRuntime(value as AgentRuntime)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_RUNTIMES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {RUNTIME_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agent-model">Model</Label>
                  <Input
                    id="agent-model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="Runtime default"
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-prompt">System prompt</Label>
                <Textarea
                  id="agent-prompt"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder="Describe how this Agent should work…"
                  rows={8}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-skills">Skills</Label>
                <Textarea
                  id="agent-skills"
                  value={skillsText}
                  onChange={(event) => setSkillsText(event.target.value)}
                  placeholder="One skill reference per line"
                  rows={3}
                  className="font-mono text-xs"
                />
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="rounded-md border border-error/20 bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => navigate(`/agents${window.location.search}`)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!name.trim() || !username.trim() || !systemPrompt.trim() || createAgent.isPending}>
                {createAgent.isPending ? "Creating Agent…" : "Create Agent"}
              </Button>
            </div>
          </div>

          <aside className="sticky top-8 overflow-hidden rounded-lg border border-border bg-surface-secondary">
            <div className="h-1" style={{ background: previewColor }} />
            <div className="flex flex-col items-center px-5 py-7 text-center">
              <AgentIdenticon publicKey={previewSeed} size={72} glow />
              <h2 className="mt-4 font-mono text-base font-bold text-content-primary">{name || "New Agent"}</h2>
              <p className="mt-1 font-mono text-[11px] text-content-tertiary">@{username || "username"}</p>
              <span className="mt-4 rounded-full border border-border bg-surface-primary px-2.5 py-1 font-mono text-[10px] text-content-secondary">
                {RUNTIME_LABELS[runtime]} · {model || "default"}
              </span>
            </div>
            <div className="border-t border-border px-4 py-3 text-center font-mono text-[10px] text-content-tertiary">
              Realmroot identity is created automatically
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
