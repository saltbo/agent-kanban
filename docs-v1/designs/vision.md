# Agent Kanban — Product Vision

Created: 2026-03-20
Status: ACTIVE

## Core Principle

Agent Kanban is an **agent coordination layer**, not an agent itself. We never build our own agent runtime. We integrate with existing agent CLIs (Claude Code, Codex CLI, Gemini CLI, etc.) and provide them with: task awareness, identity, communication channels, and dispatch capabilities.

## Evolution Path

```
v1:  Build & complete foundational capabilities
     Kanban core, agent identity, dependencies, projects.
     Machine daemon — auto-claim todo tasks, spawn agent per task.
     `ak link` binds local repos to projects.
     Agent behavior stream (pass-through, no storage on platform).
     Chat with agent via Machine relay.

v2:  Role & Skill system for agent specialization
     Agent = generic runtime + loaded Skills = Role.
     Machine daemon filters claimable tasks by installed roles.
     Built-in roles + user-defined roles.

v3:  Open agent marketplace (vision)
     Anyone registers Machines. Multiple agents compete per task.
     Scoring & reputation system. Best result wins.
     Cost borne by agent operators — market surfaces quality.
```

## v1 — Agent Interaction on Web

### Agent Identity

Each agent that interacts with the system has a persistent identity:
- Name (user-assigned or auto-generated)
- Avatar/icon (distinguishes agents visually)
- Activity history (all tasks claimed, logs, completions)

Early iterations already had `assigned_to` and `created_by` as string fields. v1 elevates this to a first-class entity with the `agents` table, auto-registration, and status lifecycle.

### Machine Daemon

A Machine is a compute environment where agents can run (developer laptop, cloud VM, CI runner, sandbox). The Machine daemon is the bridge between the platform and agent CLIs — it auto-claims tasks, spawns agents, and relays I/O.

**Startup:**

```
$ ak start
  → starts persistent daemon process
  → registers Machine with platform (name, status)
  → heartbeat keeps registration alive
  → polls for unblocked todo tasks
  → claims task → spawns agent CLI in linked repo directory
  → holds stdin/stdout pipes to each agent process
```

**Configuration:**

```yaml
# ~/.agent-kanban/config.yaml
max_concurrent: 3          # max simultaneous agents
agent_cli: claude-code     # which CLI to spawn
poll_interval: 10s         # how often to check for new tasks
projects:                  # only claim tasks from these projects (empty = all)
  - agent-kanban
  - my-other-project
```

**Task lifecycle inside the daemon:**

1. Poll `GET /api/tasks?status=todo` → filter unblocked, filter by linked projects
2. If current agents < `max_concurrent`, pick highest priority unblocked task
3. `POST /api/tasks/:id/claim` → atomically claim
4. Look up `task.project_id` → find local linked repo directory
5. Spawn agent CLI in that directory with task context (title, description, input)
6. Hold stdin/stdout pipes → relay to platform when Web UI is watching
7. Agent completes (process exit or explicit `ak task complete`) → `POST /complete`
8. Agent crashes → `POST /release`, log error
9. Free concurrency slot → back to step 1

**Scheduling is decentralized.** Each Machine daemon decides what to claim based on its local config (project filter, concurrency limit). Multiple Machines compete for claims — `db.batch()` atomicity ensures first-to-claim wins. No central orchestrator needed.

### Agent Behavior Data

The platform does **not** store agent behavior data (stdout, tool use, thinking). Behavior data stays on the Machine locally, managed by the agent CLI itself (e.g., Claude Code session files).

```
Platform stores (lightweight structured events):
  task_logs: claimed, commented, completed, moved
  → existing mechanism, unchanged

Platform stores (persistent):
  messages: human ↔ agent chat messages
  → agent_id field = agent CLI session ID (e.g., Claude Code session ID)

Machine local storage (agent CLI's own):
  Claude Code session data, stdout history
  → not managed by platform
  → user can review via: claude --resume <agent_id>
```

| Direction | Data | Platform stores? |
|-----------|------|-----------------|
| Up (agent → web) | chat replies | Yes — messages table (role='agent') |
| Down (web → agent) | user chat messages | Yes — messages table (role='human') |
| Agent behavior | thinking, tool use, output | No — stays on Machine, resume via session ID |
| Structured events | claimed, completed, commented | Yes — task_logs table |

Key constraint: we don't control the agent's output. We consume it. The `agent_id` in the messages table doubles as the agent CLI session ID — it's used both for message routing (daemon knows which process to pipe stdin to) and for session resume (`claude --resume <agent_id>`).

### Chat with Agent

