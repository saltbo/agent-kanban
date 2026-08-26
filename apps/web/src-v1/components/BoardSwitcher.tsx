import { useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

interface Board {
  id: string;
  name: string;
  description?: string | null;
}

interface BoardSwitcherProps {
  boards: Board[];
  activeBoardId: string | null;
  onSelect: (boardId: string) => void;
  onCreate: (name: string, type: "dev" | "ops") => void;
  onClose: () => void;
}

export function BoardSwitcher({ boards, activeBoardId, onSelect, onCreate, onClose }: BoardSwitcherProps) {
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"dev" | "ops">("dev");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    onCreate(name, newType);
    setNewName("");
    setNewType("dev");
    setCreating(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-[11px] font-mono font-medium text-content-tertiary uppercase tracking-[0.08em]">Switch Board</DialogTitle>
          <DialogDescription className="sr-only">Select a board to switch to</DialogDescription>
        </DialogHeader>

        {/* Board list */}
        <div className="max-h-[320px] overflow-y-auto -mx-4 px-1.5">
          {boards.map((b) => {
            const isActive = b.id === activeBoardId;
            return (
              <button
                key={b.id}
                onClick={() => {
                  onSelect(b.id);
                  onClose();
                }}
                className={`w-full text-left px-3.5 py-3 rounded-lg transition-colors group ${
                  isActive ? "bg-accent-soft" : "hover:bg-surface-tertiary"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-accent" : "bg-transparent"}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium truncate ${isActive ? "text-accent" : "text-content-primary"}`}>{b.name}</div>
                    {b.description && <div className="text-xs text-content-tertiary truncate mt-0.5">{b.description}</div>}
                  </div>
                </div>
              </button>
            );
          })}

          {boards.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-content-tertiary">No boards yet</p>
            </div>
          )}
        </div>

        {/* Footer: create */}
        <div className="border-t border-border -mx-4 px-4 pt-3 -mb-4 pb-4">
          {creating ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="Board name"
                  autoFocus
                />
                <Button onClick={handleCreate} disabled={!newName.trim()} size="sm">
                  Create
                </Button>
              </div>
              <div className="flex gap-1.5">
                {(["dev", "ops"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setNewType(t)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      newType === t ? "bg-accent text-white" : "bg-surface-tertiary text-content-secondary hover:text-content-primary"
                    }`}
                  >
                    {t === "dev" ? "Dev" : "Ops"}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)} className="w-full justify-start text-content-tertiary">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New board
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
