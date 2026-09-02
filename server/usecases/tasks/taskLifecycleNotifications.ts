export type TaskLifecycleEvent = "assigned" | "review_rejected" | "completed" | "cancelled";

export interface TaskLifecycleNotification {
  taskId: string;
  assigneeActorId: string;
  event: TaskLifecycleEvent;
  version: string;
  reason?: string | null;
}

export interface TaskLifecycleNotifier {
  notify(notification: TaskLifecycleNotification): Promise<void>;
}

export class TaskLifecycleNotificationFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskLifecycleNotificationFailure";
  }
}

export async function notifyTaskLifecycle(notifier: TaskLifecycleNotifier, notification: TaskLifecycleNotification): Promise<void> {
  await notifier.notify(notification);
}