Chat is a bidirectional message channel through the Machine daemon, using D1 as the message bus:

- **Down (web → agent):** User sends message in Web UI → POST to platform → stored in `messages` (role='human') → daemon polls for new messages → pipes to agent stdin
- **Up (agent → web):** Agent responds via stdout → daemon captures → POST to platform → stored in `messages` (role='agent') → Web UI reads via SSE

**Data model:**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,  -- = agent CLI session ID
  role TEXT NOT NULL,       -- 'human' | 'agent'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

**Idle agents:** When a task completes, the agent CLI process may exit. The `agent_id` (session ID) is preserved in the messages table. If the user wants to review what the agent did, they can `claude --resume <agent_id>` on the Machine to see the full session history. If the user wants to chat with a completed task's agent, the Machine can resume the session.

**When the daemon claims a task:**
- `task.project_id` → look up local links → if found, use the local repo directory
- If no local link exists, query `project_resources` for `git_repo` entries → auto-clone to `~/.agent-kanban/workspaces/` → spawn agent there
- If the project has multiple repos (local or remote), the agent works in the primary one and can access others

## v2 — Role & Skill System

### The Insight

Claude Code (or any agent CLI) is a **generic agent**. It can do anything, but it doesn't know about your specific workflows, tools, or conventions until you tell it. Skills are the mechanism for specialization.

### Agent Roles

