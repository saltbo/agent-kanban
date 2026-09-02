import type { Board, Repository, Task, TaskAction } from "@shared";

export async function representationEtag(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  const tag = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${tag}"`;
}

export function boardResource(board: Board, requestUrl: string) {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    type: board.type,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
    links: {
      self: absolute(requestUrl, `/api/boards/${encodeURIComponent(board.id)}`),
      tasks: absolute(requestUrl, `/api/tasks?boardId=${encodeURIComponent(board.id)}`),
    },
  };
}

export function repositoryResource(repository: Repository, requestUrl: string) {
  return {
    id: repository.id,
    name: repository.name,
    url: repository.url,
    fullName: repository.full_name,
    createdAt: repository.created_at,
    taskCount: repository.task_count ?? 0,
    appStatus: repository.app_status ?? null,
    links: {
      self: absolute(requestUrl, `/api/repositories/${encodeURIComponent(repository.id)}`),
      tasks: absolute(requestUrl, `/api/tasks?repositoryId=${encodeURIComponent(repository.id)}`),
    },
  };
}

export function taskResource(task: Task & { depends_on?: string[] }, requestUrl: string) {
  return {
    id: task.id,
    seq: task.seq,
    status: task.status.replaceAll("_", "-"),
    title: task.title,
    description: task.description,
    boardId: task.board_id,
    repositoryId: task.repository_id,
    labels: task.labels ?? [],
    createdBy: task.created_by,
    assignedTo: task.assigned_to,
    pullRequestUrl: task.pr_url,
    input: task.input,
    metadata: task.metadata,
    createdFrom: task.created_from,
    scheduledAt: task.scheduled_at,
    position: task.position,
    blocked: task.blocked ?? false,
    dependsOn: task.depends_on ?? [],
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    links: {
      self: absolute(requestUrl, `/api/tasks/${encodeURIComponent(task.id)}`),
      board: absolute(requestUrl, `/api/boards/${encodeURIComponent(task.board_id)}`),
      repository: task.repository_id ? absolute(requestUrl, `/api/repositories/${encodeURIComponent(task.repository_id)}`) : null,
      notes: absolute(requestUrl, `/api/tasks/${encodeURIComponent(task.id)}/notes`),
      assignment: absolute(requestUrl, `/api/task-assignments/${encodeURIComponent(task.id)}`),
      claim: absolute(requestUrl, `/api/task-claims/${encodeURIComponent(task.id)}`),
      reviewSubmission: absolute(requestUrl, `/api/task-review-submissions/${encodeURIComponent(task.id)}`),
    },
  };
}

export function taskNoteResource(note: TaskAction, requestUrl: string) {
  return {
    id: note.id,
    taskId: note.task_id,
    action: note.action,
    actorType: note.actor_type,
    actorId: note.actor_id,
    actorName: note.actor_name ?? null,
    detail: note.detail,
    createdAt: note.created_at,
    links: {
      self: absolute(requestUrl, `/api/tasks/${encodeURIComponent(note.task_id)}/notes/${encodeURIComponent(note.id)}`),
      task: absolute(requestUrl, `/api/tasks/${encodeURIComponent(note.task_id)}`),
    },
  };
}

export function taskEventResource(result: { cursor: string; outcome: string; tasks: Task[]; until: string }, requestUrl: string) {
  return {
    cursor: result.cursor,
    outcome: result.outcome.replaceAll("_", "-"),
    tasks: result.tasks.map((task) => taskResource(task, requestUrl)),
    until: result.until.replaceAll("_", "-"),
  };
}

function absolute(requestUrl: string, path: string): string {
  return new URL(path, requestUrl).toString();
}
