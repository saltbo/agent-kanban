# Session observation

A successful Task Claim persists the runtime and canonical Agency Session
identity from the verified Realmroot Agent binding. That immutable binding is
the only way a Task acquires a Session relationship.

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
