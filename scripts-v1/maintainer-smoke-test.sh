#!/usr/bin/env bash
set -euo pipefail

# Board maintainer smoke test.
#
# This script is intentionally manual. It validates the maintainer workflow
# end-to-end against the currently configured AK environment without adding a CI
# job.
#
# Layer A (default, seconds): CLI/API contract and repo auth surface.
#   - creates a worker agent with role=board-maintainer
#   - ensures the board can discover its repositories via `ak get repo --board`
#   - creates/lists/gets/updates/deletes a board-level maintainer
#   - verifies heartbeat on/off and the 1h minimum interval contract
#   - verifies maintainers are not bound to repository_id
#   - verifies `ak auth git <repo-id>` can print a token without leaking it
#   - verifies git credential writes are guarded outside AK_WORKER and work under
#     an isolated worker HOME when AK_WORKER + AMA_WORKSPACE are set
#
# Layer B (--live, minutes): real maintainer trigger sessions.
#   - creates a real GitHub issue in the board repository
#   - sends a signed GitHub issues webhook with the real issue payload
#   - waits for the event-triggered maintainer run/session to complete
#   - closes the issue and verifies the existing subject session is closed
#     without dispatching another maintainer run
#   - comments on the closed issue to verify the maintainer session can be
#     reopened by a follow-up event and closed again
#   - captures maintainer run history, session events, memory files, and board
#     tasks created during the observation window
#   - optionally waits for a scheduled heartbeat run when --wait-heartbeat is set
#
# Usage:
#   ./scripts/maintainer-smoke-test.sh [--live] [--keep-artifacts] [--runtime <runtime>] [--repo <repo_id>] \
#     [--observe-seconds <seconds>] [--wait-heartbeat] [board_id]
#
# Optional environment:
#   AK_MAINTAINER_SMOKE_GH_USER=saltbo
#     Use a specific gh-authenticated user only for GitHub issue operations.
#   AK_MAINTAINER_SMOKE_TRIGGER_READY_SECONDS=30
#     Wait after maintainer creation before creating the GitHub issue.
#   AK_MAINTAINER_SMOKE_SESSION_START_TIMEOUT_SECONDS=600
#     Fail a live session that remains pending/waiting-for-runner too long.
#   AK_MAINTAINER_SMOKE_CLOSED_NO_RUN_SECONDS=30
#     Observation window used to verify closed issue events do not dispatch a run.
#
# Missing board/repo arguments are discovered from the current AK account.
# Defaults target a dev board named Demo, a repository named slink, and the
# local codex runtime. Live maintainer execution requires an active machine
# runner for the selected runtime from `ak start`.

LIVE=0
KEEP_ARTIFACTS=0
WAIT_HEARTBEAT=0
OBSERVE_SECONDS=900
RUNTIME="codex"
REPO_ID=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live)
      LIVE=1
      shift
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --wait-heartbeat)
      WAIT_HEARTBEAT=1
      shift
      ;;
    --observe-seconds)
      OBSERVE_SECONDS="${2:-}"
      [ -z "$OBSERVE_SECONDS" ] && { echo "FATAL: --observe-seconds requires a value"; exit 1; }
      shift 2
      ;;
    --observe-seconds=*)
      OBSERVE_SECONDS="${1#*=}"
      shift
      ;;
    --runtime)
      RUNTIME="${2:-}"
      [ -z "$RUNTIME" ] && { echo "FATAL: --runtime requires a value"; exit 1; }
      shift 2
      ;;
    --runtime=*)
      RUNTIME="${1#*=}"
      shift
      ;;
    --repo)
      REPO_ID="${2:-}"
      [ -z "$REPO_ID" ] && { echo "FATAL: --repo requires a value"; exit 1; }
      shift 2
      ;;
    --repo=*)
      REPO_ID="${1#*=}"
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

BOARD_ID="${ARGS[0]:-}"
PASS=0
FAIL=0
TIMESTAMP=$(date +%s)
ORIGINAL_HOME="${HOME:-}"
ARTIFACT_DIR="${AK_MAINTAINER_SMOKE_ARTIFACT_DIR:-.maintainer-smoke/$TIMESTAMP}"
GITHUB_SMOKE_USER="${AK_MAINTAINER_SMOKE_GH_USER:-}"
TRIGGER_READY_SECONDS="${AK_MAINTAINER_SMOKE_TRIGGER_READY_SECONDS:-30}"
SESSION_START_TIMEOUT_SECONDS="${AK_MAINTAINER_SMOKE_SESSION_START_TIMEOUT_SECONDS:-600}"
CLOSED_NO_RUN_SECONDS="${AK_MAINTAINER_SMOKE_CLOSED_NO_RUN_SECONDS:-30}"

AGENT_ID=""
CALLER_AGENT_ID=""
MAINTAINER_ID=""
HTTP_MAINTAINER_ID=""
REPO_FULL_NAME=""
INSTALLATION_ID=""
BOARD_REPO_TASK_ID=""
HTTP_ISSUE_NUMBER=""
HTTP_ISSUE_TITLE=""
HTTP_ISSUE_URL=""
HTTP_ISSUE_REST_JSON=""
HTTP_REPOSITORY_REST_JSON=""
HTTP_COMMENT_REST_JSON=""
TEMP_AMA_WORKSPACE=""
TEMP_HOST_HOME=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ -n "$MAINTAINER_ID" ]; then ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$HTTP_MAINTAINER_ID" ]; then ak delete maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_ARTIFACTS" != 1 ] && [ -n "$HTTP_ISSUE_NUMBER" ]; then
    gh_smoke issue close "$HTTP_ISSUE_NUMBER" -R "$REPO_FULL_NAME" --reason "not planned" --comment "Closed by AK maintainer smoke test cleanup." >/dev/null 2>&1 || true
  fi
  if [ -n "$BOARD_REPO_TASK_ID" ]; then ak task cancel "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_ARTIFACTS" != 1 ] && [ -n "$AGENT_ID" ]; then ak delete agent "$AGENT_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$TEMP_AMA_WORKSPACE" ]; then rm -rf "$TEMP_AMA_WORKSPACE"; fi
  if [ -n "$TEMP_HOST_HOME" ]; then rm -rf "$TEMP_HOST_HOME"; fi
}
trap cleanup EXIT

json_query() {
  local query="$1"
  node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const result = ($query);
if (result === undefined || result === null) process.exit(1);
if (typeof result === 'object') console.log(JSON.stringify(result));
else console.log(result);
"
}

