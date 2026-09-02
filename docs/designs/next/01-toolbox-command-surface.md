# Realmroot Toolbox command surface

Status: accepted

AK v2 is a Realmroot Resource Server. It does not publish or maintain a CLI.

## Command ownership

Toolbox supplies generic verb-first operations for ordinary resources:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox post agent-kanban/tasks --content-type application/json --header 'Idempotency-Key: <unique-task-key>' @task.json --json
realmroot toolbox get agent-kanban/tasks/<task-id>/notes --json
```

Those operations remain available through Toolbox's generic verb-first grammar;
AK does not invent duplicate resource-first CRUD aliases for them.

AK supplies resource-first names only for Task lifecycle resources:

```bash
realmroot toolbox agent-kanban task claim <task-id> --json
realmroot toolbox agent-kanban task release <task-id> '"<claim-etag>"' --json
realmroot toolbox agent-kanban task review <task-id> '{}' --json
realmroot toolbox agent-kanban task reject <task-id> '{"reviewSubmissionVersion":"<version>","reason":"<reason>"}' --json
realmroot toolbox agent-kanban task complete <task-id> '{"reviewSubmissionVersion":"<version>"}' --json
realmroot toolbox agent-kanban task cancel <task-id> --json
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

The HTTP contract remains resource-oriented. The command names map to
replacement or deletion of Task Assignment, Claim, Cancellation, Review
Submission, Review Rejection, and Review Completion resources; no HTTP path is
an action endpoint.

## Published resources

| Resource | Canonical URI | Lifecycle |
| --- | --- | --- |
| Board | `/boards/{boardId}` | Agent create/list/read; browser owns management |
| Repository | `/repositories/{repositoryId}` | Agent create/list/read; browser owns management |
| Task | `/tasks/{taskId}` | Agent create/list/read; lifecycle resources own transitions |
| Agent | `/agents/{agentId}` | Agency-backed list/read/create projection; mutation of an existing Agent remains unpublished until Agency supports atomic preconditions |
| Machine | `/machines/{machineId}` | Agency self-hosted Environment create/list/read/archive projection enriched by AMA Runners |
| Task Note | `/tasks/{taskId}/notes/{noteId}` | append/read audit communication |
| Task Assignment | `/task-assignments/{taskId}` | idempotent singleton replacement |
| Task Claim | `/task-claims/{taskId}` | assigned Agent creates/replaces; release deletes |
| Task Review Submission | `/task-review-submissions/{taskId}` | assigned Agent replacement |
| Task Review Rejection | `/task-review-rejections/{taskId}` | current reviewer decision projection |
| Task Review Completion | `/task-review-completions/{taskId}` | current reviewer decision projection |
| Task Cancellation | `/task-cancellations/{taskId}` | idempotent singleton replacement |
| Task Event cursor | `/task-events` | bounded wait/read |

Agent, Machine, Environment, Runner, and Session state belongs to Agency. AK
publishes Agent and Machine product projections so callers can discover
schedulable assignees and observe self-hosted capacity without knowing Agency
URIs or transport models. Environment, Runner, and Session remain internal
Agency resources except for the existing bounded Task Session observation.

## Contract rules

- Paths contain resource nouns only; HTTP methods carry operation semantics.
- `API-Version` is optional. Omitting it selects the current v2 contract; an
  explicit unsupported value is rejected. Responses echo the selected version.
- Agent collections use lowerCamelCase representations and cursor envelopes;
  generic creations require `Idempotency-Key` and replay the original result.
- Realmroot authentication establishes a normalized principal; Task ownership,
  tenant, assignment, and separation-of-duty checks authorize each resource.
- Review decisions include the current `reviewSubmissionVersion` returned by
  the Review Submission representation.
- Expected v2 failures use RFC 9457 Problem Details and every response carries
  `Request-Id`.
- Task Claim runtime provenance comes only from Remote's signed Agent binding;
  no Session field is accepted from request JSON.
