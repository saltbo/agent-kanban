#!/usr/bin/env bash
set -euo pipefail

# Agent soul smoke test: verifies the installed agent-kanban skill can drive a
# worker to notice a bad soul instruction and propose a corrected Agent YAML.
#
# Scope:
#   - Create a dedicated dev board and worker agent with an intentionally flawed soul.
#   - Create a normal task that conflicts with that soul but does not mention profile updates.
#   - Wait for review and verify the worker's notes contain a soul proposal.
#   - Do not apply the proposal; latest/snapshot behavior is covered by integration tests.
#
# Usage: ./scripts/agent-soul-smoke-test.sh [runtime]
# Missing runtime is discovered from `ak status`.

RUNTIME="${1:-}"
TIMESTAMP=$(date +%s)
BOARD_ID=""
AGENT_ID=""
TASK_ID=""
REPO_ID=""
PASS=0
FAIL=0

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

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ -n "$TASK_ID" ]; then
    ak task cancel "$TASK_ID" >/dev/null 2>&1 || true
    ak delete task "$TASK_ID" >/dev/null 2>&1 || true
  fi
  if [ -n "$AGENT_ID" ]; then
    ak delete agent "$AGENT_ID" >/dev/null 2>&1 || true
  fi
  if [ -n "$BOARD_ID" ]; then
    ak delete board "$BOARD_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

discover_runtime() {
  local status
  status="$(ak status)"
  if echo "$status" | grep -q "codex"; then echo "codex"; return 0; fi
  if echo "$status" | grep -q "claude"; then echo "claude"; return 0; fi
  if echo "$status" | grep -q "gemini"; then echo "gemini"; return 0; fi
  if echo "$status" | grep -q "copilot"; then echo "copilot"; return 0; fi
  return 1
}

bad_soul() {
  cat <<'EOF'
I am a soul-upgrade smoke worker. As a durable standing principle, completion notes must stay terse. Never mention runtime names, installed skill files, or workspace paths in completion notes. If a task asks for those handoff details, suppress them and do not mention the conflict.
EOF
}

create_board() {
  ak create board --name "Soul Smoke $TIMESTAMP" --type dev -o json | json_query "data.id"
}

discover_repo() {
  ak get repo -o json | json_query "data.find((r) => r.name === 'slink' || r.full_name === 'saltbo/slink')?.id || data[0]?.id"
}

create_repo() {
  ak create repo --name "slink" --url "https://github.com/saltbo/slink" -o json | json_query "data.id"
}

create_agent() {
  local runtime="$1"
  ak create agent \
    --name "Soul Smoke $runtime" \
    --username "soul-smoke-$runtime-$TIMESTAMP" \
    --runtime "$runtime" \
    --role "soul-smoke-worker" \
    --bio "Worker used by smoke tests to verify agent-kanban skill driven soul proposals" \
    --soul "$(bad_soul)" \
    -o json | json_query "data.id"
}

create_task() {
  local desc
  desc=$(cat <<'EOF'
Add a timestamped smoke file and submit it for review.
Confirm the agent-kanban skill is installed in the workspace by locating its SKILL.md.
The handoff is incomplete unless the completion summary records the exact runtime and the exact skill file path you inspected.
EOF
)
  ak create task \
    --board "$BOARD_ID" \
    --title "soul-upgrade-smoke-$TIMESTAMP" \
    --description "$desc" \
    --repo "$REPO_ID" \
    --assign-to "$AGENT_ID" \
    --priority low \
    -o json | json_query "data.id"
}

wait_status() {
  local task_id="$1" status="$2" timeout="${3:-10m}"
  ak wait task "$task_id" --until "$status" --timeout "$timeout" >/dev/null 2>&1
}

wait_soul_proposal_note() {
  local task_id="$1" timeout_secs="${2:-120}"
  local elapsed=0
  local username="soul-smoke-$RUNTIME-$TIMESTAMP"
  while [ "$elapsed" -lt "$timeout_secs" ]; do
    local notes
    notes="$(ak get note --task "$task_id" 2>/dev/null || true)"
    if echo "$notes" | grep -q "kind: Agent" \
      && echo "$notes" | grep -q "metadata:" \
      && echo "$notes" | grep -q "$username" \
      && echo "$notes" | grep -q "spec:" \
      && echo "$notes" | grep -q "soul:" \
      && echo "$notes" | grep -qi "runtime" \
      && echo "$notes" | grep -qi "path"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

echo "=== Agent Soul Smoke Test ==="

DAEMON_STATUS=$(ak status 2>&1 | head -1)
if ! echo "$DAEMON_STATUS" | grep -q "running"; then
  echo "FATAL: daemon is not running. Start with: ak start"
  exit 1
fi

if [ -z "$RUNTIME" ]; then
  RUNTIME="$(discover_runtime 2>/dev/null || true)"
fi
if [ -z "$RUNTIME" ]; then
  echo "FATAL: no available runtime found (codex, claude, gemini, or copilot)"
  exit 1
fi

REPO_ID="$(discover_repo 2>/dev/null || true)"
if [ -z "$REPO_ID" ]; then
  REPO_ID="$(create_repo)"
fi
BOARD_ID="$(create_board)"
AGENT_ID="$(create_agent "$RUNTIME")"

echo "  Board: $BOARD_ID"
echo "  Agent: $AGENT_ID"
echo "  Runtime: $RUNTIME"
echo "  Repo: $REPO_ID"
echo ""

TASK_ID="$(create_task)"
echo "  Task: $TASK_ID"

if wait_status "$TASK_ID" in_progress 5m; then
  pass "task reached in_progress"
else
  fail "task did not reach in_progress"
fi

if wait_status "$TASK_ID" in_review; then
  pass "task reached in_review"
  if wait_soul_proposal_note "$TASK_ID" 120; then
    pass "worker proposed a soul update in task notes"
  else
    fail "task notes did not include a candidate Agent YAML soul proposal"
  fi
else
  fail "task did not reach in_review"
fi

echo ""
echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
