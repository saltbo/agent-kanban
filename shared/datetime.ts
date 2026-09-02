// Strict ISO 8601 datetime with required timezone (Z or ±HH:mm)
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse a strict ISO 8601 datetime string and return UTC ISO string.
 * Requires full datetime with timezone. Rejects date-only, ambiguous, or non-standard formats.
 * Returns null if invalid.
 */
export function parseScheduledAt(value: string): string | null {
  if (!ISO_8601_RE.test(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
