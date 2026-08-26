export interface Env {
  DB: D1Database;
  AE: AnalyticsEngineDataset;
  EMAIL: SendEmail;
  TUNNEL_RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  ALLOWED_HOSTS: string;
  REALMROOT_ISSUER: string;
  REALMROOT_WEB_CLIENT_ID: string;
  REALMROOT_WEB_CLIENT_SECRET: string;
  REALMROOT_SESSION_ENCRYPTION_KEY: string;
  REALMROOT_CLI_CLIENT_ID: string;
  AK_RESOURCE: string;
  REALMROOT_CONSOLE_URL?: string;
  MAILS_ADMIN_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AK_API_URL?: string;
  AMA_ORIGIN?: string;
  AMA_RESOURCE?: string;
  AMA_RUNNER_VERSION?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  // base64 of the App's PKCS#8 PEM private key
  GITHUB_APP_PRIVATE_KEY?: string;
  // public App slug, used to build the install URL github.com/apps/<slug>/installations/new
  GITHUB_APP_SLUG?: string;
  MIN_CLI_VERSION?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    ownerId: string;
    identityType: "user" | "machine" | "agent:worker" | "agent:leader" | "service";
    principal: {
      source: "session" | "token";
      type: "human" | "machine" | "agent" | "service";
      subjectId: string;
      tenantId: string;
      clientId?: string;
      scopes: string[];
    };
    machineId?: string;
    agentId?: string;
    sessionId?: string;
    agentRuntimeSource?: "ama" | "legacy";
    agentCapabilities?: string[];
    user?: { id: string; name: string; email: string; image?: string | null; role: string };
    session?: { id: string; expiresAt: Date; csrfToken: string };
  }
}
