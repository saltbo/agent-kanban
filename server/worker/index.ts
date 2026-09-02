import type { Env } from "@server/env";
import { api } from "@server/http/app";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return api.fetch(request, env);
  },
};
