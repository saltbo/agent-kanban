#!/usr/bin/env bash
set -euo pipefail

# Daemon smoke test: covers the full task scheduling lifecycle.
#
# Scenarios tested:
#   1. Dispatch    — create task → dispatch → agent runs → in_review (+ subagent install on local runtimes)
#   2. Reject/Resume — reject in_review task → agent resumes → back to in_review
#   3. Complete    — complete task → server tears down the runtime binding
#   4. Cancel      — create task → cancel while agent is running → session torn down
#
# Runtimes:
#   codex | claude | copilot — self-hosted: tasks run on this machine's runner
#   ama                      — cloud: tasks run on AMA Cloudflare Sandbox sessions
#   mixed                    — one local (claude) and one cloud (ama) task in parallel
#
# Usage: ./scripts/daemon-smoke-test.sh <runtime> [board_id] [repo_id]
# Missing arguments are discovered or created. Defaults target the Demo board
# and the slink repository.

SMOKE_RUNTIME=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      SMOKE_RUNTIME="${2:-}"
      if [ -z "$SMOKE_RUNTIME" ]; then
        echo "FATAL: --runtime requires a value"
        exit 1
      fi
      shift 2
      ;;
    --runtime=*)
      SMOKE_RUNTIME="${1#*=}"
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

BOARD_ID="${ARGS[0]:-}"
if [ -z "$SMOKE_RUNTIME" ]; then
  SMOKE_RUNTIME="$BOARD_ID"
  BOARD_ID="${ARGS[1]:-}"
  REPO_ID="${ARGS[2]:-}"
else
  REPO_ID="${ARGS[1]:-}"
fi
AGENT_ID=""
CLOUD_AGENT_ID=""

PASS=0
FAIL=0
TASKS=()
TIMESTAMP=$(date +%s)
SUBAGENT_ID=""
SUBAGENT_USERNAME=""
SUBAGENT_TOKEN=""
AGENT_RUNTIME=""
CREATED_AGENT_IDS=()
SWEEP_PID=""