discover_board() {
  ak get board -o json | json_query "data.find((b) => b.name === 'Demo' && b.type === 'dev')?.id || data.find((b) => b.type === 'dev')?.id"
}

create_board() {
  ak create board --name "Demo" --type dev -o json | json_query "data.id"
}

board_field() {
  ak get board "$1" -o json | json_query "data['$2']"
}

discover_repo() {
  ak get repo -o json | json_query "data.find((r) => r.name === 'slink' || r.full_name === 'saltbo/slink')?.id || data[0]?.id"
}

repo_field() {
  ak get repo "$1" -o json | json_query "data['$2']"
}

maintainer_field() {
  ak get maintainer "$1" --board "$BOARD_ID" -o json | json_query "data['$2']"
}

runtime_default_model() {
  local runtime="$1"
  case "$runtime" in
    claude) ak get model --runtime "$runtime" -o json | json_query "data.find((m) => m.id.includes('opus'))?.id || data[0]?.id" ;;
    *) ak get model --runtime "$runtime" -o json | json_query "data[0]?.id" ;;
  esac
}

create_smoke_agent() {
  local runtime="$1"
  local model
  local model_args=()
  model="$(runtime_default_model "$runtime" 2>/dev/null || true)"
  if [ -n "$model" ]; then model_args=(--model "$model"); fi
  ak create agent \
    --name "Maintainer Smoke $TIMESTAMP" \
    --username "maintainer-smoke-$TIMESTAMP" \
    --runtime "$runtime" \
    "${model_args[@]}" \
    --role "board-maintainer" \
    --bio "Worker agent used by maintainer smoke tests" \
    --soul "I am a board maintainer smoke-test worker. Inspect board activity, react only to the maintainer smoke trigger, and record deterministic evidence without changing unrelated work." \
    -o json | json_query "data.id"
}

api_url() {
  node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'agent-kanban', 'config.json'), 'utf8'));
const current = config.current;
if (!current || !config.environments?.[current]) process.exit(1);
console.log(config.environments[current]['api-url'].replace(/\\/$/, ''));
"
}

api_get() {
  local path="$1"
  realmroot toolbox get "agent-kanban/\${path#/api/}" --json
}

dev_var() {
  local key="$1"
  node -e "
const fs = require('fs');
const key = process.argv[1];
const file = 'apps/web/.dev.vars';
if (!fs.existsSync(file)) process.exit(1);
const line = fs.readFileSync(file, 'utf8').split(/\\r?\\n/).find((item) => item.startsWith(key + '='));
if (!line) process.exit(1);
let value = line.slice(key.length + 1).trim();
if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith(\"'\") && value.endsWith(\"'\"))) {
  value = value.slice(1, -1);
}
console.log(value);
" "$key"
}

write_artifact() {
  local name="$1"
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/$name"
}

gh_smoke() {
  if [ -n "$GITHUB_SMOKE_USER" ]; then
    local token
    token="$(gh auth token -u "$GITHUB_SMOKE_USER")" || return 1
    GH_TOKEN="$token" gh "$@"
  else
    gh "$@"
  fi
}

snapshot_tasks_since() {
  local baseline_seq="$1"
  ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | BASELINE_SEQ="$baseline_seq" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const baseline = Number(process.env.BASELINE_SEQ) || 0;
const tasks = data.filter((item) => (Number(item.seq) || 0) > baseline);
console.log(JSON.stringify(tasks, null, 2));
"
}

discover_installation_id() {
  local owner_id base_url first_flag second_flag id
  owner_id="$(repo_field "$REPO_ID" owner_id)"
  base_url="$(api_url)"
  case "$base_url" in
    http://localhost* | http://127.0.0.1* | http://0.0.0.0* | http://::1*)
      first_flag="--local"
      second_flag="--remote"
      ;;
    *)
      first_flag="--remote"
      second_flag="--local"
      ;;
  esac
  id="$((cd apps/web && npx wrangler d1 execute agent-kanban-db "$first_flag" --json --command \
    "SELECT installation_id FROM github_installations WHERE owner_id = '$owner_id' AND suspended_at IS NULL ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null) \
    | json_query "data[0]?.results?.[0]?.installation_id" 2>/dev/null || true)"
  if [ -n "$id" ]; then
    echo "$id"
    return 0
  fi
  (cd apps/web && npx wrangler d1 execute agent-kanban-db "$second_flag" --json --command \
    "SELECT installation_id FROM github_installations WHERE owner_id = '$owner_id' AND suspended_at IS NULL ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null) \
    | json_query "data[0]?.results?.[0]?.installation_id"
}

create_real_github_issue() {
  local created_url issue_json
  created_url="$(gh_smoke issue create \
    -R "$REPO_FULL_NAME" \
    --title "$HTTP_ISSUE_TITLE" \
    --body "Temporary issue created by AK maintainer smoke test $TIMESTAMP. It will be closed by the smoke cleanup unless --keep-artifacts is set.")"
  issue_json="$(gh_smoke issue view "$created_url" -R "$REPO_FULL_NAME" --json number,title,url)"
  HTTP_ISSUE_NUMBER="$(printf '%s' "$issue_json" | json_query "data.number")"
  HTTP_ISSUE_TITLE="$(printf '%s' "$issue_json" | json_query "data.title")"
  HTTP_ISSUE_URL="$(printf '%s' "$issue_json" | json_query "data.url")"
  refresh_github_issue_json
}

refresh_github_issue_json() {
  HTTP_ISSUE_REST_JSON="$(gh_smoke api "repos/$REPO_FULL_NAME/issues/$HTTP_ISSUE_NUMBER" --jq '{ id, node_id, number, title, html_url, state, user: { login: .user.login, id: .user.id, node_id: .user.node_id, type: .user.type } }')"
  HTTP_REPOSITORY_REST_JSON="$(gh_smoke api "repos/$REPO_FULL_NAME" --jq '{ id, node_id, full_name, html_url, private, owner: { login: .owner.login, id: .owner.id, node_id: .owner.node_id, type: .owner.type } }')"
}

create_closed_issue_comment() {
  HTTP_COMMENT_REST_JSON="$(gh_smoke api -X POST "repos/$REPO_FULL_NAME/issues/$HTTP_ISSUE_NUMBER/comments" \
    -f body="Maintainer smoke closed-issue follow-up $TIMESTAMP." \
    --jq '{ id, node_id, html_url, body, user: { login: .user.login, id: .user.id, node_id: .user.node_id, type: .user.type } }')"
}

