/**
 * JSON import dialog for relay endpoints — paste or pick a CC-Switch-style
 * config file (accepted shapes are documented on parseRelayImport in shared).
 * Each parsed block imports as its own relay; the server probes every token
 * before saving, so per-entry failures surface inline next to the entry.
 */
import { parseRelayImport } from "@agent-kanban/shared";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, FileJson, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";

/** Per-entry import outcome, keyed by entry index. */
type Outcomes = Record<number, { ok: boolean; message?: string }>;

export function RelayImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcomes>({});

  useEffect(() => {
    if (!open) return;
    setText("");
    setOutcomes({});
    setImporting(false);
  }, [open]);

  const parsed = useMemo(() => (text.trim() ? parseRelayImport(text) : null), [text]);
  const importable = useMemo(
    () => (parsed ? parsed.entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => entry.input && !outcomes[index]?.ok) : []),
    [parsed, outcomes],
  );

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
    setOutcomes({});
  }

  async function importAll() {
    if (!parsed || importable.length === 0) return;
    setImporting(true);
    let succeeded = 0;
    let failed = 0;
    for (const { entry, index } of importable) {
      try {
        await api.relays.create(entry.input!);
        succeeded++;
        setOutcomes((prev) => ({ ...prev, [index]: { ok: true } }));
      } catch (err) {
        failed++;
        setOutcomes((prev) => ({ ...prev, [index]: { ok: false, message: (err as Error).message } }));
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["relays"] });
    setImporting(false);
    if (failed === 0) {
      toast.success(`Imported ${succeeded} ${succeeded === 1 ? "relay" : "relays"}`);
      onOpenChange(false);
    } else {
      toast.error(`${failed} of ${succeeded + failed} relays failed to import — see inline errors`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import relays from JSON</DialogTitle>
          <DialogDescription className="sr-only">Import relay endpoint configs from a JSON file</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Textarea
              aria-label="Relay config JSON"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setOutcomes({});
              }}
              placeholder={'{\n  "kimi": {\n    "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding/",\n    "ANTHROPIC_AUTH_TOKEN": "sk-..."\n  }\n}'}
              rows={8}
              className="resize-none font-mono text-xs"
              autoFocus
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-content-tertiary">
                Named env blocks or a settings.json env object; concatenated documents are supported.
              </p>
              <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileJson className="size-3.5" />
                Choose file
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.cfg,.txt,application/json"
                className="hidden"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {parsed && (
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] uppercase tracking-wider text-content-tertiary">
                {parsed.entries.length} {parsed.entries.length === 1 ? "entry" : "entries"} parsed
              </p>
              <div className="space-y-1">
                {parsed.entries.map((entry, index) => {
                  const outcome = outcomes[index];
                  return (
                    <div
                      key={`${entry.source}-${index}`}
                      className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface-secondary px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs text-content-primary">{entry.input?.name ?? entry.source}</p>
                        {entry.input && <p className="truncate font-mono text-[10px] text-content-tertiary">{entry.input.base_url}</p>}
                        {(entry.error ?? outcome?.message) && <p className="mt-0.5 text-[11px] text-error">{entry.error ?? outcome?.message}</p>}
                      </div>
                      <span className="shrink-0 pt-0.5">
                        {outcome?.ok ? (
                          <CircleCheck className="size-3.5 text-success" />
                        ) : entry.error || outcome?.ok === false ? (
                          <CircleX className="size-3.5 text-error" />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void importAll()} disabled={importing || importable.length === 0} className={cn(importing && "opacity-80")}>
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            {importing ? "Importing…" : `Import ${importable.length > 0 ? importable.length : ""} ${importable.length === 1 ? "relay" : "relays"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
