#!/usr/bin/env bash
#
# service_runner.sh — one-click run Agent Kanban on 0.0.0.0 for remote access.
#
# Runs the exact same stack as `pnpm dev` (React SPA + Hono worker + local D1
# via Miniflare) but binds Vite to 0.0.0.0, so the board is reachable from
# other hosts on the LAN.
#
# It also starts this machine's local AK runtime (the `ak` machine runner that
# executes tasks) so the whole stack comes up together — including after a
# reboot via systemd. Controlled by env vars:
#   AK_LOCAL_START    1 (default) to start it, 0 to skip
#   AK_LOCAL_API_URL  API origin for the runtime (default: http://127.0.0.1:<port>)
# The runtime uses saved `ak` credentials (non-interactive); set them once with
# `ak start --api-url <url> --api-key <key>`.
#
# Modes:
#   start    (default) run in the background as a detached process (setsid,
#            own process group), logs appended to .run/logs/service.log
#   run      run in the foreground (used by the process spawned from `start`
#            and by systemd — see scripts/install-systemd-service.sh)
#   stop / restart / status / logs   manage the background service
#
# Single-instance guarantee: the service holds an flock on .run/service.lock
# for its whole lifetime (the vite process itself, via fd inheritance across
# exec); its pid is written to .run/service.pid. A second start fails fast
# instead of competing for the port. The lock is per-checkout (under .run), so
# worktree copies can each run their own instance on a different --port.
#
# Refresh options (work with start / restart / run) — pick up new code:
#   --pull       git pull --ff-only before starting (latest frontend+backend)
#   --install    force pnpm install even if node_modules exists (dep changes)
#   --build      rebuild @agent-kanban/shared (the dev server loads its dist,
#                so shared-package changes need this to take effect)
#   --skip-install / --skip-migrate   skip the corresponding setup step
#
# Typical refresh restart after pulling new code:
#   ./service_runner.sh restart --pull --install --build
#
# First run also:
#   - installs dependencies if node_modules is missing
#   - applies D1 migrations to the local database (.wrangler/state)
#   - creates apps/web/.dev.vars (AUTH_SECRET + ALLOWED_HOSTS) when missing so
#     auth works and email-verification links print to the log
#   - sign in at /auth with email+password; the verification link is logged
#
set -euo pipefail

PORT="${AK_PORT:-6265}"
HOST="${AK_HOST:-0.0.0.0}"
DO_INSTALL=1
DO_MIGRATE=1
FORCE_INSTALL=0
DO_PULL=0
DO_BUILD=0
# Start this machine's local AK runtime alongside the UI (default on).
DO_LOCAL_START="${AK_LOCAL_START:-1}"
LOCAL_API_URL="${AK_LOCAL_API_URL:-http://127.0.0.1:${PORT}}"
COMMAND=""

# ---------------------------------------------------------------------------
# Paths + helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"
WEB_DIR="$ROOT/apps/web"
DEV_VARS="$WEB_DIR/.dev.vars"
RUN_DIR="$ROOT/.run"
LOG_DIR="$RUN_DIR/logs"
LOG_FILE="$LOG_DIR/service.log"
PID_FILE="$RUN_DIR/service.pid"
LOCK_FILE="$RUN_DIR/service.lock"

# Colors (disabled when not a TTY)
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  R="$(tput sgr0)"; B="$(tput bold)"; GR="$(tput setaf 2)"; YE="$(tput setaf 3)"; CY="$(tput setaf 6)"; RE="$(tput setaf 1)"
else
  R=""; B=""; GR=""; YE=""; CY=""; RE=""
fi

