import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const workerWorkspace = process.env.AK_WORKSPACE_DIR || (process.env.AK_WORKER === "1" && process.env.AMA_WORKSPACE ? process.env.AMA_WORKSPACE : "");
const workerAkDir = workerWorkspace ? join(workerWorkspace, ".ak") : "";

export const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "agent-kanban")
  : workerAkDir
    ? join(workerAkDir, "config")
    : join(home, ".config", "agent-kanban");

export const DATA_DIR = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "agent-kanban")
  : workerAkDir
    ? join(workerAkDir, "data")
    : join(home, ".local", "share", "agent-kanban");

export const STATE_DIR = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "agent-kanban")
  : workerAkDir
    ? join(workerAkDir, "state")
    : join(home, ".local", "state", "agent-kanban");

export const LOGS_DIR = join(STATE_DIR, "logs");

export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const PID_FILE = join(STATE_DIR, "daemon.pid");
export const DAEMON_STATE_FILE = join(STATE_DIR, "daemon-state.json");
export const MACHINE_ID_FILE = join(STATE_DIR, "machine-id");
export const BIN_DIR = join(DATA_DIR, "bin");
export const REPOS_DIR = join(DATA_DIR, "repos");
export const WORKTREES_DIR = join(DATA_DIR, "worktrees");
export const SESSIONS_DIR = join(STATE_DIR, "sessions");
export const TRACKED_TASKS_FILE = join(STATE_DIR, "tracked-tasks.json");
export const IDENTITIES_DIR = join(STATE_DIR, "identities");
export const WORKER_AUTH_SESSION_FILE = join(STATE_DIR, "worker-auth-session.json");

// Legacy paths — used only for migration, then removed
export const LEGACY_SAVED_SESSIONS_FILE = join(DATA_DIR, "saved-sessions.json");
export const LEGACY_SESSION_PIDS_FILE = join(DATA_DIR, "session-pids.json");
