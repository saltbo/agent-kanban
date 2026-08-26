import type { RepoAppStatus, Repository } from "@agent-kanban/shared";
import { Github } from "lucide-react";
import { useState } from "react";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useGithubAppConfig, useInstallableRepos } from "../hooks/useGithubApp";
import { useCreateRepository, useDeleteRepository, useRepositories } from "../hooks/useRepositories";

const STATUS_BADGE: Record<RepoAppStatus, { label: string; className: string }> = {
  covered: { label: "App connected", className: "bg-success/10 text-success" },
  not_covered: { label: "Not in App", className: "bg-warning/10 text-warning" },
  suspended: { label: "App suspended", className: "bg-warning/10 text-warning" },
  app_not_installed: { label: "App not installed", className: "bg-surface-tertiary text-content-tertiary" },
};

function RepoStatusBadge({ status, installUrl }: { status?: RepoAppStatus; installUrl: string | null }) {
  if (!status) return null;
  const badge = STATUS_BADGE[status];
  const span = <span className={`text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-sm ${badge.className}`}>{badge.label}</span>;
  if (status === "covered" || !installUrl) return span;
  return (
    <a
      href={installUrl}
      target="_blank"
      rel="noreferrer"
      className="hover:opacity-80 transition-opacity"
      title="Configure the GitHub App on this repository"
    >
      {span}
    </a>
  );
}

export function RepositoriesPage() {
  const { repos, loading } = useRepositories();
  const config = useGithubAppConfig();
  const createRepo = useCreateRepository();
  const deleteRepo = useDeleteRepository();
  const [showDialog, setShowDialog] = useState(false);
  const [addTab, setAddTab] = useState("github");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null);

  const installUrl = config?.install_url ?? null;
  const installable = useInstallableRepos(showDialog && addTab === "github" && Boolean(config?.configured));

  async function handleAddManual() {
    if (!newName.trim() || !newUrl.trim()) return;
    await createRepo.mutateAsync({ name: newName.trim(), url: newUrl.trim() });
    setNewName("");
    setNewUrl("");
    setShowDialog(false);
  }

  async function handleImport(name: string, url: string) {
    await createRepo.mutateAsync({ name, url });
    await installable.refetch();
  }

  async function handleDelete() {
    if (!repoToDelete) return;
    await deleteRepo.mutateAsync(repoToDelete.id);
    setRepoToDelete(null);
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-content-primary">Repositories</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-tertiary font-mono">{repos.length} total</span>
            {config?.configured && installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                title={config.installed ? "Manage the GitHub App on GitHub" : "Install the GitHub App"}
                className="flex items-center gap-1.5 border border-border text-content-secondary font-medium text-xs px-3 py-1.5 rounded-md hover:border-accent/30 hover:text-content-primary transition-colors"
              >
                <Github className="size-3.5" />
                {config.installed ? (
                  <>
                    <span className="text-success">Connected</span>
                    {config.accounts[0] && <span className="text-content-tertiary">@{config.accounts.join(", @")}</span>}
                  </>
                ) : (
                  "Install GitHub App"
                )}
              </a>
            )}
            <button
              onClick={() => setShowDialog(true)}
              className="bg-accent text-[#09090B] font-medium text-xs px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              Add Repository
            </button>
          </div>
        </div>

        {loading ? (
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
                    <RepoStatusBadge status={repo.app_status} installUrl={installUrl} />
                    <span className="text-[11px] font-mono text-content-tertiary truncate hidden sm:inline">{repo.url}</span>
                  </div>
                  <button
                    onClick={() => setRepoToDelete(repo)}
                    disabled={deleteRepo.isPending}
                    className="text-xs text-content-tertiary hover:text-error transition-colors shrink-0 ml-3 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-6 text-xs text-content-secondary">
                  <div>
                    <span className="text-content-tertiary">Tasks: </span>
                    <span className="font-mono text-content-primary">{repo.task_count ?? 0}</span>
                  </div>
                  <div>
                    <span className="text-content-tertiary">Added: </span>
                    <span className="font-mono text-content-primary">{formatRelative(repo.created_at)}</span>
                  </div>
                  <span className="text-[11px] font-mono text-content-tertiary truncate sm:hidden">{repo.url}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) setShowDialog(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Repository</DialogTitle>
            <DialogDescription className="sr-only">Add a repository to track tasks</DialogDescription>
          </DialogHeader>
          <Tabs value={addTab} onValueChange={(v) => setAddTab(v as string)}>
            <TabsList className="w-full">
              <TabsTrigger value="github">From GitHub</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>

            <TabsContent value="github" className="pt-4">
              {!config?.configured ? (
                <p className="text-sm text-content-tertiary py-4 text-center">The GitHub App is not configured on this instance.</p>
              ) : installable.data?.installed === false ? (
                <div className="space-y-3 py-4 text-center">
                  <p className="text-sm text-content-secondary">Install the GitHub App to browse and import your repositories.</p>
                  {installUrl && (
                    <a
                      href={installUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 bg-accent text-[#09090B] font-medium text-sm px-3 py-2 rounded-lg hover:opacity-90 transition-opacity"
                    >
                      <Github className="size-4" />
                      Install GitHub App
                    </a>
                  )}
                </div>
              ) : installable.isLoading ? (
                <p className="text-sm text-content-tertiary py-4 text-center">Loading repositories…</p>
              ) : (
                <div className="space-y-2">
                  <div className="max-h-72 overflow-y-auto space-y-1.5">
                    {installable.data?.repositories.map((repo) => (
                      <div key={repo.full_name} className="flex items-center justify-between gap-3 border border-border rounded-md px-3 py-2">
                        <span className="font-mono text-xs text-content-primary truncate">{repo.full_name}</span>
                        <button
                          onClick={() => handleImport(repo.name, repo.clone_url)}
                          disabled={repo.already_added || createRepo.isPending}
                          className="text-xs font-medium text-accent shrink-0 disabled:text-content-tertiary disabled:cursor-default hover:opacity-80 transition-opacity"
                        >
                          {repo.already_added ? "Added" : "Add"}
                        </button>
                      </div>
                    ))}
                  </div>
                  {installUrl && (
                    <a
                      href={installUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-[11px] text-content-tertiary hover:text-accent transition-colors pt-1"
                    >
                      Don't see a repository? Configure the App on GitHub →
                    </a>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="manual" className="pt-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Name</label>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="my-repo"
                    className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-content-tertiary uppercase tracking-wide font-medium">Clone URL</label>
                  <input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-sm text-content-primary placeholder:text-content-tertiary outline-none focus:border-accent font-mono"
                  />
                </div>
                <button
                  onClick={handleAddManual}
                  disabled={!newName.trim() || !newUrl.trim() || createRepo.isPending}
                  className="w-full bg-accent text-[#09090B] font-medium text-sm py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {createRepo.isPending ? "Adding..." : "Add Repository"}
                </button>
                <p className="text-[11px] text-content-tertiary">
                  If the GitHub App isn't installed on this repo, you'll be prompted to install it after adding.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={!!repoToDelete} onOpenChange={(open) => !open && setRepoToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Repository</DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono text-content-primary">{repoToDelete?.name}</span> from this workspace. Existing tasks linked to this
              repository will lose their repository association.
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
