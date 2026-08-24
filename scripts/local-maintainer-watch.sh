#!/usr/bin/env bash
# local-maintainer-watch.sh — trigger local board-maintainer review runs.
#
# Pure-local deployments (Hono dev server + local D1 + `ak start` local daemon)
# have no server-side maintainer scheduler. This script is the trigger: when
# tasks land in `in_review`, it creates one deduped review task assigned to the
# board's maintainer agent; the local daemon then dispatches it.
#
# Modes:
#   watch (default): long-running. Tails the board SSE stream
#     (GET /api/boards/:id/stream) and triggers on `review_requested` actions.
#     The SSE window closes every ~25s (CF Workers limit); every reconnect runs
#     a full poll, which doubles as the ≤2-minute fallback for events missed
#     during disconnects.
#   --once: single poll and exit. For cron / systemd timers.
#
# Install examples:
#   cron (fallback poll every 2 minutes):
#     */2 * * * * /path/to/scripts/local-maintainer-watch.sh --board <board-id> --once >>/tmp/ak-maintainer-watch.log 2>&1
#
#   systemd user unit (~/.config/systemd/user/ak-maintainer-watch.service):
#     [Unit]
#     Description=AK local maintainer watcher
#     After=default.target
#     [Service]
#     ExecStart=/path/to/scripts/local-maintainer-watch.sh --board <board-id>
#     Restart=always
#     RestartSec=10
#     [Install]
#     WantedBy=default.target
#     # systemctl --user enable --now ak-maintainer-watch.service
#
# Requirements: ak (authenticated), jq, curl. Optional: gh (PR freshness check).
# Config is read from ~/.config/agent-kanban/config.json (current host);
# override with AK_API_URL / AK_API_KEY env vars.

set -euo pipefail

BOARD_ID=""
ONCE=0

usage() {
  sed -n '2,40p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --board) BOARD_ID="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$BOARD_ID" ]]; then
  echo "error: --board <board-id> is required" >&2
  usage 1
fi

for cmd in ak jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: required command not found: $cmd" >&2; exit 1; }
done

CONFIG_FILE="${AK_CONFIG_FILE:-$HOME/.config/agent-kanban/config.json}"
if [[ -z "${AK_API_URL:-}" || -z "${AK_API_KEY:-}" ]]; then
  [[ -f "$CONFIG_FILE" ]] || { echo "error: no AK config at $CONFIG_FILE (set AK_API_URL/AK_API_KEY)" >&2; exit 1; }
  CURRENT_HOST="$(jq -r '.current // empty' "$CONFIG_FILE")"
  [[ -n "$CURRENT_HOST" ]] || { echo "error: no current host in $CONFIG_FILE" >&2; exit 1; }
  AK_API_URL="${AK_API_URL:-$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-url"] // empty' "$CONFIG_FILE")}"
  AK_API_KEY="${AK_API_KEY:-$(jq -r --arg h "$CURRENT_HOST" '.credentials[$h]["api-key"] // empty' "$CONFIG_FILE")}"
fi
[[ -n "$AK_API_URL" && -n "$AK_API_KEY" ]] || { echo "error: could not resolve AK API credentials" >&2; exit 1; }

MEMORY_DIR="$HOME/.local/share/agent-kanban/maintainer/$BOARD_ID"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# True when the local daemon is up; without it a review task would sit in todo.
# Match the positive form exactly — the down state ("Machine runner is not
# running") also contains the word "running".
daemon_running() {
  ak status 2>/dev/null | grep -q "Machine runner running (PID"
}

# True when a PR looks freshly updated (within 2 minutes): the worker may still
# be pushing / posting the completion note, so skip this round and let the next
# poll pick it up. Falls back to the task's own updated_at when gh or the PR
# URL is unavailable.
pr_is_fresh() {
  local pr_url="$1" task_updated_at="$2"
  local now updated=""
  now="$(date +%s)"
  if [[ -n "$pr_url" && "$pr_url" == http* ]] && command -v gh >/dev/null 2>&1; then
    updated="$(gh pr view "$pr_url" --json updatedAt --jq '.updatedAt' 2>/dev/null || true)"
  fi
  if [[ -z "$updated" ]]; then
    updated="$task_updated_at"
  fi
  [[ -n "$updated" ]] || return 1
  local updated_ts
  updated_ts="$(date -d "$updated" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$updated" +%s 2>/dev/null || echo 0)"
  [[ "$updated_ts" =~ ^[0-9]+$ ]] || return 1
  (( now - updated_ts < 120 ))
}

