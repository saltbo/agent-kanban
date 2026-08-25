import type { BuiltinSkill, Skill } from "@agent-kanban/shared";
import { useState } from "react";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useBuiltinSkills, useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from "../hooks/useSkills";

export function SkillsPage() {
  const { skills, loading } = useSkills();
  const { builtin, loading: builtinLoading } = useBuiltinSkills();
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();

  const [tab, setTab] = useState("custom");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [viewing, setViewing] = useState<BuiltinSkill | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setBody("");
    setEditorOpen(true);
  }

  function openEdit(skill: Skill) {
    setEditing(skill);
    setName(skill.name);
    setDescription(skill.description);
    setBody(skill.body);
    setEditorOpen(true);
  }

  async function handleSave() {
    if (!name.trim()) return;
    try {
      if (editing) {
        await updateSkill.mutateAsync({ id: editing.id, name: name.trim(), description, body });
        toast.success(`Skill "${name.trim()}" updated`);
      } else {
        await createSkill.mutateAsync({ name: name.trim(), description, body });
        toast.success(`Skill "${name.trim()}" created`);
      }
      setEditorOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!skillToDelete) return;
    try {
      await deleteSkill.mutateAsync(skillToDelete.id);
      toast.success(`Skill "${skillToDelete.name}" removed`);
      setSkillToDelete(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const saving = createSkill.isPending || updateSkill.isPending;

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-content-primary">Skills</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{skills.length} custom</span>
            <button
              onClick={openCreate}
              className="bg-accent text-[#09090B] font-medium text-xs px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              New Skill
            </button>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="custom">Custom</TabsTrigger>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
          </TabsList>

          <TabsContent value="custom" className="pt-4">
            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 bg-surface-secondary border border-border rounded-lg animate-pulse" />
                ))}
              </div>
            ) : skills.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <p className="text-content-secondary text-sm">No custom skills yet.</p>
                <p className="text-content-tertiary text-xs">
                  Custom skills are referenced from agents as <span className="font-mono">ak@name</span> and installed by the local daemon.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    className="bg-surface-secondary border border-border rounded-lg px-5 py-4 hover:border-accent/30 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-sm text-content-primary font-medium truncate">{skill.name}</span>
                        <span className="text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm bg-accent/10 text-accent">
                          ak@{skill.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 ml-3">
                        <button onClick={() => openEdit(skill)} className="text-xs text-content-tertiary hover:text-accent transition-colors">
                          Edit
                        </button>
                        <button
                          onClick={() => setSkillToDelete(skill)}
                          disabled={deleteSkill.isPending}
                          className="text-xs text-content-tertiary hover:text-error transition-colors disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-6 text-xs text-content-secondary">
                      {skill.description && <span className="truncate">{skill.description}</span>}
                      <div className="shrink-0">
                        <span className="text-content-tertiary">Updated: </span>
                        <span className="font-mono text-content-primary">{formatRelative(skill.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="builtin" className="pt-4">
            {builtinLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 bg-surface-secondary border border-border rounded-lg animate-pulse" />
                ))}
              </div>
            ) : builtin.length === 0 ? (
              <div className="text-center py-16 space-y-3">
                <p className="text-content-secondary text-sm">No built-in skills available.</p>
                <p className="text-content-tertiary text-xs">Built-in skills ship with the repository and are only readable on local deployments.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {builtin.map((skill) => (
                  <div key={skill.name} className="bg-surface-secondary border border-border rounded-lg px-5 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-sm text-content-primary font-medium truncate">{skill.name}</span>
                        <span className="text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm bg-surface-tertiary text-content-tertiary">
                          Read-only
                        </span>
                      </div>
                      <button
                        onClick={() => setViewing(skill)}
                        className="text-xs text-content-tertiary hover:text-accent transition-colors shrink-0 ml-3"
                      >
                        View
                      </button>
                    </div>
                    {skill.description && <p className="mt-2 text-xs text-content-secondary line-clamp-2">{skill.description}</p>}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Create / edit dialog */}
      <Dialog open={editorOpen} onOpenChange={(open) => !open && setEditorOpen(false)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "New Skill"}</DialogTitle>
            <DialogDescription className="sr-only">Create or edit a custom skill</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When to use this skill"
                className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Body (SKILL.md markdown)</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="# My Skill&#10;&#10;Instructions for the agent..."
                rows={12}
                className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-[13px] text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono leading-relaxed"
              />
            </div>
            <button
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="w-full bg-accent text-[#09090B] font-medium text-sm py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? "Saving..." : editing ? "Save Changes" : "Create Skill"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Built-in view dialog */}
      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription className="sr-only">Built-in skill content</DialogDescription>
          </DialogHeader>
          {viewing?.description && <p className="text-xs text-content-secondary">{viewing.description}</p>}
          <pre className="max-h-[60vh] overflow-y-auto bg-surface-primary border border-border rounded-lg px-3 py-2 text-[12px] font-mono text-content-secondary whitespace-pre-wrap leading-relaxed">
            {viewing?.body}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!skillToDelete} onOpenChange={(open) => !open && setSkillToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Skill</DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono text-content-primary">{skillToDelete?.name}</span>? Agents referencing{" "}
              <span className="font-mono">ak@{skillToDelete?.name}</span> will fail to install it on their next dispatch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkillToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSkill.isPending}>
              {deleteSkill.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
