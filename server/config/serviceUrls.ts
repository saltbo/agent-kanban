import type { Env } from "@server/env";

export function akPublicUrl(env: Env, path: string): string {
  return new URL(path, `${new URL(env.AK_PUBLIC_ORIGIN).origin}/`).toString();
}

export function akResource(env: Env): string {
  return akPublicUrl(env, "/api").replace(/\/$/, "");
}

export function agencyResource(env: Env): string {
  return new URL("/api", `${new URL(env.AGENCY_ORIGIN).origin}/`).toString().replace(/\/$/, "");
}
