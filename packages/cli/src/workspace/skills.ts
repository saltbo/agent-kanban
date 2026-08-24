import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { isValidSkillRef } from "@agent-kanban/shared";
import { createLogger } from "../logger.js";
import { DATA_DIR } from "../paths.js";
import { getRuntimeSettings } from "../providers/runtimeSettingsState.js";
import { ensureGitExclude } from "./gitExclude.js";

const logger = createLogger("skills");

const SKILL_SOURCE = process.env.AK_AGENT_KANBAN_SKILL_SOURCE || "saltbo/agent-kanban";
const SKILL_NAME = "agent-kanban";
const SKILL_GITIGNORE_ENTRIES = [".claude/skills/", ".agents/"];
const CACHE_DIR = join(DATA_DIR, "skill-cache");
const OBJECTS_DIR = join(CACHE_DIR, "objects");
const STAGING_DIR = join(CACHE_DIR, "staging");
const MANIFEST_FILE = join(CACHE_DIR, "manifest.json");
const REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FAILED_INSTALL_BACKOFF_MS = 5 * 60 * 1000;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const execFileAsync = promisify(execFile);

interface CacheEntry {
  ref: string;
  source: string;
  skill: string;
  contentHash: string;
  fetchedAt: number;
  checkedAt: number;
}

interface CacheManifest {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface SkillSnapshot {
  ref: string;
  skill: string;
  contentHash: string;
  objectDir: string;
}

const failedUntil = new Map<string, number>();

function emptyManifest(): CacheManifest {
  return { version: 1, entries: {} };
}

function ensureCacheDirs(): void {
  mkdirSync(OBJECTS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
}

function readManifest(): CacheManifest {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Partial<CacheManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) return emptyManifest();
    const entries: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<CacheEntry>;
      if (
        entry.ref !== key ||
        typeof entry.source !== "string" ||
        typeof entry.skill !== "string" ||
        !SAFE_SKILL_NAME_RE.test(entry.skill) ||
        typeof entry.contentHash !== "string" ||
        !CONTENT_HASH_RE.test(entry.contentHash) ||
        typeof entry.fetchedAt !== "number" ||
        !Number.isFinite(entry.fetchedAt) ||
        typeof entry.checkedAt !== "number" ||
        !Number.isFinite(entry.checkedAt)
      ) {
        continue;
      }
      let parsedRef: { source: string; skill: string };
      try {
        parsedRef = parseSkillRef(entry.ref);
      } catch {
        continue;
      }
      if (
        parsedRef.source !== entry.source ||
        parsedRef.skill !== entry.skill ||
        (entry.ref !== `${SKILL_SOURCE}@${SKILL_NAME}` && !isValidSkillRef(entry.ref))
      ) {
        continue;
      }
      entries[key] = entry as CacheEntry;
    }
    return { version: 1, entries };
  } catch {
    return emptyManifest();
  }
}

function writeManifest(manifest: CacheManifest): void {
  ensureCacheDirs();
  const temp = `${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, MANIFEST_FILE);
}

function parseSkillRef(ref: string): { source: string; skill: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1) throw new Error(`Invalid skill reference: ${ref}`);
  const source = ref.slice(0, at);
  const skill = ref.slice(at + 1);
  if (!SAFE_SKILL_NAME_RE.test(skill)) throw new Error(`Unsafe skill name in reference: ${ref}`);
  return { source, skill };
}

function requestedRefs(agentSkills: string[]): Array<{ ref: string; source: string; skill: string }> {
  const refs = [`${SKILL_SOURCE}@${SKILL_NAME}`, ...agentSkills];
  const byName = new Map<string, string>();
  return refs.map((ref, index) => {
    if (index > 0 && !isValidSkillRef(ref)) throw new Error(`Invalid skill reference: ${ref}`);
    const parsed = parseSkillRef(ref);
    const existing = byName.get(parsed.skill);
    if (existing && existing !== ref) throw new Error(`Skill name collision: ${existing} and ${ref} both install as "${parsed.skill}"`);
    byName.set(parsed.skill, ref);
    return { ref, ...parsed };
  });
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`d:${name}\0`);
        visit(path);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Skill snapshot contains unsupported symlink: ${name} -> ${readlinkSync(path)}`);
      } else if (entry.isFile()) {
        hash.update(`f:${name}\0`);
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function objectIsUsable(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry || !CONTENT_HASH_RE.test(entry.contentHash)) return false;
  const objectDir = join(OBJECTS_DIR, entry.contentHash);
  try {
    return existsSync(join(objectDir, "SKILL.md")) && hashDirectory(objectDir) === entry.contentHash;
  } catch {
    return false;
  }
}

