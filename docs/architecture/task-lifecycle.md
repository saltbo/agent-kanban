# Task lifecycle

```text
todo
  ├─ assign ─► todo + assigned actor
  │              └─ claim ─► in_progress
  │                            └─ submit review ─► in_review
  │                                                  ├─ reject ─► in_progress
  │                                                  └─ complete ─► done
  └──────────────────────────── cancel ─────────────► cancelled
```

Assignment patches the selected Agent projection's Realmroot subject into the
Task's `assignedTo` field and atomically records a durable launch intent; it
does not synchronously call Agency or start a Session. Only that verified Agent
actor can create its Claim or patch
the Task to `in-review`. An authorized human or a different authorized Agent can
patch an `in-review` Task back to `in-progress` or forward to `done`. Each Task
PATCH reads the current version and commits with an internal compare-and-swap;
a concurrent change returns `409 Conflict` so the caller can reread the Task.

Claim copies `runtime` and `session_id` provenance from the verified
Realmroot-issued Agent binding. The values are not accepted from request JSON.
For Tasks with a launch intent, the transaction also requires the exact Session
recorded in its Session annotation, no scheduled time, and no blocking dependencies.
Assignment and Session creation alone never move the Task to `in_progress`.
The exact Session is exposed to human viewers through the read-only observation flow in
[session observation](session-observation.md).

Task dependencies are stored as Task relationships. A Task is computed as
blocked while any dependency is neither done nor cancelled; recursive checks reject dependency
cycles and cross-tenant relationships. Notes form the Task communication and
streaming audit surface.

Assignment now creates the exact Session through the caller's token exchange
after the D1 assignment commits. Completion and cancellation recover any
unrecorded creation response, close that Session, and revoke its repository
bootstrap credential. Repeated terminal transitions can resume cleanup.
Agent creation no longer creates an Inbox Trigger. Review rejection sends its
feedback to the exact Session with the caller's delegated `sessions:write`
authority, then acknowledges the existing review decision's delivery effect.
The server-owned `agent-kanban.dev/review-delivery` annotation reserves a single
sender for that decision. An acknowledged decision is not resent. An uncertain
delivery keeps its reservation; retries reconcile the exact Session's accepted
or delivered prompt content before acknowledging it. Missing evidence returns a
conflict without sending another prompt. Explicit API rejection releases the
reservation for retry. This prevents blind duplicate sends without claiming that
Enbor provides exactly-once messages. See the proposed replacement in
[ADR 0012](../adr/0012-durable-task-session-dispatch.md).

Reassignment first reserves the replacement actor in the existing launch
metadata with a Task version check. That reservation prevents the old Session
from claiming or acquiring another startup lease. AK settles the previous
Session and bootstrap credential before committing the new assignment. Cleanup
failure retains the reservation and exact resource identifiers; the same
assignment can resume cleanup after its lease expires, while a different
replacement receives a conflict. Claimed Tasks cannot enter this reservation.

Delayed scheduling is not implemented. The `scheduledAt` field is retained for
compatibility, but non-null create or update writes return 422. Omit it on
creation; PATCH with null may clear a stored schedule. No timer-based execution
is promised for existing scheduled Tasks.
