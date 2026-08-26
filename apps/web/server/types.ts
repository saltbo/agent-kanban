export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  REALMROOT_ISSUER: string;
  REALMROOT_WEB_CLIENT_ID: string;
  REALMROOT_WEB_CLIENT_SECRET: string;
  REALMROOT_SESSION_ENCRYPTION_KEY: string;
  REALMROOT_CLI_CLIENT_ID: string;
  AK_RESOURCE: string;
  AK_PUBLIC_ORIGIN?: string;
  AMA_ORIGIN: string;
  AMA_RESOURCE: string;
  AK_DEV_AUTH_SECRET?: string;
  AMA_DEV_ACCESS_TOKEN?: string;
}

export type Principal = {
  source: "session" | "token";
  type: "human" | "machine" | "agent" | "service";
  subjectId: string;
  tenantId: string;
  clientId?: string;
  scopes: string[];
  actor?: { issuer: string; subject: string };
};

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    traceparent?: string;
    tracestate?: string;
    failureClassification?: string;
    failureCause?: string;
    principal: Principal;
    ownerId: string;
    actorAgentIds?: Map<string, Promise<string | null>>;
    user?: { id: string; name: string; email: string; image?: string | null; role: string };
    session?: { id: string; expiresAt: Date; csrfToken: string };
  }
}
