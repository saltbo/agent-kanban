import { realmrootClientCredentialsToken } from "@server/adapters/realmroot/clientCredentials";
import { akResource } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import {
  type TaskLifecycleEvent,
  TaskLifecycleNotificationFailure,
  type TaskLifecycleNotifier,
} from "@server/usecases/tasks/taskLifecycleNotifications";

export function inboxTaskLifecycleNotifier(env: Env): TaskLifecycleNotifier {
  return {
    async notify(notification) {
      try {
        requireConfiguration(env);
        const token = await realmrootClientCredentialsToken({
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_SERVICE_CLIENT_ID,
          clientSecret: env.OIDC_SERVICE_CLIENT_SECRET,
          resource: env.INBOX_RESOURCE,
          scope: "messages:create",
        });
        const response = await fetch(`${env.INBOX_RESOURCE}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "API-Version": env.INBOX_API_VERSION,
            "Content-Type": "application/json",
            "Idempotency-Key": `ak:${notification.event}:${notification.taskId}:${notification.version}`,
          },
          body: JSON.stringify({
            recipients: [`agent:${notification.assigneeActorId}`],
            subject: subject(notification.event),
            content: { text: content(env, notification) },
            routingKey: `agent-kanban:task:${notification.taskId}`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new TaskLifecycleNotificationFailure(`Inbox rejected the ${notification.event} notification with HTTP ${response.status}`);
        }
      } catch (error) {
        if (error instanceof TaskLifecycleNotificationFailure) throw error;
        throw new TaskLifecycleNotificationFailure(
          `Inbox ${notification.event} notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function requireConfiguration(env: Env): void {
  if (!env.INBOX_RESOURCE || !env.INBOX_API_VERSION || !env.OIDC_SERVICE_CLIENT_ID || !env.OIDC_SERVICE_CLIENT_SECRET) {
    throw new TaskLifecycleNotificationFailure("AK Inbox machine integration is not configured");
  }
}

function subject(event: TaskLifecycleEvent): string {
  if (event === "assigned") return "Agent Kanban task assigned";
  if (event === "review_rejected") return "Agent Kanban review rejected";
  if (event === "completed") return "Agent Kanban task accepted";
  return "Agent Kanban task cancelled";
}

function content(env: Env, notification: { taskId: string; event: TaskLifecycleEvent; reason?: string | null }): string {
  const taskUrl = `${akResource(env)}/tasks/${notification.taskId}`;
  const reason = notification.reason ? `\nReview reason: ${notification.reason}` : "";
  return `Task ${notification.taskId} changed: ${notification.event}.${reason}\nRead the current Task before acting: realmroot toolbox get ${taskUrl} --json\nCanonical resource: ${taskUrl}`;
}
