import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type GithubAuthOptions = {
  homeDir?: string;
  run?: (file: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<unknown>;
};

async function runCommand(file: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"], env: options.env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${file} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function githubCredentialLine(token: string): string {
  return `https://x-access-token:${token}@github.com`;
}

function isolatedGithubEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GH_CONFIG_DIR: join(home, ".config", "gh"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function configureGitCredential(token: string, options: GithubAuthOptions = {}) {
  const home = options.homeDir ?? homedir();
  const credentialsPath = join(home, ".git-credentials");
  const line = githubCredentialLine(token);
  await mkdir(dirname(credentialsPath), { recursive: true });
  const existing = existsSync(credentialsPath) ? await readFile(credentialsPath, "utf-8") : "";
  const kept = existing.split("\n").filter((entry) => entry.trim() && !entry.includes("@github.com"));
  kept.push(line);
  await writeFile(credentialsPath, `${kept.join("\n")}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  await (options.run ?? runCommand)("git", ["config", "--global", "credential.helper", `store --file=${credentialsPath}`], {
    env: isolatedGithubEnv(home),
  });
}

async function configureGhCredential(token: string, options: GithubAuthOptions = {}) {
  const home = options.homeDir ?? homedir();
  const configDir = join(home, ".config", "gh");
  const hostsPath = join(configDir, "hosts.yml");
  await mkdir(configDir, { recursive: true });
  await writeFile(hostsPath, `github.com:\n  git_protocol: https\n  oauth_token: ${token}\n  user: x-access-token\n`, { mode: 0o600 });
  await chmod(hostsPath, 0o600);
}

async function configureGhCli(token: string, options: GithubAuthOptions = {}): Promise<"configured" | "missing"> {
  const run = options.run ?? runCommand;
  try {
    await run("gh", ["--version"]);
  } catch {
    return "missing";
  }
  return "configured";
}

export async function configureGithubAuth(token: string, options: GithubAuthOptions = {}) {
  await configureGitCredential(token, options);
  await configureGhCredential(token, options);
  return await configureGhCli(token, options);
}
