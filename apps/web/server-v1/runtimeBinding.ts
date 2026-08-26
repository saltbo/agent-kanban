import type { Task } from "@agent-kanban/shared";

export type TaskRuntimeSource = "ama" | "legacy";

export const TASK_RUNTIME_SOURCE_ANNOTATION = "runtime.source";

type Annotations = Record<string, unknown>;

export function taskRuntimeSource(task: Pick<Task, "metadata">): TaskRuntimeSource | null {
  const annotations = taskRuntimeAnnotations(task);
  const source = annotations[TASK_RUNTIME_SOURCE_ANNOTATION];
  if (source === "ama" || source === "legacy") return source;

  // Tasks created before runtime.source was introduced already carry AMA
  // binding annotations. Preserve that one-way compatibility inference until
  // the legacy migration window closes.
  if (typeof annotations["ama.sessionId"] === "string" || typeof annotations["ama.dispatch.result"] === "string") return "ama";
  return null;
}

export function metadataWithRuntimeSource(metadata: unknown, source: TaskRuntimeSource): Record<string, unknown> {
  const next = { ...metadataObject(metadata) };
  next.annotations = {
    ...metadataObject(next.annotations),
    [TASK_RUNTIME_SOURCE_ANNOTATION]: source,
  };
  return next;
}

export function taskRuntimeAnnotations(task: Pick<Task, "metadata">): Annotations {
  return metadataObject(metadataObject(task.metadata).annotations);
}

export function stringRuntimeAnnotation(annotations: Annotations, key: string): string | null {
  const value = annotations[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
