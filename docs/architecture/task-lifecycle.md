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
Task's `assignedTo` field; it does not call Agency or start a
Session. Only that verified Agent actor can create or delete its Claim or patch
the Task to `in-review`. An authorized human or a different authorized Agent can
patch an `in-review` Task back to `in-progress` or forward to `done`. Each Task
PATCH reads the current version and commits with an internal compare-and-swap;
a concurrent change returns `409 Conflict` so the caller can reread the Task.

Claim copies `runtime` and `session_id` provenance from the verified
Realmroot-issued Agent binding. The values are not accepted from request JSON.
The exact Session is exposed to human viewers through the read-only observation flow in
[session observation](session-observation.md).

Task dependencies are stored as Task relationships. A Task is computed as
blocked while any dependency is not done; recursive checks reject dependency
cycles and cross-tenant relationships. Notes form the Task communication and
streaming audit surface.

Assignment, rejection, completion, and cancellation notify the assignee after
the D1 transition commits. See
[ADR 0009](../adr/0009-post-commit-task-notifications.md).