# One trigger round. Shared by --once and the watch loop.
poll_once() {
  daemon_running || { log "daemon not running, skipping"; return 0; }

  local review_tasks
  review_tasks="$(ak get task --board "$BOARD_ID" --status in_review -o json 2>/dev/null || echo '[]')"
  [[ "$(jq 'length' <<<"$review_tasks")" -gt 0 ]] || return 0

  local maintainer_agent_id
  maintainer_agent_id="$(ak get maintainer --board "$BOARD_ID" -o json 2>/dev/null | jq -r '.[0].agent_id // empty')"
  if [[ -z "$maintainer_agent_id" ]]; then
    log "no maintainer on board $BOARD_ID (create one with: ak create maintainer --board $BOARD_ID --agent <agent-id>), skipping"
    return 0
  fi

  # Dedup: the maintainer already has an active review task for this board.
  local active_reviews
  active_reviews="$(ak get task --board "$BOARD_ID" --label maintainer-review -o json 2>/dev/null || echo '[]')"
  local existing
  existing="$(jq --arg a "$maintainer_agent_id" \
    '[.[] | select(.assigned_to == $a and (.status == "todo" or .status == "in_progress" or .status == "in_review"))] | length' \
    <<<"$active_reviews")"
  if [[ "$existing" -gt 0 ]]; then
    log "maintainer review task already active, skipping"
    return 0
  fi

  # Skip freshly-updated PRs this round; they will be picked up next round.
  local pending
  pending="$(jq -c '[.[] | {id, title, pr_url: (.pr_url // ""), repository_id: (.repository_id // ""), updated_at: (.updated_at // "")}]' <<<"$review_tasks")"
  local selected="[]"
  while IFS= read -r task; do
    [[ -n "$task" ]] || continue
    if pr_is_fresh "$(jq -r '.pr_url' <<<"$task")" "$(jq -r '.updated_at' <<<"$task")"; then
      log "skipping $(jq -r '.id' <<<"$task"): PR/task updated within the last 2 minutes"
      continue
    fi
    selected="$(jq -c --argjson t "$task" '. + [$t]' <<<"$selected")"
  done < <(jq -c '.[]' <<<"$pending")
  [[ "$(jq 'length' <<<"$selected")" -gt 0 ]] || return 0

  local repo_id
  repo_id="$(jq -r '[.[].repository_id | select(. != "")][0] // ""' <<<"$selected")"

  local task_lines
  task_lines="$(jq -r '.[] | "- " + .id + " — " + .title + (if .pr_url != "" then " — PR: " + .pr_url else "" end)' <<<"$selected")"

  local description
  description="$(cat <<EOF
Review the following board tasks that are waiting in review:

$task_lines

Instructions:
- Follow the installed ak-maintainer skill. When the ak-verify skill is installed, use it as the acceptance standard (its Review step is your code review; its Tests/Regression steps are the verification evidence to require or re-run).
- Use \`gh pr checkout\` in this workspace to run verification locally when a PR is linked.
- Circuit breaker: if a task has already been rejected 2 or more times, do NOT reject it again — leave a note on the task summarizing the repeated failure and escalate to a human reviewer.
- Durable memory: keep cross-run context in $MEMORY_DIR/HEARTBEAT.md (create the directory on first use). This is the local equivalent of AMA maintainer memory.
EOF
)"

  log "creating maintainer review task for $(jq 'length' <<<"$selected") task(s)"
  local args=(task --board "$BOARD_ID" --title "Maintainer review: $(jq -r 'length' <<<"$selected") task(s) in review" \
    --description "$description" --labels "maintenance,maintainer-review" --assign-to "$maintainer_agent_id")
  if [[ -n "$repo_id" ]]; then
    args+=(--repo "$repo_id")
  fi
  ak create "${args[@]}" >/dev/null
}

if [[ "$ONCE" -eq 1 ]]; then
  poll_once
  exit 0
fi

log "watching board $BOARD_ID (SSE + poll on every reconnect)"
while true; do
  poll_once
  # The stream closes itself after ~25s; reconnect (and re-poll) immediately.
  curl -sN -H "Authorization: Bearer $AK_API_KEY" "$AK_API_URL/api/boards/$BOARD_ID/stream" 2>/dev/null | \
    while IFS= read -r line; do
      case "$line" in
        data:*review_requested*) poll_once ;;
      esac
    done || true
  sleep 2
done