info()  { printf "%s[*]%s %s\n" "$GR" "$R" "$*"; }
warn()  { printf "%s[!]%s %s\n" "$YE" "$R" "$*" >&2; }
fatal() { printf "%s[x]%s %s\n" "$RE" "$R" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
service_runner.sh — one-click run Agent Kanban on 0.0.0.0 for remote access.

Usage:
  ./service_runner.sh start              # background, detached (default)
  ./service_runner.sh run                # foreground (systemd / debugging)
  ./service_runner.sh stop               # stop the background service
  ./service_runner.sh restart            # stop + start
  ./service_runner.sh status             # service lock + port health
  ./service_runner.sh logs [-f]          # show log (tail -f with -f)
  ./service_runner.sh start --port 8080  # run on a different port
  ./service_runner.sh start --skip-install --skip-migrate
  ./service_runner.sh restart --pull --install --build
                                     # refresh restart: pull latest code,
                                     # reinstall deps, rebuild shared package
  ./service_runner.sh --help

The background service runs as a detached process (setsid, its own process
group) with logs appended to .run/logs/service.log. Uniqueness is enforced by
an flock on .run/service.lock — see the top of this script.

It runs the same stack as `pnpm dev` (React SPA + Hono worker + local D1), but
binds Vite to 0.0.0.0 so the board is reachable from other hosts on the LAN.
It also starts this machine's local AK runtime (`ak local_start`) once the API
is up — set AK_LOCAL_START=0 to skip, AK_LOCAL_API_URL to retarget it.

First run:
  - installs dependencies if node_modules is missing
  - applies D1 migrations to the local database (.wrangler/state)
  - creates apps/web/.dev.vars (AUTH_SECRET + ALLOWED_HOSTS) when missing so
    auth works and email-verification links print to the log
  - sign in at /auth with email+password; the verification link is logged

To start Agent Kanban automatically at boot, install the systemd unit:
  ./scripts/install-systemd-service.sh
EOF
  exit 0
}

# Non-loopback IPv4 addresses of this host (LAN / remote-accessible). Used for
# the generated ALLOWED_HOSTS, so it intentionally keeps every interface.
lan_ips() {
  local ips=""
  if command -v hostname >/dev/null 2>&1; then
    ips="$(hostname -I 2>/dev/null || true)"
  fi
  if [ -z "$ips" ] && command -v ip >/dev/null 2>&1; then
    ips="$(ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | tr '\n' ' ')"
  fi
  if [ -z "$ips" ] && command -v ifconfig >/dev/null 2>&1; then
    ips="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./{print $2}')"
  fi
  # shellcheck disable=SC2086
  printf '%s\n' $ips | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | sort -u
}

# 172.16.0.0/12 and 198.18.0.0/15 are container/tunnel bridge ranges (docker,
# CGNAT benchmarks), not the user-facing LAN. Excluded from the banner only.
is_bridge_ip() {
  local ip=$1 o1 o2
  IFS=. read -r o1 o2 _ _ <<<"$ip"
  if [ "$o1" = "172" ] && [ "$o2" -ge 16 ] && [ "$o2" -le 31 ]; then return 0; fi
  if [ "$o1" = "198" ] && [ "$o2" -ge 18 ] && [ "$o2" -le 19 ]; then return 0; fi
  return 1
}

# The address a peer most likely reaches us on: the default-route source IP,
# falling back to the first non-bridge LAN address. Skips container/tunnel
# ranges so a dockerized or tunneled host still surfaces its real LAN IP.
primary_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
    is_bridge_ip "$ip" && ip=""
  fi
  if [ -z "$ip" ]; then
    ip="$(lan_ips | while read -r a; do is_bridge_ip "$a" || { printf '%s\n' "$a"; break; }; done)"
  fi
  printf '%s\n' "$ip"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || fatal "required command not found: $1 (see README.md for prerequisites)"; }

