import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type AgentTemplate,
  fetchTemplate,
  fetchTemplateIndex,
  findInvalidSkillRef,
  RUNTIME_LABELS,
  type TemplateIndex,
} from "@agent-kanban/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentIdenticon } from "../components/AgentIdenticon";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useAgents, useCreateAgent } from "../hooks/useAgents";
import { agentColor } from "../lib/agentIdentity";

type Step = "choose" | "recruit" | "form";

export function AgentNewPage() {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const createAgent = useCreateAgent();
  const [step, setStep] = useState<Step>("choose");
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [soul, setSoul] = useState("");
  const [role, setRole] = useState("");
  const [handoffTo, setHandoffTo] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<AgentRuntime>("claude");
  const [model, setModel] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const existingRoles = [...new Set(agents.map((a) => a.role).filter(Boolean))];

  function applyTemplate(t: AgentTemplate) {
    setSelectedTemplate(t);
    setName(t.name);
    setUsername(t.username || "");
    setBio(t.bio || "");
    setSoul(t.soul || "");
    setRole(t.role || "");
    setHandoffTo(t.handoff_to || []);
    setRuntime(t.runtime || "claude");
    setModel(t.model || "");
    setSkills(t.skills || []);
    setStep("form");
  }

  function startCustom() {
    setSelectedTemplate(null);
    setName("");
    setUsername("");
    setBio("");
    setSoul("");
    setRole("");
    setHandoffTo([]);
    setRuntime("claude");
    setModel("");
    setSkills([]);
    setStep("form");
  }

  async function handleCreate() {
    if (!username.trim()) return;
    setError(null);
    const invalidSkill = findInvalidSkillRef(skills);
    if (invalidSkill) {
      setError(`Invalid skill "${invalidSkill}". Use source/repo[#ref]@skill-name format.`);
      return;
    }
    try {
      await createAgent.mutateAsync({
        name: name.trim() || undefined,
        username: username.trim(),
        bio: bio.trim() || undefined,
        soul: soul.trim() || undefined,
        role: role.trim() || undefined,
        handoff_to: handoffTo.length ? handoffTo : undefined,
        runtime,
        model: model.trim() || undefined,
        skills: skills.length ? skills : undefined,
      });
      navigate("/agents");
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto px-8 py-10">
        {step === "choose" && <ChooseStep onRecruit={() => setStep("recruit")} onCustom={startCustom} />}
        {step === "recruit" && <RecruitStep onSelect={applyTemplate} onBack={() => setStep("choose")} />}
        {step === "form" && (
          <FormStep
            template={selectedTemplate}
            existingRoles={existingRoles}
            name={name}
            setName={setName}
            username={username}
            setUsername={setUsername}
            bio={bio}
            setBio={setBio}
            soul={soul}
            setSoul={setSoul}
            role={role}
            setRole={setRole}
            handoffTo={handoffTo}
            setHandoffTo={setHandoffTo}
            runtime={runtime}
            setRuntime={setRuntime}
            model={model}
            setModel={setModel}
            skills={skills}
            setSkills={setSkills}
            creating={createAgent.isPending}
            error={error}
            onBack={() => setStep(selectedTemplate ? "recruit" : "choose")}
            onCreate={handleCreate}
          />
        )}
      </div>
    </div>
  );
}

/* ── Step 1: Choose path ── */

function ChooseStep({ onRecruit, onCustom }: { onRecruit: () => void; onCustom: () => void }) {
  return (
    <div>
      <button
        onClick={() => window.history.back()}
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
        Back to agents
      </button>
      <h1 className="text-2xl font-bold text-content-primary mb-2" style={{ letterSpacing: "-0.02em" }}>
        New agent
      </h1>
      <p className="text-sm text-content-tertiary mb-8">Choose how to create your agent</p>

      <div className="grid grid-cols-2 gap-4 max-w-xl">
        <button
          onClick={onRecruit}
          className="group flex flex-col items-start gap-4 p-6 rounded-lg border border-border hover:border-accent/40 bg-surface-secondary transition-all text-left"
        >
          <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-content-primary group-hover:text-accent transition-colors">Recruit</p>
            <p className="text-xs text-content-tertiary mt-1">Choose from battle-tested roles</p>
          </div>
        </button>
        <button
          onClick={onCustom}
          className="group flex flex-col items-start gap-4 p-6 rounded-lg border border-border hover:border-accent/40 bg-surface-secondary transition-all text-left"
        >
          <div className="w-10 h-10 rounded-full bg-surface-tertiary flex items-center justify-center">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-content-tertiary"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-content-primary group-hover:text-accent transition-colors">Custom</p>
            <p className="text-xs text-content-tertiary mt-1">Build your own from scratch</p>
          </div>
        </button>
      </div>
    </div>
  );
}

/* ── Step 2: Recruit — pick a template ── */

function RecruitStep({ onSelect, onBack }: { onSelect: (t: AgentTemplate) => void; onBack: () => void }) {
  const [index, setIndex] = useState<TemplateIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);

  useEffect(() => {
    fetchTemplateIndex()
      .then(setIndex)
      .finally(() => setLoading(false));
  }, []);

  async function handleSelect(slug: string) {
    setLoadingSlug(slug);
    try {
      const t = await fetchTemplate(slug);
      if (!t.role) t.role = slug;
      onSelect(t);
    } finally {
      setLoadingSlug(null);
    }
  }

  return (
    <div>
      <button
        onClick={onBack}
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
        Back
      </button>
      <h1 className="text-2xl font-bold text-content-primary mb-2" style={{ letterSpacing: "-0.02em" }}>
        Recruit an agent
      </h1>
      <p className="text-sm text-content-tertiary mb-8">Select a role template to get started</p>

      {loading ? (
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-36 bg-surface-secondary rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {index.map((entry) => (
            <button
              key={entry.slug}
              onClick={() => handleSelect(entry.slug)}
              disabled={loadingSlug === entry.slug}
              className="group flex flex-col items-center gap-2.5 p-5 rounded-lg border border-border hover:border-accent/40 bg-surface-secondary transition-all text-center disabled:opacity-60"
            >
              <AgentIdenticon publicKey={entry.slug} size={48} />
              <p className="font-mono text-sm font-bold text-content-primary group-hover:text-accent transition-colors">{entry.name}</p>
              <span className="text-[10px] font-mono text-content-tertiary bg-surface-tertiary px-1.5 py-0.5 rounded">{entry.slug}</span>
              {loadingSlug === entry.slug && <span className="text-[10px] text-accent animate-pulse">Loading...</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Step 3: Form with live preview ── */

interface FormStepProps {
  template: AgentTemplate | null;
  existingRoles: string[];
  name: string;
  setName: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  bio: string;
  setBio: (v: string) => void;
  soul: string;
  setSoul: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  handoffTo: string[];
  setHandoffTo: (v: string[]) => void;
  runtime: AgentRuntime;
  setRuntime: (v: AgentRuntime) => void;
  model: string;
  setModel: (v: string) => void;
  skills: string[];
  setSkills: (v: string[]) => void;
  creating: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
}

function FormStep(props: FormStepProps) {
  const {
    template,
    existingRoles,
    name,
    setName,
    username,
    setUsername,
    bio,
    setBio,
    soul,
    setSoul,
    role,
    setRole,
    handoffTo,
    setHandoffTo,
    runtime,
    setRuntime,
    model,
    setModel,
    skills,
    setSkills,
    creating,
    error,
    onBack,
    onCreate,
  } = props;

  const previewKey = name.trim() || "preview";
  const previewColor = agentColor(previewKey);

  return (
    <div>
      <button
        onClick={onBack}
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
        Back
      </button>
      <h1 className="text-2xl font-bold text-content-primary mb-8" style={{ letterSpacing: "-0.02em" }}>
        {template ? `Recruit ${template.name}` : "Create agent"}
      </h1>

      <div className="grid grid-cols-[1fr_280px] gap-10 items-start">
        {/* Left: form */}
        <div className="space-y-6">
          {/* Identity */}
          <fieldset className="space-y-4">
            <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Identity</legend>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">Name</Label>
                <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bolt" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-username">Username</Label>
                <Input
                  id="agent-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="e.g. bolt"
                  className="font-mono"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-role">Role</Label>
              <Input
                id="agent-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. backend-developer"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-bio">Bio</Label>
              <Input id="agent-bio" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Short description" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-soul">Soul</Label>
              <Textarea
                id="agent-soul"
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
                <Label htmlFor="agent-runtime">Runtime</Label>
                <Select
                  value={runtime}
                  onValueChange={(v) => {
                    if (v) setRuntime(v as AgentRuntime);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{(v: string) => RUNTIME_LABELS[v as AgentRuntime] ?? v}</SelectValue>
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
                <Label htmlFor="agent-model">Model</Label>
                <Input id="agent-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4-6" />
              </div>
            </div>
          </fieldset>

          {/* Workflow */}
          <fieldset className="space-y-4">
            <legend className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Workflow</legend>
            <div className="space-y-1.5">
              <Label>Handoff to</Label>
              <RoleMultiSelect selected={handoffTo} onChange={setHandoffTo} options={existingRoles} />
            </div>
            <div className="space-y-1.5">
              <Label>Skills</Label>
              <TagInput tags={skills} onChange={setSkills} placeholder="owner/repo[#ref]@skill-name" />
            </div>
          </fieldset>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-3 pt-2">
            <Button variant="ghost" onClick={onBack}>
              Cancel
            </Button>
            <Button onClick={onCreate} disabled={!name.trim() || creating}>
              {creating ? "Creating..." : template ? "Recruit" : "Create agent"}
            </Button>
          </div>
        </div>

        {/* Right: live preview card */}
        <div className="sticky top-24">
          <p className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em] mb-3">Preview</p>
          <div className="rounded-lg overflow-hidden border border-border bg-surface-secondary">
            <div className="h-[3px]" style={{ background: previewColor }} />
            <div className="flex flex-col items-center pt-6 pb-4 px-5">
              <AgentIdenticon publicKey={previewKey} size={64} />
              <h2 className="mt-3 font-mono text-base font-bold tracking-tight text-content-primary">{name.trim() || "Agent"}</h2>
              {role && <span className="mt-1 text-[10px] font-mono text-content-tertiary bg-surface-tertiary px-1.5 py-0.5 rounded">{role}</span>}
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5" style={{ background: "var(--bg-secondary)" }}>
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={previewColor}
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="opacity-50"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="font-mono text-[10px] tracking-[0.12em] text-content-secondary">??:??:??:??</span>
              </div>
              {bio && <p className="mt-3 text-xs text-content-secondary text-center leading-relaxed">{bio}</p>}
            </div>
            <div className="border-t border-border/50 px-5 py-3 flex items-center justify-between text-[10px] font-mono text-content-tertiary">
              <span>0 tasks</span>
              <span>0 tok</span>
              <span>$0.00</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Shared components ── */

function RoleMultiSelect({ selected, onChange, options }: { selected: string[]; onChange: (v: string[]) => void; options: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const available = options.filter((r) => !selected.includes(r));

  function toggle(role: string) {
    onChange(selected.includes(role) ? selected.filter((r) => r !== role) : [...selected, role]);
  }

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => options.length > 0 && setOpen(!open)}
        className={`flex h-9 w-full items-center gap-1.5 rounded-md border px-3 text-sm shadow-xs ${
          options.length === 0 ? "border-input/50 cursor-not-allowed" : "border-input cursor-pointer"
        } focus-within:ring-1 focus-within:ring-ring`}
      >
        {selected.map((r) => (
          <span key={r} className="inline-flex items-center gap-1 bg-accent/10 text-accent font-mono text-xs px-2 py-0.5 rounded">
            {r}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggle(r);
              }}
              className="hover:opacity-70"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
        {selected.length === 0 && (
          <span className="text-muted-foreground text-sm">{options.length === 0 ? "No roles available" : "Select roles..."}</span>
        )}
      </div>
      {open && available.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-popover border border-border rounded-md shadow-lg py-1 max-h-40 overflow-y-auto">
          {available.map((r) => (
            <button
              key={r}
              onClick={() => toggle(r)}
              className="w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-surface-tertiary transition-colors"
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
