import { generateWorktreeName, isValidWorktreeName, parseWorktreeConfig } from "@agent-kanban/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

export type TaskFormMode = "create" | "edit";

export interface TaskFormInitial {
  id: string;
  title: string;
  description?: string | null;
  repository_id?: string | null;
  labels?: string[];
  assigned_to?: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  depends_on?: string[];
}

interface TaskFormDialogProps {
  mode: TaskFormMode;
  open: boolean;
  boardId: string;
  /** dev boards require a repository, ops boards forbid one (server-enforced). */
  boardType?: "dev" | "ops";
  labels: { name: string; color: string; description: string }[];
  initialTask?: TaskFormInitial | null;
  onClose: () => void;
  onSaved: () => void;
}

const NONE = "__none__";

function labelToggleStyle(color: string, active: boolean) {
  return {
    color,
    borderColor: `color-mix(in srgb, ${color} ${active ? 48 : 30}%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${color} ${active ? 14 : 6}%, transparent)`,
  };
}

export function TaskFormDialog({ mode, open, boardId, boardType, labels, initialTask, onClose, onSaved }: TaskFormDialogProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryId, setRepositoryId] = useState<string>(NONE);
  const [assignTo, setAssignTo] = useState<string>(NONE);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(true);
  const [worktreeName, setWorktreeName] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [depPick, setDepPick] = useState("");
  const [showLocalPath, setShowLocalPath] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const [registeringLocal, setRegisteringLocal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh random suggestion each time the dialog opens.
  const nameSuggestion = useMemo(() => (open ? generateWorktreeName() : ""), [open]);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTask?.title ?? "");
    setDescription(initialTask?.description ?? "");
    setRepositoryId(initialTask?.repository_id ?? NONE);
    setAssignTo(initialTask?.assigned_to ?? NONE);
    setSelectedLabels(initialTask?.labels ?? []);
    const initialWorktree = parseWorktreeConfig(initialTask?.metadata);
    setUseWorktree(initialWorktree.enabled);
    setWorktreeName(initialWorktree.name ?? "");
    setDependsOn(initialTask?.depends_on ?? []);
    setDepPick("");
    setShowLocalPath(false);
    setLocalPath("");
    setError(null);
    setPending(false);
  }, [open, initialTask]);

  const { data: repositories = [] } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.repositories.list(),
    staleTime: 60_000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
    staleTime: 30_000,
  });
  const workers = agents.filter((a: any) => a.kind !== "leader");

  const { data: boardTasks = [] } = useQuery({
    queryKey: ["tasks", "board", boardId],
    queryFn: () => api.tasks.list({ board_id: boardId }),
    staleTime: 15_000,
  });

  // The assign route only accepts todo + unassigned tasks; anything else is
  // shown read-only so the dialog never offers an action the API will reject.
  const assignEditable = mode === "create" || (initialTask?.status === "todo" && !initialTask?.assigned_to);
  const repoRequired = boardType === "dev";
  const repoForbidden = boardType === "ops";
  const repoMissing = repoRequired && repositoryId === NONE;
  // Worktree only applies once a repo is involved, and renaming after dispatch
  // doesn't rename a live worktree — lock it unless the task is still pre-dispatch.
  const worktreeEditable = (mode === "create" || initialTask?.status === "todo") && !repoForbidden && repositoryId !== NONE;
  const trimmedWorktreeName = worktreeName.trim();
  // Only block submit on the name when the field is actually in play — the
  // input is hidden/inert when the switch is off, no repo is selected, or the
  // section is locked.
  const worktreeNameInvalid = useWorktree && worktreeEditable && trimmedWorktreeName !== "" && !isValidWorktreeName(trimmedWorktreeName);

  const repoNameById = new Map(repositories.map((r: any) => [r.id, r.full_name ? `${r.name} — ${r.full_name}` : `${r.name} — ${r.url}`]));
  // Agent names are not unique (many workers share a display name); the
  // username is. Lead with @username everywhere so duplicates stay distinct.
  const agentNameById = new Map(workers.map((a: any) => [a.id, a.name && a.name !== a.username ? `@${a.username} · ${a.name}` : `@${a.username}`]));
  const taskById = new Map(boardTasks.map((t: any) => [t.id, t]));
  const depLabel = (id: string) => {
    const t: any = taskById.get(id);
    return t ? `#${t.seq ?? "?"} ${t.title}` : id;
  };

  function toggleLabel(name: string) {
    setSelectedLabels((prev) => (prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]));
  }

  // Dependencies only matter at dispatch time — lock them once the task has
  // left todo, same as the worktree settings. Cancelled tasks are excluded:
  // they never reach done, so depending on one would block forever.
  const depsEditable = mode === "create" || initialTask?.status === "todo";
  const depCandidates = boardTasks.filter((t: any) => t.id !== initialTask?.id && t.status !== "cancelled" && !dependsOn.includes(t.id));

  function addDependency(id: string) {
    setDependsOn((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setDepPick("");
  }

  async function registerLocalPath() {
    const path = localPath.trim().replace(/\/+$/, "");
    if (!path.startsWith("/")) {
      setError("Local path must be absolute, e.g. /home/you/project");
      return;
    }
    setRegisteringLocal(true);
    setError(null);
    try {
      const name = path.split("/").pop() || "local-repo";
      const repo = await api.repositories.create({ name, url: path });
      await queryClient.invalidateQueries({ queryKey: ["repositories"] });
      setRepositoryId(repo.id);
      setLocalPath("");
      setShowLocalPath(false);
    } catch (err: any) {
      setError(err?.message ?? "Failed to register local repository");
    } finally {
      setRegisteringLocal(false);
    }
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      if (mode === "create") {
        const body: Record<string, unknown> = { board_id: boardId, title: title.trim() };
        if (description.trim()) body.description = description.trim();
        if (!repoForbidden && repositoryId !== NONE) body.repository_id = repositoryId;
        if (assignTo !== NONE) body.assigned_to = assignTo;
        if (selectedLabels.length > 0) body.labels = selectedLabels;
        if (dependsOn.length > 0) body.depends_on = dependsOn;
        if (worktreeEditable && repositoryId !== NONE) {
          // Only send non-default worktree config; the daemon defaults to enabled.
          if (!useWorktree) body.metadata = { worktree: { enabled: false } };
          else if (trimmedWorktreeName) body.metadata = { worktree: { enabled: true, name: trimmedWorktreeName } };
        }
        await api.tasks.create(body);
      } else if (initialTask) {
        const body: Record<string, unknown> = {};
        if (title.trim() !== initialTask.title) body.title = title.trim();
        if (description.trim() !== (initialTask.description ?? "")) body.description = description.trim();
        if (!repoForbidden && (repositoryId === NONE ? null : repositoryId) !== (initialTask.repository_id ?? null)) {
          body.repository_id = repositoryId === NONE ? null : repositoryId;
        }
        const initialLabels = initialTask.labels ?? [];
        if (selectedLabels.length !== initialLabels.length || selectedLabels.some((l) => !initialLabels.includes(l))) {
          body.labels = selectedLabels;
        }
        if (depsEditable) {
          const initialDeps = initialTask.depends_on ?? [];
          if (dependsOn.length !== initialDeps.length || dependsOn.some((d) => !initialDeps.includes(d))) {
            body.depends_on = dependsOn;
          }
        }
        if (worktreeEditable) {
          const initialWorktree = parseWorktreeConfig(initialTask.metadata);
          const nextWorktree = !useWorktree
            ? { enabled: false as const }
            : trimmedWorktreeName
              ? { enabled: true as const, name: trimmedWorktreeName }
              : { enabled: true as const };
          if (nextWorktree.enabled !== initialWorktree.enabled || nextWorktree.name !== initialWorktree.name) {
            // Merge — metadata also carries annotations and other daemon keys.
            body.metadata = { ...(initialTask.metadata ?? {}), worktree: nextWorktree };
          }
        }
        if (Object.keys(body).length > 0) await api.tasks.update(initialTask.id, body);
        if (assignEditable && assignTo !== NONE && assignTo !== initialTask.assigned_to) {
          await api.tasks.assign(initialTask.id, assignTo);
        }
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Request failed");
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New task" : "Edit task"}</DialogTitle>
          <DialogDescription className="sr-only">{mode === "create" ? "Create a task on this board" : "Edit task fields"}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Details, acceptance criteria… (Markdown supported)"
              rows={5}
              className="resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {!repoForbidden && (
              <div className="min-w-0 space-y-1.5">
                <Label>Repository{repoRequired && <span className="text-error"> *</span>}</Label>
                <Select value={repositoryId} onValueChange={(v) => v && setRepositoryId(v)}>
                  <SelectTrigger className={repoMissing ? "w-full min-w-0 border-error" : "w-full min-w-0"}>
                    <SelectValue>{(v: string) => <span className="truncate">{v === NONE ? "None" : (repoNameById.get(v) ?? v)}</span>}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {repositories.map((r: any) => (
                      <SelectItem key={r.id} value={r.id} className="items-start">
                        <span className="flex flex-col items-start gap-0.5 whitespace-normal">
                          <span>{r.name}</span>
                          <span className="font-mono text-[11px] text-content-tertiary break-all">{r.full_name ?? r.url}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {repoMissing && <p className="text-[11px] text-content-tertiary">Dev board tasks require a repository</p>}
                <button
                  type="button"
                  onClick={() => setShowLocalPath((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-content-tertiary hover:text-content-secondary"
                >
                  <FolderPlus className="size-3" />
                  Register a local path…
                </button>
                {showLocalPath && (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder="/home/you/Security-agent"
                      aria-label="Local repository path"
                      className="font-mono text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void registerLocalPath();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void registerLocalPath()}
                      disabled={registeringLocal || !localPath.trim()}
                    >
                      {registeringLocal ? "Adding..." : "Add"}
                    </Button>
                  </div>
                )}
                {showLocalPath && (
                  <p className="text-[11px] text-content-tertiary">Absolute path to a git project on the machine running the daemon.</p>
                )}
              </div>
            )}

            <div className="min-w-0 space-y-1.5">
              <Label>Assign to</Label>
              {assignEditable ? (
                <Select value={assignTo} onValueChange={(v) => v && setAssignTo(v)}>
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue>
                      {(v: string) => <span className="truncate">{v === NONE ? "Unassigned" : (agentNameById.get(v) ?? v)}</span>}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {workers.map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="font-mono text-xs">@{a.username}</span>
                        {a.name && a.name !== a.username && <span className="ml-1.5 text-[11px] text-content-tertiary">{a.name}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="truncate text-[13px] text-content-tertiary pt-1.5">
                  {(initialTask?.assigned_to && (agentNameById.get(initialTask.assigned_to) ?? initialTask.assigned_to)) || "—"}
                </p>
              )}
            </div>
          </div>

          {(depsEditable || dependsOn.length > 0) && (
            <div className="space-y-1.5">
              <Label>Depends on</Label>
              {dependsOn.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {dependsOn.map((depId) => (
                    <span
                      key={depId}
                      className="inline-flex h-5 items-center gap-1 rounded-[4px] border border-border bg-surface-secondary px-1.5 font-mono text-[10px] font-medium text-content-secondary"
                    >
                      <span className="max-w-48 truncate">{depLabel(depId)}</span>
                      {depsEditable && (
                        <button
                          type="button"
                          aria-label={`Remove dependency ${depLabel(depId)}`}
                          onClick={() => setDependsOn((prev) => prev.filter((d) => d !== depId))}
                          className="text-content-tertiary hover:text-content-primary"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {depsEditable && depCandidates.length > 0 && (
                <Select value={depPick} onValueChange={(v) => v && addDependency(v)}>
                  <SelectTrigger aria-label="Add a dependency" className="w-full min-w-0">
                    <SelectValue placeholder="Add a dependency…" />
                  </SelectTrigger>
                  <SelectContent>
                    {depCandidates.map((t: any) => (
                      <SelectItem key={t.id} value={t.id}>
                        <span className="font-mono text-[11px] text-content-tertiary">#{t.seq ?? "?"}</span>
                        <span className="ml-1.5 truncate">{t.title}</span>
                        <span className="ml-1.5 font-mono text-[10px] text-content-tertiary">{t.status}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[11px] text-content-tertiary">
                Blocked until every dependency is done — e.g. fan out 3 worktree agents, then let a merge/review task depend on all three.
                {!depsEditable && mode === "edit" && " Locked: the task has already been dispatched."}
              </p>
            </div>
          )}

          {!repoForbidden && repositoryId !== NONE && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="task-worktree">Isolated worktree</Label>
                <Switch id="task-worktree" checked={useWorktree} onCheckedChange={setUseWorktree} disabled={!worktreeEditable} />
              </div>
              {useWorktree && (
                <Input
                  id="task-worktree-name"
                  value={worktreeName}
                  onChange={(e) => setWorktreeName(e.target.value)}
                  placeholder={nameSuggestion}
                  disabled={!worktreeEditable}
                  className="font-mono text-xs"
                />
              )}
              {worktreeNameInvalid && <p className="text-[11px] text-error">Letters, numbers, hyphens, underscores; max 41 chars.</p>}
              <p className="text-[11px] text-content-tertiary">
                {useWorktree
                  ? trimmedWorktreeName
                    ? `Agent works in an isolated git worktree on branch ak/${trimmedWorktreeName} — parallel tasks stay mergeable.`
                    : "Agent works in an isolated git worktree on an auto-generated ak/* branch — parallel tasks stay mergeable."
                  : "Agent works directly in the repo checkout — one task at a time per repo."}
                {!worktreeEditable && mode === "edit" && " Locked: the task has already been dispatched."}
              </p>
            </div>
          )}

          {labels.length > 0 && (
            <div className="space-y-1.5">
              <Label>Labels</Label>
              <div className="flex gap-1.5 flex-wrap">
                {labels.map((label) => {
                  const active = selectedLabels.includes(label.name);
                  return (
                    <Button
                      key={label.name}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-5 rounded-[4px] px-1.5 font-mono text-[10px] font-medium"
                      style={labelToggleStyle(label.color, active)}
                      onClick={() => toggleLabel(label.name)}
                      title={label.description || label.name}
                    >
                      {label.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-error">{error}</p>}
        </div>

        <DialogFooter className="flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !title.trim() || repoMissing || worktreeNameInvalid}>
            {pending ? "Saving..." : mode === "create" ? "Create task" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