# --- Singleton guard ---------------------------------------------------------
# Uniqueness is enforced by an flock on $LOCK_FILE, held for the lifetime of
# the service process (fd survives the final `exec npx vite`, so the vite
# process itself holds the lock). The kernel releases the lock automatically
# when the process dies — no stale-pidfile problem. The lock lives under
# $ROOT/.run, so separate checkouts/worktrees each have their own lock and can
# coexist on different ports.
service_running() {
  [ -f "$LOCK_FILE" ] || return 1
  # Lock free → not running (flock exits 0 after acquiring it in the subshell).
  (flock -n "$LOCK_FILE" -c true) 2>/dev/null && return 1
  return 0
}

service_pid() { cat "$PID_FILE" 2>/dev/null || true; }

# Called by cmd_run right before exec'ing the server. FD 9 stays open across
# exec, and $$ becomes the vite pid, so the pidfile always names the process
# holding the lock.
acquire_lock() {
  mkdir -p "$RUN_DIR"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    fatal "another instance of this service is already running (pid $(service_pid), lock $LOCK_FILE). Use '$0 stop' or '$0 restart'."
  fi
  echo $$ >"$PID_FILE"
}

port_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]${PORT}$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]${PORT}$"
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
step_prereqs() {
  require_cmd node
  require_cmd pnpm
  info "node $(node -v), pnpm $(pnpm -v)"
}

# Fast-forward the working copy so a restart picks up the latest frontend and
# backend code. ff-only: a dirty or diverged checkout fails loudly instead of
# producing a surprise merge inside a service script.
step_pull() {
  [ "$DO_PULL" = "1" ] || return 0
  require_cmd git
  info "Pulling latest code (git pull --ff-only)…"
  (cd "$ROOT" && git pull --ff-only) \
    || fatal "git pull --ff-only failed — commit/stash local changes or pull manually, then retry."
  info "Now on $(cd "$ROOT" && git rev-parse --short HEAD) ($(cd "$ROOT" && git branch --show-current))."
}

step_install() {
  [ "$DO_INSTALL" = "1" ] || return 0
  if [ "$FORCE_INSTALL" = "1" ]; then
    info "Installing dependencies (--install)…"
    (cd "$ROOT" && pnpm install --loglevel=warn)
  elif [ ! -d "$ROOT/node_modules" ]; then
    info "Installing dependencies (first run, can take a few minutes)…"
    (cd "$ROOT" && pnpm install --loglevel=warn)
  fi
}

# The dev server imports @agent-kanban/shared from its built dist/, so source
# changes in packages/shared only take effect after a rebuild. Frontend and
# server code under apps/web are compiled on the fly by vite and need no build.
step_build() {
  [ "$DO_BUILD" = "1" ] || return 0
  info "Rebuilding @agent-kanban/shared…"
  (cd "$ROOT" && pnpm --filter @agent-kanban/shared build)
}