ensure_board_repo_mapping() {
  local has_repo
  has_repo=$(ak get repo --board "$BOARD_ID" -o json | json_query "data.some((r) => r.id === '$REPO_ID')" 2>/dev/null || echo "false")
  if [ "$has_repo" = "true" ]; then
    pass "board repository mapping already exists"
    return 0
  fi

  BOARD_REPO_TASK_ID=$(ak create task \
    --board "$BOARD_ID" \
    --repo "$REPO_ID" \
    --title "maintainer-smoke-map-$TIMESTAMP" \
    --description "Temporary task used by maintainer smoke test to record board repository scope." \
    -o json | json_query "data.id")

  has_repo=$(ak get repo --board "$BOARD_ID" -o json | json_query "data.some((r) => r.id === '$REPO_ID')" 2>/dev/null || echo "false")
  if [ "$has_repo" = "true" ]; then
    pass "board repository mapping created through task repo association"
  else
    fail "board repository mapping missing after task repo association"
  fi
}

max_task_seq() {
  ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(Math.max(0, ...data.map((item) => Number(item.seq) || 0)));
"
}

assert_no_caller_created_tasks_since() {
  local baseline_seq="$1"
  local label="$2"
  local offenders
  if [ -z "$CALLER_AGENT_ID" ]; then
    fail "$label could not verify caller-created task leakage because caller identity is unknown"
    return
  fi
  offenders="$(ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | BASELINE_SEQ="$baseline_seq" CALLER_AGENT_ID="$CALLER_AGENT_ID" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const baseline = Number(process.env.BASELINE_SEQ) || 0;
const caller = process.env.CALLER_AGENT_ID;
const offenders = data
  .filter((item) => (Number(item.seq) || 0) > baseline && item.created_by === caller)
  .map((item) => '#' + item.seq + ' ' + item.id + ' ' + item.title);
if (offenders.length > 0) console.log(offenders.join('\\n'));
")"
  if [ -z "$offenders" ]; then
    pass "$label created no tasks as caller/leader identity"
  else
    fail "$label created tasks as caller/leader identity"
    printf '%s\n' "$offenders" | sed 's/^/    /'
  fi
}

post_signed_github_event() {
  local event="$1"
  local suffix="$2"
  local payload="$3"
  local base_url secret signature delivery
  base_url="$(api_url)"
  secret="$(dev_var GITHUB_APP_WEBHOOK_SECRET)"
  delivery="maintainer-smoke-${TIMESTAMP}-${suffix}"
  signature=$(node -e "
const crypto = require('crypto');
const secret = process.argv[1];
const payload = process.argv[2];
process.stdout.write('sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex'));
" "$secret" "$payload")
  curl -fsS -X POST "$base_url/api/webhooks/github-app" \
    -H "content-type: application/json" \
    -H "x-github-event: $event" \
    -H "x-github-delivery: $delivery" \
    -H "x-hub-signature-256: $signature" \
    --data "$payload" >/dev/null
}

post_github_issue_event() {
  local suffix="$1"
  local action="${2:-opened}"
  local payload
  payload=$(ISSUE_JSON="$HTTP_ISSUE_REST_JSON" REPOSITORY_JSON="$HTTP_REPOSITORY_REST_JSON" ACTION="$action" node -e "
const issue = JSON.parse(process.env.ISSUE_JSON);
const repository = JSON.parse(process.env.REPOSITORY_JSON);
const payload = {
  action: process.env.ACTION,
  installation: { id: Number(process.argv[1]) },
  repository,
  issue,
  sender: issue.user,
};
process.stdout.write(JSON.stringify(payload));
" "$INSTALLATION_ID")
  post_signed_github_event "issues" "$suffix" "$payload"
}

post_github_issue_comment_event() {
  local suffix="$1"
  local payload
  payload=$(ISSUE_JSON="$HTTP_ISSUE_REST_JSON" REPOSITORY_JSON="$HTTP_REPOSITORY_REST_JSON" COMMENT_JSON="$HTTP_COMMENT_REST_JSON" node -e "
const issue = JSON.parse(process.env.ISSUE_JSON);
const repository = JSON.parse(process.env.REPOSITORY_JSON);
const comment = JSON.parse(process.env.COMMENT_JSON);
const payload = {
  action: 'created',
  installation: { id: Number(process.argv[1]) },
  repository,
  issue,
  comment,
  sender: comment.user,
};
process.stdout.write(JSON.stringify(payload));
" "$INSTALLATION_ID")
  post_signed_github_event "issue_comment" "$suffix" "$payload"
}

maintainer_runs_count() {
  ak get maintainer "$1" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "(data.data || []).length" || echo "0"
}

maintainer_runs_json() {
  ak get maintainer "$1" --board "$BOARD_ID" --runs --limit "${2:-20}" -o json 2>/dev/null
}

latest_run_summary() {
  ak get maintainer "$1" --board "$BOARD_ID" --runs -o json 2>/dev/null \
    | json_query "data.data?.[0] ? { id: data.data[0].id, status: data.data[0].status, error_message: data.data[0].error_message || null, session_id: data.data[0].session_id || null } : null" || true
}

latest_run_field() {
  local maintainer_id="$1"
  local field="$2"
  maintainer_runs_json "$maintainer_id" 10 | FIELD="$field" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const run = data.data?.[0];
if (!run) process.exit(1);
const value = run[process.env.FIELD];
if (value === undefined || value === null) process.exit(1);
if (typeof value === 'object') console.log(JSON.stringify(value));
else console.log(value);
"
}

wait_for_maintainer_run() {
  local maintainer_id="$1"
  local baseline="$2"
  local timeout="${3:-600}"
  local elapsed=0
  local count
  while [ "$elapsed" -lt "$timeout" ]; do
    count="$(maintainer_runs_count "$maintainer_id")"
    if [ "${count:-0}" -gt "${baseline:-0}" ]; then
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  return 1
}

wait_for_no_maintainer_run() {
  local maintainer_id="$1"
  local baseline="$2"
  local timeout="${3:-30}"
  local elapsed=0
  local count
  while [ "$elapsed" -lt "$timeout" ]; do
    count="$(maintainer_runs_count "$maintainer_id")"
    if [ "${count:-0}" -gt "${baseline:-0}" ]; then
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 0
}

wait_for_latest_run_session() {
  local maintainer_id="$1"
  local timeout="${2:-300}"
  local elapsed=0
  local session_id=""
  while [ "$elapsed" -lt "$timeout" ]; do
    session_id="$(latest_run_field "$maintainer_id" "session_id" 2>/dev/null || true)"
    if [ -n "$session_id" ]; then
      echo "$session_id"
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  return 1
}

session_state() {
  local session_id="$1"
  ak get session "$session_id" -o json 2>/dev/null | node -e "
const raw = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const data = raw.session || raw.data?.session || raw.data || raw;
const state = data.state || data.status || data.lifecycle_state;
if (!state) process.exit(1);
console.log(state);
"
}

wait_for_session_terminal() {
  local session_id="$1"
  local timeout="${2:-600}"
  local elapsed=0
  local state=""
  while [ "$elapsed" -lt "$timeout" ]; do
    state="$(session_state "$session_id" 2>/dev/null || true)"
    case "$state" in
      completed | idle | closed | failed | error | stopped | cancelled | canceled)
        echo "$state"
        return 0
        ;;
    esac
    if [ "$state" = "pending" ] && [ "$elapsed" -ge "$SESSION_START_TIMEOUT_SECONDS" ]; then
      echo "$state"
      return 1
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  [ -n "$state" ] && echo "$state"
  return 1
}

wait_for_session_closed() {
  local session_id="$1"
  local timeout="${2:-120}"
  local elapsed=0
  local state=""
  while [ "$elapsed" -lt "$timeout" ]; do
    state="$(session_state "$session_id" 2>/dev/null || true)"
    case "$state" in
      closed)
        echo "$state"
        return 0
        ;;
      failed | error | cancelled | canceled)
        echo "$state"
        return 1
        ;;
    esac
    sleep 5
    elapsed=$((elapsed + 5))
  done
  [ -n "$state" ] && echo "$state"
  return 1
}

