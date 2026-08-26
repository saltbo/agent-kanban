import { isVersionBelowMin } from "@agent-kanban/shared";
import type { Context, Next } from "hono";
import type { Env } from "./types.js";

export async function cliVersionMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const clientVersion = c.req.header("X-CLI-Version");
  // Non-CLI clients (browser, curl, older CLI without the header) are always allowed through
  if (!clientVersion) return next();

  const minVersion = c.env.MIN_CLI_VERSION;
  if (!minVersion) return next();

  if (isVersionBelowMin(clientVersion, minVersion)) {
    return c.json(
      {
        error: {
          code: "CLI_UPGRADE_REQUIRED",
          message: `CLI v${clientVersion} is no longer supported. Minimum required: v${minVersion}. Run \`ak upgrade\` to update.`,
          min_version: minVersion,
        },
      },
      426,
    );
  }

  return next();
}