cleanup() {
  if [ -n "$SWEEP_PID" ]; then
    kill "$SWEEP_PID" >/dev/null 2>&1 || true
  fi
  if [ "${#TASKS[@]}" -gt 0 ]; then
    for tid in "${TASKS[@]}"; do
      ak task cancel "$tid" >/dev/null 2>&1 || true
    done
  fi
  for agent_id in "${CREATED_AGENT_IDS[@]}"; do
    ak delete agent "$agent_id" >/dev/null 2>&1 || true
  done
  if [ -n "$SUBAGENT_ID" ]; then
    ak delete subagent "$SUBAGENT_ID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────────────

create_task() {
  local agent_id="$1" title="$2" desc="$3"
  local id output
  if ! output=$(ak create task \
    --board "$BOARD_ID" \
    --title "$title" \
    --description "$desc" \
    --repo "$REPO_ID" \
    --assign-to "$agent_id" 2>&1); then
    echo "$output" >&2
    echo "  FATAL: failed to create task"
    exit 1
  fi
  id=$(printf '%s\n' "$output" | sed -n 's/Created task \([^: ]*\).*/\1/p')
  if [ -z "$id" ]; then
    echo "$output" >&2
    echo "  FATAL: failed to create task"
    exit 1
  fi
  TASKS+=("$id")
  echo "$id"
}

wait_status() {
  local task_id="$1" status="$2" timeout="${3:-10m}"
  ak wait task "$task_id" --until "$status" --timeout "$timeout" >/dev/null 2>&1
}

task_status() {
  ak describe task "$1" 2>/dev/null | sed -n 's/^Status: *//p'
}

# The runtime binding lives in the task's metadata annotations server-side.
# ama.sessionId is retained after terminal states so task history can still link
# to the stopped AMA session and its events.
task_runtime_binding() {
  local task_id="$1"
  ak get task "$task_id" -o json 2>/dev/null \
    | json_query 'data.metadata && data.metadata.annotations ? data.metadata.annotations["ama.sessionId"] : null' 2>/dev/null || true
}

task_session_state() {
  ak get session "$1" 2>/dev/null | sed -n 's/^  State: *//p' | head -n 1
}

task_runtime_state() {
  local task_id="$1"
  local session_id
  session_id="$(task_runtime_binding "$task_id")"
  if [ -z "$session_id" ]; then
    return 0
  fi
  task_session_state "$session_id"
}

task_pr_url() {
  ak describe task "$1" 2>/dev/null | sed -n 's/^PR: *//p'
}

json_query() {
  local query="$1"
  node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = ($query);
if (result === undefined || result === null) process.exit(1);
if (typeof result === 'object') console.log(JSON.stringify(result));
else console.log(result);
"
}

run_json_query() {
  local query="$1"
  shift
  local payload
  payload=$("$@") || return $?
  printf '%s\n' "$payload" | json_query "$query"
}

discover_board() {
  run_json_query "data.find((b) => b.id === 'k847fy7k' && b.type === 'dev')?.id || data.find((b) => b.name === 'Demo' && b.type === 'dev')?.id || data.find((b) => b.type === 'dev')?.id || ''" \
    ak get board -o json
}

create_board() {
  run_json_query "data.id" ak create board --name "Demo" --type dev -o json
}

discover_repo() {
  run_json_query "data.find((r) => r.name === 'slink' || r.full_name === 'saltbo/slink')?.id || data[0]?.id || ''" ak get repo -o json
}

create_repo() {
  run_json_query "data.id" ak create repo --name "slink" --url "https://github.com/saltbo/slink" -o json
}

# Every smoke agent pins an explicit model: an empty model falls through to
# provider defaults that may select the most expensive tier.
runtime_default_model() {
  local runtime="$1"
  case "$runtime" in
    codex) run_json_query "data[0]?.id" ak get model --runtime "$runtime" -o json ;;
    claude) run_json_query "data.find((m) => m.id.includes('opus'))?.id || data[0]?.id" ak get model --runtime "$runtime" -o json ;;
    ama) run_json_query "data[0]?.id" ak get model --runtime "$runtime" -o json ;;
    *) run_json_query "data[0]?.id" ak get model --runtime "$runtime" -o json ;;
  esac
}

create_agent() {
  local runtime="$1"
  local name="Smoke ${runtime} $TIMESTAMP"
  local username="smoke-${runtime}-${TIMESTAMP}"
  local bio="${runtime} worker for daemon smoke tests"
  local model
  model="$(runtime_default_model "$runtime")"
  if [ -z "$model" ]; then
    echo "  FATAL: no model available for runtime $runtime" >&2
    exit 1
  fi
  local id
  id=$(run_json_query "data.id" ak create agent \
    --name "$name" \
    --username "$username" \
    --runtime "$runtime" \
    --model "$model" \
    --role "fullstack-developer" \
    --bio "$bio" \
    --soul "I am a daemon smoke-test worker. Complete only the assigned smoke task, keep changes minimal, and report deterministic evidence in the task log." \
    -o json)
  echo "$id"
}

agent_field() {
  local agent_id="$1" field="$2"
  run_json_query "data['$field']" ak get agent "$agent_id" -o json
}

ensure_smoke_subagent() {
  local runtime="$1"
  local username="smoke-subagent-$runtime-$TIMESTAMP"
  local name="$username"
  local model
  model="$(runtime_default_model "$runtime")"
  SUBAGENT_ID=$(run_json_query "data.id" ak create subagent \
    --name "$name" \
    --username "$username" \
    --role "smoke-subagent" \
    --bio "Registered worker used by daemon smoke tests to verify task-local subagent installation" \
    --soul "I am a smoke-test helper subagent. Keep answers short and verify delegated work precisely." \
    --models "$runtime=$model" \
    -o json)
  SUBAGENT_USERNAME="$username"
  SUBAGENT_TOKEN="SMOKE-SUBAGENT-OK-$TIMESTAMP"
}

ensure_agent_subagent_link() {
  local agent_id="$1"
  local current
  current=$(run_json_query "((data.subagents || []).includes('$SUBAGENT_ID') ? (data.subagents || []) : [...(data.subagents || []), '$SUBAGENT_ID']).join(',')" \
    ak get agent "$agent_id" -o json)
  ak update agent "$agent_id" --subagents "$current" >/dev/null
}

