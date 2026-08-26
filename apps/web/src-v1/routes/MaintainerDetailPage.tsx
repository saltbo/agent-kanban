import { AK_ANNOTATION_KEY_SOURCE_EVENT, AK_ANNOTATION_KEY_SOURCE_URL, AK_LABEL_KEY_GITHUB_SUBJECT } from "@agent-kanban/shared";
import { ArrowLeft, ExternalLink, FileText, KeyRound, MessageSquare, Pencil, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { AmaSessionChat } from "../components/ChatPanel";
import { Header } from "../components/Header";
import { formatRelative } from "../components/TaskDetailFields";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import {
  useBoard,
  useBoardMaintainer,
  useBoardMaintainerMemories,
  useBoardMaintainerRuns,
  useBoardMaintainerSessions,
  useBoardMaintainerVariables,
  useUpdateBoardMaintainerVariables,
} from "../hooks/useBoard";

interface MaintainerRun {
  id: string;
  scheduled_for: string | null;
  heartbeat_at: string | null;
  triggered_at: string | null;
  status: "claimed" | "queued" | "dispatching" | "dispatched" | "failed";
  session_id: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface MaintainerMemory {
  id: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface MaintainerVariable {
  name: string;
}

interface MaintainerSession {
  id: string;
  title?: string | null;
  state?: string | null;
  agentId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  stoppedAt?: string | null;
  metadata?: Record<string, unknown>;
}

interface GithubSubject {
  event: string | null;
  action: string | null;
  repository: string | null;
  repositoryUrl: string | null;
  subjectType: "issue" | "pull" | null;
  subjectNumber: number | null;
  subjectTitle: string | null;
  subjectUrl: string | null;
}

export function MaintainerDetailPage() {
  const { boardId, maintainerId } = useParams<{ boardId: string; maintainerId: string }>();
  const { board, loading: boardLoading } = useBoard(boardId);
  const { maintainer, loading: maintainerLoading, refresh: refreshMaintainer } = useBoardMaintainer(boardId, maintainerId);
  const { runs, loading: runsLoading, refresh: refreshRuns } = useBoardMaintainerRuns(boardId, maintainerId);
  const { sessions, loading: sessionsLoading, refresh: refreshSessions } = useBoardMaintainerSessions(maintainerId);
  const { memories, loading: memoriesLoading, error: memoriesError, refresh: refreshMemories } = useBoardMaintainerMemories(boardId, maintainerId);
  const {
    variables,
    loading: variablesLoading,
    error: variablesError,
    refresh: refreshVariables,
  } = useBoardMaintainerVariables(boardId, maintainerId);
  const updateVariables = useUpdateBoardMaintainerVariables(boardId, maintainerId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<MaintainerSession | null>(null);
  const [variablesDialogOpen, setVariablesDialogOpen] = useState(false);

  useEffect(() => {
    if (memories.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && memories.some((memory: MaintainerMemory) => memory.path === selectedPath)) return;
    const heartbeat = memories.find((memory: MaintainerMemory) => memory.path === "HEARTBEAT.md");
    setSelectedPath((heartbeat ?? memories[0]).path);
  }, [memories, selectedPath]);

  if (boardLoading || maintainerLoading) return <MaintainerDetailLoading />;
  if (!board || !maintainer || !boardId) return <MaintainerDetailNotFound />;

  const selectedMemory = memories.find((memory: MaintainerMemory) => memory.path === selectedPath) ?? null;

  async function refreshAll() {
    await Promise.all([refreshMaintainer(), refreshSessions(), refreshRuns(), refreshMemories(), refreshVariables()]);
  }

  async function saveVariables(nextVariables: Record<string, string>) {
    try {
      await updateVariables.mutateAsync(nextVariables);
      setVariablesDialogOpen(false);
    } catch (error) {
      toast.error((error as Error).message || "Failed to save variables");
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-6xl p-6 sm:p-8">
        <div className="mb-6 space-y-4">
          <Link
            to={`/boards/${boardId}/settings`}
            className="inline-flex items-center gap-1.5 text-xs text-content-tertiary transition-colors hover:text-content-secondary"
          >
            <ArrowLeft className="size-3.5" />
            Board settings
          </Link>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{board.name}</p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span className={`size-2 rounded-full ${maintainer.status === "active" ? "bg-accent" : "bg-content-tertiary"}`} />
                <h1 className="truncate text-xl font-bold text-content-primary">Board maintainer</h1>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">{maintainer.status}</span>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid gap-3 rounded-lg border border-border bg-surface-secondary p-3 sm:grid-cols-5">
          <Metric label="Agent" value={maintainer.agent_id ?? "unbound"} />
          <Metric label="Heartbeat" value={maintainer.heartbeat_enabled === false ? "off" : "on"} />
          <Metric label="Interval" value={formatInterval(maintainer.interval_seconds)} />
          <Metric label="Last run" value={maintainer.last_run_at ? formatRelative(maintainer.last_run_at) : "never"} />
          <Metric label="Last session" value={maintainer.last_session_id ?? "none"} />
        </div>

        {maintainer.last_error_message ? (
          <div className="mt-4 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">{maintainer.last_error_message}</div>
        ) : null}

        <Tabs defaultValue="sessions" className="mt-8 gap-5">
          <TabsList variant="line" aria-label="Maintainer detail sections" className="border-b border-border">
            <TabsTrigger value="sessions" className="px-3 font-mono text-xs">
              Sessions
              <span className="ml-1 text-content-tertiary">{sessions.length}</span>
            </TabsTrigger>
            <TabsTrigger value="memory" className="px-3 font-mono text-xs">
              Memory
              <span className="ml-1 text-content-tertiary">{memories.length}</span>
            </TabsTrigger>
            <TabsTrigger value="variables" className="px-3 font-mono text-xs">
              Variables
              <span className="ml-1 text-content-tertiary">{variables.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="px-3 font-mono text-xs">
              Activity
              <span className="ml-1 text-content-tertiary">{runs.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sessions">
            <SessionsPanel sessions={sessions as MaintainerSession[]} loading={sessionsLoading} onOpenSession={setSelectedSession} />
          </TabsContent>

          <TabsContent value="memory">
            <MemoryPanel
              memories={memories as MaintainerMemory[]}
              loading={memoriesLoading}
              error={memoriesError}
              selectedPath={selectedPath}
              selectedMemory={selectedMemory}
              onSelect={setSelectedPath}
              onRefresh={refreshMemories}
            />
          </TabsContent>

          <TabsContent value="variables">
            <VariablesPanel
              variables={variables as MaintainerVariable[]}
              loading={variablesLoading}
              error={variablesError}
              onEdit={() => setVariablesDialogOpen(true)}
            />
          </TabsContent>

          <TabsContent value="activity">
            <ActivityPanel runs={runs as MaintainerRun[]} loading={runsLoading} onOpenSession={setSelectedSession} />
          </TabsContent>
        </Tabs>
      </main>
      <MaintainerSessionDrawer
        maintainerName={maintainer.agent_id ?? maintainer.id}
        session={selectedSession}
        onOpenChange={(open) => !open && setSelectedSession(null)}
      />
      <VariablesDialog
        open={variablesDialogOpen}
        variables={variables as MaintainerVariable[]}
        saving={updateVariables.isPending}
        onOpenChange={setVariablesDialogOpen}
        onSave={saveVariables}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-content-primary">{value}</div>
    </div>
  );
}

function SessionsPanel({
  sessions,
  loading,
  onOpenSession,
}: {
  sessions: MaintainerSession[];
  loading: boolean;
  onOpenSession: (session: MaintainerSession) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">No sessions yet.</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
      <Table>
        <TableHeader>
          <TableRow className="border-border bg-surface-secondary hover:bg-surface-secondary">
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Session</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Subject</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">State</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => {
            const github = githubSubjectFromMetadata(session.metadata);
            return (
              <TableRow key={session.id} className="border-border hover:bg-surface-tertiary">
                <TableCell className="max-w-[240px] truncate px-3 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 min-w-0 justify-start gap-2 px-1 font-mono text-xs text-accent hover:text-accent"
                    onClick={() => onOpenSession(session)}
                    title={session.id}
                  >
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span className="truncate">{session.id}</span>
                  </Button>
                </TableCell>
                <TableCell className="max-w-[360px] px-3 py-2">
                  <GithubSubjectLink subject={github} fallback={session.title ?? "No subject"} />
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">{session.state ?? "unknown"}</TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">
                  {sessionLastActivity(session) ? formatRelative(sessionLastActivity(session)!) : "unknown"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function VariablesPanel({
  variables,
  loading,
  error,
  onEdit,
}: {
  variables: MaintainerVariable[];
  loading: boolean;
  error: unknown;
  onEdit: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-3 text-sm text-error">
        {(error as Error).message || "Failed to load variables"}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-content-secondary">User variables</h2>
          <p className="mt-1 text-xs text-content-tertiary">Stored in the user-variables credential.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
      </div>

      {variables.length === 0 ? (
        <button
          type="button"
          onClick={onEdit}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-secondary px-3 py-8 text-sm text-content-tertiary transition-colors hover:border-accent/40 hover:text-content-secondary"
        >
          <KeyRound className="size-4" />
          No user variables.
        </button>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
          <Table>
            <TableHeader>
              <TableRow className="border-border bg-surface-secondary hover:bg-surface-secondary">
                <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Name</TableHead>
                <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variables.map((variable) => (
                <TableRow key={variable.name} className="border-border hover:bg-surface-tertiary">
                  <TableCell className="px-3 py-2 font-mono text-xs text-content-primary">{variable.name}</TableCell>
                  <TableCell className="px-3 py-2 font-mono text-xs text-content-tertiary">secret</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function VariablesDialog({
  open,
  variables,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  variables: MaintainerVariable[];
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (variables: Record<string, string>) => Promise<void>;
}) {
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEnvText("");
    setError(null);
  }, [open]);

  async function submit() {
    try {
      const nextVariables = parseEnvText(envText);
      setError(null);
      await onSave(nextVariables);
    } catch (err) {
      setError((err as Error).message || "Invalid variables");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>User variables</DialogTitle>
          <DialogDescription>Values are write-only. Saving updates the user-variables credential.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {variables.length > 0 ? (
            <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-content-tertiary">Current keys</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {variables.map((variable) => (
                  <span
                    key={variable.name}
                    className="rounded border border-border bg-surface-primary px-1.5 py-0.5 font-mono text-[11px] text-content-secondary"
                  >
                    {variable.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="maintainer-user-variables">Variables</Label>
            <Textarea
              id="maintainer-user-variables"
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
              spellCheck={false}
              className="min-h-48 font-mono text-xs"
              placeholder={"GH_TOKEN=...\nFEATURE_FLAG=true"}
            />
          </div>

          {error ? <p className="text-sm text-error">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnvText(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Line ${index + 1} must be NAME=value`);
    }
    const name = assignment.slice(0, separator).trim();
    const rawValue = assignment.slice(separator + 1).trim();
    if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid variable name on line ${index + 1}`);
    }
    if (Object.hasOwn(variables, name)) {
      throw new Error(`Duplicate variable ${name}`);
    }
    const value = unquoteEnvValue(rawValue);
    if (!value) {
      throw new Error(`${name} cannot be empty`);
    }
    variables[name] = value;
  }
  if (Object.keys(variables).length === 0) {
    throw new Error("At least one variable is required");
  }
  return variables;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function MaintainerSessionDrawer({
  maintainerName,
  session,
  onOpenChange,
}: {
  maintainerName: string;
  session: MaintainerSession | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={!!session} onOpenChange={onOpenChange}>
      <SheetContent showCloseButton={false} className="flex flex-col gap-0 p-0 shadow-2xl !w-[50%] max-md:!w-full">
        <SheetTitle className="sr-only">Maintainer session</SheetTitle>
        <SheetDescription className="sr-only">Maintainer runtime events</SheetDescription>
        {session ? (
          <>
            <div className="flex items-center gap-3 border-b border-border p-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[13px] text-accent">{maintainerName}</span>
                <GithubSubjectLink subject={githubSubjectFromMetadata(session.metadata)} fallback={session.title ?? session.id} compact />
                <span className="truncate font-mono text-[11px] text-content-tertiary">{session.id}</span>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)} aria-label="Close session">
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col pl-4 pb-4">
              <AmaSessionChat
                sessionId={session.id}
                taskDone={isTerminalSessionState(session.state)}
                unavailableMessage="Session history is not available for this maintainer session."
              />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ActivityPanel({
  runs,
  loading,
  onOpenSession,
}: {
  runs: MaintainerRun[];
  loading: boolean;
  onOpenSession: (session: MaintainerSession) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">No activity yet.</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
      <Table>
        <TableHeader>
          <TableRow className="border-border bg-surface-secondary hover:bg-surface-secondary">
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Subject</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Event</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Status</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Session</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Time</TableHead>
            <TableHead className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const github = githubSubjectFromMetadata(run.metadata);
            const session = run.session_id ? ({ id: run.session_id, metadata: run.metadata } satisfies MaintainerSession) : null;
            return (
              <TableRow key={run.id} className="border-border hover:bg-surface-tertiary">
                <TableCell className="max-w-[360px] px-3 py-2" title={run.id}>
                  <GithubSubjectLink subject={github} fallback={run.id} />
                </TableCell>
                <TableCell className="px-3 py-2">
                  <RunEventLink run={run} github={github} />
                </TableCell>
                <TableCell className="px-3 py-2">
                  <Badge variant={runStatusBadgeVariant(run.status)}>{run.status}</Badge>
                </TableCell>
                <TableCell className="max-w-[180px] truncate px-3 py-2" title={run.session_id ?? ""}>
                  {session ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 min-w-0 justify-start gap-2 px-1 font-mono text-xs text-accent hover:text-accent"
                      onClick={() => onOpenSession(session)}
                    >
                      <MessageSquare className="size-3.5 shrink-0" />
                      <span className="truncate">{session.id}</span>
                    </Button>
                  ) : (
                    <span className="font-mono text-xs text-content-secondary">none</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs text-content-secondary">
                  {runTimestamp(run) ? formatRelative(runTimestamp(run)!) : "unknown"}
                </TableCell>
                <TableCell className="max-w-[220px] truncate px-3 py-2 text-xs text-error">{run.error_message ?? ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function runStatusBadgeVariant(status: MaintainerRun["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "dispatching") return "default";
  if (status === "dispatched") return "outline";
  return "secondary";
}

function MemoryPanel({
  memories,
  loading,
  error,
  selectedPath,
  selectedMemory,
  onSelect,
  onRefresh,
}: {
  memories: MaintainerMemory[];
  loading: boolean;
  error: unknown;
  selectedPath: string | null;
  selectedMemory: MaintainerMemory | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-8 text-center text-sm text-error">
        {error instanceof Error ? error.message : "Unable to load memory files"}
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-secondary px-3 py-8 text-center text-sm text-content-tertiary">
        No memory files yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-secondary">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Files</span>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh memory files" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        <div className="max-h-[640px] overflow-auto">
          {memories.map((memory) => {
            const selected = memory.path === selectedPath;
            return (
              <button
                key={memory.id}
                type="button"
                onClick={() => onSelect(memory.path)}
                className={`flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 ${
                  selected ? "bg-accent/10 text-content-primary" : "text-content-secondary hover:bg-surface-tertiary"
                }`}
              >
                <FileText className={`mt-0.5 size-3.5 shrink-0 ${selected ? "text-accent" : "text-content-tertiary"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{memory.path}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-content-tertiary">Updated {formatRelative(memory.updated_at)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary">
        {selectedMemory ? (
          <>
            <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="truncate font-mono text-sm font-medium text-content-primary">{selectedMemory.path}</h2>
              <span className="font-mono text-[10px] text-content-tertiary">Updated {formatDate(selectedMemory.updated_at)}</span>
            </div>
            <div className="max-h-[640px] overflow-auto p-4">
              <div className="text-sm leading-relaxed text-content-secondary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-content-primary [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-content-primary [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-content-primary [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-primary [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_code]:rounded [&_code]:bg-surface-primary [&_code]:px-1 [&_code]:font-mono [&_code]:text-accent [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-content-secondary [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-content-tertiary">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {selectedMemory.content}
                </ReactMarkdown>
              </div>
            </div>
          </>
        ) : (
          <div className="px-3 py-8 text-center text-sm text-content-tertiary">Select a memory file.</div>
        )}
      </div>
    </div>
  );
}

function formatInterval(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function runEvent(run: MaintainerRun, github: GithubSubject | null) {
  if (github?.event) return github.action ? `${github.event}.${github.action}` : github.event;
  if (run.scheduled_for || run.heartbeat_at) return "scheduled";
  const event = run.metadata?.event;
  return typeof event === "string" ? event : "event";
}

function RunEventLink({ run, github }: { run: MaintainerRun; github: GithubSubject | null }) {
  const label = runEvent(run, github);
  const url = runSourceUrl(run);
  if (!url) return <span className="font-mono text-xs text-content-secondary">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs text-accent hover:underline"
      title={url}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 text-content-tertiary" />
    </a>
  );
}

function runSourceUrl(run: MaintainerRun): string | null {
  const metadataObject = objectValue(run.metadata);
  const sessionMetadata = objectValue(metadataObject?.sessionMetadata);
  return metadataString(metadataObject, sessionMetadata, "annotation", AK_ANNOTATION_KEY_SOURCE_URL);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function githubSubjectFromMetadata(metadata: Record<string, unknown> | undefined): GithubSubject | null {
  const metadataObject = objectValue(metadata);
  const sessionMetadata = objectValue(metadataObject?.sessionMetadata);
  const sessionKey = metadataString(metadataObject, sessionMetadata, "label", AK_LABEL_KEY_GITHUB_SUBJECT);
  const subject = sessionKey ? githubSubjectFromSessionKey(sessionKey) : null;
  if (!subject) return null;
  return {
    ...subject,
    event: metadataString(metadataObject, sessionMetadata, "annotation", AK_ANNOTATION_KEY_SOURCE_EVENT),
    action: null,
  };
}

function metadataString(
  metadata: Record<string, unknown> | null,
  sessionMetadata: Record<string, unknown> | null,
  source: "label" | "annotation",
  key: string,
): string | null {
  const collectionName = source === "label" ? "labels" : "annotations";
  const metadataCollection = objectValue(metadata?.[collectionName]);
  const sessionCollection = objectValue(sessionMetadata?.[collectionName]);
  return (
    stringValue(metadata?.[key]) ??
    stringValue(metadataCollection?.[key]) ??
    stringValue(sessionMetadata?.[key]) ??
    stringValue(sessionCollection?.[key])
  );
}

function githubSubjectFromSessionKey(sessionKey: string): GithubSubject | null {
  const match = /^github:([^:]+):(issue|pull):(\d+)$/.exec(sessionKey);
  if (!match) return null;
  const repository = match[1];
  const subjectType = match[2] as "issue" | "pull";
  const subjectNumber = Number.parseInt(match[3], 10);
  const subjectPath = subjectType === "pull" ? "pull" : "issues";
  return {
    event: null,
    action: null,
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    subjectType,
    subjectNumber,
    subjectTitle: null,
    subjectUrl: `https://github.com/${repository}/${subjectPath}/${subjectNumber}`,
  };
}

function githubSubjectLabel(subject: GithubSubject | null, fallback: string) {
  if (!subject) return fallback;
  const number = subject.subjectNumber === null ? "" : `#${subject.subjectNumber}`;
  const repo = subject.repository ?? "GitHub";
  const kind = subject.subjectType === "pull" ? "PR" : subject.subjectType === "issue" ? "Issue" : "Item";
  return `${repo} ${kind} ${number}`.trim();
}

function GithubSubjectLink({ subject, fallback, compact = false }: { subject: GithubSubject | null; fallback: string; compact?: boolean }) {
  const label = githubSubjectLabel(subject, fallback);
  const title = subject?.subjectTitle;
  if (!subject?.subjectUrl) {
    return (
      <div className="min-w-0">
        <div className={`truncate font-mono ${compact ? "text-[11px]" : "text-xs"} text-content-secondary`}>{label}</div>
        {title && !compact ? <div className="mt-0.5 truncate text-xs text-content-tertiary">{title}</div> : null}
      </div>
    );
  }
  return (
    <a
      href={subject.subjectUrl}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 font-mono ${compact ? "text-[11px]" : "text-xs"} text-accent hover:underline`}
      title={title ?? subject.subjectUrl}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 text-content-tertiary" />
    </a>
  );
}

function runTimestamp(run: MaintainerRun): string | null {
  return run.heartbeat_at ?? run.triggered_at ?? run.created_at ?? null;
}

function sessionLastActivity(session: MaintainerSession): string | null {
  return session.updatedAt ?? session.stoppedAt ?? session.startedAt ?? session.createdAt ?? null;
}

function isTerminalSessionState(state: string | null | undefined) {
  return state === "stopped" || state === "error";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function MaintainerDetailLoading() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-6xl space-y-4 p-6 sm:p-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-80 rounded-lg" />
      </main>
    </div>
  );
}

function MaintainerDetailNotFound() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="flex min-h-[60vh] items-center justify-center text-content-tertiary">Maintainer not found</div>
    </div>
  );
}