maintainer_memories_json() {
  api_get "/api/boards/$BOARD_ID/maintainers/$1/memories?limit=${2:-100}"
}

json_array_count() {
  node -e "
const raw = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const data = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
console.log(data.length);
"
}

leader_session_json() {
  node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = path.join(os.homedir(), '.local', 'state', 'agent-kanban', 'sessions');
if (!fs.existsSync(dir)) process.exit(1);
const sessions = fs.readdirSync(dir)
  .map((file) => {
    try {
      const full = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const stat = fs.statSync(full);
      return { ...data, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  })
  .filter((item) => item?.type === 'leader' && item.agentId && item.sessionId && item.privateKeyJwk && item.apiUrl)
  .sort((a, b) => b.mtimeMs - a.mtimeMs);
const session = sessions[0];
if (!session) process.exit(1);
console.log(JSON.stringify({
  agentId: session.agentId,
  sessionId: session.sessionId,
  apiUrl: session.apiUrl,
  privateKeyJwk: session.privateKeyJwk,
}));
"
}

assert_session_event_artifact() {
  local file="$1"
  local label="$2"
  local code=0
  node -e "
const raw = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const events = raw.events || raw.data?.events || [];
const text = JSON.stringify(events);
if (!Array.isArray(events) || events.length === 0) process.exit(2);
if (!/(assistant|message|tool|runtime\\.output|sandbox\\.exec)/i.test(text)) process.exit(3);
" "$file" || code=$?
  case "$code" in
    0) pass "$label session events show agent/runtime activity" ;;
    2) fail "$label session event artifact has no events" ;;
    3) fail "$label session events do not show recognizable agent/runtime activity" ;;
    *) fail "$label session event artifact could not be parsed" ;;
  esac
}

assert_maintainer_tasks_since() {
  local baseline_seq="$1"
  local label="$2"
  local artifact="$3"
  local code=0
  snapshot_tasks_since "$baseline_seq" | tee "$artifact" >/dev/null
  node -e "
const tasks = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const agent = process.argv[2];
const repo = process.argv[3];
const maintainerTasks = tasks.filter((task) => task.created_by === agent);
const offenders = maintainerTasks.filter((task) => task.repository_id !== repo || !task.assigned_to);
if (offenders.length > 0) {
  console.log(JSON.stringify({ maintainerTasks, offenders }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify({ count: tasks.length, maintainerCount: maintainerTasks.length }, null, 2));
" "$artifact" "$AGENT_ID" "$REPO_ID" > "$artifact.summary" || code=$?
  case "$code" in
    0)
      local maintainer_count
      maintainer_count="$(node -e "const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(s.maintainerCount)" "$artifact.summary")"
      if [ "$maintainer_count" -gt 0 ]; then
        pass "$label maintainer-created tasks are repo-linked and assigned"
      else
        echo "  OBSERVE: $label created no maintainer tasks; inspect $artifact and memory artifacts"
      fi
      ;;
    2)
      fail "$label maintainer-created task contract violation"
      sed 's/^/    /' "$artifact.summary"
      ;;
    *)
      fail "$label task artifact could not be parsed"
      ;;
  esac
}

require_machine_runner() {
  local status first_line
  status="$(ak status 2>&1 || true)"
  first_line="${status%%$'\n'*}"
  if [[ "$first_line" == *"not running"* || "$first_line" != *running* ]]; then
    echo "FATAL: machine runner is not running; maintainer smoke for runtime $RUNTIME requires an active local runner."
    echo "Start it with: ak start"
    exit 1
  fi
}

require_runtime_available() {
  local runtime="$1"
  local status runtimes_line runtimes_csv
  status="$(ak status 2>&1 || true)"
  runtimes_line="$(printf '%s\n' "$status" | awk -F: '/Runtimes:/ {print $2; exit}' | xargs || true)"
  runtimes_csv=",${runtimes_line// /},"
  if [ -z "$runtimes_line" ] || [[ "$runtimes_csv" != *",$runtime,"* ]]; then
    echo "FATAL: runtime $runtime is not available on the active machine runner."
    echo "Available runtimes: ${runtimes_line:-none}"
    exit 1
  fi
}

is_local_api_url() {
  case "$(api_url)" in
    http://localhost* | http://127.0.0.1* | http://0.0.0.0* | http://::1*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Preflight ────────────────────────────────────────────────────────────────

echo "=== Maintainer Smoke Test ($([ "$LIVE" = 1 ] && echo "contract + live" || echo "contract")) ==="

case "$RUNTIME" in
  codex | claude | copilot | ama) ;;
  *) echo "FATAL: runtime must be codex, claude, copilot, or ama; got: $RUNTIME"; exit 1 ;;
