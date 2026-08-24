#!/usr/bin/env bash
#
# service_runner.sh — one-click run Agent Kanban on 0.0.0.0 for remote access.
#
# Runs the exact same stack as `pnpm dev` (React SPA + Hono worker + local D1
# via Miniflare) but binds Vite to 0.0.0.0, so the board is reachable from
# other hosts on the LAN.
#
# Modes:
#   start    (default) run in the background inside a detached screen session,
#            logs appended to .run/logs/service.log
#   run      run in the foreground (used by the screen session and by systemd —
#            see scripts/install-systemd-service.sh)
#   stop / restart / status / logs   manage the background service
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
SESSION="agent-kanban"

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
  ./service_runner.sh start              # background via screen (default)
  ./service_runner.sh run                # foreground (systemd / debugging)
  ./service_runner.sh stop               # stop the background service
  ./service_runner.sh restart            # stop + start
  ./service_runner.sh status             # screen session + port health
  ./service_runner.sh logs [-f]          # show log (tail -f with -f)
  ./service_runner.sh start --port 8080  # run on a different port
  ./service_runner.sh start --skip-install --skip-migrate
  ./service_runner.sh restart --pull --install --build
                                     # refresh restart: pull latest code,
                                     # reinstall deps, rebuild shared package
  ./service_runner.sh --help

The background service runs in a detached screen session named
"agent-kanban"; logs are appended to .run/logs/service.log.

It runs the same stack as `pnpm dev` (React SPA + Hono worker + local D1), but
binds Vite to 0.0.0.0 so the board is reachable from other hosts on the LAN.

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

screen_running() { screen -ls 2>/dev/null | grep -q "[.]$SESSION[[:space:]]"; }

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
# screen session spawned from `start`, and by the systemd unit.
cmd_run() {
  step_prereqs
  step_pull
  step_install
  step_build
  step_migrate
  step_dev_vars
  step_banner
  info "Starting dev server on $HOST:$PORT (React SPA + Hono worker + local D1). Ctrl-C to stop."
  cd "$WEB_DIR"
  exec npx vite dev --host "$HOST" --port "$PORT"
}

cmd_start() {
  require_cmd screen
  if screen_running; then
    info "Already running (screen session '$SESSION')."
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

  AK_PORT="$PORT" AK_HOST="$HOST" screen -dmS "$SESSION" \
    bash -c "exec '$ROOT/service_runner.sh' run --skip-install --skip-migrate >> '$LOG_FILE' 2>&1"

  # Wait for the port (vite cold start + D1 init can take a few seconds).
  local waited=0
  while [ "$waited" -lt 30 ]; do
    if port_listening; then break; fi
    screen_running || { warn "Screen session died during startup — last log lines:"; tail -n 20 "$LOG_FILE" >&2; exit 1; }
    sleep 1
    waited=$((waited + 1))
  done

  step_banner
  if port_listening; then
    info "Running in background (screen session '$SESSION', port $PORT)."
  else
    warn "Screen session started but port $PORT isn't listening yet — check the log."
  fi
  printf '%s[·]%s Logs:    %s  (./service_runner.sh logs -f to follow)\n' "$CY" "$R" "$LOG_FILE"
  printf '%s[·]%s Attach:  screen -r %s   (detach with Ctrl-A D)\n' "$CY" "$R" "$SESSION"
  printf '%s[·]%s Stop:    ./service_runner.sh stop\n' "$CY" "$R"
  printf '\n'
}

cmd_stop() {
  if ! screen_running; then
    info "Not running (no screen session '$SESSION')."
    return 0
  fi
  info "Stopping screen session '$SESSION'…"
  screen -S "$SESSION" -X quit
  local waited=0
  while screen_running && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if screen_running; then
    warn "Session still alive after 10s — sending SIGKILL to the window."
    screen -S "$SESSION" -p 0 -X kill 2>/dev/null || true
    sleep 1
  fi
  screen_running && fatal "Could not stop screen session '$SESSION'."
  info "Stopped."
}

cmd_status() {
  if screen_running; then
    info "screen session '$SESSION' is up:"
    screen -ls | grep "[.]$SESSION[[:space:]]" | sed 's/^/    /'
  else
    warn "screen session '$SESSION' is not running."
  fi
  if port_listening; then
    info "port $PORT is listening."
  else
    warn "port $PORT is not listening."
  fi
  if [ -f "$LOG_FILE" ]; then
    info "log: $LOG_FILE ($(du -h "$LOG_FILE" | cut -f1))"
  fi
  screen_running && port_listening
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
