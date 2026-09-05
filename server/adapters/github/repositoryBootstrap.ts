import { getRepository } from "@server/adapters/d1/repositoryRepo";
import { getInstallation, mintRepositoryReadToken } from "@server/adapters/github/githubApp";
import { getInstallationsForOwner } from "@server/adapters/github/githubInstallations";
import type { Env } from "@server/env";

export interface RepositoryBootstrap {
  repositoryId: string;
  installationId: number;
  githubRepositoryId: number;
  url: string;
  ref: string;
  mountPath: string;
  token: string;
  expiresAt: string;
}

export async function repositoryBootstrap(env: Env, ownerId: string, repositoryId: string, expectedUrl?: string): Promise<RepositoryBootstrap> {
  const repository = await getRepository(env.DB, repositoryId, ownerId);
  if (!repository) throw new Error("Repository is not available in this tenant");
  if (expectedUrl !== undefined && repository.url !== expectedUrl) throw new Error("Repository changed after the Task launch was recorded");
  const url = new URL(repository.url);
  const path = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !path) {
    throw new Error("Repository bootstrap requires a canonical GitHub HTTPS repository URL");
  }
  const account = path[1]!;
  const name = path[2]!.replace(/\.git$/, "");
  const installation = (await getInstallationsForOwner(env.DB, ownerId)).find(
    (candidate) => candidate.accountLogin.toLowerCase() === account.toLowerCase() && candidate.suspendedAt === null,
  );
  if (!installation) throw new Error("Connect the GitHub App installation for this repository before launching the Task");
  const current = await getInstallation(env, installation.installationId);
  if (current.suspendedAt || current.account.id !== installation.accountId || current.account.login.toLowerCase() !== account.toLowerCase()) {
    throw new Error("GitHub App installation ownership changed or the installation is suspended");
  }
  // GitHub validates current selected-repository access when minting this restricted token.
  const credential = await mintRepositoryReadToken(env, installation.installationId, name);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(account)}/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${credential.token}`, "user-agent": "agent-kanban/2.0", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
    // Workers supports manual redirects; the status check below rejects them
    // without forwarding the repository credential to another URL.
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`GitHub repository bootstrap metadata failed (HTTP ${response.status})`);
  const remote = (await response.json()) as { id?: unknown; full_name?: unknown; default_branch?: unknown; owner?: { id?: unknown } };
  if (
    !Number.isSafeInteger(remote.id) ||
    remote.owner?.id !== current.account.id ||
    typeof remote.full_name !== "string" ||
    remote.full_name.toLowerCase() !== `${account}/${name}`.toLowerCase() ||
    typeof remote.default_branch !== "string" ||
    !remote.default_branch
  ) {
    throw new Error("GitHub repository ownership or default branch does not match the connected Repository");
  }
  return {
    repositoryId,
    installationId: installation.installationId,
    githubRepositoryId: remote.id as number,
    url: `https://github.com/${account}/${name}.git`,
    ref: remote.default_branch,
    mountPath: `/workspace/repos/github.com/${account}/${name}`,
    ...credential,
  };
}
