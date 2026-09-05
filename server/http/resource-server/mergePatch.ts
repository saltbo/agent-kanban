export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;

  const members = new Map(Object.entries(isObject(target) ? target : {}));
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) members.delete(name);
    else members.set(name, mergePatch(members.get(name), value));
  }
  return Object.fromEntries(members);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
