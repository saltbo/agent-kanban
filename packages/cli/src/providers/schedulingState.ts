/**
 * Daemon-side cache of the owner's scheduling settings.
 *
 * The server delivers settings in the heartbeat response (no new auth
 * surface); the heartbeat handler calls `setSchedulingSettings`. Until the
 * first successful heartbeat — or if the payload is malformed — evaluation
 * falls back to the shared defaults (fail-open on the safe side: DeepSeek's
 * published Beijing peak hours).
 */

import { DEFAULT_SCHEDULING_SETTINGS, normalizeSchedulingSettings, type SchedulingSettings } from "@agent-kanban/shared";

let current: SchedulingSettings = DEFAULT_SCHEDULING_SETTINGS;

export function getSchedulingSettings(): SchedulingSettings {
  return current;
}

export function setSchedulingSettings(raw: unknown): void {
  current = normalizeSchedulingSettings(raw);
}
