# AMA Runtime Integration

Status: implementation record for `codex/ama-runtime-integration`

## Goal

Agent Kanban remains the task orchestration and review product. Any Managed
Agents is the runtime substrate.

AK owns:

- boards, org scoping, tasks, dependencies, review, PR workflow, and task
  annotations
- AK CLI workflow commands used by humans, lead agents, and worker agents
- AK product features such as board maintainers

AMA owns:

- projects as the runtime workspace scope
- agent definitions, environments, runners, sessions, scheduled triggers,
  vault-backed runtime secrets, events, usage, and runtime history

The integration must keep AMA hidden as product plumbing. AK users should not
need to understand AMA project, environment, runner runtime support, or session
configuration in order to use AK.

## Boundary Decisions

- AK org maps to one AMA project.
- AK board does not map to an AMA project.
- AMA does not store AK task, board, review, or PR semantics as first-class
  product fields.
- AK stores runtime correlation in task metadata annotations.
- AK may keep product tables such as `agents`, `repositories`, `machines`, and
  `board_maintainers` while the public AK UX still depends on them.
- The old Machine UX is preserved as an AK concept. Its backend now starts an
  AMA runner through AK-managed onboarding instead of exposing AMA runner setup.

## Runtime Flow

Assigned AK tasks dispatch through AMA:

1. AK receives a task create or assignment with an AK agent id.
2. AK resolves the owning AMA project and an online AK machine runtime mapped
   to an AMA environment server-side.
3. AK ensures the AK agent has a mapped AMA AgentDefinition.
4. AK creates a short-lived AK agent session identity.
5. AK stores the private runtime credential in AMA vault as a session secret
   and records the credential id in `ama_agent_sessions` for later revocation.
6. AK creates an AMA session with AK runtime env and vault-backed secret refs.
7. AK stores AMA ids and dispatch result in task metadata annotations.
8. The AMA runner starts the session; the agent uses AK CLI/API for claim,
   notes, review, reject handling, completion, and cancellation.

The public task API and CLI still speak AK concepts. `ak create task` and task
assignment do not require AMA agent, environment, or runner flags.

### Dispatch policy

Dispatch is deferred — the task stays todo+assigned without a runtime
binding — when the task is dependency-blocked, `scheduled_at` is in the
future, or capable machines exist but every runner is busy or offline.
Dispatch fails (409) only when no machine supports the agent's runtime at all.

A per-minute cron closes the loop, replacing the old daemon poll loop:

- `reconcileAmaBoundTasks` — releases tasks whose AMA session died
  (error/stopped/archived/missing) and tears down bindings left behind by
  best-effort cleanup on complete/cancel.
- `dispatchPendingAmaTasks` — dispatches assigned, unblocked, due,
  undispatched todo tasks (requires `AK_API_URL`).
- The stale sweep stops the bound AMA session before releasing a stale task.

### Binding teardown

`releaseTaskRuntimeBinding` is the single teardown path: stop the AMA session
(404/409 tolerated as already-terminal), revoke the vault session secret,
close the AK agent session, clear the binding annotations. Complete and cancel
transition locally first and tear down best-effort (the reconcile sweep mops
up if AMA is unreachable); release tears down strictly before re-dispatch;
re-dispatch always tears down the previous session first. Reject falls back
from resume to restart (teardown + release) when the session is already dead.

## Runner Onboarding

`ak start` keeps the existing AK credential flow:

- the CLI reads or saves AK API credentials
- it registers an AK machine with the runtime the runner will actually serve
- AK creates or reuses the machine's AMA environment during machine
  registration
- AK returns runner onboarding data in the machine registration response
- AK resolves AMA project, environment, structured runtime support, and runner federation
  server-side
- AK creates/refreshes the generic AMA external project binding
- the CLI ensures `ama-runner` has a valid AMA Context-login credential for the
  onboarding AMA origin
- the CLI starts `ama-runner`

The runner credentials are written by `ama-runner` to an AK-owned credentials
file with restricted permissions. `AMA_TOKEN` and `AMA_RUNNER_CONFIG` are
removed from the child process environment. The runner command line contains
the AMA API server, project, environment, workdir, and concurrency because
those are runner process inputs, but they are not exposed as AK CLI options.

