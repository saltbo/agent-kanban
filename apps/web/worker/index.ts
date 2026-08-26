import { dispatchOutbox } from "../server/outbox";
import { api } from "../server/routes";
import type { Env } from "../server/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return api.fetch(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchOutbox(env));
  },
};
