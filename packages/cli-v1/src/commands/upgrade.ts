import { execSync } from "node:child_process";
import { isVersionBelowMin } from "@agent-kanban/shared";
import type { Command } from "commander";
import { fetchLatestVersion, isNpx } from "../updateCheck.js";
import { getVersion } from "../version.js";

function detectInstallMethod(): "npx" | "volta" | "global" {
  if (isNpx()) return "npx";
  if (process.argv[1]?.includes(".volta/")) return "volta";
  return "global";
}

export function registerUpgradeCommand(program: Command) {
  program
    .command("upgrade")
    .description("Upgrade ak to the latest version")
    .action(async () => {
      const method = detectInstallMethod();
      const current = getVersion();

      if (method === "npx") {
        console.log(`You're running via npx — it always fetches the latest version (v${current}).`);
        return;
      }

      const latest = await fetchLatestVersion();
      if (!latest) {
        console.error("Could not reach npm registry. Check your network connection.");
        process.exit(1);
      }

      if (!isVersionBelowMin(current, latest)) {
        console.log(`Already on the latest version (v${current}).`);
        return;
      }

      console.log(`Upgrading agent-kanban: v${current} → v${latest}...`);
      const cmd = method === "volta" ? "volta install agent-kanban" : "npm install -g agent-kanban";

      try {
        execSync(cmd, { stdio: "inherit" });
        console.log(`\nUpgraded to v${latest}.`);
      } catch (err) {
        console.error(`\nUpgrade failed (${err instanceof Error ? err.message : String(err)}). Run manually: ${cmd}`);
        process.exit(1);
      }
    });
}
