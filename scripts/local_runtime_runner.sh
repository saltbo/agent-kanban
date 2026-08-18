#!/usr/bin/env bash
#
# Reproducibly install and start Agent Kanban's local task runtime.
# The runtime registers this machine with the local AK API and executes tasks
# through locally installed agent CLIs. It does not require AMA or Cloudflare.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

API_URL="${AK_API_URL:-http://127.0.0.1:6265}"
MAX_CONCURRENT="${AK_MAX_CONCURRENT:-5}"
POLL_INTERVAL="${AK_POLL_INTERVAL:-10000}"
TASK_TIMEOUT="${AK_TASK_TIMEOUT:-7200000}"
DO_INSTALL=1
DO_RESTART=0

fatal() { printf '[x] %s\n' "$*" >&2; exit 1; }
info() { printf '[*] %s\n' "$*"; }

usage() {
  printf '%s\n' \
    'local_runtime_runner.sh — install and start the local AK machine runtime.' \
    '' \
    'Usage:' \
    '  AK_API_KEY=ak_xxx ./scripts/local_runtime_runner.sh' \
    '  ./scripts/local_runtime_runner.sh --api-url http://127.0.0.1:6265' \
    '  ./scripts/local_runtime_runner.sh --restart --skip-install' \
    '' \
    'Options:' \
    '  --api-url <url>          Local AK API origin' \
    '  --max-concurrent <n>     Maximum concurrent local agents (default: 5)' \
    '  --poll-interval <ms>     Task polling interval (default: 10000)' \
    '  --task-timeout <ms>      Per-task timeout; 0 disables it (default: 7200000)' \
    '  --restart                Restart an existing runtime' \
    '  --skip-install           Reuse the currently installed ak CLI' \
    '' \
    'Authentication:' \
    '  Set AK_API_KEY for the first run. The CLI stores it in the local AK' \
    '  config with directory mode 0700 and file mode 0600. Later runs' \
    '  can omit AK_API_KEY and reuse the saved credential for --api-url.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --api-url=*) API_URL="${1#*=}"; shift ;;
    --max-concurrent) MAX_CONCURRENT="${2:-}"; shift 2 ;;
    --max-concurrent=*) MAX_CONCURRENT="${1#*=}"; shift ;;
    --poll-interval) POLL_INTERVAL="${2:-}"; shift 2 ;;
    --poll-interval=*) POLL_INTERVAL="${1#*=}"; shift ;;
    --task-timeout) TASK_TIMEOUT="${2:-}"; shift 2 ;;
    --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
    --restart) DO_RESTART=1; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fatal "unknown option: $1 (try --help)" ;;
  esac
done

for value in "$MAX_CONCURRENT" "$POLL_INTERVAL" "$TASK_TIMEOUT"; do
  case "$value" in ''|*[!0-9]*) fatal 'concurrency, poll interval, and timeout must be non-negative integers' ;; esac
done
[ "$MAX_CONCURRENT" -gt 0 ] || fatal '--max-concurrent must be greater than zero'

if [ "$DO_INSTALL" = "1" ]; then
  info 'Building and installing the local ak CLI…'
  bash "$ROOT/scripts/install-cli.sh"
fi

command -v ak >/dev/null 2>&1 || fatal 'ak is not installed; rerun without --skip-install'
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error "$API_URL/" >/dev/null || fatal "AK server is not reachable at $API_URL"
fi

command_name=start
[ "$DO_RESTART" = "1" ] && command_name=restart
args=(
  "$command_name"
  --mode local
  --api-url "$API_URL"
  --max-concurrent "$MAX_CONCURRENT"
  --poll-interval "$POLL_INTERVAL"
  --task-timeout "$TASK_TIMEOUT"
)
info "Starting local runtime against $API_URL…"
AK_API_URL="$API_URL" ak "${args[@]}"
ak status
