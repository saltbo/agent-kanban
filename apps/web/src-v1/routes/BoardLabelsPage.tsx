import type { BoardLabel } from "@agent-kanban/shared";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { DeleteLabelDialog, LabelFormDialog, type LabelFormMode } from "../components/BoardLabelDialogs";
import { BoardSettingsNav } from "../components/BoardSettingsNav";
import { Header } from "../components/Header";
import { LabelChip } from "../components/LabelChip";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { useBoard, useCreateBoardLabel, useDeleteBoardLabel, useUpdateBoardLabel } from "../hooks/useBoard";

export function BoardLabelsPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { board, loading } = useBoard(boardId);
  const [formMode, setFormMode] = useState<LabelFormMode>("create");
  const [formOpen, setFormOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<BoardLabel | null>(null);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createLabel = useCreateBoardLabel();
  const updateLabel = useUpdateBoardLabel();
  const deleteLabel = useDeleteBoardLabel();

  if (loading) return <BoardLabelsLoading />;
  if (!board || !boardId) return <BoardLabelsNotFound />;
  const currentBoardId = boardId;

  function openCreateDialog() {
    setError(null);
    setFormMode("create");
    setEditingLabel(null);
    setFormOpen(true);
  }

  function openEditDialog(label: BoardLabel) {
    setError(null);
    setFormMode("edit");
    setEditingLabel(label);
    setFormOpen(true);
  }

  async function submitLabel(input: BoardLabel) {
    setError(null);
    try {
      if (formMode === "create") {
        await createLabel.mutateAsync({ boardId: currentBoardId, ...input });
      } else {
        await updateLabel.mutateAsync({
          boardId: currentBoardId,
          name: editingLabel!.name,
          nextName: input.name,
          color: input.color,
          description: input.description,
        });
      }
      setFormOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save label");
    }
  }

  async function confirmDeleteLabel() {
    setError(null);
    try {
      await deleteLabel.mutateAsync({ boardId: currentBoardId, name: deleteName! });
      setDeleteName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete label");
    }
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl p-6 sm:p-8">
        <div className="mb-6 space-y-4">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{board.name}</p>
            <h1 className="mt-1 text-xl font-bold text-content-primary">Labels</h1>
          </div>
          <BoardSettingsNav boardId={currentBoardId} />
        </div>

        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h2>Board labels</h2>
            </CardTitle>
            <CardDescription>Labels are available to tasks on this board.</CardDescription>
            <CardAction>
              <Button size="sm" onClick={openCreateDialog}>
                Add label
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent>
            {board.labels?.length ? (
              <ul className="overflow-hidden rounded-lg border border-border">
                {board.labels.map((label: BoardLabel) => (
                  <li
                    key={label.name}
                    className="grid grid-cols-[minmax(96px,auto)_1fr_auto] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <LabelChip name={label.name} color={label.color} description={label.description} />
                    </div>
                    <p className="min-w-0 truncate text-xs text-content-tertiary">{label.description || "No description"}</p>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit label ${label.name}`} onClick={() => openEditDialog(label)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete label ${label.name}`}
                        onClick={() => {
                          setError(null);
                          setDeleteName(label.name);
                        }}
                      >
                        <Trash2 className="size-3.5 text-error" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm text-content-tertiary">No labels yet.</p>
            )}
          </CardContent>
        </Card>
      </main>

      <LabelFormDialog
        mode={formMode}
        open={formOpen}
        initialLabel={editingLabel}
        pending={createLabel.isPending || updateLabel.isPending}
        error={formOpen ? error : null}
        onClose={() => setFormOpen(false)}
        onSubmit={submitLabel}
      />
      <DeleteLabelDialog
        labelName={deleteName}
        pending={deleteLabel.isPending}
        error={deleteName ? error : null}
        onClose={() => setDeleteName(null)}
        onConfirm={confirmDeleteLabel}
      />
    </div>
  );
}

function BoardLabelsLoading() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl space-y-4 p-6 sm:p-8">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-44 rounded-lg" />
      </main>
    </div>
  );
}

function BoardLabelsNotFound() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="flex min-h-[60vh] items-center justify-center text-content-tertiary">Board not found</div>
    </div>
  );
}