# Returns 0 when every migration file in apps/web/migrations is recorded in the
# local D1 d1_migrations table (i.e. the DB is up to date), 1 otherwise.
migrate_verified() {
  command -v sqlite3 >/dev/null 2>&1 || return 1
  local db name
  db="$(find "$WEB_DIR/.wrangler/state/v3/d1" -name '*.sqlite' 2>/dev/null | head -1)"
  [ -n "$db" ] || return 1
  for sql in "$WEB_DIR"/migrations/*.sql; do
    [ -e "$sql" ] || continue
    name="$(basename "$sql")"
    sqlite3 "$db" "SELECT 1 FROM d1_migrations WHERE name = '$name' LIMIT 1;" 2>/dev/null | grep -q 1 || return 1
  done
  return 0
}

step_migrate() {
  [ "$DO_MIGRATE" = "1" ] || return 0
  info "Applying D1 migrations to the local database…"
  # Fast path: if the local D1 DB already has every migration, skip wrangler
  # entirely — it can otherwise finish the migration and then hang forever on
  # an idle update-check HTTPS socket (tunneled networks).
  if migrate_verified; then
    info "Local D1 database already up to date."
    return 0
  fi
  # Bounded run + independent verification: never wait on wrangler indefinitely.
  local rc=0
  (cd "$ROOT" && CI=true WRANGLER_SEND_METRICS=false timeout 120 pnpm --filter @agent-kanban/web db:migrate) || rc=$?
  if [ "$rc" -eq 124 ]; then
    warn "db:migrate timed out after 120s — checking whether migrations actually landed…"
    if migrate_verified; then
      warn "Migrations are recorded in the local D1 database — continuing."
    elif command -v sqlite3 >/dev/null 2>&1; then
      fatal "Migrations did not complete — rerun this script to retry."
    else
      warn "Can't verify (sqlite3 not installed) — continuing; the DB may need a manual migrate."
    fi
  elif [ "$rc" -ne 0 ]; then
    fatal "db:migrate failed with exit code $rc."
  fi
}

step_dev_vars() {
  local allowed ip
  allowed="localhost:${PORT},127.0.0.1:${PORT}"
  for ip in $(lan_ips); do allowed="${allowed},${ip}:${PORT}"; done

  if [ -f "$DEV_VARS" ]; then
    # A file we generated: refresh the IP list but keep AUTH_SECRET stable so
    # existing sessions/sign-ups survive IP changes between runs.
    if grep -q '^# Generated by service_runner.sh' "$DEV_VARS"; then
      if grep -q '^ALLOWED_HOSTS=' "$DEV_VARS"; then
        sed -i "s|^ALLOWED_HOSTS=.*|ALLOWED_HOSTS=$allowed|" "$DEV_VARS"
      else
        printf '\nALLOWED_HOSTS=%s\n' "$allowed" >> "$DEV_VARS"
      fi
      info "Refreshed ALLOWED_HOSTS in $DEV_VARS (AUTH_SECRET kept)."
      return 0
    fi
    grep -q '^AUTH_SECRET=' "$DEV_VARS" \
      || warn "$DEV_VARS exists but has no AUTH_SECRET — sign-in will fail. Add one, or delete the file and rerun."
    grep -q '^ALLOWED_HOSTS=' "$DEV_VARS" \
      || warn "$DEV_VARS exists but has no ALLOWED_HOSTS — email verification won't print locally and remote logins may be rejected. Add e.g. ALLOWED_HOSTS=localhost:${PORT},127.0.0.1:${PORT},<lan-ip>:${PORT}"
    return 0
  fi

  info "Creating $DEV_VARS (AUTH_SECRET + ALLOWED_HOSTS)…"
  local secret
  secret="$(openssl rand -hex 32 2>/dev/null || (head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n'))"

  cat > "$DEV_VARS" <<EOF
# Generated by service_runner.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Edit freely; this file is git-ignored.
AUTH_SECRET=$secret
ALLOWED_HOSTS=$allowed
# Optional: enable "Sign in with GitHub". Create an OAuth app at
# https://github.com/settings/developers, then uncomment and fill in:
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
EOF
  chmod 600 "$DEV_VARS"
  info "Generated $DEV_VARS with a fresh AUTH_SECRET."
}

step_local_start() {
  [ "$DO_LOCAL_START" = "1" ] || return 0
  # The UI must be up first: `ak start` registers/heartbeats against this API.
  if ! port_listening; then
    warn "Skipping local AK runtime — API not listening on $PORT yet."
    return 0
  fi
  if ! command -v ak >/dev/null 2>&1; then
    warn "Skipping local AK runtime — \`ak\` CLI not installed (run ./scripts/install-cli.sh)."
    return 0
  fi
  if ak status >/dev/null 2>&1; then
    info "Local AK runtime already running."
    return 0
  fi
  info "Starting local AK runtime against $LOCAL_API_URL (set AK_LOCAL_START=0 to disable, AK_LOCAL_API_URL to retarget)…"
  if ak local_start --api-url "$LOCAL_API_URL"; then
    info "Local AK runtime started."
  else
    warn "Local AK runtime did not start — board UI is unaffected. Set credentials with \`ak start --api-url $LOCAL_API_URL --api-key <key>\` once, or set AK_LOCAL_START=0 to silence."
  fi
}

step_banner() {
  printf '\n%s────────────────────────────────────────────────────────%s\n' "$CY" "$R"
  printf '%s  Agent Kanban — service runner%s\n' "$B" "$R"
  printf '%s────────────────────────────────────────────────────────%s\n' "$CY" "$R"
  printf '  %sLocal:%s   http://localhost:%s/\n' "$B" "$R" "$PORT"
  local primary="" n=0 ip
  primary="$(primary_ip)"
  if [ -n "$primary" ]; then
    printf '  %sRemote:%s  http://%s:%s/   %s(primary)%s\n' "$B" "$R" "$primary" "$PORT" "$CY" "$R"
  fi
  for ip in $(lan_ips); do
    is_bridge_ip "$ip" && continue
    [ "$ip" = "$primary" ] && continue
    n=$((n + 1))
    printf '  %sLAN #%d:%s   http://%s:%s/\n' "$B" "$n" "$R" "$ip" "$PORT"
  done
  printf '  %sAPI:%s     http://<address-above>:%s/api\n' "$B" "$R" "$PORT"
  printf '%s────────────────────────────────────────────────────────%s\n' "$CY" "$R"
  if [ -z "$primary" ] && [ "$n" -eq 0 ]; then
    warn "No LAN IP detected — the server still binds $HOST:$PORT, but I couldn't enumerate an address. Check the network / firewall."
  fi
  if [ -f "$DEV_VARS" ] && ! grep -q '^GITHUB_CLIENT_SECRET=' "$DEV_VARS"; then
    printf '%s[·]%s First login: open /auth and register with email+password.\n' "$CY" "$R"
    printf '%s[·]%s The email-verification link prints in the service log (local dev never sends real email).\n' "$CY" "$R"
    printf '%s[·]%s GitHub OAuth is off — add GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET to %s to enable it.\n' "$CY" "$R" "$DEV_VARS"
  fi
  printf '%s[·]%s After creating a machine API key, start local task execution with scripts/local_runtime_runner.sh.\n' "$CY" "$R"
  printf '\n'
}

# Full foreground run: setup + exec vite. Used by `run` directly, by the
# detached process spawned from `start`, and by the systemd unit.
cmd_run() {
  step_prereqs
  step_pull
  step_install
  step_build
  step_migrate
  step_dev_vars
  # Bring up the local AK runtime only when the API is already reachable (e.g.
  # systemd Restart=on-failure respawn after a crash). On a cold boot the UI
  # isn't listening yet, so this no-ops — the runtime starts on the next respawn.
  step_local_start
  step_banner
  acquire_lock
  info "Starting dev server on $HOST:$PORT (React SPA + Hono worker + local D1). Ctrl-C to stop."
  cd "$WEB_DIR"
  exec npx vite dev --host "$HOST" --port "$PORT"
}

cmd_start() {
  # Serialize concurrent `start` invocations for the setup+spawn window —
  # setup steps can take a while on a cold boot, and the service's own
  # singleton lock is only acquired once the spawned `run` reaches
  # acquire_lock. fd 8 is released when this function returns.
  mkdir -p "$RUN_DIR"
  exec 8>"$RUN_DIR/start.lock"
  flock 8

  if service_running; then
    info "Already running (pid $(service_pid))."
    cmd_status
    return 0
  fi

  # Run setup in the foreground so install/migrate failures surface here,
  # not buried in the log of a session that died silently.
  step_prereqs
  step_pull
  step_install
  step_build
  step_migrate
  step_dev_vars

  mkdir -p "$LOG_DIR"
  {
    printf '\n════════════════════════════════════════════════════════\n'
    printf '  service start — %s (host=%s port=%s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$HOST" "$PORT"
    printf '════════════════════════════════════════════════════════\n'
  } >> "$LOG_FILE"

  # Detached into its own session/process group (setsid): survives this
  # shell's exit, and lets `stop` kill vite + its workerd/esbuild children
  # with one process-group signal. fd 8 is closed in the child so the start
  # lock isn't held for the service's whole lifetime.
  AK_PORT="$PORT" AK_HOST="$HOST" setsid \
    bash -c "exec 8>&-; exec '$ROOT/service_runner.sh' run --skip-install --skip-migrate >> '$LOG_FILE' 2>&1" \
    </dev/null &

  # Wait for the port (vite cold start + D1 init can take a few seconds).
  local waited=0
  while [ "$waited" -lt 30 ]; do
    if port_listening; then break; fi
    sleep 1
    waited=$((waited + 1))
  done

  step_local_start
  step_banner
  if port_listening; then
    info "Running in background (pid $(service_pid), port $PORT)."
  else
    warn "Service spawned but port $PORT isn't listening yet — last log lines:"
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  fi
  printf '%s[·]%s Logs:    %s  (./service_runner.sh logs -f to follow)\n' "$CY" "$R" "$LOG_FILE"
  printf '%s[·]%s Stop:    ./service_runner.sh stop\n' "$CY" "$R"
  printf '\n'
}

cmd_stop() {
  local stopped=0
  # Stop the service by pidfile/lock. Note: under systemd use
  # `systemctl stop` instead, or the unit's Restart policy will respawn it.
  if service_running; then
    local pid waited=0
    pid="$(service_pid)"
    info "Stopping service process $pid…"
    # Prefer killing the whole process group: vite's children (workerd,
    # esbuild) inherit the lock fd and would keep the singleton held after
    # vite itself dies. Only group-kill when the service leads its own group —
    # a foreground `run` shares the user's shell pgrp, which must not be
    # group-killed.
    if [ -n "$pid" ] && [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ]; then
      kill -- -"$pid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
    while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      warn "Process $pid still alive after 10s — sending SIGKILL."
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && fatal "Could not stop service process $pid."
    if service_running; then
      warn "Service process is dead but a child still holds the lock — it releases when that child exits."
    fi
    stopped=1
  fi
  if [ "$stopped" = "0" ]; then
    info "Not running (no service lock held)."
    rm -f "$PID_FILE"
    return 0
  fi
  rm -f "$PID_FILE"
  info "Stopped."
}

cmd_status() {
  if service_running; then
    info "service is running (pid $(service_pid), lock $LOCK_FILE)."
  else
    warn "service lock not held (no running instance)."
  fi
  if port_listening; then
    info "port $PORT is listening."
  else
    warn "port $PORT is not listening."
  fi
  if [ -f "$LOG_FILE" ]; then
    info "log: $LOG_FILE ($(du -h "$LOG_FILE" | cut -f1))"
  fi
  service_running && port_listening
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || fatal "no log file yet at $LOG_FILE — start the service first."
  if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
    exec tail -n 100 -f "$LOG_FILE"
  fi
  tail -n 100 "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    start|run|stop|restart|status) COMMAND="$1"; shift ;;
    logs) COMMAND="logs"; shift; LOG_ARG="${1:-}"; [ $# -gt 0 ] && shift || true ;;
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --pull) DO_PULL=1; shift ;;
    --install) DO_INSTALL=1; FORCE_INSTALL=1; shift ;;
    --build) DO_BUILD=1; shift ;;
    --skip-install) DO_INSTALL=0; FORCE_INSTALL=0; shift ;;
    --skip-migrate) DO_MIGRATE=0; shift ;;
    --help|-h) usage ;;
    *) fatal "unknown option: $1 (try --help)" ;;
  esac
done
COMMAND="${COMMAND:-start}"

case "$PORT" in
  ''|*[!0-9]*) fatal "--port must be a number" ;;
esac

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
case "$COMMAND" in
  start)   cmd_start ;;
  run)     cmd_run ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${LOG_ARG:-}" ;;
esac
