import type { Repository } from "@agent-kanban/shared";
import { useState } from "react";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useCreateRepository, useDeleteRepository, useRepositories } from "../hooks/useRepositories";

export function RepositoriesPage() {
  const { repos, loading, error } = useRepositories();
  const createRepo = useCreateRepository();
  const deleteRepo = useDeleteRepository();
  const [showDialog, setShowDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null);

  async function handleAdd() {
    if (!newName.trim() || !newUrl.trim()) return;
    try {
      await createRepo.mutateAsync({ name: newName.trim(), url: newUrl.trim() });
      setNewName("");
      setNewUrl("");
      setShowDialog(false);
    } catch (cause) {
      toast.error((cause as Error).message || "Failed to add repository");
    }
  }

  async function handleDelete() {
    if (!repoToDelete) return;
    try {
      await deleteRepo.mutateAsync(repoToDelete.id);
      setRepoToDelete(null);
    } catch (cause) {
      toast.error((cause as Error).message || "Failed to remove repository");
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-content-primary">Repositories</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{repos.length} total</span>
            <button
              onClick={() => setShowDialog(true)}
              className="bg-accent text-[#09090B] font-medium text-xs px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              Add Repository
            </button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
            {(error as Error).message}
          </p>
        ) : loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 bg-surface-secondary border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <p className="text-content-secondary text-sm">No repositories registered.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {repos.map((repo) => (
              <div key={repo.id} className="bg-surface-secondary border border-border rounded-lg px-5 py-4 hover:border-accent/30 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-sm text-content-primary font-medium truncate">{repo.name}</span>
                    <span className="text-[11px] font-mono text-content-tertiary truncate">{repo.url}</span>
                  </div>
                  <button
                    onClick={() => setRepoToDelete(repo)}
                    disabled={deleteRepo.isPending}
                    className="text-xs text-content-tertiary hover:text-error transition-colors shrink-0 ml-3 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-2 text-xs text-content-secondary">
                  <span className="text-content-tertiary">Added: </span>
                  <span className="font-mono text-content-primary">{formatRelative(repo.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Repository</DialogTitle>
            <DialogDescription>Register a Git repository for board tasks.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="repo-name" className="text-xs text-content-secondary">
                Name
              </label>
              <Input id="repo-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="agent-kanban" />
            </div>
            <div className="space-y-2">
              <label htmlFor="repo-url" className="text-xs text-content-secondary">
                Clone URL
              </label>
              <Input
                id="repo-url"
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="https://github.com/example/repository.git"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!newName.trim() || !newUrl.trim() || createRepo.isPending}>
              {createRepo.isPending ? "Adding..." : "Add Repository"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(repoToDelete)} onOpenChange={(open) => !open && setRepoToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Repository</DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono text-content-primary">{repoToDelete?.name}</span> from Agent Kanban?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepoToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteRepo.isPending}>
              {deleteRepo.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
