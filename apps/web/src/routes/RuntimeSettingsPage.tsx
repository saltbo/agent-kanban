import {
  DEFAULT_RUNTIME_SETTINGS,
  MAX_SKILL_CACHE_REFRESH_HOURS,
  MIN_SKILL_CACHE_REFRESH_HOURS,
  type RuntimeSettings,
  validateRuntimeSettings,
} from "@agent-kanban/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { api } from "../lib/api";

function settingsEqual(a: RuntimeSettings, b: RuntimeSettings): boolean {
  return a.skill_cache_auto_update === b.skill_cache_auto_update && a.skill_cache_refresh_hours === b.skill_cache_refresh_hours;
}

export function RuntimeSettingsPage() {
  const queryClient = useQueryClient();
  const { data: saved } = useQuery({ queryKey: ["settings", "runtime"], queryFn: () => api.settings.getRuntime() });
  const [autoUpdate, setAutoUpdate] = useState(DEFAULT_RUNTIME_SETTINGS.skill_cache_auto_update);
  const [refreshHours, setRefreshHours] = useState(String(DEFAULT_RUNTIME_SETTINGS.skill_cache_refresh_hours));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setAutoUpdate(saved.skill_cache_auto_update);
    setRefreshHours(String(saved.skill_cache_refresh_hours));
  }, [saved]);

  const parsedHours = Number(refreshHours);
  const draft: RuntimeSettings = {
    skill_cache_auto_update: autoUpdate,
    skill_cache_refresh_hours: parsedHours,
  };
  const validationError = validateRuntimeSettings(draft);
  const isDirty = !!saved && !settingsEqual(draft, saved);
  const canSave = isDirty && validationError === null && !saving;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const next = await api.settings.putRuntime(draft);
      queryClient.setQueryData(["settings", "runtime"], next);
      toast.success("Runtime settings saved");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save runtime settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 flex-1 space-y-6">
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-content-primary">Runtime</h1>
        <p className="mt-1 text-sm text-content-secondary">Control how local machines persist and refresh agent skills.</p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <section className="space-y-3">
          <div className="flex items-start gap-3 rounded-md bg-surface-secondary p-4">
            <input
              id="skill-cache-auto-update"
              type="checkbox"
              checked={autoUpdate}
              onChange={(event) => setAutoUpdate(event.target.checked)}
              className="mt-0.5 size-4 accent-accent"
            />
            <div className="space-y-1">
              <Label htmlFor="skill-cache-auto-update" className="text-sm font-medium text-content-primary">
                Automatically update cached skills
              </Label>
              <p className="text-xs text-content-tertiary">
                Machines keep immutable local snapshots and refresh upstream sources in the background. Failed refreshes retain the last-known-good
                copy.
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-5">
          <Label htmlFor="skill-cache-refresh-hours" className="text-xs uppercase tracking-[0.06em] text-content-tertiary">
            Refresh interval (hours)
          </Label>
          <Input
            id="skill-cache-refresh-hours"
            type="number"
            min={MIN_SKILL_CACHE_REFRESH_HOURS}
            max={MAX_SKILL_CACHE_REFRESH_HOURS}
            step={1}
            value={refreshHours}
            onChange={(event) => setRefreshHours(event.target.value)}
            disabled={!autoUpdate}
            aria-invalid={validationError !== null}
            className="max-w-32 font-mono"
          />
          <p className="text-xs text-content-tertiary">
            From {MIN_SKILL_CACHE_REFRESH_HOURS} to {MAX_SKILL_CACHE_REFRESH_HOURS} hours. The default is 24 hours; changes reach online machines on
            their next heartbeat.
          </p>
        </section>

        {validationError && isDirty && (
          <p role="alert" className="text-sm text-error">
            {validationError}
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={!canSave}>
            {saving ? "Saving..." : "Save runtime"}
          </Button>
          {!isDirty && <p className="text-xs text-content-tertiary">No unsaved changes</p>}
        </div>
      </form>
    </main>
  );
}
