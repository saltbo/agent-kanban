---
status: DRAFT
created: 2026-04-19
---

# Event Bus Migration — Unified WebSocket Channel

Replace today's three-transport mess (daemon HTTP poll + Worker-level SSE +
single-instance TunnelRelay WebSocket) with one thing: **a per-board Durable
Object that accepts WebSocket subscriptions and fans out every event — task
lifecycle, agent subprocess I/O, human chat — over a single typed protocol.**

## Thesis

Every cross-party signal in this product is "a thing happened on board X, tell
whoever is watching." We have three transports because features accreted one at
a time, not because the problem needs three. One transport, scoped by board, is
sufficient and is the direction Cloudflare has explicitly optimized for.

## Context

Today (verified 2026-04-19 from CF GraphQL analytics):

- 5 daemons generate **~100K Worker requests/day**, **~80% of which are idle
  `listTasks` + `listRepositories` poll calls** returning "nothing new."
- `apps/web/server/sse.ts` is Worker-level SSE that polls D1 every 2s for 25s
  per browser connection. Each poll's average scan is ~44 rows → this is the
  dominant component of the **7M D1 rows read/day** from the prod DB.
- `apps/web/server/tunnelRelay.ts` is a single shared Durable Object that
  already does pub/sub — just limited to agent subprocess I/O + human chat.
- Server-side stale detection (`detectStaleMachines`, `detectAndReleaseStale`)
  is hot-pathed on every read, amplifying writes.

Extrapolated daily CF cost at current scale: **$0.85**. Extrapolated at 100
daemons with same architecture: **~$17/day**. Not a crisis, but architecturally
an order of magnitude off.

The goal is not "save pennies today." The goal is: when Show HN lands and 50
users try it in an evening, nothing lights on fire, and the design still makes
sense at 1000 users.

## Current Architecture

```
┌──────────┐                 ┌─────────────────────────────┐
│  Daemon  │─── HTTP poll ──▶│  Hono API (Worker)          │
│          │    every 10s    │  ├─ listTasks               │
│          │◀── response ────│  ├─ listRepositories        │
│          │                 │  └─ writes to D1            │
│          │─── WS ─────────▶│                             │
│          │  (TunnelRelay)  │  ┌─────────────────────┐   │
│          │                 │  │ TunnelRelay DO      │   │
│          │                 │  │ (single, shared)    │   │
│          │                 │  │ - agent:event       │   │
│          │                 │  │ - human:message     │   │
│          │                 │  └─────────────────────┘   │
│          │                 │                             │
│          │                 │  D1 ◀── writes              │
└──────────┘                 └─────────────────────────────┘
                                       ▲
                                       │ SSE poll (2s × 25s)
                                       │ reads task_actions + messages
┌──────────┐                           │
│ Browser  │───────── HTTP ────────────┘
│          │───── SSE subscribe ───────▶
│          │───────── WS ──────────────▶ (via TunnelRelay for chat)
└──────────┘
```

Three transports, three reconnection stories, three places to add a new event
type.

## Target Architecture

```
                           ┌────────────────────────────────────┐
                           │  EventRelay DO (per board)         │
                           │                                    │
┌──────────┐               │  State:                            │
│  Daemon  │─── WS ───────▶│  - subscribers: {wsId → filter}    │
│          │  one per      │  - ring buffer: last 200 events    │
│          │  owner/board  │  - nsMap for DO duration attrib.   │
└──────────┘               │                                    │
                           │  Protocol:                         │
┌──────────┐               │  ← subscribe {board, since?}       │
│ Browser  │─── WS ───────▶│  → replay …                        │
│          │  one per      │  → live events                     │
│          │  active board │  ← agent:input / human:message     │
└──────────┘               │  → ping/pong (hibernation-friendly)│
                           └────────────┬───────────────────────┘
                                        │ publish(event)
                                        ▲
                            ┌───────────┴────────────┐
                            │                        │
                       ┌────┴─────┐           ┌──────┴────────┐
                       │ API write│           │ Cron: stale,  │
                       │  → D1    │           │ reconcile,    │
                       │  → DO.pub│           │ cleanup       │
                       └──────────┘           └───────────────┘
```

HTTP stays for: initial state hydration (`GET /api/boards/:id`), all writes
(REST mutations), auth, file upload. These are **actions**, not **events** —
request/response is the right shape.

## Design Decisions

### DD-1: WebSocket + Hibernation API as the only live channel

**Why**: Cloudflare has specifically optimized WS + DO for this use case. An
idle WebSocket on a DO with Hibernation enabled incurs near-zero billable
duration. A DO carrying 100 idle subscribers costs pennies per month at rest
and only bills on actual event fire.

**Alternatives considered**:

