import type { BoardLabel } from "@agent-kanban/shared";
import { Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { LabelChip } from "./LabelChip";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type LabelFormMode = "create" | "edit";

const LABEL_COLORS = ["#22D3EE", "#22C55E", "#EAB308", "#EF4444", "#A78BFA", "#F97316", "#38BDF8", "#F472B6"];

function randomLabelColor() {
  return LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
}

interface LabelFormDialogProps {
  mode: LabelFormMode;
  open: boolean;
  initialLabel: BoardLabel | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: BoardLabel) => void;
}

export function LabelFormDialog(props: LabelFormDialogProps) {
  const { mode, open, initialLabel, pending, error, onClose, onSubmit } = props;
  const [name, setName] = useState("");
  const [color, setColor] = useState("#71717A");
  const [description, setDescription] = useState("");

  useEffect(() => {
    setName(initialLabel?.name ?? "");
    setColor(initialLabel?.color ?? "#71717A");
    setDescription(initialLabel?.description ?? "");
  }, [initialLabel, open]);

  function submit() {
    onSubmit({ name: name.trim(), color, description: description.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add label" : "Edit label"}</DialogTitle>
          <DialogDescription className="sr-only">Configure board label name, color, and description</DialogDescription>
        </DialogHeader>

        <LabelFormFields name={name} color={color} description={description} onName={setName} onColor={setColor} onDescription={setDescription} />
        {error && <p className="text-xs text-error">{error}</p>}
        <div className="flex">
          <LabelChip name={name.trim() || "label-name"} color={color} description={description.trim()} />
        </div>

        <DialogFooter className="flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Saving..." : mode === "create" ? "Add label" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LabelFormFieldsProps {
  name: string;
  color: string;
  description: string;
  onName: (value: string) => void;
  onColor: (value: string) => void;
  onDescription: (value: string) => void;
}

function LabelFormFields(props: LabelFormFieldsProps) {
  const { name, color, description, onName, onColor, onDescription } = props;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs text-content-tertiary" htmlFor="label-name">
          Label name
        </Label>
        <Input id="label-name" value={name} onChange={(event) => onName(event.target.value)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="label-color">
            Label color
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="label-color"
              type="color"
              value={color}
              onChange={(event) => onColor(event.target.value)}
              className="h-9 w-14 cursor-pointer p-1"
            />
            <Button type="button" variant="outline" size="icon-sm" aria-label="Random color" onClick={() => onColor(randomLabelColor())}>
              <Shuffle className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-content-tertiary" htmlFor="label-description">
            Label description
          </Label>
          <Input id="label-description" value={description} onChange={(event) => onDescription(event.target.value)} />
        </div>
      </div>
    </div>
  );
}

interface DeleteLabelDialogProps {
  labelName: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteLabelDialog({ labelName, pending, error, onClose, onConfirm }: DeleteLabelDialogProps) {
  return (
    <Dialog open={!!labelName} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete label</DialogTitle>
          <DialogDescription>Delete {labelName ? `"${labelName}"` : "this label"} from this board and remove it from all tasks.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-error">{error}</p>}
        <DialogFooter className="flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
