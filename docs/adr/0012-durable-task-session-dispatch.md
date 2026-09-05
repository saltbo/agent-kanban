# 0012: Direct Task Session dispatch

Status: Proposed — production wiring is incomplete.

## Scope and ownership

Issue #269 moves AK Task startup from Inbox Triggers to Enbor Session creation.
AK owns Task eligibility and the exact requested Session association. Enbor
owns execution and repository preparation; the Agent uses its existing
Realmroot identity to Claim and perform work. No new Agent identity subsystem
is required.

The user explicitly deferred delayed scheduling. Keep `scheduledAt` readable,
but reject non-null create and update writes with 422. Existing scheduled Tasks
are excluded from automatic startup; clearing their schedule is explicit.
Do not implement time-based dispatch or introduce authorization storage for it.

## Task-owned state

Task and its current Session are represented together. Store the exact Session
ID at `metadata.annotations["agent-kanban.dev/session-id"]`. Store the current
launch's immutable request, idempotency key, credential references, and recovery
state in the Task's server-owned `metadata["agent-kanban.dev/launch"]` object.
There is no separate launch table or new Task column. Client writes cannot
forge or erase the reserved execution fields.

Assignment commits its action and launch metadata in one D1 batch. Session
creation uses one stable idempotency key and the persisted request. A lost
response is recovered by replaying that same request, never by finding the
latest Session for an Agent. Concurrent writes compare the stored launch
snapshot; changes advance the Task version while preserving unrelated metadata.

The requested Session annotation is separate from the immutable signed runtime
provenance stored at Claim. Claim validates the exact recorded Session and
current assignment and dependency eligibility. Assignment or Session creation
alone does not set the Task to `in_progress`. The Claim handler reconciles an early Claim by replaying the saved request
through token exchange before performing the Claim transaction. This race has
local D1 and HTTP coverage; production activation remains unverified.

Unstarted assignments may replace their pending launch metadata. Once remote
preparation begins, settle its resources before replacing the state. Close the
exact Session before revoking its bootstrap credential. Do not delete the Task
before cleanup completes, since its metadata owns the recovery information.
Review continuation must preserve the existing Session and workspace.

## Authorization and workspace

Reuse AK's existing token-exchange integration for Enbor calls, with the required
Session and Vault scope mappings. Retire Inbox's M2M notification path with the
old startup path. Do not reuse M2M as a substitute for delegated Enbor authority.

Repository preparation uses the connected GitHub App's temporary token,
restricted to one verified repository and read-only contents. Pass it through
an Enbor Vault credential and Git volume secretRef. Task metadata contains
references and expiry only; never raw tokens. Subsequent Agent GitHub work
uses its own Realmroot identity.

## Delivery

This record proposes narrowly superseding the Inbox startup and continuation
parts of ADR 0009 while retaining the signed Claim boundary of ADR 0008.
Accepted records remain unchanged until delivery is complete.

The Enbor idempotency prerequisite is deployed. AK's direct request wiring,
repository credential lifecycle, review continuation,
old-trigger retirement, and production acceptance remain incomplete. Do not
activate this partial implementation. Full acceptance is a real Task assignment,
execution, Claim, review, completion, and cleanup, with exact Session evidence.
See [delivery evidence](../operations/issue-269-verification.md).
