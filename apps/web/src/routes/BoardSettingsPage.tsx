import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { BoardSettingsNav } from "../components/BoardSettingsNav";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { useBoard, useDeleteBoard, useUpdateBoard } from "../hooks/useBoard";

interface BoardSettingsBoard {
  id: string;
  name: string;
  description?: string | null;
}

export function BoardSettingsPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { board, loading } = useBoard(boardId);

  if (loading) return <BoardSettingsLoading />;
  if (!board || !boardId) return <BoardSettingsNotFound />;

  return <BoardSettingsContent board={board} boardId={boardId} />;
}

function BoardSettingsContent({ board, boardId }: { board: BoardSettingsBoard; boardId: string }) {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl p-6 sm:p-8">
        <div className="mb-6 space-y-4">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-content-tertiary">{board.name}</p>
            <h1 className="mt-1 text-xl font-bold text-content-primary">Board settings</h1>
          </div>
          <BoardSettingsNav boardId={boardId} />
        </div>

        <BoardDetailsSection board={board} boardId={boardId} />
        <BoardDangerSection board={board} />
      </main>
    </div>
  );
}

function BoardDetailsSection({ board, boardId }: { board: BoardSettingsBoard; boardId: string }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const updateBoard = useUpdateBoard();

  useEffect(() => {
    setName(board.name);
    setDescription(board.description || "");
  }, [board.id]);

  const hasChanges = name.trim() !== board.name || description.trim() !== (board.description || "");

  async function save() {
    try {
      await updateBoard.mutateAsync({ id: boardId, name: name.trim(), description: description.trim() });
      toast.success("Board settings saved");
    } catch {
      toast.error("Failed to save board settings");
    }
  }

  return (
    <Card size="sm">
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="board-name">
            Name
          </Label>
          <Input id="board-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="board-description">
            Description
          </Label>
          <Textarea
            id="board-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="What is this board for?"
            className="resize-none"
          />
        </div>
      </CardContent>

      <CardFooter className="justify-end border-t-0 bg-transparent pt-0">
        <Button onClick={save} disabled={updateBoard.isPending || !name.trim() || !hasChanges}>
          {updateBoard.isPending ? "Saving..." : "Save"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function BoardDangerSection({ board }: { board: BoardSettingsBoard }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const deleteBoard = useDeleteBoard();
  const navigate = useNavigate();

  async function deleteCurrentBoard() {
    await deleteBoard.mutateAsync(board.id);
    navigate("/");
  }

  return (
    <Card className="mt-6 ring-error/30" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Delete board</h2>
        </CardTitle>
        <CardDescription>Deletes this board and its tasks. This cannot be undone.</CardDescription>
        <CardAction>
          <Button variant="destructive" size="xs" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </CardAction>
      </CardHeader>
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setConfirmId("");
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete board</DialogTitle>
            <DialogDescription>Type this board ID to confirm deletion: {board.id}</DialogDescription>
          </DialogHeader>
          <Input
            value={confirmId}
            onChange={(event) => setConfirmId(event.target.value)}
            placeholder={board.id}
            aria-label="Board ID confirmation"
            className="font-mono"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteCurrentBoard} disabled={deleteBoard.isPending || confirmId !== board.id}>
              {deleteBoard.isPending ? "Deleting..." : "Delete board"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function BoardSettingsLoading() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-2xl space-y-4 p-6 sm:p-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-36 rounded-lg" />
      </main>
    </div>
  );
}

function BoardSettingsNotFound() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="flex min-h-[60vh] items-center justify-center text-content-tertiary">Board not found</div>
    </div>
  );
}
