import { DEFAULT_RUNTIME_SETTINGS, normalizeRuntimeSettings, type RuntimeSettings } from "@agent-kanban/shared";

let current: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };

export function getRuntimeSettings(): RuntimeSettings {
  return current;
}

export function setRuntimeSettings(raw: unknown): void {
  current = normalizeRuntimeSettings(raw);
}