subagent_definition_path() {
  local runtime="$1"
  case "$runtime" in
    codex) echo ".codex/agents/$SUBAGENT_USERNAME.toml" ;;
    claude | copilot) echo ".claude/agents/$SUBAGENT_USERNAME.md" ;;
    *) echo "" ;;
  esac
}

# The dispatch task instructs the agent to echo SUBAGENT_TOKEN into its task
# log once it has verified the installed definition file — a deterministic
# marker instead of fuzzy phrase matching.
wait_subagent_evidence() {
  local task_id="$1" timeout_secs="${2:-120}"
  local elapsed=0
  local needle
  needle=$(printf '%s' "$SUBAGENT_TOKEN" | tr '[:upper:]' '[:lower:]')
  while [ "$elapsed" -lt "$timeout_secs" ]; do
    if ak describe task "$task_id" -o json 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -q "$needle"; then
      return 0
    fi
    if ak get task "$task_id" --session -o json 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -q "$needle"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# Terminal lifecycle checks should prove the runtime is no longer active, while
# preserving ama.sessionId for historical session/event inspection.
wait_session_stopped() {
  local task_id="$1" timeout_secs="${2:-120}"
  local elapsed=0
  local session_id
  local state
  while [ "$elapsed" -lt "$timeout_secs" ]; do
    session_id="$(task_runtime_binding "$task_id")"
    if [ -z "$session_id" ]; then
      return 0
    fi
    state="$(task_session_state "$session_id")"
    if [[ "$state" == stopped* || "$state" == closed* ]]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Local dev servers have no cron: drive the per-minute dispatch/reconcile
# sweeps by poking the scheduled handler while the smoke runs.
start_dev_sweep_loop() {
  local api_url
  api_url=$(ak config get 2>/dev/null | sed -n 's/^api-url: *//p')
  case "$api_url" in
    http://localhost*|http://127.0.0.1*)
      (
        while true; do
          curl -s -o /dev/null "$api_url/cdn-cgi/handler/scheduled" || true
          sleep 15
        done
      ) &
      SWEEP_PID=$!
      echo "Dev sweep loop: poking $api_url/cdn-cgi/handler/scheduled every 15s (pid $SWEEP_PID)"
      ;;
  esac
}

dispatch_task_description() {
  local marker="$1" subagent_check="$2"
  local desc="Add file $marker.txt containing the current timestamp. Commit and open a PR. No dependency installation is needed for this change."
  if [ -n "$subagent_check" ]; then
    desc="$desc Also verify the subagent definition file $subagent_check exists in this workspace; once verified, include the literal text $SUBAGENT_TOKEN in your completion summary or task log."
  fi
  echo "$desc"
}

# ── Lifecycle phases (parameterized by agent/task) ───────────────────────────

# The parallel scenario checks tasks sequentially; a fast task may already be
# past the awaited status by the time its check runs.
wait_status_reached_or_passed() {
  local task_id="$1" timeout="$2"
  if wait_status "$task_id" in_progress "$timeout"; then return 0; fi
  case "$(task_status "$task_id")" in
    in_review | done) return 0 ;;
  esac
  return 1
}

run_dispatch_phase() {
  local label="$1" task_id="$2" check_subagent="$3"
  if wait_status_reached_or_passed "$task_id" 5m; then
    pass "[$label] task reached in_progress"
    if [ -n "$check_subagent" ]; then
      if wait_subagent_evidence "$task_id" 600; then
        pass "[$label] subagent definition verified in task workspace"
      else
        fail "[$label] subagent evidence ($SUBAGENT_TOKEN) not found"
      fi
    fi
  else
    fail "[$label] task did not reach in_progress (status: $(task_status "$task_id"))"
  fi

  if wait_status "$task_id" in_review 15m; then
    pass "[$label] task reached in_review"
    local pr
    pr=$(task_pr_url "$task_id")
    if [ -n "$pr" ]; then
      pass "[$label] PR created: $pr"
    else
      fail "[$label] no PR link on in_review task"
    fi
  else
    fail "[$label] task did not reach in_review (status: $(task_status "$task_id"))"
  fi
}

run_reject_phase() {
  local label="$1" task_id="$2"
  sleep 5
  ak task reject "$task_id" --reason "Smoke test: change file content to REJECTED" >/dev/null 2>&1 || true

  local status_after
  status_after=$(task_status "$task_id")
  if [ "$status_after" = "in_progress" ]; then
    pass "[$label] task back to in_progress after reject"
  else
    fail "[$label] expected in_progress after reject, got: $status_after"
  fi

  if wait_status "$task_id" in_review 15m; then
    pass "[$label] task reached in_review again after reject-resume"
  else
    fail "[$label] task did not reach in_review after reject"
  fi
}

run_complete_phase() {
  local label="$1" task_id="$2"
  ak task complete "$task_id" >/dev/null 2>&1 || true

  local status_after
  status_after=$(task_status "$task_id")
  if [ "$status_after" = "done" ]; then
    pass "[$label] task is done"
  else
    fail "[$label] expected done, got: $status_after"
  fi

  if wait_session_stopped "$task_id" 120; then
    pass "[$label] session stopped after completion"
  else
    fail "[$label] session still active after completion timeout (state=$(task_runtime_state "$task_id"), binding=$(task_runtime_binding "$task_id"))"
  fi
}

run_cancel_phase() {
  local label="$1" agent_id="$2"
  local task_id
  task_id=$(create_task "$agent_id" "smoke-cancel-$label-$TIMESTAMP" "Run this shell command and wait for it: sleep 300. This task will be cancelled while it runs.")
  echo "  Task: $task_id"

  if wait_status "$task_id" in_progress 5m; then
    pass "[$label] cancel-task reached in_progress"
  else
    fail "[$label] cancel-task did not reach in_progress (status: $(task_status "$task_id"))"
  fi

  sleep 3
  ak task cancel "$task_id" >/dev/null 2>&1 || true

  local status_after
  status_after=$(task_status "$task_id")
  if [ "$status_after" = "cancelled" ]; then
    pass "[$label] task is cancelled"
  else
    fail "[$label] expected cancelled, got: $status_after"
  fi

  if wait_session_stopped "$task_id" 60; then
    pass "[$label] cancelled task session stopped"
  else
    fail "[$label] cancelled task session still active after 60s (state=$(task_runtime_state "$task_id"), binding=$(task_runtime_binding "$task_id"))"
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────────

echo "=== Daemon Smoke Test ==="

if [ -z "$SMOKE_RUNTIME" ]; then
  echo "FATAL: runtime is required. Usage: ./scripts/daemon-smoke-test.sh <runtime> [board_id] [repo_id]"
  exit 1
fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(discover_board)"; fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(create_board)"; fi
if [ -z "$REPO_ID" ]; then REPO_ID="$(discover_repo)"; fi
if [ -z "$REPO_ID" ]; then REPO_ID="$(create_repo)"; fi

LOCAL_RUNTIME=""
CLOUD_RUNTIME=""
case "$SMOKE_RUNTIME" in
  codex | claude | copilot) LOCAL_RUNTIME="$SMOKE_RUNTIME" ;;
  ama) CLOUD_RUNTIME="ama" ;;
  mixed)
    LOCAL_RUNTIME="claude"
    CLOUD_RUNTIME="ama"
    ;;
  *) echo "FATAL: smoke runtime must be codex, claude, copilot, ama, or mixed; got: $SMOKE_RUNTIME"; exit 1 ;;
