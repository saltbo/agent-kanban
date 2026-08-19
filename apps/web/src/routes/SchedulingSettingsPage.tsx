import {
  DEFAULT_SCHEDULING_SETTINGS,
  isValidTimezone,
  type PeakWindow,
  type SchedulingSettings,
  validateSchedulingSettings,
} from "@agent-kanban/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { api } from "../lib/api";

const COMMON_TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];

function settingsEqual(a: SchedulingSettings, b: SchedulingSettings): boolean {
  return (
    a.timezone === b.timezone &&
    a.peak_windows.length === b.peak_windows.length &&
    a.peak_windows.every((w, i) => w.start === b.peak_windows[i].start && w.end === b.peak_windows[i].end)
  );
}

/**
 * Peak-pricing windows for relay-backed runtimes (DeepSeek). During a peak
 * window the runtime reports itself limited and local dispatch holds new
 * tasks until the window ends; changes reach daemons via their next
 * heartbeat (~30s).
 */
export function SchedulingSettingsPage() {
  const queryClient = useQueryClient();
  const { data: saved } = useQuery({ queryKey: ["settings", "scheduling"], queryFn: () => api.settings.getScheduling() });

  const [windows, setWindows] = useState<PeakWindow[]>([]);
  const [timezone, setTimezone] = useState(DEFAULT_SCHEDULING_SETTINGS.timezone);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setWindows(saved.peak_windows.map((w) => ({ ...w })));
    setTimezone(saved.timezone);
  }, [saved]);

  const draft: SchedulingSettings = { peak_windows: windows, timezone: timezone.trim() };
  const validationError = validateSchedulingSettings(draft);
  // Not dirty until the saved settings have loaded — arming Save during the
  // initial empty-state would let a fast click clobber stored windows.
  const isDirty = !!saved && !settingsEqual(draft, { peak_windows: saved.peak_windows, timezone: saved.timezone });
  const canSave = isDirty && validationError === null && !saving;

  function updateWindow(index: number, patch: Partial<PeakWindow>) {
    setWindows((prev) => prev.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const next = await api.settings.putScheduling(draft);
      queryClient.setQueryData(["settings", "scheduling"], next);
      toast.success("Scheduling settings saved");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save scheduling settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 flex-1 space-y-6">
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-content-primary">Scheduling</h1>
        <p className="mt-1 text-sm text-content-secondary">
          Peak-pricing windows for metered relays (e.g. DeepSeek). Tasks are not dispatched during peak hours.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <section className="space-y-3">
          <Label className="text-xs uppercase tracking-[0.06em] text-content-tertiary">Peak windows</Label>
          {windows.length === 0 && <p className="text-sm text-content-tertiary">No peak windows — tasks are dispatched around the clock.</p>}
          {windows.map((window, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="time"
                aria-label={`Window ${index + 1} start`}
                value={window.start}
                onChange={(event) => updateWindow(index, { start: event.target.value })}
                className="w-32 font-mono"
              />
              <span className="text-sm text-content-tertiary">to</span>
              <Input
                type="time"
                aria-label={`Window ${index + 1} end`}
                value={window.end}
                onChange={(event) => updateWindow(index, { end: event.target.value })}
                className="w-32 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove window ${index + 1}`}
                onClick={() => setWindows((prev) => prev.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setWindows((prev) => [...prev, { start: "09:00", end: "12:00" }])}>
              <Plus className="size-4" />
              Add window
            </Button>
          </div>
          <p className="text-xs text-content-tertiary">
            DeepSeek's published peak hours are 09:00–12:00 and 14:00–18:00 Beijing time (off-peak is half price). Windows must not overlap and cannot
            cross midnight.
          </p>
        </section>

        <section className="space-y-2 border-t border-border pt-5">
          <Label htmlFor="scheduling-timezone" className="text-xs uppercase tracking-[0.06em] text-content-tertiary">
            Timezone
          </Label>
          <Input
            id="scheduling-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            list="scheduling-timezones"
            aria-invalid={!isValidTimezone(timezone.trim())}
            className="max-w-xs font-mono"
          />
          <datalist id="scheduling-timezones">
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          {!isValidTimezone(timezone.trim()) && <p className="text-xs text-error">Enter a valid IANA timezone, e.g. Asia/Shanghai.</p>}
        </section>

        {validationError && isDirty && (
          <p role="alert" className="text-sm text-error">
            {validationError}
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={!canSave}>
            {saving ? "Saving..." : "Save scheduling"}
          </Button>
          {!isDirty && <p className="text-xs text-content-tertiary">No unsaved changes</p>}
        </div>
      </form>
    </main>
  );
}