esac
if ! [[ "$OBSERVE_SECONDS" =~ ^[0-9]+$ ]] || [ "$OBSERVE_SECONDS" -le 0 ]; then
  echo "FATAL: --observe-seconds must be a positive integer"
  exit 1
fi
if ! [[ "$TRIGGER_READY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "FATAL: AK_MAINTAINER_SMOKE_TRIGGER_READY_SECONDS must be a non-negative integer"
  exit 1
fi
if ! [[ "$SESSION_START_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$SESSION_START_TIMEOUT_SECONDS" -le 0 ]; then
  echo "FATAL: AK_MAINTAINER_SMOKE_SESSION_START_TIMEOUT_SECONDS must be a positive integer"
  exit 1
fi
if ! [[ "$CLOSED_NO_RUN_SECONDS" =~ ^[0-9]+$ ]] || [ "$CLOSED_NO_RUN_SECONDS" -le 0 ]; then
  echo "FATAL: AK_MAINTAINER_SMOKE_CLOSED_NO_RUN_SECONDS must be a positive integer"
  exit 1
fi

if ! ak auth whoami >/dev/null 2>&1; then
  echo "FATAL: ak is not authenticated. Run ak config set/use or agent identity setup first."
  exit 1
fi

if [ "$LIVE" = 1 ]; then
  require_machine_runner
  require_runtime_available "$RUNTIME"
else
  case "$RUNTIME" in
    codex | claude | copilot) require_machine_runner ;;
  esac
fi

if [ -z "$BOARD_ID" ]; then BOARD_ID="$(discover_board 2>/dev/null || true)"; fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(create_board)"; fi

BOARD_TYPE="$(board_field "$BOARD_ID" type)"
if [ "$BOARD_TYPE" != "dev" ]; then
  echo "FATAL: maintainer smoke requires a dev board so repository workflow can be validated; board $BOARD_ID is $BOARD_TYPE"
  exit 1
fi

if [ -z "$REPO_ID" ]; then REPO_ID="$(discover_repo 2>/dev/null || true)"; fi
if [ -z "$REPO_ID" ]; then
  echo "FATAL: no repository found. Register a GitHub App-backed repo first, or pass --repo <repo_id>."
  exit 1
fi
REPO_FULL_NAME="$(repo_field "$REPO_ID" full_name)"

AGENT_ID="$(create_smoke_agent "$RUNTIME")"
CALLER_AGENT_ID="$(ak auth whoami 2>/dev/null | awk '/Agent ID:/ {print $3; exit}' || true)"

echo "  Board:   $BOARD_ID"
echo "  Repo:    $REPO_ID ($REPO_FULL_NAME)"
echo "  Agent:   $AGENT_ID ($RUNTIME, role=board-maintainer)"
[ -n "$CALLER_AGENT_ID" ] && echo "  Caller:  $CALLER_AGENT_ID"
echo ""

# ── Layer A: contract ────────────────────────────────────────────────────────

echo "[Layer A] CLI/API contract"

ensure_board_repo_mapping

BOARD_REPOS_JSON=$(ak get repo --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$BOARD_REPOS_JSON" | json_query "data.some((r) => r.id === '$REPO_ID' && r.full_name === '$REPO_FULL_NAME')")" = "true" ]; then
  pass "ak get repo --board returns target repository"
else
  fail "ak get repo --board does not return target repository"
fi

MAINTAINER_ID=$(ak create maintainer \
  --board "$BOARD_ID" \
  --agent "$AGENT_ID" \
  --interval-seconds 3600 \
  --heartbeat off \
  -o json | json_query "data.id")
if [ -n "$MAINTAINER_ID" ]; then
  pass "create board-level maintainer ($MAINTAINER_ID)"
else
  fail "create board-level maintainer"
  echo "==== Passed: $PASS  Failed: $((FAIL + 1)) ===="
  exit 1
fi

[ "$(maintainer_field "$MAINTAINER_ID" status)" = "active" ] \
  && pass "created maintainer is active" || fail "created maintainer is not active"

[ "$(maintainer_field "$MAINTAINER_ID" heartbeat_enabled)" = "false" ] \
  && pass "created maintainer has scheduled heartbeat disabled" || fail "created maintainer heartbeat was not disabled"

if [ "$(ak get maintainer "$MAINTAINER_ID" --board "$BOARD_ID" -o json | json_query "Object.prototype.hasOwnProperty.call(data, 'repository_id')")" = "false" ]; then
  pass "maintainer has no repository_id binding"
else
  fail "maintainer still exposes repository_id"
fi

LIST_JSON=$(ak get maintainer --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$LIST_JSON" | json_query "data.some((m) => m.id === '$MAINTAINER_ID')")" = "true" ]; then
  pass "maintainer appears in list"
else
  fail "maintainer missing from list"
fi

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --status paused >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" status)" = "paused" ] \
  && pass "maintainer paused via update" || fail "maintainer did not pause"

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --status active >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" status)" = "active" ] \
  && pass "maintainer resumed via update" || fail "maintainer did not resume"

if ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --interval-seconds 3599 >/tmp/maintainer-smoke-interval.out 2>&1; then
  fail "maintainer accepted interval below 1h"
else
  if grep -q ">= 3600" /tmp/maintainer-smoke-interval.out; then
    pass "maintainer rejects heartbeat interval below 1h"
  else
    fail "maintainer interval below 1h failed for unexpected reason"
  fi
fi
rm -f /tmp/maintainer-smoke-interval.out

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --interval-seconds 7200 >/dev/null 2>&1
if [ "$(maintainer_field "$MAINTAINER_ID" interval_seconds)" = "7200" ]; then
  pass "maintainer interval updated to 7200"
else
  fail "maintainer interval update not reflected"
fi

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --heartbeat on >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" heartbeat_enabled)" = "true" ] \
  && pass "maintainer heartbeat enabled via update" || fail "maintainer heartbeat did not enable"

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --heartbeat off >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" heartbeat_enabled)" = "false" ] \
  && pass "maintainer heartbeat disabled via update" || fail "maintainer heartbeat did not disable"

if [ "$(ak get maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --runs -o json | json_query "Array.isArray(data.data)")" = "true" ]; then
  pass "maintainer runs history is listable"
else
  fail "maintainer runs history not listable"
fi

if token_output="$(ak auth git "$REPO_ID" --print-token 2>&1)"; then
  if printf '%s' "$token_output" | grep -Eq 'gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_'; then
    pass "ak auth git --print-token returns an installation token"
  else
    fail "ak auth git --print-token succeeded but token shape was not recognized"
  fi
