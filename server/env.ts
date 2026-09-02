export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;
  ASSETS: Fetcher;
  ALLOWED_HOSTS: string;
  AK_PUBLIC_ORIGIN: string;
  AK_SIGNING_KEY: string;
  OIDC_ISSUER: string;
  OIDC_WEB_CLIENT_ID: string;
  OIDC_WEB_CLIENT_SECRET: string;
  OIDC_SERVICE_CLIENT_ID: string;
  OIDC_SERVICE_CLIENT_SECRET: string;
  AK_SESSION_ENCRYPTION_KEY: string;
  INBOX_RESOURCE: string;
  INBOX_API_VERSION: string;
  AMA_ORIGIN: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  // base64 of the App's PKCS#8 PEM private key
  GITHUB_APP_PRIVATE_KEY?: string;
  // public App slug, used to build the install URL github.com/apps/<slug>/installations/new
  GITHUB_APP_SLUG?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    traceId: string;
    spanId: string;
    traceparent: string;
    requestError?: {
      error_name: string;
      error_message: string;
      error_stack?: string;
      error_cause?: string;
    };
    ownerId: string;
    identityType: "user" | "machine" | "realmroot:agent" | "service";
    principal: {
      source: "session" | "token";
      type: "human" | "machine" | "agent" | "service";
      subjectId: string;
      actorId?: string;
      controllerSubjectId?: string;
      runtime?: string;
      runtimeSessionId?: string;
      tenantId: string;
      clientId?: string;
      scopes: string[];
      sourceAccessToken?: string;
    };
    user?: { id: string; name: string; email: string; image?: string | null; role: string };
    session?: { id: string; expiresAt: Date; csrfToken: string };
    resourceIdempotency?: import("@server/adapters/d1/resourceIdempotency").ResourceIdempotency;
  }
}