A Role = a named configuration of:
- Skills (loaded into the agent's context)
- System instructions (behavior guidelines)
- Tool access (what the agent can use)
- Constraints (what the agent should NOT do)

### Built-in Roles (examples)

| Role | Skills | Purpose |
|------|--------|---------|
| Code Reviewer | review, investigate | Reviews PRs, finds bugs |
| Feature Builder | plan-eng-review, qa | Implements features end-to-end |
| Bug Fixer | investigate, qa | Debugs and fixes issues |
| Docs Writer | document-release | Keeps documentation current |
| DevOps | ship, careful | Handles deployment and infra |

### User-Defined Roles

Users can create custom roles:
1. Name the role
2. Select skills to load
3. Optionally write custom system instructions
4. Save → role is available for assignment

### Role-Task Matching

The Machine daemon filters claimable tasks by its installed roles. Two matching modes:

**Mode A: Task specifies required role (job posting)**
Human creates task with a `required_role` tag. Only Machines with that role installed can claim it.

**Mode B: Machine self-selects role (smart contractor)**
Machine daemon reads task description → matches against locally installed roles → claims with the best-fit role. The matching logic lives in the daemon, not in the platform.

**Impact on v1 daemon:** In v1 (no roles), the daemon claims any unblocked todo task for its linked projects. In v2, the daemon additionally checks whether it has a matching role before claiming.

### Two-Layer Model

```
Role Layer (capability definition)
  ├── Built-in roles (pre-loaded skills)
  ├── User-defined roles (custom skill combinations)
  └── Finite set — like job descriptions

Agent Instance Layer (execution)
  ├── Each spawned CLI process = one agent instance
  ├── Ephemeral — spawned on claim, done when task completes
  ├── Gets assigned a role by the daemon
  └── Unlimited instances — like contractors
```

## Identity & Auth Architecture

### v1 (current): Machine-Level Auth + Explicit Leader Identity

```
api_keys (represents a Machine, not an Agent)
  id, key_hash, name (machine name), created_at

agents
  id, name, username, runtime, kind, created_at

tasks
  assigned_to → agents.id (not api_key name)
  created_by  → agents.id or "human"
```

One API key per Machine. One Machine can have many concurrent agent instances. Leader identities are created explicitly once per runtime, then reused across sessions. If the local identity cache is missing, the CLI restores the unique server-side leader for that runtime.

### v2: Add Roles

```
roles (new table)
  id, name, description, skills (JSON), system_prompt, created_by, created_at

agents (add role_id)
  role_id → roles.id (which role this instance was spawned with)
```

## Project = Resource Container

A Project is an **organizational unit that groups related resources**. It is NOT tied 1:1 to a git repository. A Project can contain multiple resources of different types.

### Why not Project = Repo?

The product should not be limited to coding. A self-media creator might use Agent Kanban to manage content workflows — their Project has no git repos but might have media libraries, publishing platform accounts, etc. Even for developers, a single project often spans multiple repos, databases, and infrastructure.

### Data Model

```
projects
  id, name, description, created_at

project_resources (multiple per project, multiple types)
  id, project_id, type, name, uri, config (JSON)

tasks
  project_id → projects.id
```

Resource types (extensible):
- `git_repo`: code repository (uri = clone URL)
- `credentials`: third-party platform accounts, API keys, tokens
- `database`: structured data (uri = connection string)
- `storage`: file/media storage (uri = S3/R2/OSS bucket)
- `document`: knowledge base, specs, design docs
- `data_feed`: real-time data source (uri = API endpoint)
- User-defined types

Each type can have multiple instances per project. A game dev project might have 3 git repos, 2 databases, and 5 asset storage buckets.

### Industry Examples

**Game Development — "星际殖民"**
```
Resources:
  git_repo:    game-client, game-server, shared-proto
  storage:     art-assets, sound-library
  database:    player-db, config-tables
  credentials: Steam Developer, App Store Connect
  document:    game-design-doc
```

**Self-Media — "科技频道"**
```
Resources:
  storage:     media-assets (photos, videos, audio)
  credentials: YouTube, TikTok, WeChat Official Account
  document:    content-calendar, brand-guidelines
```

**Finance — "量化策略 Alpha-7"**
```
Resources:
  git_repo:    strategy-code, backtest-framework
  database:    market-history, trade-records
  data_feed:   realtime-quotes (exchange API)
  credentials: exchange API keys
  document:    risk-rules, compliance-requirements
```

**Real Estate Agency — "翡翠湾楼盘"**
```
Resources:
  database:    property-listings, client-needs
  storage:     property-photos, floor-plans
  credentials: 贝壳/链家, WeChat groups
  document:    contract-templates
```

### Task → Resource: No Hard Binding

**Design principle: Task only associates with Project. Task does NOT link to specific Resources. Resource selection is the Agent's decision, not a data model constraint.**

When an agent is dispatched to work on a task:
1. Look up `task.project_id` → Project
2. Query `project_resources` for that Project → get all available resources
3. Agent reads task description + available resources → decides which to use
4. If the task spans multiple resources (e.g., update API contract across client + server repos), the agent works across them

This mirrors how human developers work: a Jira ticket says "fix the auth bug in Project X." It doesn't say "go to the user-service repo." The developer figures that out. Agents should too — that intelligence belongs in the Agent's Skill, not in the database schema.

## v3 (Vision) — Open Agent Marketplace

### The Model

Agent Kanban evolves from a personal coordination tool to an open task marketplace. Anyone can register their Machine and compete for tasks.

```
Task publisher creates task → sets max_concurrent (e.g. 3)
  → up to 3 agents from different Machines claim simultaneously
  → all work in parallel on the same task
  → publisher reviews results → selects the best one
  → winning agent gets score points, losing agents get participation credit
```

### Why Competitive Execution

Agent output quality is unstable. Some operators invest in tuning their agents (custom skills, system prompts, workflow optimizations). Competitive execution lets the market surface the best-tuned agents through results, not promises.

**Cost model:** Each agent operator bears their own compute cost (API tokens, machine resources). Accepting a task is a voluntary investment — operators bet their tuning gives them an edge. Similar to miners spending electricity: the cost is on the provider, the reward goes to the best result.

### Scoring & Reputation

- Task completed and selected → score up (major)
- Task completed but not selected → participation credit (minor)
- Task failed / timed out → score down
- Claim priority influenced by score — higher-scored agents get first chance at high-value tasks

### Key Differences from v1/v2

| Aspect | v1/v2 (Personal) | v3 (Marketplace) |
|--------|------------------|-------------------|
| Who registers Machines | You, on your own computers | Anyone |
| Who pays for agent compute | You | Each agent operator |
| Tasks claimed by | One agent (first wins) | Multiple agents (up to N) |
| Quality assurance | Trust your own agent | Competition + review |
| Scoring | Not needed | Core mechanism |

### Open Questions (deferred)

- Payment/reward system beyond reputation scores?
- How does the publisher review multiple results efficiently? AI-assisted diff?
- Trust & abuse prevention for open registration?
- Task pricing / bounty model?

## Key Design Constraints

1. **We don't build execution agents.** The Machine daemon coordinates; the agents that do the actual work are external CLIs (Claude Code, Codex CLI, Gemini CLI, etc.).
2. **CLI is always the primary interface for agents.** Web UI extends but never replaces CLI.
3. **Each version's data model must be forward-compatible.** v1 fields evolve into v2 entities without breaking changes.
4. **Scheduling is decentralized.** Each Machine daemon decides what to claim based on local config (project filter, concurrency limit, roles in v2). No central orchestrator. Multiple Machines compete for claims — atomic claim ensures first wins.
5. **Platform is a coordination layer, not a data warehouse.** Structured task events are stored. Agent behavior data is pass-through only — never stored on the platform.
