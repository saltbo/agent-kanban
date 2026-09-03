# 0008: Observe only the Session proven by Task Claim

Status: accepted

## Context

The board must display work performed for a Task without owning Session
execution. Guessing the latest Session by Agent or accepting a caller-provided
URL could expose unrelated work or cross a tenant boundary.

## Decision

Task Claim copies `runtime` and the canonical Agency `session_id` only from
Realmroot Remote's verified Agent binding into an immutable Task observation
binding. Claim accepts no client-authored Session identifier or socket URL.

For an authenticated human viewer, AK uses delegated Agency authority and the
tenant's mapped Project to read that exact Session. It verifies the returned
Session and Project identities and relays the canonical event socket read-only.
The relay accepts history-backfill frames and rejects runtime commands.

## Consequences

Task work is observable without an AK Session entity or reverse dependency in
Agency. Missing, mismatched, or unavailable Agency data fails closed. Agents
cannot use the observation endpoints to control a Session.
