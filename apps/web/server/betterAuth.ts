import { agentAuth } from "@better-auth/agent-auth";
import { apiKey } from "@better-auth/api-key";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { admin, bearer, genericOAuth } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { D1 } from "./db";
import { sendVerificationEmail } from "./emailService";
import type { Env } from "./types";

// AMA can only be unlinked once the user has no AMA-backed resources left:
// latest worker agents that actually have a backing AMA agent, or machines.
// Leaders, builtin agents, old snapshots, and pre-AMA rows still missing an
// ama_agent_id are AK-only records and must not block disconnect.
export async function hasAmaResources(db: D1, ownerId: string): Promise<boolean> {
  const agent = await db
    .prepare(
      "SELECT 1 FROM agents WHERE owner_id = ? AND builtin = 0 AND kind = 'worker' AND version = 'latest' AND ama_agent_id IS NOT NULL LIMIT 1",
    )
    .bind(ownerId)
    .first();
  if (agent) return true;
  const machine = await db.prepare("SELECT 1 FROM machines WHERE owner_id = ? LIMIT 1").bind(ownerId).first();
  return Boolean(machine);
}

// Registers AMA as a generic OIDC provider so each AK user can link their own
// AMA account. Only added when AMA OIDC is configured; standalone AK skips it.
function amaProviderPlugins(env: Env): BetterAuthPlugin[] {
  const issuer = env.AMA_OIDC_ISSUER;
  if (!issuer || !env.AMA_OIDC_CLIENT_ID || !env.AMA_OIDC_CLIENT_SECRET) return [];
  const resource = amaOidcResource(env);
  return [
    genericOAuth({
      config: [
        {
          providerId: "ama",
          discoveryUrl: oidcDiscoveryUrl(issuer),
          clientId: env.AMA_OIDC_CLIENT_ID,
          clientSecret: env.AMA_OIDC_CLIENT_SECRET,
          authentication: "basic",
          scopes: amaOidcScopes(env),
          pkce: true,
          ...(resource ? { authorizationUrlParams: { resource }, tokenUrlParams: { resource } } : {}),
        },
      ],
    }),
  ];
}

export function oidcDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function amaOidcScopes(env: Env): string[] {
  return (
    env.AMA_OIDC_SCOPES?.trim()
      .split(/[\s,]+/)
      .filter(Boolean) ?? ["openid", "profile", "email", "offline_access"]
  );
}

export function amaOidcResource(env: Pick<Env, "AMA_ORIGIN">): string | null {
  const origin = env.AMA_ORIGIN?.trim().replace(/\/+$/, "");
  return origin || null;
}

export function createAuth(env: Env) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }),
      type: "sqlite",
    },
    basePath: "/api/auth",
    baseURL: {
      allowedHosts: authAllowedHosts(env),
      fallback: `https://${env.ALLOWED_HOSTS.split(",")[0]}`,
      protocol: "auto",
    },
    trustedOrigins: authTrustedOrigins(env),
    secret: env.AUTH_SECRET,
    // The AK user links their AMA account (a separate FlareAuth identity) whose
    // email need not match their AK login email, so account linking must allow
    // different emails — otherwise BetterAuth rejects the link with
    // "email_doesn't_match". Linking is user-initiated and authenticated, and the
    // linked token is only used for that user's own AMA calls.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["ama"],
        allowDifferentEmails: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }, request) => {
        await sendVerificationEmail(env, user.email, verificationPageUrl(env, url, request));
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        scope: ["user", "admin:gpg_key"],
      },
    },
    plugins: [
      bearer(),
      // Admin plugin enables /api/auth/admin/* endpoints (list-users, ban-user, set-role, etc.)
      // First admin must be set manually via D1 console:
      //   UPDATE user SET role = 'admin' WHERE email = '...'
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      apiKey([
        {
          configId: "default",
          defaultPrefix: "ak_",
          enableMetadata: true,
          rateLimit: { enabled: false },
        },
        {
          configId: "maintainer",
          defaultPrefix: "ak_maint_",
          enableMetadata: true,
          rateLimit: { enabled: true, maxRequests: 60, timeWindow: 60_000 },
          permissions: {
            defaultPermissions: { maintainerSession: ["create"] },
          },
        },
      ]),
      agentAuth({
        allowedKeyAlgorithms: ["Ed25519"],
        agentSessionTTL: 86400,
        agentMaxLifetime: 86400,
        allowDynamicHostRegistration: true,
        modes: ["autonomous"],
        rateLimit: {
          "/agent/session": { window: 60, max: 6000 },
        },
        capabilities: [
          { name: "task:claim", description: "Claim an assigned task" },
          { name: "task:review", description: "Submit a task for review" },
          { name: "task:complete", description: "Complete a task in review" },
          { name: "task:reject", description: "Reject a task back to in-progress" },
          { name: "task:cancel", description: "Cancel a task" },
          { name: "task:log", description: "Add logs to a task" },
          { name: "task:message", description: "Send and read task messages" },
          { name: "agent:usage", description: "Report token usage" },
        ],
      }),
      ...amaProviderPlugins(env),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

function authAllowedHosts(env: Env): string[] {
  const hosts = env.ALLOWED_HOSTS.split(",");
  const localHosts = ["localhost:*", "127.0.0.1:*"];
  return [...hosts, ...localHosts.filter((host) => !hosts.includes(host))];
}

// better-auth derives trusted origins from baseURL.allowedHosts but only adds
// the http:// variant for localhost/127.0.0.1 — any LAN/remote host reached
// over plain http (e.g. http://10.0.0.5:6265) is rejected as an invalid origin
// even when it is allowlisted. Trust every explicitly allowlisted host over
// both schemes so remote sign-in/sign-up over http works.
export function authTrustedOrigins(env: Env): string[] {
  const origins = new Set<string>();
  for (const host of env.ALLOWED_HOSTS.split(",")) {
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return [...origins];
}

function verificationUrlForRequest(env: Env, url: string, request?: Request): string {
  if (!request) return new URL(url, `https://${env.ALLOWED_HOSTS.split(",")[0]}`).toString();
  const origin = new URL(request.url).origin;
  return new URL(url, origin).toString();
}

function verificationPageUrl(env: Env, url: string, request?: Request): string {
  const resolved = new URL(verificationUrlForRequest(env, url, request));
  const page = new URL("/auth/verify", resolved.origin);
  page.searchParams.set("token", resolved.searchParams.get("token") || "");
  return page.toString();
}