else
  fail "ak auth git --print-token failed"
fi
unset token_output

if AK_WORKER=0 ak auth git "$REPO_ID" >/tmp/maintainer-smoke-git.out 2>&1; then
  fail "ak auth git modified credentials outside AK_WORKER"
else
  if grep -q "Refusing to modify global git credentials" /tmp/maintainer-smoke-git.out; then
    pass "ak auth git refuses outside AK_WORKER"
  else
    fail "ak auth git failed for unexpected reason outside AK_WORKER"
  fi
fi
rm -f /tmp/maintainer-smoke-git.out

TEMP_AMA_WORKSPACE="$(mktemp -d)"
TEMP_HOST_HOME="$(mktemp -d)"
mkdir -p "$TEMP_AMA_WORKSPACE/.ak/config" "$TEMP_AMA_WORKSPACE/.home"
cp "$ORIGINAL_HOME/.config/agent-kanban/config.json" "$TEMP_AMA_WORKSPACE/.ak/config/config.json"
LEADER_SESSION_JSON="$(leader_session_json 2>/dev/null || true)"
if [ -n "$LEADER_SESSION_JSON" ]; then
  LEADER_AGENT_ID="$(printf '%s' "$LEADER_SESSION_JSON" | json_query "data.agentId")"
  LEADER_SESSION_ID="$(printf '%s' "$LEADER_SESSION_JSON" | json_query "data.sessionId")"
  LEADER_API_URL="$(printf '%s' "$LEADER_SESSION_JSON" | json_query "data.apiUrl")"
  pass "found current leader agent session for synthetic AK_WORKER isolation check"
else
  fail "could not locate a current leader agent session for AK_WORKER isolation check"
fi

if [ -n "$LEADER_SESSION_JSON" ] \
  && AK_WORKER=1 \
    AMA_WORKSPACE="$TEMP_AMA_WORKSPACE" \
    AMA_WORKSPACE_HOME="$TEMP_AMA_WORKSPACE/.home" \
    HOME="$TEMP_HOST_HOME" \
    AK_API_URL="$LEADER_API_URL" \
    AK_AGENT_ID="$LEADER_AGENT_ID" \
    AK_SESSION_ID="$LEADER_SESSION_ID" \
    REALMROOT_STATE_DIR="${REALMROOT_STATE_DIR:-$ORIGINAL_HOME/.local/state/realmroot}" \
    ak get repo "$REPO_ID" -o json >/dev/null 2>&1; then
  pass "ak command works with AK_WORKER and isolated AMA workspace env"
else
  fail "ak command failed with AK_WORKER and isolated AMA workspace env"
fi

if [ -n "$LEADER_SESSION_JSON" ] \
  && AK_WORKER=1 \
    AMA_WORKSPACE="$TEMP_AMA_WORKSPACE" \
    AMA_WORKSPACE_HOME="$TEMP_AMA_WORKSPACE/.home" \
    HOME="$TEMP_HOST_HOME" \
    AK_API_URL="$LEADER_API_URL" \
    AK_AGENT_ID="$LEADER_AGENT_ID" \
    AK_SESSION_ID="$LEADER_SESSION_ID" \
    REALMROOT_STATE_DIR="${REALMROOT_STATE_DIR:-$ORIGINAL_HOME/.local/state/realmroot}" \
    ak auth git "$REPO_ID" >/dev/null 2>&1; then
  if [ -f "$TEMP_AMA_WORKSPACE/.home/.git-credentials" ] \
    && grep -q "x-access-token:" "$TEMP_AMA_WORKSPACE/.home/.git-credentials" \
    && [ -f "$TEMP_AMA_WORKSPACE/.home/.gitconfig" ] \
    && grep -q "helper = store --file=$TEMP_AMA_WORKSPACE/.home/.git-credentials" "$TEMP_AMA_WORKSPACE/.home/.gitconfig" \
    && [ ! -f "$TEMP_HOST_HOME/.git-credentials" ] \
    && [ ! -f "$TEMP_HOST_HOME/.gitconfig" ] \
    && [ ! -f "$TEMP_HOST_HOME/.config/gh/hosts.yml" ]; then
    pass "ak auth git configures credentials inside isolated worker HOME"
  else
    fail "AMA workspace git credential files were not written as expected"
  fi
else
  fail "ak auth git failed with AK_WORKER and AMA_WORKSPACE"
fi

