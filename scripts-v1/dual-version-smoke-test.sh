#!/usr/bin/env bash
set -euo pipefail

# Dual-version acceptance smoke for the session-event-storage + self-hosted-relay
# migration. The migration is accepted only when ONE server is driven by BOTH a
# new-version ak (AMA runner) and an old-version ak (legacy daemon) at the same
# time, and each task's session renders on its own path:
#
#   new ak  → claims + runs a task → AMA path (Session DO / snapshot): the task
#             gets an ama.sessionId annotation and AMA session events.
#   old ak  → claims + runs a task → legacy tunnel: the task gets an
#             active_session_id (the daemon's claim session) and relays
#             AgentEvents over /api/tunnel/ws + TunnelRelay; the web chat renders
#             it via RelayRuntimeProvider.
#   concurrency → both run at once; neither path blanks the other.
#
# Topology (per the goal): AMA = the online control plane (AMA_ORIGIN, e.g.
# https://ama.tftt.cc); AK = local (a `pnpm dev` server this script talks to via
# the ak CLI's configured api-url). The new ak is the current local build; the
# old ak is the last pre-AMA published version (agent-kanban@1.13.4).
#
# Prerequisites (the live acceptance gate needs your machine's credentials):
#   - A local AK dev server running (pnpm dev) and `ak config` api-url pointed at
#     it (ak用本地环境). The script refuses to run against a non-local api-url.
#   - ak authenticated to that local AK (loopback PKCE login).
#   - Runtime credentials on this host for the chosen runtimes (claude + ama).
#     ama runs in the cloud; claude needs claude-code creds on the runner host.
#   - The current ak built + installed (bash scripts/install-cli.sh).
#
# Usage: ./scripts/dual-version-smoke-test.sh [new_runtime] [board_id] [repo_id]
#   new_runtime: the runtime for the NEW-ak task (ama | claude). Default: ama.
#   The OLD-ak task always runs the legacy daemon (claude), the only runtime an
#   un-upgraded 1.13.4 client knows.

OLD_VERSION="1.13.4"
NEW_RUNTIME="${1:-ama}"
BOARD_ID="${2:-}"
REPO_ID="${3:-}"
TIMESTAMP=$(date +%s)
PASS=0
FAIL=0
TASKS=()
CREATED_AGENT_IDS=()
OLD_AK_DIR=""
NEW_DAEMON_PID=""
OLD_DAEMON_PID=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

json_query() {
  node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const result = ($1);
if (result === undefined || result === null) process.exit(1);
console.log(typeof result === 'object' ? JSON.stringify(result) : result);
"
}

cleanup() {
  [ -n "$NEW_DAEMON_PID" ] && kill "$NEW_DAEMON_PID" >/dev/null 2>&1 || true
  [ -n "$OLD_DAEMON_PID" ] && kill "$OLD_DAEMON_PID" >/dev/null 2>&1 || true
  for tid in "${TASKS[@]:-}"; do [ -n "$tid" ] && ak task cancel "$tid" >/dev/null 2>&1 || true; done
  for aid in "${CREATED_AGENT_IDS[@]:-}"; do [ -n "$aid" ] && ak delete agent "$aid" >/dev/null 2>&1 || true; done
  [ -n "$OLD_AK_DIR" ] && rm -rf "$OLD_AK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Guard: AK must be the local environment ───────────────────────────────────
api_url=$(ak config get 2>/dev/null | sed -n 's/^api-url: *//p')
case "$api_url" in
  http://localhost*|http://127.0.0.1*) echo "AK (local): $api_url" ;;
  *) echo "FATAL: ak api-url is '$api_url' — point ak at a local AK dev server (ak用本地环境)." >&2; exit 1 ;;
esac

# ── Pin the old ak (last pre-AMA published version) ───────────────────────────
echo "Pinning old ak (agent-kanban@$OLD_VERSION)..."
OLD_AK_DIR=$(mktemp -d)
( cd "$OLD_AK_DIR" && npm init -y >/dev/null 2>&1 && npm install "agent-kanban@$OLD_VERSION" >/dev/null 2>&1 )
OLD_AK="$OLD_AK_DIR/node_modules/.bin/ak"
[ -x "$OLD_AK" ] || { echo "FATAL: failed to install agent-kanban@$OLD_VERSION" >&2; exit 1; }
echo "  old ak: $("$OLD_AK" --version 2>&1 | head -1)"
echo "  new ak: $(ak --version 2>&1 | head -1)"
# The old ak shares the same ak config (api-url + auth) as the current ak.
"$OLD_AK" config set api-url "$api_url" >/dev/null 2>&1 || true

# ── Board + repo ──────────────────────────────────────────────────────────────
[ -z "$BOARD_ID" ] && BOARD_ID=$(ak get board -o json | json_query "data.find((b) => b.type === 'dev')?.id" || true)
[ -z "$BOARD_ID" ] && BOARD_ID=$(ak create board --name "Dual-version smoke" --type dev -o json | json_query "data.id")
[ -z "$REPO_ID" ] && REPO_ID=$(ak get repo -o json | json_query "data.find((r) => r.name === 'slink')?.id || data[0]?.id" || true)
echo "Board: $BOARD_ID  Repo: $REPO_ID"

model_for() { ak get model --runtime "$1" -o json | json_query "data[0]?.id"; }