function createInstallStaging(skill: string): string {
  ensureCacheDirs();
  const staging = mkdtempSync(join(STAGING_DIR, `${skill}-`));
  // skills CLI treats a directory outside a project as a global install.
  mkdirSync(join(staging, ".git"));
  return staging;
}

function publishStagedSkill(ref: string, source: string, skill: string, staging: string, previous?: CacheEntry): CacheEntry {
  const installed = join(staging, ".agents", "skills", skill);
  if (!existsSync(join(installed, "SKILL.md"))) throw new Error(`installer did not produce .agents/skills/${skill}/SKILL.md`);
  const sourceDir = realpathSync(installed);
  const contentHash = hashDirectory(sourceDir);
  const objectDir = join(OBJECTS_DIR, contentHash);
  let existingIsUsable = false;
  if (existsSync(objectDir)) {
    try {
      existingIsUsable = existsSync(join(objectDir, "SKILL.md")) && hashDirectory(objectDir) === contentHash;
    } catch {
      existingIsUsable = false;
    }
  }
  if (!existingIsUsable) {
    const pendingObject = join(OBJECTS_DIR, `.pending-${randomUUID()}`);
    const quarantine = join(OBJECTS_DIR, `.corrupt-${randomUUID()}`);
    cpSync(sourceDir, pendingObject, { recursive: true, dereference: false, errorOnExist: true });
    try {
      if (existsSync(objectDir)) renameSync(objectDir, quarantine);
      renameSync(pendingObject, objectDir);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (err) {
      rmSync(pendingObject, { recursive: true, force: true });
      if (!existsSync(objectDir) && existsSync(quarantine)) renameSync(quarantine, objectDir);
      throw err;
    }
  }
  failedUntil.delete(ref);
  const now = Date.now();
  return {
    ref,
    source,
    skill,
    contentHash,
    fetchedAt: previous?.contentHash === contentHash ? previous.fetchedAt : now,
    checkedAt: now,
  };
}

function installFailure(ref: string, previous: CacheEntry | undefined, err: unknown): CacheEntry | null {
  failedUntil.set(ref, Date.now() + FAILED_INSTALL_BACKOFF_MS);
  logger.warn(`Failed to refresh skill "${ref}"; keeping last-known-good snapshot: ${(err as Error).message}`);
  return previous && objectIsUsable(previous) ? previous : null;
}

function installIntoCache(ref: string, source: string, skill: string, previous?: CacheEntry): CacheEntry | null {
  if (Date.now() < (failedUntil.get(ref) ?? 0)) return previous && objectIsUsable(previous) ? previous : null;
  const staging = createInstallStaging(skill);
  try {
    logger.info(`Refreshing machine skill cache for "${ref}"`);
    execFileSync("npx", ["skills", "add", source, "--skill", skill, "--agent", "universal", "--copy", "-y"], {
      cwd: staging,
      stdio: "pipe",
      timeout: 300_000,
    });
    return publishStagedSkill(ref, source, skill, staging, previous);
  } catch (err) {
    return installFailure(ref, previous, err);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function installIntoCacheAsync(
  ref: string,
  source: string,
  skill: string,
  previous?: CacheEntry,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  if (Date.now() < (failedUntil.get(ref) ?? 0)) return previous && objectIsUsable(previous) ? previous : null;
  const staging = createInstallStaging(skill);
  try {
    logger.info(`Refreshing machine skill cache for "${ref}" in background`);
    await execFileAsync("npx", ["skills", "add", source, "--skill", skill, "--agent", "universal", "--copy", "-y"], {
      cwd: staging,
      timeout: 300_000,
      signal,
    });
    return publishStagedSkill(ref, source, skill, staging, previous);
  } catch (err) {
    return installFailure(ref, previous, err);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function snapshotFor(entry: CacheEntry): SkillSnapshot {
  return { ref: entry.ref, skill: entry.skill, contentHash: entry.contentHash, objectDir: join(OBJECTS_DIR, entry.contentHash) };
}

/** Resolve requested skills before any worktree is created. */
export function prepareSkillSnapshots(agentSkills: string[]): SkillSnapshot[] | null {
  try {
    const requested = requestedRefs(agentSkills);
    const manifest = readManifest();
    let changed = false;
    const snapshots: SkillSnapshot[] = [];
    for (const item of requested) {
      let entry: CacheEntry | undefined = manifest.entries[item.ref];
      if (entry && (entry.ref !== item.ref || entry.source !== item.source || entry.skill !== item.skill)) entry = undefined;
      if (!objectIsUsable(entry)) {
        const installed = installIntoCache(item.ref, item.source, item.skill, entry);
        if (!installed) return null;
        entry = installed;
        manifest.entries[item.ref] = installed;
        changed = true;
      }
      snapshots.push(snapshotFor(entry));
    }
    if (changed) writeManifest(manifest);
    return snapshots;
  } catch (err) {
    logger.error(`Failed to prepare skill snapshots: ${(err as Error).message}`);
    return null;
  }
}

/** Copy fixed snapshots into a workspace without network access. */
export function materializeSkillSnapshots(worktreeDir: string, snapshots: SkillSnapshot[]): boolean {
  try {
    for (const snapshot of snapshots) {
      if (!SAFE_SKILL_NAME_RE.test(snapshot.skill) || !CONTENT_HASH_RE.test(snapshot.contentHash)) throw new Error("Invalid skill snapshot metadata");
      const expectedObjectDir = join(OBJECTS_DIR, snapshot.contentHash);
      if (
        snapshot.objectDir !== expectedObjectDir ||
        !existsSync(join(expectedObjectDir, "SKILL.md")) ||
        hashDirectory(expectedObjectDir) !== snapshot.contentHash
      ) {
        throw new Error(`Missing or corrupt cached object ${snapshot.contentHash}`);
      }
      for (const base of [join(worktreeDir, ".agents", "skills"), join(worktreeDir, ".claude", "skills")]) {
        const target = join(base, snapshot.skill);
        if (existsSync(target)) {
          if (existsSync(join(target, "SKILL.md")) && hashDirectory(realpathSync(target)) === snapshot.contentHash) continue;
          throw new Error(`Workspace already contains a different skill named "${snapshot.skill}"`);
        }
        mkdirSync(base, { recursive: true });
        cpSync(snapshot.objectDir, target, { recursive: true, dereference: false, errorOnExist: true });
      }
    }

    ensureGitExclude(worktreeDir, SKILL_GITIGNORE_ENTRIES, "agent skills (managed by daemon)");
    return true;
  } catch (err) {
    logger.error(`Failed to materialize skill snapshots: ${(err as Error).message}`);
    return false;
  }
}

async function refreshStaleEntries(signal?: AbortSignal): Promise<void> {
  const settings = getRuntimeSettings();
  if (!settings.skill_cache_auto_update) return;
  const maxAgeMs = settings.skill_cache_refresh_hours * 60 * 60 * 1000;
  const manifest = readManifest();
  for (const entry of Object.values(manifest.entries)) {
    if (signal?.aborted) return;
    if (Date.now() - entry.checkedAt < maxAgeMs) continue;
    const refreshed = await installIntoCacheAsync(entry.ref, entry.source, entry.skill, entry, signal);
    if (!refreshed) continue;
    // Merge with the latest manifest so a foreground cache fill that happened
    // while the child process ran is not lost.
    const current = readManifest();
    current.entries[entry.ref] = refreshed;
    writeManifest(current);
  }
}

/** Start a non-blocking hourly check using the latest heartbeat settings. */
export function startSkillCacheRefresh(): () => void {
  let running = false;
  let controller: AbortController | null = null;
  const run = () => {
    if (running) return;
    running = true;
    controller = new AbortController();
    refreshStaleEntries(controller.signal)
      .catch((err) => logger.warn(`Skill cache refresh failed: ${(err as Error).message}`))
      .finally(() => {
        running = false;
        controller = null;
      });
  };
  run();
  const timer = setInterval(run, REFRESH_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    controller?.abort();
  };
}

export const skillCachePaths = { cacheDir: CACHE_DIR, manifestFile: MANIFEST_FILE, objectsDir: OBJECTS_DIR };