DELETE_OK=$(ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" -o json 2>/dev/null | json_query "data.ok" || echo "")
if [ "$DELETE_OK" = "true" ]; then
  pass "maintainer deleted"
else
  fail "maintainer delete did not return ok"
fi
LIST_AFTER_JSON=$(ak get maintainer --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$LIST_AFTER_JSON" | json_query "data.every((m) => m.id !== '$MAINTAINER_ID')")" = "true" ]; then
  pass "deleted maintainer no longer appears in active list"
else
  fail "deleted maintainer still appears in list"
fi
MAINTAINER_ID=""
echo ""

# ── Layer B: live runs ───────────────────────────────────────────────────────

if [ "$LIVE" = 1 ]; then
  echo "[Layer B] Live maintainer trigger sessions (runtime=$RUNTIME; this can take several minutes)"
  mkdir -p "$ARTIFACT_DIR"
  echo "  Artifacts: $ARTIFACT_DIR"

  INSTALLATION_ID="$(discover_installation_id 2>/dev/null || true)"
  if [ -z "$INSTALLATION_ID" ]; then
    echo "FATAL: could not discover GitHub App installation id for repo $REPO_ID"
    exit 1
  fi
  echo "  GitHub installation: $INSTALLATION_ID"

  HTTP_ISSUE_TITLE="Maintainer smoke issue $TIMESTAMP"
  LIVE_BASELINE_SEQ="$(max_task_seq)"

  HTTP_MAINTAINER_ID=$(ak create maintainer \
    --board "$BOARD_ID" \
    --agent "$AGENT_ID" \
    --interval-seconds 3600 \
    --heartbeat off \
    -o json | json_query "data.id")
  echo "  HTTP maintainer: $HTTP_MAINTAINER_ID"
  ak get maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" -o json | write_artifact "http-maintainer.json"

  if [ "$TRIGGER_READY_SECONDS" -gt 0 ]; then
    echo "  Waiting ${TRIGGER_READY_SECONDS}s for maintainer HTTP trigger propagation"
    sleep "$TRIGGER_READY_SECONDS"
  fi
  HTTP_BASELINE="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
  create_real_github_issue
  echo "  GitHub issue: $REPO_FULL_NAME#$HTTP_ISSUE_NUMBER ($HTTP_ISSUE_URL)"
  if is_local_api_url; then
    if post_github_issue_event "issue"; then
      pass "synthetic signed GitHub issues webhook posted to local API"
    else
      fail "synthetic signed GitHub issues webhook failed"
    fi
  else
    echo "  OBSERVE: remote API detected; waiting for real GitHub App webhook delivery instead of using local .dev.vars secret"
  fi
  if wait_for_maintainer_run "$HTTP_MAINTAINER_ID" "$HTTP_BASELINE" "$OBSERVE_SECONDS"; then
    pass "GitHub issues webhook dispatched an HTTP maintainer run"
  else
    fail "GitHub issues webhook did not dispatch an HTTP maintainer run"
  fi
  maintainer_runs_json "$HTTP_MAINTAINER_ID" 20 | write_artifact "http-runs.json"

  HTTP_RUN_STATUS="$(latest_run_field "$HTTP_MAINTAINER_ID" "status" 2>/dev/null || true)"
  HTTP_SESSION_ID=""
  case "$HTTP_RUN_STATUS" in
    failed | error | cancelled | canceled)
      fail "HTTP maintainer run failed before creating an AMA session"
      echo "    latest HTTP run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
      ;;
    *)
      HTTP_SESSION_ID="$(wait_for_latest_run_session "$HTTP_MAINTAINER_ID" 300 || true)"
      ;;
  esac
  if [ -n "$HTTP_SESSION_ID" ]; then
    pass "HTTP maintainer run recorded AMA session id ($HTTP_SESSION_ID)"
    HTTP_SESSION_STATE="$(wait_for_session_terminal "$HTTP_SESSION_ID" "$OBSERVE_SECONDS" || true)"
    case "$HTTP_SESSION_STATE" in
      completed | idle | closed | stopped)
        pass "HTTP maintainer session reached terminal state: $HTTP_SESSION_STATE"
        ;;
      failed | error | cancelled | canceled)
        fail "HTTP maintainer session ended with failure state: $HTTP_SESSION_STATE"
        ;;
      pending)
        fail "HTTP maintainer session stayed pending longer than ${SESSION_START_TIMEOUT_SECONDS}s"
        ;;
      *)
        fail "HTTP maintainer session did not reach terminal state within ${OBSERVE_SECONDS}s; latest state: ${HTTP_SESSION_STATE:-unknown}"
        ;;
    esac
    if ak get session "$HTTP_SESSION_ID" --all -o json > "$ARTIFACT_DIR/http-session-events.json" 2>/dev/null; then
      assert_session_event_artifact "$ARTIFACT_DIR/http-session-events.json" "HTTP maintainer"
    else
      fail "HTTP maintainer session events could not be fetched"
    fi
  elif [ "$HTTP_RUN_STATUS" != "failed" ] && [ "$HTTP_RUN_STATUS" != "error" ] && [ "$HTTP_RUN_STATUS" != "cancelled" ] && [ "$HTTP_RUN_STATUS" != "canceled" ]; then
    fail "HTTP maintainer run did not record AMA session id"
    echo "    latest HTTP run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
  fi

  CLOSED_BASELINE="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
  if gh_smoke issue close "$HTTP_ISSUE_NUMBER" -R "$REPO_FULL_NAME" --reason "not planned" >/dev/null; then
    refresh_github_issue_json
    pass "GitHub issue closed for maintainer lifecycle smoke"
  else
    fail "GitHub issue close failed for maintainer lifecycle smoke"
  fi
  if is_local_api_url; then
    if post_github_issue_event "issue-closed" "closed"; then
      pass "synthetic signed GitHub issues closed webhook posted to local API"
    else
      fail "synthetic signed GitHub issues closed webhook failed"
    fi
  else
    echo "  OBSERVE: waiting for real GitHub issues closed webhook delivery"
  fi
  if wait_for_no_maintainer_run "$HTTP_MAINTAINER_ID" "$CLOSED_BASELINE" "$CLOSED_NO_RUN_SECONDS"; then
    pass "GitHub issues closed webhook did not dispatch a maintainer run"
  else
    fail "GitHub issues closed webhook dispatched an unexpected maintainer run"
  fi
  maintainer_runs_json "$HTTP_MAINTAINER_ID" 30 | write_artifact "http-closed-runs.json"
  if [ -n "$HTTP_SESSION_ID" ]; then
    CLOSED_SESSION_STATE="$(wait_for_session_closed "$HTTP_SESSION_ID" "$OBSERVE_SECONDS" || true)"
    case "$CLOSED_SESSION_STATE" in
      closed)
        pass "closed issue event closed the existing maintainer session"
        ;;
      failed | error | cancelled | canceled)
        fail "closed issue maintainer session ended with failure state: $CLOSED_SESSION_STATE"
        ;;
      *)
        fail "closed issue event did not close the existing maintainer session within ${OBSERVE_SECONDS}s; latest state: ${CLOSED_SESSION_STATE:-unknown}"
        ;;
    esac
  else
    fail "closed issue session close could not be verified because the original session id is missing"
  fi

  COMMENT_BASELINE="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
  if create_closed_issue_comment; then
    refresh_github_issue_json
    pass "GitHub comment created on closed issue for maintainer lifecycle smoke"
  else
    fail "GitHub comment on closed issue failed for maintainer lifecycle smoke"
  fi
  if is_local_api_url; then
    if post_github_issue_comment_event "closed-issue-comment"; then
      pass "synthetic signed GitHub issue_comment webhook posted to local API"
    else
      fail "synthetic signed GitHub issue_comment webhook failed"
    fi
  else
    echo "  OBSERVE: waiting for real GitHub issue_comment webhook delivery"
  fi
  if wait_for_maintainer_run "$HTTP_MAINTAINER_ID" "$COMMENT_BASELINE" "$OBSERVE_SECONDS"; then
    pass "closed issue comment dispatched a maintainer run"
  else
    fail "closed issue comment did not dispatch a maintainer run"
  fi
  maintainer_runs_json "$HTTP_MAINTAINER_ID" 40 | write_artifact "http-closed-comment-runs.json"
  COMMENT_SESSION_ID="$(wait_for_latest_run_session "$HTTP_MAINTAINER_ID" 300 || true)"
  if [ -n "$COMMENT_SESSION_ID" ]; then
    COMMENT_SESSION_STATE="$(wait_for_session_terminal "$COMMENT_SESSION_ID" "$OBSERVE_SECONDS" || true)"
    case "$COMMENT_SESSION_STATE" in
      completed | idle | closed | stopped)
        pass "closed issue comment maintainer session reached terminal state: $COMMENT_SESSION_STATE"
        ;;
      failed | error | cancelled | canceled)
        fail "closed issue comment maintainer session ended with failure state: $COMMENT_SESSION_STATE"
        ;;
      pending)
        fail "closed issue comment maintainer session stayed pending longer than ${SESSION_START_TIMEOUT_SECONDS}s"
        ;;
      *)
        fail "closed issue comment maintainer session did not reach terminal state within ${OBSERVE_SECONDS}s; latest state: ${COMMENT_SESSION_STATE:-unknown}"
        ;;
    esac
  else
    fail "closed issue comment maintainer run did not record AMA session id"
  fi

  if maintainer_memories_json "$HTTP_MAINTAINER_ID" 100 > "$ARTIFACT_DIR/http-memories.json" 2>/dev/null; then
    MEMORY_COUNT="$(json_array_count < "$ARTIFACT_DIR/http-memories.json")"
    if [ "$MEMORY_COUNT" -gt 0 ]; then
      pass "HTTP maintainer persisted memory files ($MEMORY_COUNT)"
    else
      fail "HTTP maintainer persisted no memory files"
    fi
  else
    fail "HTTP maintainer memory API could not be fetched"
  fi

  assert_maintainer_tasks_since "$LIVE_BASELINE_SEQ" "HTTP maintainer event window" "$ARTIFACT_DIR/http-created-tasks.json"
  assert_no_caller_created_tasks_since "$LIVE_BASELINE_SEQ" "HTTP maintainer event window"

  if [ "$WAIT_HEARTBEAT" = 1 ] && { [ "$HTTP_RUN_STATUS" = "failed" ] || [ "$HTTP_RUN_STATUS" = "error" ] || [ "$HTTP_RUN_STATUS" = "cancelled" ] || [ "$HTTP_RUN_STATUS" = "canceled" ]; }; then
    echo "  OBSERVE: scheduled heartbeat live wait skipped because the HTTP maintainer run failed before session creation"
  elif [ "$WAIT_HEARTBEAT" = 1 ]; then
    if [ "$OBSERVE_SECONDS" -lt 3600 ]; then
      echo "  OBSERVE: --wait-heartbeat with --observe-seconds < 3600 may time out because heartbeat minimum interval is 1h"
    fi
    HEARTBEAT_BASELINE="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
    ak update maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" --heartbeat on >/dev/null
    if wait_for_maintainer_run "$HTTP_MAINTAINER_ID" "$HEARTBEAT_BASELINE" "$OBSERVE_SECONDS"; then
      pass "scheduled heartbeat dispatched a maintainer run"
      maintainer_runs_json "$HTTP_MAINTAINER_ID" 30 | write_artifact "heartbeat-runs.json"
      HEARTBEAT_RUN_STATUS="$(latest_run_field "$HTTP_MAINTAINER_ID" "status" 2>/dev/null || true)"
      HEARTBEAT_SESSION_ID=""
      case "$HEARTBEAT_RUN_STATUS" in
        failed | error | cancelled | canceled)
          fail "scheduled heartbeat run failed before creating an AMA session"
          echo "    latest heartbeat run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
          ;;
        *)
          HEARTBEAT_SESSION_ID="$(wait_for_latest_run_session "$HTTP_MAINTAINER_ID" 300 || true)"
          ;;
      esac
      if [ -n "$HEARTBEAT_SESSION_ID" ]; then
        pass "scheduled heartbeat run recorded AMA session id ($HEARTBEAT_SESSION_ID)"
        HEARTBEAT_SESSION_STATE="$(wait_for_session_terminal "$HEARTBEAT_SESSION_ID" "$OBSERVE_SECONDS" || true)"
        case "$HEARTBEAT_SESSION_STATE" in
          completed | idle | closed | stopped)
            pass "scheduled heartbeat session reached terminal state: $HEARTBEAT_SESSION_STATE"
            ;;
          failed | error | cancelled | canceled)
            fail "scheduled heartbeat session ended with failure state: $HEARTBEAT_SESSION_STATE"
            ;;
          pending)
            fail "scheduled heartbeat session stayed pending longer than ${SESSION_START_TIMEOUT_SECONDS}s"
            ;;
          *)
            fail "scheduled heartbeat session did not reach terminal state within ${OBSERVE_SECONDS}s; latest state: ${HEARTBEAT_SESSION_STATE:-unknown}"
            ;;
        esac
        if ak get session "$HEARTBEAT_SESSION_ID" --all -o json > "$ARTIFACT_DIR/heartbeat-session-events.json" 2>/dev/null; then
          assert_session_event_artifact "$ARTIFACT_DIR/heartbeat-session-events.json" "scheduled heartbeat"
        else
          fail "scheduled heartbeat session events could not be fetched"
        fi
      elif [ "$HEARTBEAT_RUN_STATUS" != "failed" ] && [ "$HEARTBEAT_RUN_STATUS" != "error" ] && [ "$HEARTBEAT_RUN_STATUS" != "cancelled" ] && [ "$HEARTBEAT_RUN_STATUS" != "canceled" ]; then
        fail "scheduled heartbeat run did not record AMA session id"
        echo "    latest heartbeat run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
      fi
      if maintainer_memories_json "$HTTP_MAINTAINER_ID" 100 > "$ARTIFACT_DIR/heartbeat-memories.json" 2>/dev/null; then
        pass "scheduled heartbeat memory API fetched"
      else
        fail "scheduled heartbeat memory API could not be fetched"
      fi
    else
      fail "scheduled heartbeat did not dispatch a maintainer run within ${OBSERVE_SECONDS}s"
    fi
  else
    echo "  OBSERVE: scheduled heartbeat live wait skipped; pass --wait-heartbeat --observe-seconds 3900+ for a full 1h heartbeat observation"
  fi
  assert_no_caller_created_tasks_since "$LIVE_BASELINE_SEQ" "live maintainer run window"
  echo ""
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$KEEP_ARTIFACTS" = 1 ]; then
  if [ -n "$AGENT_ID" ]; then echo "  Maintainer agent:      $AGENT_ID"; fi
  if [ -d "$ARTIFACT_DIR" ]; then echo "  Artifact dir:          $ARTIFACT_DIR"; fi
fi
echo "==============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
