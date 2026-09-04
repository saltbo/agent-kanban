import { realmrootClientCredentialsToken } from "@server/adapters/realmroot/clientCredentials";
import type { Env } from "@server/env";
import { TaskLifecycleNotificationFailure, type TaskLifecycleNotifier } from "@server/usecases/tasks/taskLifecycleNotifications";

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
            subject: "Agent Kanban notification",
            content: { text: content(notification) },
            routingKey: `agent-kanban:task:${notification.taskId}`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new TaskLifecycleNotificationFailure("Inbox rejected the task notification", {
            cause: new Error(`Inbox responded with HTTP ${response.status}`),
          });
        }
      } catch (error) {
        if (error instanceof TaskLifecycleNotificationFailure) throw error;
        throw new TaskLifecycleNotificationFailure("Inbox task notification is unavailable", { cause: error });
      }
    },
  };
}

function requireConfiguration(env: Env): void {
  if (!env.INBOX_RESOURCE || !env.INBOX_API_VERSION || !env.OIDC_SERVICE_CLIENT_ID || !env.OIDC_SERVICE_CLIENT_SECRET) {
    throw new TaskLifecycleNotificationFailure("AK Inbox machine integration is not configured");
  }
}

function content(notification: { taskId: string; ownerId: string }): string {
  return `Task ID: ${notification.taskId}\nOwner ID: ${notification.ownerId}`;
}
