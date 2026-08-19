/**
 * Per-task git worktree configuration, carried in `task.metadata.worktree`.
 *
 * Fork feature: tasks on repository-backed boards run in an isolated git
 * worktree by default (branch `ak/<name>`) so multiple agents can work the
 * same repo in parallel and their branches merge cleanly afterwards. The UI
 * can disable this (agent works directly in the repo checkout) or pick a
 * custom branch/worktree name.
 */

export interface WorktreeConfig {
  enabled: boolean;
  /** Custom branch/worktree slug; defaults to the session id prefix. */
  name?: string;
}

export const WORKTREE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/;

export function isValidWorktreeName(name: string): boolean {
  return WORKTREE_NAME_PATTERN.test(name);
}

/** Read the worktree config from a task's metadata bag. Defaults to enabled. */
export function parseWorktreeConfig(metadata: unknown): WorktreeConfig {
  const raw = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).worktree : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { enabled: true };
  const config = raw as Record<string, unknown>;
  const name = typeof config.name === "string" && isValidWorktreeName(config.name) ? config.name : undefined;
  return { enabled: config.enabled !== false, name };
}

const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "delta",
  "ember",
  "frost",
  "grand",
  "hazy",
  "ionic",
  "jolly",
  "keen",
  "lunar",
  "misty",
  "noble",
  "onyx",
  "proud",
  "quiet",
  "rapid",
  "solar",
  "tidy",
] as const;

const NOUNS = [
  "atlas",
  "beacon",
  "canyon",
  "drift",
  "engine",
  "falcon",
  "grove",
  "harbor",
  "inlet",
  "jetty",
  "karma",
  "lagoon",
  "meadow",
  "nexus",
  "orbit",
  "prism",
  "quarry",
  "ridge",
  "summit",
  "tundra",
] as const;

/** Random default worktree name, e.g. `ak-brisk-falcon-7f2a`. */
export function generateWorktreeName(rand: () => number = Math.random): string {
  const adjective = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)];
  const suffix = Math.floor(rand() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `ak-${adjective}-${noun}-${suffix}`;
}
