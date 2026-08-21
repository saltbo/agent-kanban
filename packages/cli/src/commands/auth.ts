import { join } from "node:path";
import type { Command } from "commander";
import { AgentClient } from "../client/agent.js";
import { MachineClient } from "../client/machine.js";
import { getCredentials } from "../config.js";
import { clearRealmrootAuthority, loginWithRealmroot } from "../nativeAuth.js";
import { configureGithubAuth } from "./github.js";

async function currentClient() {
  return (await AgentClient.fromEnv()) ?? new MachineClient();
}

function workerGithubAuthHome(): string {
  if (process.env.AMA_WORKSPACE_HOME) return process.env.AMA_WORKSPACE_HOME;
  if (process.env.AMA_WORKSPACE) return join(process.env.AMA_WORKSPACE, ".home");
  throw new Error("Refusing to modify GitHub credentials without an isolated worker HOME.");
}

export function registerAuthCommand(program: Command) {
  const authCmd = program.command("auth").description("Authenticate through Realmroot");

  authCmd
    .command("login")
    .description("Authenticate this CLI through Realmroot Device Authorization")
    .requiredOption("--api-url <url>", "AK API server URL")
    .option("--client-id <id>", "Realmroot AK CLI Application id", process.env.AK_REALMROOT_CLIENT_ID)
    .option("--issuer <url>", "Realmroot issuer", "https://id.realmroot.dev/api/auth")
    .action(async (opts) => {
      if (!opts.clientId) throw new Error("--client-id or AK_REALMROOT_CLIENT_ID is required");
      await loginWithRealmroot({ apiUrl: opts.apiUrl, clientId: opts.clientId, issuer: opts.issuer });
      console.log(`Authenticated ${new URL(opts.apiUrl).host} through Realmroot`);
    });

  authCmd
    .command("logout")
    .description("Delete the current Realmroot authority from the OS keychain")
    .action(() => {
      clearRealmrootAuthority();
      console.log("Removed AK Realmroot authority from the OS keychain");
    });

  authCmd
    .command("whoami")
    .description("Show the current AK Realmroot context")
    .action(async () => {
      const agent = await AgentClient.fromEnv();
      if (agent) {
        console.log("Type:        AK Agent Session");
        console.log(`Agent ID:    ${agent.getAgentId()}`);
        if (agent.getSessionId()) console.log(`Session ID:  ${agent.getSessionId()}`);
        return;
      }
      const environment = getCredentials();
      console.log("Type:        Realmroot native client");
      console.log(`Issuer:      ${environment.issuer}`);
      console.log(`Resource:    ${environment.resource}`);
      console.log(`API:         ${environment.apiUrl}`);
    });

  authCmd
    .command("git <repo-id>")
    .description("Configure git authentication for an AK repository")
    .option("--print-token", "Print the minted provider token instead of configuring local tools")
    .action(async (repoId: string, opts) => {
      const client = await currentClient();
      const repo = await client.getRepository(repoId);
      const url = String((repo as { url?: string }).url ?? "");
      if (!url.includes("github.com:") && !url.includes("github.com/")) throw new Error(`Unsupported git provider for repository URL: ${url}`);
      const auth = await client.createRepositoryGithubToken(repoId);
      if (opts.printToken) {
        console.log(auth.token);
        return;
      }
      if (process.env.AK_WORKER !== "1") throw new Error("Refusing to modify global git credentials outside an AK worker. Use --print-token.");
      const ghStatus = await configureGithubAuth(auth.token, { homeDir: workerGithubAuthHome() });
      console.log(
        `Configured GitHub auth for ${auth.full_name}; ${ghStatus === "configured" ? "gh credentials configured" : "git credentials configured"}`,
      );
    });
}
