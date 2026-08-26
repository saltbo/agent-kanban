import type { Env } from "./types";

const VERIFY_FROM = { email: "noreply@agent-kanban.dev", name: "Agent Kanban" };

export async function sendVerificationEmail(env: Env, to: string, url: string): Promise<void> {
  if (isLocalDev(env)) {
    console.info(`[email-verification] ${to}: ${localVerificationUrl(url)}`);
    return;
  }

  await env.EMAIL.send({
    to,
    from: VERIFY_FROM,
    subject: "Verify your Agent Kanban email",
    html: verificationHtml(url),
    text: `Verify your Agent Kanban email: ${url}\n\nThis link expires in 1 hour.`,
  });
}

function verificationHtml(url: string): string {
  const escapedUrl = escapeHtml(url);
  return `
    <p>Verify your Agent Kanban email address.</p>
    <p><a href="${escapedUrl}">Verify email</a></p>
    <p>This link expires in 1 hour.</p>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isLocalDev(env: Env): boolean {
  return env.ALLOWED_HOSTS.split(",").some((host) => host.startsWith("localhost") || host.startsWith("127.0.0.1"));
}

function localVerificationUrl(url: string): string {
  return url.replace(/^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, "http://$1$2");
}
