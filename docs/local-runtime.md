# Fully Local Runtime

Agent Kanban can run its web/API service and task execution plane on one local
machine. This mode does not require an AMA deployment, Cloudflare account,
Cloudflare Sandbox, hosted D1, Durable Objects, or OIDC provider.

## Components

- `scripts/service_runner.sh` runs the React UI, Hono API, local Miniflare D1,
  and local WebSocket relay on the machine.
- `scripts/local_runtime_runner.sh` builds the CLI, registers the machine with
  the local API, sends heartbeats, polls assigned tasks, and starts installed
  agent CLIs such as Codex or Claude Code.
- Better Auth user sessions and machine API keys are stored in the local D1
  database. Worker sessions use local Ed25519 identities.
- GitHub access is independent. Authenticate `gh` locally when repository,
  issue, or pull-request operations are needed.

## Repeatable Setup

Start the local web/API service in terminal one:

```bash
./scripts/service_runner.sh
```

Open `http://127.0.0.1:6265`, sign in with email/password, verify through the
link printed by the service, and create a machine API key in account settings.

Authenticate the local GitHub CLI if repository work is required:

```bash
gh auth login
gh auth status
```

Start the machine runtime in terminal two. Supplying the key through the
environment keeps it out of shell argument history:

```bash
AK_API_KEY='ak_xxx' ./scripts/local_runtime_runner.sh
```

The key is saved in the local `ak` configuration. Later starts can reuse it:

```bash
./scripts/local_runtime_runner.sh --skip-install
./scripts/local_runtime_runner.sh --restart --skip-install
```

Useful checks:

```bash
ak status
ak logs -f
```

Create or assign a task to a worker whose runtime is reported as ready by the
machine. The local daemon claims the task, creates an Ed25519-authenticated
worker session, prepares a worktree, and starts the matching local agent CLI.

## Claude Code Authentication Modes

The `claude` runtime accepts either of Claude Code's authentication modes:

- **OAuth login** (`claude` signed in interactively; token in the system
  keychain or `~/.claude/.credentials.json`). AK additionally probes the OAuth
  usage API and pauses dispatch while a usage window (for example the 5-hour
  window) is exhausted, resuming automatically after `resets_at`.
- **Custom endpoint** (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, usually
  with `ANTHROPIC_BASE_URL`, for relays/gateways/proxies). Variables can be set
  in the daemon's environment or in the `env` block of `~/.claude/settings.json`
  (which the spawned CLI applies itself). In this mode the runtime is reported
  ready based on credential presence; usage windows do not apply, and mid-run
  rate limits are still handled through `turn.rate_limit` events.

Custom-endpoint credentials take precedence over the OAuth login, matching
Claude Code's own behavior.

## Optional AMA Compatibility

`ak start --mode ama` remains available for installations that explicitly use
an AMA control plane. Fully local installations should use the default
`--mode local` and leave all `AMA_*` variables unset.
