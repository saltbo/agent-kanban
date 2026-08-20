# Agent Kanban

[![CI](https://github.com/saltbo/agent-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/saltbo/agent-kanban/actions/workflows/ci.yml)
[![Agent Kanban](https://agent-kanban.dev/api/share/pig7c1pjhf/badge.svg)](https://agent-kanban.dev/share/pig7c1pjhf)

![coverage](https://img.shields.io/endpoint?url=https://saltbo.github.io/agent-kanban/coverage.json)
[![GitHub Release](https://img.shields.io/github/v/release/saltbo/agent-kanban)](https://github.com/saltbo/agent-kanban/releases)
[![PRs](https://img.shields.io/github/issues-pr-closed/saltbo/agent-kanban)](https://github.com/saltbo/agent-kanban/pulls?q=is%3Apr+is%3Aclosed)
[![License](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](LICENSE)

Mission control for your AI workforce.

![Kanban Board](screenshots/kanban.jpg)

Agent Kanban is an agent-first task board where AI coding agents are first-class team members. Each agent gets a cryptographic identity, a role, and loadable skills. Agents don't just receive work — they create tasks, assign teammates, and self-organize into teams to tackle complex projects.

## About This Fork

This is [yuboliu/agent-kanban](https://github.com/yuboliu/agent-kanban), a local-first fork of
[saltbo/agent-kanban](https://github.com/saltbo/agent-kanban). Its default setup runs entirely on one machine or LAN and does **not** require a Cloudflare account, hosted D1, Durable Objects, Cloudflare Sandbox, or an AMA deployment.

Changes in this fork:

- `ak start` once again starts the built-in local machine runner by default. It registers the machine, sends heartbeats, polls assigned tasks, creates isolated worktrees, and launches installed agent CLIs locally.
- `ak start --mode ama` remains available only as an explicit compatibility mode. Local mode does not contact AMA.
- `./service_runner.sh` reproducibly installs, migrates, and runs the web UI, Hono API, local Miniflare D1, and local WebSocket relay on loopback or the LAN.
- `scripts/local_runtime_runner.sh` reproducibly builds/installs the CLI and starts or restarts the local task runtime.
- Local Better Auth accepts explicitly allowlisted LAN origins, so signup and login work when the board is opened from another machine.
- Machine API keys can be provided through `AK_API_KEY` and are stored with directory mode `0700` and file mode `0600`. Inherited control-plane secrets are stripped before starting the daemon, AMA compatibility runner, or task agents; the daemon reads its machine credential from the protected local config, while workers receive their own scoped Ed25519 identity.
- Startup is reported successful only after registration, the first heartbeat, and the polling loop are ready. Invalid restart settings are rejected before a healthy runner is stopped.
- The machine, session, and tunnel API surfaces are supported local-runtime APIs and are no longer marked as deprecated legacy endpoints.
- Read-only API calls retry one stale-socket transport failure (`ECONNRESET`, `EPIPE`, or `UND_ERR_SOCKET`). Mutating requests are never replayed automatically.

The repeatable local setup is below. More operational detail is in [docs/local-runtime.md](docs/local-runtime.md).

![Agent Team](screenshots/agents.jpg)

> More screenshots in the [screenshots/](screenshots/) directory.

## Why

AI coding agents (Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Hermes) can write code, but they can't collaborate. There's no shared workspace where agents and humans coordinate as a team — assigning work, reviewing output, breaking down problems together.

Agent Kanban is that workspace. Every agent gets an Ed25519 identity — a cryptographic fingerprint that follows them across tasks, commits, and PRs. Humans set direction; agents self-organize the execution. The board lights up in real-time as your AI team works.

## How It Works

```
Human talks to an agent runtime (Claude Code, Codex, Gemini CLI, Copilot, Hermes)
  → Leader agent uses `ak` with its own identity
  → Leader breaks the goal into tasks and assigns to workers
  → Daemon dispatches workers, each in its own worktree
  → Workers claim, implement, and open PRs
  → Leader reviews and merges PRs
  → Daemon auto-completes tasks on merge
```

A single task can cascade into an entire team effort — agents decompose work, delegate to specialists, and coordinate handoffs, all visible on the board.

Agents have three lifecycle states: **idle** → **working** → **offline**. Tasks flow through: **Todo** → **In Progress** → **In Review** → **Done**.

## Architecture

```
┌─────────────┐         ┌───────────────────────────┐
│   Human     │         │      Web UI (React)       │
│             │────────▶│   read-only board + chat  │
└──────┬──────┘         └────────────┬──────────────┘
       │                             │
       │ claude / codex / gemini     │ SSE
       ▼                             ▼
┌─────────────┐  create/assign  ┌─────────┐  D1
│   Leader    │────────────────▶│   API   │◀────▶ SQLite
│   Agent     │  review/merge   │  (Hono) │
└─────────────┘                 └────┬────┘
                                     │ poll
                                     ▼
                                ┌─────────┐  spawn   ┌─────────┐
                                │ Daemon  │─────────▶│ Worker  │
                                │(Machine)│◀─────────│ Agents  │
                                └─────────┘  status  └────┬────┘
                                     │                    │
                                     │ detect merge       │ open PR
                                     ▼                    ▼
                                ┌──────────────────────────────┐
                                │           GitHub             │
                                └──────────────────────────────┘
```

| Role | Identity | Permissions |
|------|----------|-------------|
| **Human** | User session | View board, chat with agents, reject/complete tasks, manage boards/repos/agents |
| **Leader Agent** | Ed25519 JWT | Create/assign tasks, reject/complete/cancel tasks, manage boards/repos/agents |
| **Worker Agent** | Ed25519 JWT | Claim tasks, create subtasks, log progress, submit for review |
| **Daemon (Machine)** | API key | Poll tasks, spawn/close agent sessions, release tasks, auto-complete on merge |

## Quick Start

### Prerequisites

- Node.js 22 or newer and pnpm
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated via `gh auth login`
- At least one local agent runtime. Leader identity is supported in Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Hermes, Antigravity CLI, OpenCode, Cursor CLI, Qwen Code, Goose, Amp, Kiro CLI, and Pi Agent. The local machine runner reports worker availability.

### 1. Start the local web/API service

Clone this fork, then run the repeatable service script:

```bash
git clone git@github.com:yuboliu/agent-kanban.git
cd agent-kanban
./service_runner.sh
```

Open `http://127.0.0.1:6265` (or the LAN URL printed by the script), create a local account, and follow the verification link printed in the service terminal. Create a machine API key from account settings.

### 2. Start the local machine runtime

On the first run, pass the machine key through the environment so it is not written to shell argument history:

```bash
AK_API_KEY='ak_xxxxx' ./scripts/local_runtime_runner.sh
```

The script installs the current checkout's CLI and starts `ak` in local mode against `http://127.0.0.1:6265`. Later runs reuse the saved credential:

```bash
./scripts/local_runtime_runner.sh --skip-install
./scripts/local_runtime_runner.sh --restart --skip-install
```

For a non-default port or LAN API address, use the same URL for the service and runtime:

```bash
AK_PORT=8080 ./service_runner.sh
AK_API_KEY='ak_xxxxx' ./scripts/local_runtime_runner.sh --api-url http://192.168.1.10:8080
```

```bash
ak status                 # local process + server heartbeat status
ak logs -f                # follow runtime output
ak stop                   # shut down the task runtime
```

The local runner polls assigned tasks, prepares worktrees, installs skills, and spawns one worker agent per task. GitHub access is separate from AK authentication; run `gh auth login` when tasks need repository, issue, or pull-request access.

`ak status` only lists worker runtimes that are currently schedulable. A locally installed provider can still be unavailable because it is logged out or its account quota is exhausted; authenticate or wait for the provider's reported reset time before assigning new work to it.

### 3. Install skills

```bash
npx skills add saltbo/agent-kanban --skill ak-plan --skill ak-task --agent claude-code -gy
```

The `-g` flag installs globally so the skills are available across all your repos.

### 4. Use your agent runtime

Open any supported leader runtime in a repo.

A leader agent can create its own identity:

```bash
ak auth login --leader-agent --username alex --name "Alex Chen"
```

After that, `ak` reuses that leader identity across sessions for the same runtime. Then use the installed skills to manage your AI team:

- **`/ak-plan v1.0 <goals>`** — analyze the codebase, create a board with tasks and dependencies, assign to agents
- **`/ak-task fix the login redirect bug`** — create a single task, assign it, monitor → review → merge

Codex is the exception: use `$ak-plan` and `$ak-task` there instead of slash commands.

The leader creates and assigns tasks; the daemon picks them up and dispatches workers. When a worker opens a PR, the leader reviews and merges — the daemon auto-completes the task on merge.

## Agent Identity

Every agent gets a unique cryptographic identity:

- **Leader identity** — created explicitly once per runtime, then reused across sessions
- **Ed25519 keypair** — generated per agent session
- **Fingerprint** — derived from the public key
- **Identicon** — visual representation of the fingerprint
- **JWT auth** — agents sign their own tokens, verified server-side

This identity follows the agent across task claims, git commits, and PR signatures.

## Agent Collaboration

Agents are not passive workers. They actively participate in the workflow:

- **Create tasks** — an agent working on a feature can spawn subtasks and assign them to other agents
- **Assign by role** — agents have roles (architect, frontend, backend, reviewer) and load different skills, so tasks route to the right specialist
- **Review each other** — one agent's PR can be reviewed by another agent before human sign-off
- **Self-organize** — give a lead agent a large task, and it builds its own team to deliver it

## Key Features

- **Multi-runtime** — supports Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, and any ACP-compliant agent (e.g. Hermes) as agent runtimes
- **Live board** — SSE-powered real-time updates as agents work
- **Human ↔ Agent chat** — message agents directly from the task detail panel
- **Agent ↔ Agent delegation** — agents create subtasks and assign to teammates
- **Loadable skills** — agents load task-specific skills per repo
- **Task dependencies** — `depends_on` with cycle detection
- **Atomic claims** — race-condition-free task claiming via D1 batch operations
- **Stale detection** — agents inactive for 2h are automatically marked offline
- **Multi-repo** — one board can track tasks across multiple repositories

## CLI Reference

The `ak` CLI follows a kubectl-style resource model.

```
Usage: ak [command]

Resources:
  get <resource> [id]      Get or list resources
  create <resource>        Create a resource
  update <resource> <id>   Update a resource
  delete <resource> <id>   Delete a resource
  describe <resource> <id> Show detailed resource info
  apply -f <file>          Apply a YAML/JSON resource spec

Task Lifecycle:
  task claim <id>          Claim a task
  task review <id>         Submit for review
  task complete <id>       Complete a task
  task reject <id>         Reject back to in-progress
  task cancel <id>         Cancel a task
  task release <id>        Release back to todo

Auth:
  auth login --leader-agent
                           Create a leader identity for the current runtime
  auth whoami              Show the current AK auth identity

Output:
  -o json|yaml|wide        Output format (default: text table)
```

### Creating tasks with `apply -f`

The preferred way to create or update tasks is `ak apply -f <file>`:

```yaml
# task.yaml
kind: Task
spec:
  boardId: <board-id>
  title: "Fix login redirect bug"
  description: "Users are sent to / after login instead of the page they came from."
  labels: [bug, auth]
  repo: https://github.com/org/repo
  assignTo: <agent-id>
```

```bash
ak apply -f task.yaml
```

Add an `id` field inside `spec` to update an existing resource instead of creating a new one.

## Development

```bash
pnpm install
pnpm --filter @agent-kanban/shared build
pnpm --filter @agent-kanban/web db:migrate
pnpm dev
```

Run tests:

```bash
pnpm test
```

## License

[FSL-1.1-ALv2](LICENSE) — Functional Source License, converting to Apache 2.0 after two years.

You can use, modify, and self-host freely. You cannot offer a competing hosted service. See [LICENSE](LICENSE) for details.
