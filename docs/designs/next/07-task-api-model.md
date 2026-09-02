# Task API resource model

Status: accepted

## Domain group

All resources below belong to the Task domain: it defines their identity,
ownership, lifecycle, review invariants, retention, and authorization. Board
and Repository remain separate resource groups referenced by Task fields.

| Resource | Identity | Owner and lifecycle | Canonical URI |
| --- | --- | --- | --- |
| Task | opaque Task id | tenant Board; created through terminal/deleted state | `/tasks/{taskId}` |
| Task Assignment | Task id singleton | Task; exists while an Agent is selected | `/task-assignments/{taskId}` |
| Task Claim | Task id singleton plus audit action | Task; created by assigned Agent, deleted on release | `/task-claims/{taskId}` |
| Current Review Submission | Task id singleton projection plus version | Task; replaced for each review iteration | `/task-review-submissions/{taskId}` |
| Current Review Rejection | Task id singleton projection | Task; evidence that returns the current submission to work | `/task-review-rejections/{taskId}` |
| Current Review Completion | Task id singleton projection | Task; evidence that finishes the current submission | `/task-review-completions/{taskId}` |
| Task Cancellation | Task id singleton | Task; terminal cancellation evidence | `/task-cancellations/{taskId}` |
| Task Note | opaque Note id | Task; append/read audit communication | `/tasks/{taskId}/notes/{noteId}` |

These are durable resources rather than command aliases: each has stable
identity, representation, authorization, idempotency/concurrency behavior, and
audit meaning.

## Assignment and claim

Assignment continues to accept `agentActorId`, whose value is the stable
Realmroot subject exposed by the selected AK Agent projection. AK stores it
directly in `assigned_to`; Assignment does not query Agency or revalidate the
Agent's scheduling state. Any authorized human or Agent may create it.
Assignment still does not create or dispatch a Session.

Only that Agent may create the Claim. Claim has no client-writable body. AK
copies `runtime` and `session_id` from the authenticated Remote binding into an
immutable Task Session binding. Repeating the same Claim from the same binding
returns the same resource; a different binding conflicts.

## Review

Only the assigned Agent may replace the current Review Submission projection.
A reviewer reads its current `ETag` and sends the unquoted value as the
decision representation's `reviewSubmissionVersion` relationship. This avoids
using a validator from one URI as the `If-Match` precondition of another URI.
A verified Agent whose actor id equals the Task assignee is forbidden from
either decision; humans and other authorized Agents may decide it.

Review action history is audit evidence, not a separately exposed Review
Submission resource. The three canonical URIs above always represent the
Task's current review iteration.

The API compares the principal directly with `assigned_to`. It does not invent
a leader/worker class, default reviewer, reviewer ownership row, or separate
review-submitter identity.

## Runtime boundary

No Task lifecycle resource creates, dispatches, messages, or closes a Session.
The read-only Session binding is execution provenance, not an AK Session
resource and not caller-writable Task state.

## HTTP requirements

- Known-URI singleton resources use idempotent `PUT` and `DELETE`.
- Claim deletion requires the current Claim `If-Match`. Review decisions carry
  the related `reviewSubmissionVersion` in their representation; stale values
  return `412`.
- Invalid state transitions return `409`; invalid representations return `422`.
- Authentication failures and authorization denials remain distinct `401` and
  `403` responses.
- Expected failures are RFC 9457 `application/problem+json`.
- `API-Version` is optional and defaults to the current v2 contract; an
  explicit unsupported version is rejected. Every operation returns `Request-Id`.
