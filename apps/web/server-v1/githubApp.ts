import type { D1 } from "./db";
import { replaceInstallationRepositories, upsertInstallation } from "./githubInstallations";
import type { Env } from "./types";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "agent-kanban/1.0";

export function isGithubAppConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

export interface GithubInstallationToken {
  token: string;
  expiresAt: string;
}

// Mints a repository-scoped, ~1h installation access token for the AK GitHub
// App. This is the push/PR credential cloud sandbox sessions receive — short
// lived and limited to the task's repository, unlike a server-level PAT.
export async function mintGithubInstallationToken(env: Env, owner: string, repo: string): Promise<GithubInstallationToken> {
  const jwt = await githubAppJwt(env);
  const headers = {
    authorization: `Bearer ${jwt}`,
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
  };

  const installationRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, { headers });
  if (!installationRes.ok) {
    throw new Error(`GitHub App is not installed on ${owner}/${repo} (HTTP ${installationRes.status})`);
  }
  const installation = (await installationRes.json()) as { id: number };

  const tokenRes = await fetch(`${GITHUB_API}/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      repositories: [repo],
      permissions: { contents: "write", issues: "write", pull_requests: "write" },
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    throw new Error(`GitHub App installation token request failed (HTTP ${tokenRes.status})${detail ? `: ${detail}` : ""}`);
  }
  const token = (await tokenRes.json()) as { token: string; expires_at: string };
  return { token: token.token, expiresAt: token.expires_at };
}

export interface GithubInstallationDetails {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

// Reads an installation's account + repo selection. Used by the setup callback
// to record the installation under the logged-in owner.
export async function getInstallation(env: Env, installationId: number): Promise<GithubInstallationDetails> {
  const jwt = await githubAppJwt(env);
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: { authorization: `Bearer ${jwt}`, "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub get installation ${installationId} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    id: number;
    account: { login: string; id: number; type: string };
    repository_selection: string;
    suspended_at: string | null;
  };
  return {
    id: data.id,
    account: { login: data.account.login, id: data.account.id, type: data.account.type as "User" | "Organization" },
    repositorySelection: data.repository_selection as "all" | "selected",
    suspendedAt: data.suspended_at,
  };
}

export interface InstallationRepository {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  private: boolean;
}

// Lists every repo the installation can access. Unlike mintGithubInstallationToken
// (repo-scoped), this mints an installation-wide token so /installation/repositories
// returns the full set the owner can import.
export async function listInstallationRepositories(env: Env, installationId: number): Promise<InstallationRepository[]> {
  const token = await mintInstallationWideToken(env, installationId);
  const repos: InstallationRepository[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GitHub list installation repositories failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as { repositories: InstallationRepository[] };
    repos.push(...data.repositories);
    // A short page (fewer than per_page) is the last page — the canonical
    // GitHub pagination terminator, and robust without relying on total_count.
    if (data.repositories.length < 100) break;
  }
  return repos;
}

// Records an installation under the logged-in owner (authoritative source of
// the owner_id mapping) and snapshots its selected repos. Called from the App's
// Setup URL callback after the user installs/configures the App.
export async function recordInstallationFromSetup(db: D1, env: Env, ownerId: string, installationId: number): Promise<GithubInstallationDetails> {
  const details = await getInstallation(env, installationId);
  await upsertInstallation(db, {
    installationId: details.id,
    ownerId,
    accountLogin: details.account.login,
    accountId: details.account.id,
    accountType: details.account.type,
    repositorySelection: details.repositorySelection,
    suspendedAt: details.suspendedAt,
  });
  const repos = details.repositorySelection === "selected" ? await listInstallationRepositories(env, installationId) : [];
  await replaceInstallationRepositories(
    db,
    installationId,
    repos.map((repo) => ({ fullName: repo.full_name, repoId: repo.id })),
  );
  return details;
}

async function mintInstallationWideToken(env: Env, installationId: number): Promise<string> {
  const jwt = await githubAppJwt(env);
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub App installation-wide token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function githubAppJwt(env: Env): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not configured");
  }
  const key = await crypto.subtle.importKey("pkcs8", base64Decode(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock drift, exp well under GitHub's 10-minute cap.
  const body = `${base64UrlEncodeJson({ alg: "RS256", typ: "JWT" })}.${base64UrlEncodeJson({ iss: appId, iat: now - 60, exp: now + 540 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// GITHUB_APP_PRIVATE_KEY accepts the raw PEM, a PEM with literal "\n" escapes,
// or a base64-encoded PEM. GitHub App keys are often PKCS#1
// "BEGIN RSA PRIVATE KEY" PEMs; WebCrypto requires PKCS#8, so wrap PKCS#1 DER
// in a PKCS#8 PrivateKeyInfo before import.
function base64Decode(value: string): ArrayBuffer {
  try {
    const normalized = value.trim().replaceAll("\\n", "\n");
    if (normalized.includes("-----BEGIN")) return pemPrivateKeyToPkcs8(normalized);

    const decoded = atob(normalized.replaceAll(/\s+/g, "")).replaceAll("\\n", "\n");
    if (decoded.includes("-----BEGIN")) return pemPrivateKeyToPkcs8(decoded);

    return binaryStringToBytes(decoded).buffer as ArrayBuffer;
  } catch (err) {
    throw new Error(
      `Invalid GITHUB_APP_PRIVATE_KEY: expected raw PKCS#8/RSA PEM, escaped-newline PEM, or base64-encoded PEM (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function pemPrivateKeyToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replaceAll("\\n", "\n").trim();
  const match = normalized.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!match) throw new Error("unsupported PEM private key block");

  const label = match[1];
  const body = match[2].replaceAll(/\s+/g, "");
  const keyDer = binaryStringToBytes(atob(body));
  if (label === "PRIVATE KEY") return keyDer.buffer as ArrayBuffer;
  if (label === "RSA PRIVATE KEY") return wrapPkcs1RsaPrivateKey(keyDer).buffer as ArrayBuffer;
  throw new Error(`unsupported PEM private key type: ${label}`);
}

function binaryStringToBytes(raw: string): Uint8Array {
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function wrapPkcs1RsaPrivateKey(pkcs1Der: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithm = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return derSequence(concatBytes([version, rsaEncryptionAlgorithm, derOctetString(pkcs1Der)]));
}

function derSequence(content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.from([0x30]), derLength(content.length), content]);
}

function derOctetString(content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.from([0x04]), derLength(content.length), content]);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
