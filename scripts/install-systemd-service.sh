#!/usr/bin/env bash
#
# install-systemd-service.sh — install Agent Kanban as a systemd service that
# starts automatically at boot.
#
# Installs a unit that runs `service_runner.sh run` in the foreground (systemd
# tracks and restarts the process itself — no screen involved). Service logs go
# to the journal (`journalctl`) and, because the unit just runs the normal
# runner, the same console output a manual run produces.
#
# Default is a *user* service (no root needed). With --system it installs a
# system-wide unit instead (requires sudo).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="agent-kanban"
PORT="${AK_PORT:-6265}"
HOST="${AK_HOST:-0.0.0.0}"
MODE="user"          # user | system
DO_START=1
DO_UNINSTALL=0

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
  cat <<EOF
install-systemd-service.sh — install Agent Kanban as a systemd service.

Usage:
  ./scripts/install-systemd-service.sh              # user service, enable + start
  ./scripts/install-systemd-service.sh --system     # system-wide service (sudo)
  ./scripts/install-systemd-service.sh --port 8080  # bake a different port into the unit
  ./scripts/install-systemd-service.sh --no-start   # install + enable, but don't start now
  ./scripts/install-systemd-service.sh --uninstall  # stop, disable, remove the unit
  ./scripts/install-systemd-service.sh --help

User service (default): installed to ~/.config/systemd/user/${SERVICE_NAME}.service
and starts at boot *for this user*. To also start without an interactive login,
linger must be enabled once:  loginctl enable-linger \$USER
(the script does this automatically when possible).

System service (--system): installed to /etc/systemd/system/${SERVICE_NAME}.service,
runs as the invoking user, starts at boot.

Manage it afterwards with:
  systemctl --user status ${SERVICE_NAME}     # or: sudo systemctl status ${SERVICE_NAME}
  journalctl --user -u ${SERVICE_NAME} -f     # follow logs
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system) MODE="system"; shift ;;
    --user) MODE="user"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --no-start) DO_START=0; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    --help|-h) usage ;;
    *) fatal "unknown option: $1 (try --help)" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fatal "--port must be a number" ;;
esac

[ -f "$ROOT/service_runner.sh" ] || fatal "service_runner.sh not found at $ROOT — this script must live in the repo's scripts/ directory."
command -v systemctl >/dev/null 2>&1 || fatal "systemctl not found — this host doesn't use systemd."

# systemctl invocation + unit path per mode
if [ "$MODE" = "system" ]; then
  SUDO=""
  [ "$(id -u)" = "0" ] || SUDO="sudo"
  CTL="$SUDO systemctl"
  UNIT_DIR="/etc/systemd/system"
else
  SUDO=""
  CTL="systemctl --user"
  UNIT_DIR="$HOME/.config/systemd/user"
fi
UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$DO_UNINSTALL" = "1" ]; then
  info "Uninstalling ${SERVICE_NAME}.service ($MODE)…"
  $CTL stop "$SERVICE_NAME" 2>/dev/null || true
  $CTL disable "$SERVICE_NAME" 2>/dev/null || true
  if [ -f "$UNIT_FILE" ]; then
    $SUDO rm -f "$UNIT_FILE"
    info "Removed $UNIT_FILE"
  else
    warn "No unit file at $UNIT_FILE — nothing to remove."
  fi
  $CTL daemon-reload
  info "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
mkdir -p "$UNIT_DIR" 2>/dev/null || $SUDO mkdir -p "$UNIT_DIR"

# The unit runs the runner in the foreground; systemd handles restart-on-crash
# and boot ordering. PATH is pinned explicitly because services get a minimal
# environment — nvm/volta-managed node would otherwise be missing.
# System units run as root unless told otherwise, so pin the invoking user to
# keep file ownership (node_modules, .wrangler/state, .run/) consistent.
RUN_USER=""
if [ "$MODE" = "system" ]; then
  RUN_USER="User=${SUDO_USER:-$(id -un)}"
fi

UNIT="$(cat <<EOF
[Unit]
Description=Agent Kanban (React SPA + Hono worker + local D1)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${RUN_USER}
WorkingDirectory=$ROOT
ExecStart=/usr/bin/env bash $ROOT/service_runner.sh run
Restart=on-failure
RestartSec=5
Environment=AK_PORT=$PORT
Environment=AK_HOST=$HOST
Environment=PATH=$PATH

[Install]
WantedBy=$([ "$MODE" = "system" ] && printf 'multi-user.target' || printf 'default.target')
EOF
)"
# systemd ignores blank lines inside a section, so an empty ${RUN_USER} is fine.

if [ "$MODE" = "system" ]; then
  printf '%s\n' "$UNIT" | $SUDO tee "$UNIT_FILE" >/dev/null
else
  printf '%s\n' "$UNIT" > "$UNIT_FILE"
fi
info "Wrote $UNIT_FILE"

$CTL daemon-reload
$CTL enable "$SERVICE_NAME"
info "Enabled ${SERVICE_NAME}.service (starts at boot)."

if [ "$MODE" = "user" ]; then
  # Without linger, a user service only starts when the user logs in.
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      info "Linger enabled for $(id -un) — the service starts at boot without login."
    else
      warn "Could not enable linger automatically. Run: sudo loginctl enable-linger $(id -un)"
    fi
  fi
fi

if [ "$DO_START" = "1" ]; then
  $CTL start "$SERVICE_NAME"
  sleep 2
  if $CTL is-active --quiet "$SERVICE_NAME"; then
    info "Started. Board will be at http://<this-host>:$PORT/ once vite is up."
  else
    warn "Service failed to stay up — inspect with: $CTL status $SERVICE_NAME"
  fi
fi

JOURNAL="journalctl --user"
UNINSTALL_FLAG=""
if [ "$MODE" = "system" ]; then
  JOURNAL="sudo journalctl"
  UNINSTALL_FLAG="--system "
fi
printf '\n%s[·]%s Status:  %s status %s\n' "$CY" "$R" "$CTL" "$SERVICE_NAME"
printf '%s[·]%s Logs:    %s -u %s -f\n' "$CY" "$R" "$JOURNAL" "$SERVICE_NAME"
printf '%s[·]%s Remove:  ./scripts/install-systemd-service.sh %s--uninstall\n' "$CY" "$R" "$UNINSTALL_FLAG"
printf '\n'
