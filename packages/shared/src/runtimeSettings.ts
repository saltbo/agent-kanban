/** Machine runtime preferences delivered to local daemons through heartbeat. */
export interface RuntimeSettings {
  /** Refresh already-cached skills from their upstream source in the background. */
  skill_cache_auto_update: boolean;
  /** Maximum age of a successful upstream check, in whole hours. */
  skill_cache_refresh_hours: number;
}

export const MIN_SKILL_CACHE_REFRESH_HOURS = 1;
export const MAX_SKILL_CACHE_REFRESH_HOURS = 168;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  skill_cache_auto_update: true,
  skill_cache_refresh_hours: 24,
};

export function validateRuntimeSettings(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "settings must be an object";
  const { skill_cache_auto_update, skill_cache_refresh_hours } = raw as Record<string, unknown>;
  if (typeof skill_cache_auto_update !== "boolean") return "skill_cache_auto_update must be a boolean";
  if (!Number.isInteger(skill_cache_refresh_hours)) return "skill_cache_refresh_hours must be a whole number";
  if (
    (skill_cache_refresh_hours as number) < MIN_SKILL_CACHE_REFRESH_HOURS ||
    (skill_cache_refresh_hours as number) > MAX_SKILL_CACHE_REFRESH_HOURS
  ) {
    return `skill_cache_refresh_hours must be between ${MIN_SKILL_CACHE_REFRESH_HOURS} and ${MAX_SKILL_CACHE_REFRESH_HOURS}`;
  }
  return null;
}

/** Normalize untrusted server data without allowing it to break daemon startup. */
export function normalizeRuntimeSettings(raw: unknown): RuntimeSettings {
  if (validateRuntimeSettings(raw) !== null) return { ...DEFAULT_RUNTIME_SETTINGS };
  const value = raw as RuntimeSettings;
  return {
    skill_cache_auto_update: value.skill_cache_auto_update,
    skill_cache_refresh_hours: value.skill_cache_refresh_hours,
  };
}