- **SSE in the DO**: works technically, but DO does not hibernate while an SSE
  response is open. Cost is ~10³ higher per idle connection than WS. Ruled out.
- **SSE at Worker level (current)**: stateless, so must poll D1 for events.
  This is the root cause of the D1 read amplification we're trying to kill.
  Ruled out.
- **HTTP long-poll**: same cost profile as current polling. Ruled out.

### DD-2: Why not CF Queues

CF Queues is not an alternative; it is a different primitive for a different
problem.

| | Queues | This event bus |
|---|---|---|
| Consumer | pull-based Worker | push-based live client (browser/daemon) |
| Latency | seconds (batched) | sub-second |
| Subscriber model | topic-fixed | dynamic per-board |
| Delivery | at-least-once + retry | at-most-once + client replays via `since` |

Queue's consumer is itself a Worker — it cannot reach a browser's WebSocket.
Using Queue in the pipeline ends up as `API → Queue → Worker consumer → DO →
WS`, which is strictly worse than `API → DO → WS`.

**Where Queue fits later**: async side-effects of events — webhooks, email
notifications, third-party integrations, analytics aggregation. When those
requirements appear, pipe them off the DO's publish site into a Queue. That
is out of scope for this migration.

### DD-3: Per-board DO, not a single shared one

The current TunnelRelay is one DO for the whole account. It works because
traffic is small. At scale it becomes a single region's bottleneck and a
single fault domain.

A DO per board:
- **Isolation**: one board's load can't starve another's
- **Locality**: CF places the DO geographically near first-requester
- **Tenancy**: board is already the product's natural scoping unit
- **Lifecycle**: unused boards hibernate cleanly; no shared state to garbage collect

The one shared concern — agent subprocess I/O that spans a whole daemon
session — maps to "the board the session's task belongs to," so it fits the
per-board shard cleanly.

### DD-4: Event ordering via single-writer DO

All publishes for a given board go through the same DO. DOs execute single-
threaded, so in-board event order is serialized at ingress. Cross-board
ordering is not a concern — no consumer cares.

### DD-5: Replay via ring buffer + D1 fallback

Clients reconnecting send `{subscribe: boardId, since: lastEventId}`:

1. DO checks its in-memory ring buffer (last 200 events per board)
2. If `since` is still in the buffer → replay from there
3. If not → query `task_actions` + `messages` for events after `since`, stream
   them, then switch to live

This is the same semantic SSE's `Last-Event-ID` gives browsers for free; we
just implement it ourselves over WS. The current SSE code already resolves
`Last-Event-ID` → timestamp via a UNION query — reuse that logic.

### DD-6: Daemon keeps a slow reconcile poll as safety net

Pure push is fragile: DO restarts, client network hiccups, unknown bugs. The
daemon keeps a **120s reconcile poll** as insurance — it compares its local
"active tasks" set against the server and fixes any divergence. Not the
primary path; a safety net. Reconcile poll is also the fallback if the WS
connection can't establish (corporate firewall, etc.).

## Event Protocol

Typed, versioned, JSON-encoded. All messages carry `{v, type, id, ts}` +
payload.

### Client → DO

```ts
// Subscribe to a board. If `since` is provided, DO replays any events with
// id > since before switching to live mode.
{ v: 1, type: "subscribe", board: "brd_xxx", since?: "evt_yyy" }

{ v: 1, type: "unsubscribe", board: "brd_xxx" }

// Bidirectional for chat / agent control
{ v: 1, type: "human:message", session: "ses_xxx", text: "..." }
{ v: 1, type: "agent:input", session: "ses_xxx", data: "..." }

// Liveness
{ v: 1, type: "ping" }
```

### DO → Client

```ts
{ v: 1, type: "subscribed", board, replayCount }
{ v: 1, type: "replay_done" }

// Task lifecycle (derived from task_actions writes)
{ v: 1, type: "task:created",  id, ts, task: {...} }
{ v: 1, type: "task:claimed",  id, ts, taskId, agentId }
{ v: 1, type: "task:assigned", id, ts, taskId, agentId }
{ v: 1, type: "task:in_review",id, ts, taskId, prUrl }
{ v: 1, type: "task:rejected", id, ts, taskId, reason }
{ v: 1, type: "task:done",     id, ts, taskId }
{ v: 1, type: "task:cancelled",id, ts, taskId }

// Action log + chat
{ v: 1, type: "action:added",  id, ts, action: {...} }
{ v: 1, type: "message:added", id, ts, message: {...} }

// Live I/O (existing TunnelRelay semantics, carried over)
{ v: 1, type: "agent:event",   session, data: "..." }
{ v: 1, type: "agent:status",  session, status: "..." }

// Daemon coordination
{ v: 1, type: "daemon:connected",    machineId }
{ v: 1, type: "daemon:disconnected", machineId }

{ v: 1, type: "pong" }
```

