export const SUPPORTED_RESOURCES = ["board", "task", "agent", "repo", "note"] as const;
export type ResourceName = (typeof SUPPORTED_RESOURCES)[number];

const PLURAL_MAP: Record<string, ResourceName> = {
  boards: "board",
  tasks: "task",
  agents: "agent",
  repos: "repo",
  repositories: "repo",
  notes: "note",
};

export function normalizeResource(input: string): ResourceName {
  const lower = input.toLowerCase();
  if ((SUPPORTED_RESOURCES as readonly string[]).includes(lower)) {
    return lower as ResourceName;
  }
  const mapped = PLURAL_MAP[lower];
  if (mapped) return mapped;

  console.error(`Unknown resource: ${input}. Supported: ${SUPPORTED_RESOURCES.join(", ")}`);
  process.exit(1);
}