## Cloud Placement (AMA Sandbox Runtime)

Placement is derived from the agent runtime, not from a per-task field:

- Agent runtime `ama` (label "AMA Cloud") maps to AMA's `ama` runtime and runs
  on the AMA Cloudflare Sandbox plane. All other runtimes map to machine-hosted
  self-hosted runners as before.
- Each owner gets one lazily created cloud AMA environment
  (`hostingMode: "cloud"`), recorded as `cloudEnvironmentId` on the owner
  integration. Cloud sessions are sandbox-isolated per session, so one
  environment serves the whole tenant.
- Cloud dispatch skips the runner capacity gate (AMA scales sandboxes per
  session) and otherwise follows the same session/binding lifecycle.
- Dispatch is serialized by an atomic claim: `ama.dispatch.result` flips
  null → `dispatching` via a conditional update, so the create/assign request
  and the cron sweep can no longer double-create sessions. Assign requests
  claim with takeover (may seize an `accepted` dispatch to kick a bound task,
  never an in-flight one). Stale `dispatching` claims are released by the
  reconcile sweep.
- Cloud sessions get `GH_TOKEN` from the AK GitHub App (AgentKanban, App ID
  4029578): a repository-scoped ~1h installation access token minted per
  dispatch, delivered through a per-session AMA vault credential
  (`ama.ghCredentialId` annotation) and revoked at binding teardown. The PR
  is authored by `app/agentkanban`. Server env: `GITHUB_APP_ID` +
  `GITHUB_APP_PRIVATE_KEY` (base64 PKCS#8 PEM). `GITHUB_AGENT_TOKEN` remains
  only as a fallback when the App is unconfigured or not installed on the
  repository.
- Runner federation uses `AK_FEDERATED_ISSUER` (default `AK_API_URL`) as the
  stable issuer identity registered with the OIDC provider's trusted issuers,
  so an ephemeral dev tunnel in `AK_API_URL` does not break `ak start`.
- npm is unusable inside the sandbox (npm worker processes orphan the exec
  pipe), so the CLI ships as a fully bundled single file
  (`packages/cli` tsup `standalone` entry, provider SDKs stubbed) served by
  the web app at `/cli/ak-standalone.mjs` with a `/cli/install.sh` bootstrap.
  The cloud initial prompt is self-contained: install CLI, claim, branch,
  commit/push (git identity + credential store are pre-configured by AMA
  runtime preparation), create the PR with `gh pr create` (the sandbox
  image `ama-sandbox:0.10.1-gh1` ships the GitHub CLI, which reads the
  session `GH_TOKEN` natively), submit review.
- The dev server has no cron; the smoke script drives the dispatch/reconcile
  sweeps by poking `/cdn-cgi/handler/scheduled`, and cloud runs against a
  local dev server need a public `AK_API_URL` (cloudflared quick tunnel).

AMA-side enablers shipped to AMA master for this placement: shared vault
secret-env resolution for cloud session startup, sandbox session env
injection, workspace clone with git identity/credential store, default
sandbox toolset when the agent has no explicit allow-list, queue-consumer
execution for session startup and turns (HTTP waitUntil killed any long
sandbox command mid-run), a bounded 10-minute sandbox exec, a watchdog that
errors stalled pending/running cloud sessions and reaps leaked sandboxes
(container instance capacity), absolute `/workspace` paths in file tools, and
idle-session reclaim for queued prompts (reject/resume race).

## Metadata

AK task metadata annotations may contain:

```json
{
  "ama.projectId": "project_...",
  "ama.agentId": "agent_...",
  "ama.environmentId": "env_...",
  "ama.sessionId": "session_...",
  "agentId": "agent_...",
  "agentSessionId": "session_uuid",
  "ama.dispatch.result": "accepted"
}
```

These annotations are AK-owned correlation data. They are not written back into
AMA as AK product semantics.

The generic AMA external project binding uses standard federation fields:
issuer, external tenant id, environment id, and capabilities. It does not need
AK task or board metadata.

## Board Maintainers

Board maintainers are an AK product feature backed by generic AMA scheduled
agent triggers.

AK stores maintainer configuration and lightweight run correlation in:

- `board_maintainers`

AMA stores the scheduled trigger, created sessions, events, runtime history, and
future agent memory/notebook capability. AK lists heartbeat runs through a
public AK-shaped API response, but AK does not copy full session history into
local tables.

Maintainers are configured with AK agent ids. AK maps those agents to AMA
AgentDefinitions internally.

## Compatibility Rules

- `ak start`, `ak stop`, `ak restart`, `ak status`, and `ak logs` remain the
  AK machine commands.
- `ak start` must not ask users for AMA environment or runtime-support arguments.
- Task creation and assignment must not ask users for AMA environment or
  session arguments.
- Machines remain visible as the AK runner/environment concept where existing
  UX depends on them.
- Legacy daemon/session APIs remain compatibility surfaces only. They are not
  the accepted runtime dispatch path.

## Implemented In This Branch

- Added task metadata annotations and runtime session mappings.
- Added AMA SDK-backed task dispatch.
- Added vault-backed AK agent session credentials for AMA sessions.
- Routed task chat, reject resume, cancel stop, and runtime snapshots through
  AMA sessions when a task is AMA-bound.
- Reworked `ak start` to launch `ama-runner` through AK onboarding while
  preserving the original AK credential flow.
- Preserved machine command names and stopped exposing AMA runner config as AK
  CLI arguments.
- Added board maintainer APIs, CLI commands, settings UI, scheduled trigger
  integration, and heartbeat run listing.
- Added server-side owner runtime bindings, machine-to-AMA-environment mappings,
  and AK-agent-to-AMA-agent mappings.
- Kept repositories as AK product records while translating GitHub repositories
  to AMA resource refs during dispatch.

## Current Verification Evidence

Local AK checks:

- `pnpm build`
- `pnpm -r --parallel run lint`
- `npx vitest run`
- `bash scripts/install-cli.sh`
- `./scripts/daemon-smoke-test.sh --runtime codex`

Real smoke evidence from the placement-scenario runs on 2026-06-11 (local AK
dev server behind a cloudflared tunnel + deployed AMA + released runner
v0.1.0):

- pure cloud (`./scripts/daemon-smoke-test.sh ama`): `Passed 10 Failed 0`,
  full lifecycle on the Cloudflare Sandbox — dispatch, claim via the
  standalone CLI, work, PR `saltbo/slink#70` created through the GitHub API
  with the vault-delivered `GH_TOKEN`, reject/resume re-review, completion
  with binding teardown, cancel with sandbox teardown.
- mixed (`./scripts/daemon-smoke-test.sh mixed`): `Passed 11 Failed 0` —
  one codex task on the local runner and one ama task on the cloud sandbox
  ran the dispatch→review→complete lifecycle concurrently
  (PRs `saltbo/slink#73` local, `saltbo/slink#74` cloud).
- pure local (`./scripts/daemon-smoke-test.sh codex`): full 4-test lifecycle
  against the machine runner (see latest run log for the summary line).

Earlier claude-runtime evidence (PR `saltbo/slink#65`, `Passed 11 Failed 0`)
still stands for the runner path.

AMA support work was pushed separately in Any Managed Agents:

- `5e3c016 fix(runners): preserve queued session resumes`

That fix prevents an older completed runner lease from overwriting newer queued
work for the same session during AK reject/resume.

## Closed Daemon-Parity Gaps

All of these are implemented and tested:

- PR state sync via a platform GitHub App: users install the app on their
  repositories (one click, no secrets, no per-user setup); GitHub delivers
  all installations' pull_request events to `POST /api/webhooks/github-app`,
  signed with the app webhook secret (`GITHUB_APP_WEBHOOK_SECRET`, platform
  env — never distributed). Events map PR merged→done and closed→cancelled
  in real time, routed by `pr_url`, which only matches tasks inside the PR
  owner's own boards — replacing the old daemon's 30s `gh` poll.
  One-time platform setup: create a GitHub App with webhook URL
  `<origin>/api/webhooks/github-app`, a generated webhook secret,
  Pull requests (Read) permission, and the Pull request event subscription;
  put the secret in the deployment env. A GitLab handler can be added as a
  sibling endpoint. (AK)
- Git author/committer identity rides `runtimeEnv` per agent. GPG signing
  remains open — needs a runner-side session signing key capability. (AK)
- Provider-native subagent files (`.claude/agents/*.md`, `.codex/agents/*.toml`)
  are materialized in the session worktree by the runner. (AMA)
- Quota-aware dispatch: runners report per-runtime quota windows; dispatch
  skips runners whose target runtime is at 100% utilization until the window
  resets, and the dispatch sweep retries. Mid-run rate-limit pause remains
  delegated to the runtime CLIs. (AK + AMA)
- Session usage accounting: AMA usage summary totals are copied into
  `ama_agent_sessions` at binding teardown. (AK)
- Leader session reaping: the CLI closes dead-PID leader sessions (with usage
  report) on the first leader command of a process. (AK)
- Session max duration: runner-side timeout (default 2h, configurable) fails
  the lease explicitly instead of renewing forever. (AMA)
- Runner runtimes, models, and readiness states are detected from installed
  CLIs and refreshed on every heartbeat. (AMA)
- Mid-run chat: prompts to a running claude-code/copilot session are delivered
  live over the runner channel into the runtime; codex (and any channel
  failure) falls back to the queued resume turn. (AMA)
- Codex/copilot resume tokens ride lease renewals and survive interrupts, so
  all three runtimes resume after a runner restart. (AMA)
- Runner version is pinned by the server via the machine registration
  response (`AMA_RUNNER_VERSION` env), with the CLI constant as fallback. (AK)
- The legacy CLI daemon is deleted (`packages/cli/src/daemon/`, `__daemon`
  command, daemon-only modules and tests — net −17k lines). Server legacy
  API surfaces stay until the 2026-09-01 sunset. (AK)

## Remaining Follow-Up

All five 2026-06-12 placement gaps are closed and re-verified by a full
three-scenario regression (codex 11/11, ama 10/10, mixed 11/11):

- self-hosted runtimes accept any model; work leases at the runtime level
  (AMA catalog)
- reconcile releases tasks whose session waits in `pending` past 10 minutes
  (AK)
- the npm CLI dropped the provider runtime SDKs (lazy imports +
  devDependencies; fresh install ~6MB instead of ~851MB); the served
  standalone bundle remains the sandbox install path (AK)
- cloud turns chain across queue invocations (`session.step` continuations
  with a 4-minute soft budget per invocation) — total turn duration is no
  longer capped (AMA)
- the dead in-container pi-bridge is removed from the image and config (AMA)

Closed after that regression (runner v0.2.1, verified by a codex 11/11 smoke):

- Runners enumerate real host models (claude via SDK `supportedModels`, codex
  via `~/.codex/models_cache.json`, copilot via `CopilotClient.listModels`) and
  report structured `runtimes` entries containing models and readiness state;
  AMA matching is model-precise. (AMA)
- `ak get model` asks the server (`GET /api/models?runtime=`), which
  aggregates runner runtime reports across the owner's machine environments
  (cloud runtimes keep the platform catalog), instead of loading provider
  SDKs locally. (AK)
- Self-hosted dispatches get the same GitHub App `GH_TOKEN` as cloud ones;
  the runner writes it into a worktree-scoped git credential store for
  pushes. (AK + AMA)
- Local PRs are authored by `app/agentkanban`: the codex CLI exposed the
  host user's personal Codex Apps GitHub connector to managed sessions and
  the agent used its `create_pull_request` tool (host identity) instead of
  `gh pr create`. The runtime-bridge codex provider now passes
  `features.apps=false`, so managed sessions only see session credentials.
  (AMA)

Still open:
- The standalone CLI bundle is rebuilt by `apps/web` prebuild and
  `scripts/install-cli.sh`; consider publishing it with the npm release so
  cloud sessions don't depend on the serving AK instance's build. (AK)
- GPG commit signing per agent (runner-side session signing key). (AMA)
- Register the production GitHub App and add a "Connect GitHub" install link
  in the web UI (the receiver endpoint is live; the app itself is a one-time
  manual registration). (AK ops/UI)
- Broaden maintainer negative-case validation; improve AMA event rendering;
  add memory/notebook UX when the AMA capability is ready. (AK)
- AMA-side changes require an AMA deploy and an ama-runner release (and a
  bump of the server runner-version pin) before they are live end-to-end;
  the latest smoke ran against the released runner v0.1.0. (ops)