create_agent() {
  local runtime="$1" suffix="$2" model
  model="$(model_for "$runtime")"
  [ -n "$model" ] || { echo "FATAL: no model for runtime $runtime" >&2; exit 1; }
  local id
  id=$(ak create agent --name "Dual $suffix $TIMESTAMP" --username "dual-$suffix-$TIMESTAMP" \
    --runtime "$runtime" --model "$model" --role "fullstack-developer" --bio "dual-version smoke" \
    -o json | json_query "data.id")
  CREATED_AGENT_IDS+=("$id")
  echo "$id"
}

create_task() {
  local agent_id="$1" title="$2" id output
  output=$(ak create task --board "$BOARD_ID" --title "$title" --description "Reply with a one-line summary, no PR." \
    ${REPO_ID:+--repo "$REPO_ID"} --assign-to "$agent_id" 2>&1) || { echo "$output" >&2; exit 1; }
  id=$(printf '%s\n' "$output" | sed -n 's/Created task \([^: ]*\).*/\1/p')
  TASKS+=("$id")
  echo "$id"
}

task_json() { ak get task "$1" -o json 2>/dev/null; }
ama_session_id() { task_json "$1" | json_query 'data.metadata?.annotations?.["ama.sessionId"] || ""' 2>/dev/null || true; }
active_session_id() { task_json "$1" | json_query 'data.active_session_id || ""' 2>/dev/null || true; }
runtime_events() { ak get task "$1" --session -o json 2>/dev/null | json_query '(data.events || []).length' 2>/dev/null || echo 0; }

# Local dev has no cron; poke the scheduled sweep so dispatch/claim progresses.
( while true; do curl -s -o /dev/null "$api_url/cdn-cgi/handler/scheduled" || true; sleep 15; done ) &
SWEEP_PID=$!
trap 'kill "$SWEEP_PID" >/dev/null 2>&1 || true; cleanup' EXIT

# ── Set up one task per ak version ────────────────────────────────────────────
echo "Creating agents + tasks..."
AGENT_NEW=$(create_agent "$NEW_RUNTIME" "new")
AGENT_OLD=$(create_agent "claude" "old")
TASK_NEW=$(create_task "$AGENT_NEW" "[new ak/$NEW_RUNTIME] dual-version smoke")
TASK_OLD=$(create_task "$AGENT_OLD" "[old ak/legacy] dual-version smoke")
echo "  new-ak task: $TASK_NEW (agent $AGENT_NEW)"
echo "  old-ak task: $TASK_OLD (agent $AGENT_OLD)"

# ── Launch both daemons against the one server, at the same time ──────────────
echo "Starting new ak daemon (current build)..."
ak start >/tmp/dual_new_ak.log 2>&1 &
NEW_DAEMON_PID=$!
echo "Starting old ak daemon (agent-kanban@$OLD_VERSION)..."
HOME="$OLD_AK_DIR/home" "$OLD_AK" start >/tmp/dual_old_ak.log 2>&1 &
OLD_DAEMON_PID=$!

# ── Wait for both to claim + run ──────────────────────────────────────────────
echo "Waiting for both tasks to reach in_review (10m)..."
ak wait task "$TASK_NEW" --until in_review --timeout 10m >/dev/null 2>&1 &
WAIT_NEW=$!
ak wait task "$TASK_OLD" --until in_review --timeout 10m >/dev/null 2>&1 &
WAIT_OLD=$!
wait "$WAIT_NEW" && pass "new ak task reached in_review" || fail "new ak task did not reach in_review (see /tmp/dual_new_ak.log)"
wait "$WAIT_OLD" && pass "old ak task reached in_review" || fail "old ak task did not reach in_review (see /tmp/dual_old_ak.log)"

# ── Assert each session renders on its own path ───────────────────────────────
echo "Asserting per-version session rendering..."
AMA_SID=$(ama_session_id "$TASK_NEW")
[ -n "$AMA_SID" ] && pass "new ak task is AMA-bound (ama.sessionId=$AMA_SID) → ChatPanel AMA path" \
  || fail "new ak task has no ama.sessionId — would not render via the AMA path"
[ "$(runtime_events "$TASK_NEW")" -gt 0 ] 2>/dev/null && pass "new ak task has AMA session events (renderable snapshot)" \
  || fail "new ak task has no AMA session events"

OLD_SID=$(active_session_id "$TASK_OLD")
[ -n "$OLD_SID" ] && pass "old ak task has a relay session (active_session_id=$OLD_SID) → ChatPanel tunnel path" \
  || fail "old ak task has no active_session_id — would not render via the legacy tunnel"
# The old ak (no ama.sessionId) must NOT be AMA-bound, or it would mis-route.
[ -z "$(ama_session_id "$TASK_OLD")" ] && pass "old ak task is NOT AMA-bound (routes to the legacy tunnel, not the AMA path)" \
  || fail "old ak task unexpectedly carries ama.sessionId"

# ── Concurrency: both ran against the one server at the same time ─────────────
[ -n "$AMA_SID" ] && [ -n "$OLD_SID" ] && pass "concurrency: both ak versions drove the one server and each task has its own session" \
  || fail "concurrency: one of the two tasks did not produce a session"

echo
echo "Dual-version smoke: $PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ] || exit 1
