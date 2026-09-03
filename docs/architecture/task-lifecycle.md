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

Assignment stores the selected Agent projection's Realmroot subject in
`assigned_to`; it does not call Agency or start a Session. Only that verified
Agent actor can claim, release, or submit review. An authorized human or a
different authorized Agent can reject or complete. A decision includes the
current Review Submission version so a stale or concurrent decision fails.

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