esac

if [ -n "$LOCAL_RUNTIME" ]; then
  AGENT_ID="$(create_agent "$LOCAL_RUNTIME")"
  CREATED_AGENT_IDS+=("$AGENT_ID")
  AGENT_RUNTIME="$(agent_field "$AGENT_ID" runtime)"
  if [ "$AGENT_RUNTIME" != "$LOCAL_RUNTIME" ]; then
    echo "FATAL: expected local agent runtime $LOCAL_RUNTIME, got: $AGENT_RUNTIME"
    exit 1
  fi
  ensure_smoke_subagent "$LOCAL_RUNTIME"
  ensure_agent_subagent_link "$AGENT_ID"
fi
if [ -n "$CLOUD_RUNTIME" ]; then
  CLOUD_AGENT_ID="$(create_agent "$CLOUD_RUNTIME")"
  CREATED_AGENT_IDS+=("$CLOUD_AGENT_ID")
fi

echo "  Board: $BOARD_ID"
echo "  Repo:  $REPO_ID"
[ -n "$AGENT_ID" ] && echo "  Local agent: $AGENT_ID ($LOCAL_RUNTIME)"
[ -n "$CLOUD_AGENT_ID" ] && echo "  Cloud agent: $CLOUD_AGENT_ID ($CLOUD_RUNTIME)"
[ -n "$SUBAGENT_ID" ] && echo "  Subagent: $SUBAGENT_ID ($SUBAGENT_USERNAME)"
echo ""

