#!/usr/bin/env bash
#
# service_runner.sh — one-click run Agent Kanban on 0.0.0.0 for remote access.
#
# Runs the exact same stack as `pnpm dev` (React SPA + Hono worker + local D1
# via Miniflare) but binds Vite to 0.0.0.0, so the board is reachable from
# other hosts on the LAN. Prints the same startup information a normal dev run
# shows (Local + Network URLs), then streams the vite/worker logs.
#
# First run also:
#   - installs dependencies if node_modules is missing
#   - applies D1 migrations to the local database (.wrangler/state)
#   - creates apps/web/.dev.vars (AUTH_SECRET + ALLOWED_HOSTS) when missing so
#     auth works and email-verification links print to this console
#   - sign in at /auth with email+password; the verification link is logged here
#
set -euo pipefail

PORT="${AK_PORT:-6265}"
HOST="${AK_HOST:-0.0.0.0}"
DO_INSTALL=1
DO_MIGRATE=1

# ---------------------------------------------------------------------------
# Paths + helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
DEV_VARS="$WEB_DIR/.dev.vars"

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
  ./scripts/service_runner.sh              # install-if-needed + migrate + run
  ./scripts/service_runner.sh --port 8080  # run on a different port
  ./scripts/service_runner.sh --skip-install
  ./scripts/service_runner.sh --skip-migrate
  ./scripts/service_runner.sh --help

It runs the same stack as `pnpm dev` (React SPA + Hono worker + local D1), but
binds Vite to 0.0.0.0 so the board is reachable from other hosts on the LAN.

First run:
  - installs dependencies if node_modules is missing
  - applies D1 migrations to the local database (.wrangler/state)
  - creates apps/web/.dev.vars (AUTH_SECRET + ALLOWED_HOSTS) when missing so
    auth works and email-verification links print to this console
  - sign in at /auth with email+password; the verification link is logged here
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

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
step_prereqs() {
  require_cmd node
  require_cmd pnpm
  info "node $(node -v), pnpm $(pnpm -v)"
}

step_install() {
  [ "$DO_INSTALL" = "1" ] || return 0
  [ -d "$ROOT/node_modules" ] || {
    info "Installing dependencies (first run, can take a few minutes)…"
    (cd "$ROOT" && pnpm install --loglevel=warn)
  }
}

step_migrate() {
  [ "$DO_MIGRATE" = "1" ] || return 0
  info "Applying D1 migrations to the local database…"
  (cd "$ROOT" && pnpm --filter @agent-kanban/web db:migrate)
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
    printf '%s[·]%s The email-verification link prints in this console (local dev never sends real email).\n' "$CY" "$R"
  printf '%s[·]%s GitHub OAuth is off — add GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET to %s to enable it.\n' "$CY" "$R" "$DEV_VARS"
  fi
  printf '%s[·]%s After creating a machine API key, start local task execution with scripts/local_runtime_runner.sh.\n' "$CY" "$R"
  printf '\n'
}

step_run() {
  info "Starting dev server on $HOST:$PORT (React SPA + Hono worker + local D1). Ctrl-C to stop."
  cd "$WEB_DIR"
  exec npx vite dev --host "$HOST" --port "$PORT"
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --skip-migrate) DO_MIGRATE=0; shift ;;
    --help|-h) usage ;;
    *) fatal "unknown option: $1 (try --help)" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fatal "--port must be a number" ;;
esac

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
step_prereqs
step_install
step_migrate
step_dev_vars
step_banner
step_run
