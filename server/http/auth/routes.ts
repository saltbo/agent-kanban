import { beginRealmrootLogin, endRealmrootWebSession, finishRealmrootLogin, readRealmrootWebSession } from "@server/auth/realmroot";
import type { Env } from "@server/env";
import type { Hono } from "hono";

export function registerAuthRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/auth/login", beginRealmrootLogin);
  api.get("/api/auth/callback", finishRealmrootLogin);
  api.get("/api/auth/session", readRealmrootWebSession);
  api.post("/api/auth/logout", endRealmrootWebSession);
}
