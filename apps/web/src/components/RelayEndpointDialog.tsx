/**
 * Config dialog for a relay endpoint — the Claude Code env parameters for a
 * Kimi/DeepSeek-style relay (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL, per-tier
 * model mappings, plus any extra CLAUDE_CODE_* env as JSON).
 *
 * Token semantics: write-only. Editing shows the masked token as a
 * placeholder; submitting with the field empty keeps the stored token (the
 * key is omitted from the PUT body). The server probes the relay before
 * saving, so an invalid token surfaces here as the submit error.
 */
import {
  type RelayEndpointConfig,
  type RelayEndpointInput,
  type RelayKindInput,
  type RelayModelMap,
  validateRelayEndpointInput,
} from "@agent-kanban/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

const KIND_OPTIONS: { value: RelayKindInput; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "kimi", label: "Kimi" },
  { value: "deepseek", label: "DeepSeek" },
];

const MODEL_TIERS = ["opus", "sonnet", "haiku", "fable"] as const;
type ModelTier = (typeof MODEL_TIERS)[number];

interface RelayEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Undefined = create. */
  endpoint?: RelayEndpointConfig;
}

export function RelayEndpointDialog({ open, onOpenChange, endpoint }: RelayEndpointDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RelayKindInput>("auto");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [modelMap, setModelMap] = useState<Record<ModelTier, { model: string; model_name: string }>>({
    opus: { model: "", model_name: "" },
    sonnet: { model: "", model_name: "" },
    haiku: { model: "", model_name: "" },
    fable: { model: "", model_name: "" },
  });
  const [extraEnv, setExtraEnv] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(endpoint?.name ?? "");
    setKind(endpoint?.kind ?? "auto");
    setBaseUrl(endpoint?.base_url ?? "");
    setToken("");
    setModel(endpoint?.model ?? "");
    setModelMap({
      opus: { model: endpoint?.model_map.opus?.model ?? "", model_name: endpoint?.model_map.opus?.model_name ?? "" },
      sonnet: { model: endpoint?.model_map.sonnet?.model ?? "", model_name: endpoint?.model_map.sonnet?.model_name ?? "" },
      haiku: { model: endpoint?.model_map.haiku?.model ?? "", model_name: endpoint?.model_map.haiku?.model_name ?? "" },
      fable: { model: endpoint?.model_map.fable?.model ?? "", model_name: endpoint?.model_map.fable?.model_name ?? "" },
    });
    setExtraEnv(endpoint && Object.keys(endpoint.extra_env).length > 0 ? JSON.stringify(endpoint.extra_env, null, 2) : "");
    setError(null);
    setPending(false);
  }, [open, endpoint]);

  function buildInput(): RelayEndpointInput | { error: string } {
    let parsedExtraEnv: Record<string, string> | undefined;
    if (extraEnv.trim()) {
      try {
        const parsed: unknown = JSON.parse(extraEnv);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "Extra env must be a JSON object" };
        for (const value of Object.values(parsed)) {
          if (typeof value !== "string") return { error: "Extra env values must be strings" };
        }
        parsedExtraEnv = parsed as Record<string, string>;
      } catch {
        return { error: "Extra env is not valid JSON" };
      }
    }
    const map: RelayModelMap = {};
    for (const tier of MODEL_TIERS) {
      const entry = modelMap[tier];
      if (entry.model.trim() || entry.model_name.trim()) {
        map[tier] = {
          ...(entry.model.trim() ? { model: entry.model.trim() } : {}),
          ...(entry.model_name.trim() ? { model_name: entry.model_name.trim() } : {}),
        };
      }
    }
    const input: RelayEndpointInput = {
      name: name.trim(),
      kind,
      base_url: baseUrl.trim(),
      ...(token.trim() ? { token: token.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      model_map: map,
      extra_env: parsedExtraEnv ?? {},
    };
    const validationError = validateRelayEndpointInput(input, { requireToken: !endpoint });
    if (validationError) return { error: validationError };
    return input;
  }

  async function submit() {
    const built = buildInput();
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (endpoint) {
        await api.relays.update(endpoint.id, built);
        toast.success(`Updated relay "${built.name}"`);
      } else {
        await api.relays.create(built);
        toast.success(`Added relay "${built.name}"`);
      }
      await queryClient.invalidateQueries({ queryKey: ["relays"] });
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{endpoint ? "Edit relay" : "Add relay"}</DialogTitle>
          <DialogDescription className="sr-only">
            {endpoint ? "Edit the relay endpoint configuration" : "Configure a Kimi/DeepSeek relay endpoint"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="relay-name">Name</Label>
              <Input id="relay-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kimi relay" autoFocus />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => v && setKind(v as RelayKindInput)}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue>{(v: string) => KIND_OPTIONS.find((o) => o.value === v)?.label ?? v}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="relay-base-url">Base URL</Label>
            <Input
              id="relay-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.kimi.com/coding/v1"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-content-tertiary">
              ANTHROPIC_BASE_URL. Auto-detect recognizes api.kimi.com and api.deepseek.com; other hosts need an explicit kind.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="relay-token">Token{!endpoint && <span className="text-error"> *</span>}</Label>
            <Input
              id="relay-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={endpoint ? endpoint.masked_token : "sk-..."}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-[11px] text-content-tertiary">
              ANTHROPIC_AUTH_TOKEN. Validated against the relay before saving.{endpoint && " Leave empty to keep the current token."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="relay-model">Primary model</Label>
            <Input
              id="relay-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="kimi-for-coding"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Model mappings</Label>
            <div className="space-y-2">
              {MODEL_TIERS.map((tier) => (
                <div key={tier} className="grid grid-cols-[72px_1fr_1fr] items-center gap-2">
                  <span className="font-mono text-[11px] capitalize text-content-tertiary">{tier}</span>
                  <Input
                    aria-label={`${tier} model`}
                    value={modelMap[tier].model}
                    onChange={(e) => setModelMap((prev) => ({ ...prev, [tier]: { ...prev[tier], model: e.target.value } }))}
                    placeholder="MODEL"
                    className="font-mono text-xs"
                  />
                  <Input
                    aria-label={`${tier} model name`}
                    value={modelMap[tier].model_name}
                    onChange={(e) => setModelMap((prev) => ({ ...prev, [tier]: { ...prev[tier], model_name: e.target.value } }))}
                    placeholder="MODEL_NAME"
                    className="font-mono text-xs"
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-content-tertiary">ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU/FABLE_MODEL(+_NAME). Empty rows are omitted.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="relay-extra-env">Extra env (JSON)</Label>
            <Textarea
              id="relay-extra-env"
              value={extraEnv}
              onChange={(e) => setExtraEnv(e.target.value)}
              placeholder={'{\n  "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"\n}'}
              rows={3}
              className="resize-none font-mono text-xs"
            />
          </div>

          {error && <p className="text-xs text-error">{error}</p>}
        </div>

        <DialogFooter className="flex-col sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? "Validating…" : endpoint ? "Save" : "Add relay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
