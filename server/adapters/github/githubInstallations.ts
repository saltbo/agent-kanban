import type { D1 } from "@server/db";
import type { RepoAppStatus } from "@shared";

// Thin D1 layer over the GitHub App installation tables. Source of truth for
// "can the App push/PR to this repo" — populated by installation webhooks and
// the setup callback, read by the repository read model and the browse flow.

export interface GithubInstallation {
  installationId: number;
  ownerId: string | null;
  accountLogin: string;
  accountId: number;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

type GithubInstallationRow = {
  installation_id: number;
  owner_id: string | null;
  account_login: string;
  account_id: number;
  account_type: string;
  repository_selection: string;
  suspended_at: string | null;
};

export interface InstallationRepoInput {
  fullName: string;
  repoId?: number | null;
}

// ─── Writes (webhook + setup callback) ───

// owner_id uses COALESCE so an owner-unknown webhook (one that arrives before
// the setup callback) never clobbers an owner the setup callback already set.
export async function upsertInstallation(
  db: D1,
  input: {
    installationId: number;
    ownerId?: string | null;
    accountLogin: string;
    accountId: number;
    accountType: string;
    repositorySelection: string;
    suspendedAt?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_installations
         (installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         owner_id = COALESCE(excluded.owner_id, github_installations.owner_id),
         account_login = excluded.account_login,
         account_id = excluded.account_id,
         account_type = excluded.account_type,
         repository_selection = excluded.repository_selection,
         suspended_at = excluded.suspended_at,
         updated_at = datetime('now')`,
    )
    .bind(
      input.installationId,
      input.ownerId ?? null,
      input.accountLogin.toLowerCase(),
      input.accountId,
      input.accountType,
      input.repositorySelection,
      input.suspendedAt ?? null,
    )
    .run();
}

// Children deleted explicitly rather than relying on ON DELETE CASCADE (D1 does
// not enforce foreign keys by default).
export async function deleteInstallation(db: D1, installationId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM github_installation_repositories WHERE installation_id = ?").bind(installationId),
    db.prepare("DELETE FROM github_installations WHERE installation_id = ?").bind(installationId),
  ]);
}

export async function setInstallationSuspended(db: D1, installationId: number, suspendedAt: string | null): Promise<void> {
  await db
    .prepare("UPDATE github_installations SET suspended_at = ?, updated_at = datetime('now') WHERE installation_id = ?")
    .bind(suspendedAt, installationId)
    .run();
}

export async function replaceInstallationRepositories(db: D1, installationId: number, repos: InstallationRepoInput[]): Promise<void> {
  const stmts = [db.prepare("DELETE FROM github_installation_repositories WHERE installation_id = ?").bind(installationId)];
  for (const repo of repos) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
        .bind(installationId, repo.fullName.toLowerCase(), repo.repoId ?? null),
    );
  }
  await db.batch(stmts);
}

export async function addInstallationRepositories(db: D1, installationId: number, repos: InstallationRepoInput[]): Promise<void> {
  if (repos.length === 0) return;
  await db.batch(
    repos.map((repo) =>
      db
        .prepare("INSERT OR IGNORE INTO github_installation_repositories (installation_id, full_name, repo_id) VALUES (?, ?, ?)")
        .bind(installationId, repo.fullName.toLowerCase(), repo.repoId ?? null),
    ),
  );
}

export async function removeInstallationRepositories(db: D1, installationId: number, fullNames: string[]): Promise<void> {
  if (fullNames.length === 0) return;
  await db.batch(
    fullNames.map((fullName) =>
      db
        .prepare("DELETE FROM github_installation_repositories WHERE installation_id = ? AND full_name = ?")
        .bind(installationId, fullName.toLowerCase()),
    ),
  );
}

// ─── Reads (repo model + browse) ───

export async function getInstallationsForOwner(db: D1, ownerId: string): Promise<GithubInstallation[]> {
  const result = await db
    .prepare(
      "SELECT installation_id, owner_id, account_login, account_id, account_type, repository_selection, suspended_at FROM github_installations WHERE owner_id = ?",
    )
    .bind(ownerId)
    .all<GithubInstallationRow>();
  return result.results.map(parseInstallation);
}

// Per-repo App coverage. Matches the owner's installations by account login
// (the owner/ segment), so coverage is always scoped to the owner — another
// tenant's installation on the same account never counts.
export async function repoAppStatus(db: D1, ownerId: string, fullName: string): Promise<RepoAppStatus> {
  return (await repoAppStatusBatch(db, ownerId, [fullName])).get(fullName) ?? "app_not_installed";
}

// Batched coverage for the repo list — one installs query + one selected-repos
// query, then computed in JS. The returned map is keyed by the exact input
// string so callers look it up by the same value they passed.
export async function repoAppStatusBatch(db: D1, ownerId: string, fullNames: string[]): Promise<Map<string, RepoAppStatus>> {
  const out = new Map<string, RepoAppStatus>();
  if (fullNames.length === 0) return out;

  const installs = await getInstallationsForOwner(db, ownerId);
  const selectedIds = installs.filter((i) => i.repositorySelection === "selected").map((i) => i.installationId);

  const reposByInstall = new Map<number, Set<string>>();
  if (selectedIds.length > 0) {
    const placeholders = selectedIds.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT installation_id, full_name FROM github_installation_repositories WHERE installation_id IN (${placeholders})`)
      .bind(...selectedIds)
      .all<{ installation_id: number; full_name: string }>();
    for (const row of rows.results) {
      const set = reposByInstall.get(row.installation_id) ?? new Set<string>();
      set.add(row.full_name);
      reposByInstall.set(row.installation_id, set);
    }
  }

  for (const fullName of fullNames) {
    out.set(fullName, computeStatus(fullName, installs, reposByInstall));
  }
  return out;
}

function computeStatus(fullName: string, installs: GithubInstallation[], reposByInstall: Map<number, Set<string>>): RepoAppStatus {
  const normalized = fullName.toLowerCase();
  const account = normalized.split("/")[0];
  const matching = installs.filter((i) => i.accountLogin === account);
  if (matching.length === 0) return "app_not_installed";

  const active = matching.filter((i) => i.suspendedAt === null);
  if (active.length === 0) return "suspended";

  for (const install of active) {
    if (install.repositorySelection === "all") return "covered";
    if (reposByInstall.get(install.installationId)?.has(normalized)) return "covered";
  }
  return "not_covered";
}

function parseInstallation(row: GithubInstallationRow): GithubInstallation {
  return {
    installationId: row.installation_id,
    ownerId: row.owner_id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    accountType: row.account_type as "User" | "Organization",
    repositorySelection: row.repository_selection as "all" | "selected",
    suspendedAt: row.suspended_at,
  };
}