All `task:*` and `action:*` events have `id` equal to the originating
`task_actions.id`. All `message:*` events use `messages.id`. This makes the
`since` cursor unambiguous across event classes.

## Migration Plan

Six phases. Every phase ends in a green build and can be released on its own;
any phase can roll back without touching the downstream ones.

### P1 — TunnelRelay → EventRelay (1 day)

- Generalize `tunnelRelay.ts` into `eventRelay.ts`
- Wire it as per-board (namespace by `board:${boardId}`), not a single instance
- Keep all current message types working: no change in semantics
- Add `subscribe` / `unsubscribe` / `replay` skeleton (not yet used)
- Add in-memory ring buffer (capacity 200)

**Done when**: existing agent chat + live I/O works identically. No observable
change to client.

**Rollback**: revert to single-instance TunnelRelay.

### P2 — Publish task events from API writes (1 day)

- Each API write that already inserts `task_actions` or `messages` gets a
  `eventRelay.publish(boardId, event)` call after the D1 write commits
- Publishes are fire-and-forget (`ctx.waitUntil`) — API latency is unaffected
- No client changes yet; the events are emitted but nobody subscribes

**Done when**: running a manual WS client can see every `task:*` /
`action:*` / `message:*` event flow through for a board.

**Rollback**: remove publish calls; event-emission is purely additive.

### P3 — Browser subscribes in parallel with SSE (2 days)

- Browser opens WS subscription alongside existing SSE
- For one release cycle, the UI ignores WS events but logs them
- Validate: for every SSE event, a matching WS event arrived within 500ms

**Done when**: A/B log shows 99%+ parity over a 24h window. Discrepancies
investigated and closed.

**Rollback**: drop WS client code; SSE unaffected.

### P4 — Browser switches to WS, SSE removed (1 day)

- UI consumes WS events as the source of truth
- `apps/web/server/sse.ts` + client `EventSource` usage deleted
- The D1 `task_actions` + `messages` polling inside SSE disappears

**Done when**: build green, E2E passes. CF analytics shows D1 rowsRead drop
noticeably (expect 50-80% reduction on prod DB).

**Rollback**: revert this commit; SSE restored.

### P5 — Daemon subscribes, poll degrades to reconcile (2 days)

- Daemon connects a WS session per machine, subscribed to its owner's boards
- Events it reacts to: `task:assigned` (self), `task:cancelled`, `task:rejected`
- `loop.ts` poll interval raised from 10s → 120s for reconcile only
- `dispatchTasks` moved off per-tick path, runs on:
  1. Receipt of `task:new` or `task:assigned` event, or
  2. 120s reconcile tick (safety)

**Done when**: daemon can process a newly-assigned task within 2s (was up to
10s). CF analytics shows daemon Worker requests drop ~10× (from 17K to <2K per
daemon per day).

**Rollback**: revert to 10s poll. WS is additive; no data corruption risk.

### P6 — Tune, monitor, polish (1 day)

- Reconcile interval: 120s → 300s after one week of clean operation
- Metrics: WS connection count, event throughput, replay rate, DO duration
- Document for contributors how to add a new event type

**Done when**: one-week production soak with no regressions. Design doc moves
from DRAFT to ACTIVE.

## Open Questions

- **Auth**: WebSocket upgrade is authenticated via `?token=` query parameter
  today. Keep that? Or move to a short-lived ticket exchanged over HTTPS
  first? Current pattern is fine for MVP; revisit before public beta.
- **Cross-board subscription**: daemon needs events for multiple boards (one
  per owner). Single WS with multi-subscribe, or one WS per board? Lean
  toward single WS with multi-subscribe — avoid N connections per daemon.
- **Ring buffer capacity**: 200 feels right for boards doing <10 events/min.
  Boards doing 100 events/min would fall through to D1 replay in 2 minutes of
  offline. Revisit if real traffic warrants it.
- **DO region migration**: first-request location pins the DO's region. If
  the first request is a cron job in Europe but all real users are in Asia,
  we eat the latency. Mitigation: the first subscribe from a real client
  should come before any cron publish. Not urgent.

## Non-Goals

- Replacing REST mutations with RPC over WS. HTTP writes stay HTTP.
- Building a generic pub/sub service. This is scoped to this product's events.
- Supporting third-party subscribers. Public webhooks belong in a future
  Queue-backed system, not here.

## Out of Scope (explicitly deferred)

- **Server-side stale detection off hot paths**: tracked as P0 in the current
  daemon efficiency work. Independent of this migration; do it in parallel.
- **Unbounded query LIMIT hardening** (`taskRepo.ts`, `messageRepo.ts`): also
  independent. Fold into general repo audit.
- **Queue-based async side effects** (webhooks, emails): revisit when a real
  integration need appears.
