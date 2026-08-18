import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryId, setRepositoryId] = useState<string>(NONE);
  const [assignTo, setAssignTo] = useState<string>(NONE);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTask?.title ?? "");
    setDescription(initialTask?.description ?? "");
    setRepositoryId(initialTask?.repository_id ?? NONE);
    setAssignTo(initialTask?.assigned_to ?? NONE);
    setSelectedLabels(initialTask?.labels ?? []);
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

  // The assign route only accepts todo + unassigned tasks; anything else is
  // shown read-only so the dialog never offers an action the API will reject.
  const assignEditable = mode === "create" || (initialTask?.status === "todo" && !initialTask?.assigned_to);
  const repoRequired = boardType === "dev";
  const repoForbidden = boardType === "ops";
  const repoMissing = repoRequired && repositoryId === NONE;

  const repoNameById = new Map(repositories.map((r: any) => [r.id, r.name]));
  const agentNameById = new Map(workers.map((a: any) => [a.id, a.name || a.username]));

  function toggleLabel(name: string) {
    setSelectedLabels((prev) => (prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]));
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
              <div className="space-y-1.5">
                <Label>Repository{repoRequired && <span className="text-error"> *</span>}</Label>
                <Select value={repositoryId} onValueChange={(v) => v && setRepositoryId(v)}>
                  <SelectTrigger className={repoMissing ? "border-error" : undefined}>
                    <SelectValue>{(v: string) => (v === NONE ? "None" : (repoNameById.get(v) ?? v))}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {repositories.map((r: any) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {repoMissing && <p className="text-[11px] text-content-tertiary">Dev board tasks require a repository</p>}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Assign to</Label>
              {assignEditable ? (
                <Select value={assignTo} onValueChange={(v) => v && setAssignTo(v)}>
                  <SelectTrigger>
                    <SelectValue>{(v: string) => (v === NONE ? "Unassigned" : (agentNameById.get(v) ?? v))}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {workers.map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name || a.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-[13px] text-content-tertiary pt-1.5">
                  {(initialTask?.assigned_to && (agentNameById.get(initialTask.assigned_to) ?? initialTask.assigned_to)) || "—"}
                </p>
              )}
            </div>
          </div>

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
          <Button onClick={submit} disabled={pending || !title.trim() || repoMissing}>
            {pending ? "Saving..." : mode === "create" ? "Create task" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
