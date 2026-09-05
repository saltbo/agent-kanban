# Session observation

A successful Task Claim persists the runtime and canonical Agency Session
identity from the verified Realmroot Agent binding. That immutable Claim binding
remains the legacy Task work observation relationship.

The direct-launch implementation also records the exact Enbor creation response
in `metadata.annotations["agent-kanban.dev/session-id"]` before Claim. This launch record is a dispatch and
cleanup receipt and allows exact Session observation before Claim; it does not
prove that the Agent has claimed the Task. For Tasks
with a current launch, the Claim transaction requires that launch's recorded
Session and rechecks assignment, absence of a schedule, and dependencies. Historical Tasks
without a launch retain their signed-Session Claim path. Existing active Claims
retain their immutable observation binding.

When a Claim arrives before the Session creation response is recorded, the
Claim handler replays the persisted request and idempotency key using the
caller's delegated `sessions:write` authority. It records only the Session id
returned by Enbor, then performs the normal signed-provenance Claim transaction.
This handles either response writer winning and cancellation during replay.
Production scope mapping and full direct-dispatch activation remain unverified.

When a human opens Task work activity, AK:

1. resolves the caller's tenant and stored Agency Project binding;
2. obtains delegated Agency read authority;
3. reads the exact stored Session identifier;
4. verifies the returned Session id and Project id;
5. returns the safe Session view or relays its event socket.

The WebSocket proxy accepts history-backfill requests only. It does not forward
prompt, abort, steer, approval, or other runtime commands. Agent callers cannot
use the browser observation route. AK never searches for a latest Session by
Agent and never accepts a browser-provided Session URL.

See [ADR 0008](../adr/0008-signed-task-session-observation.md).