if [ -n "$LOCAL_RUNTIME" ]; then
  # Capture the full output first: piping ak straight into head trips
  # EPIPE (ak status keeps printing after a server round-trip) and pipefail
  # turns that into a silent set -e exit.
  STATUS_OUTPUT=$(ak status 2>&1)
  DAEMON_STATUS=$(printf '%s\n' "$STATUS_OUTPUT" | grep "^● .* running" || true)
  if [ -z "$DAEMON_STATUS" ]; then
    echo "FATAL: machine runner is not running but a local runtime is requested. Start with: ak start"
    exit 1
  fi
  echo "Daemon: $DAEMON_STATUS"
fi
start_dev_sweep_loop
echo ""

# ── Scenario: mixed (parallel local + cloud) ─────────────────────────────────

if [ "$SMOKE_RUNTIME" = "mixed" ]; then
  echo "[Test 1/2] Parallel dispatch — local + cloud tasks run concurrently"
  TL=$(create_task "$AGENT_ID" "smoke-mixed-local-$TIMESTAMP" "$(dispatch_task_description "smoke-mixed-local-$TIMESTAMP" "$(subagent_definition_path "$LOCAL_RUNTIME")")")
  TC=$(create_task "$CLOUD_AGENT_ID" "smoke-mixed-cloud-$TIMESTAMP" "$(dispatch_task_description "smoke-mixed-cloud-$TIMESTAMP" "")")
  echo "  Local task: $TL"
  echo "  Cloud task: $TC"
  run_dispatch_phase "local" "$TL" "check"
  run_dispatch_phase "cloud" "$TC" ""
  echo ""

  echo "[Test 2/2] Complete both — runtime sessions stopped"
  run_complete_phase "local" "$TL"
  run_complete_phase "cloud" "$TC"
  echo ""
else
  # ── Scenario: single placement (local or cloud) ────────────────────────────
  RUN_AGENT_ID="${AGENT_ID:-$CLOUD_AGENT_ID}"
  RUN_LABEL="${LOCAL_RUNTIME:-$CLOUD_RUNTIME}"
  SUBAGENT_CHECK=""
  if [ -n "$LOCAL_RUNTIME" ]; then
    SUBAGENT_CHECK="$(subagent_definition_path "$LOCAL_RUNTIME")"
  fi

  echo "[Test 1/4] Dispatch — create task, wait for in_review"
  T1=$(create_task "$RUN_AGENT_ID" "smoke-dispatch-$TIMESTAMP" "$(dispatch_task_description "smoke-dispatch-$TIMESTAMP" "$SUBAGENT_CHECK")")
  echo "  Task: $T1"
  run_dispatch_phase "$RUN_LABEL" "$T1" "$SUBAGENT_CHECK"
  echo ""

  echo "[Test 2/4] Reject/Resume — reject task, wait for re-review"
  run_reject_phase "$RUN_LABEL" "$T1"
  echo ""

  echo "[Test 3/4] Complete — mark task done, verify runtime stopped"
  run_complete_phase "$RUN_LABEL" "$T1"
  echo ""

  echo "[Test 4/4] Cancel — create task, cancel while running, verify runtime stopped"
  run_cancel_phase "$RUN_LABEL" "$RUN_AGENT_ID"
  echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
