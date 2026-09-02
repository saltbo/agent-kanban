# Agent and Machine projections

Status: implemented in AK; upstream limitations remain documented below

## Decision

AK restores public Agent and Machine resources without restoring the v1 Agent,
Machine, runtime, or Session entities in AK storage.

- Agency remains authoritative for Agent definitions, Realmroot Identity
  bindings, scheduling state, Runners, and Sessions.
- AK exposes tenant-scoped Agent and Machine representations assembled through
  an Agency adapter.
- AK never reads the legacy `agents` or `machines` tables for these resources.
- Clients use only AK resource URIs. Agency resource URLs, Project ids,
  Identity ids, credential references, and provider transport models remain
  internal.
- The existing same-tenant model remains unchanged: the authenticated AK tenant
  resolves to the corresponding Agency Project. Cross-tenant Identity binding
  and platform-owned Agency Projects are not part of this change.

The projection is a product boundary, not a cache or a second source of truth.
An upstream Agency failure fails the affected AK operation explicitly; AK does
not return legacy or stale Agent/Machine data.

## Resource proof

| Resource | Stable identity | Owner and lifecycle | AK representation | Canonical URI |
| --- | --- | --- | --- | --- |
| Agent | Agency Agent `metadata.uid` | Agency creates, updates, and archives it inside the tenant Project | AK-owned projection used for discovery, configuration, and selecting an assignment subject | `/agents/{agentId}` |
| Machine | Agency self-hosted Environment `metadata.uid` | AK creates or archives the Agency Environment; AMA Runner registers beneath it and supplies live capacity | AK-owned Environment projection enriched with Runner state | `/machines/{machineId}` |

Both resources pass the resource gate because callers list, address, filter,
and link them independently. Their lack of an AK database row does not make
them less valid as public resources.

`schedulable` is Agent state owned and computed by Agency. It means Agency can
schedule runtime work for that Agent using its active configuration, Identity,
wake path, Environment, and runtime capacity. It does not mean that Agency
knows about AK Tasks, assignments, queues, or workload policy. AK never
recomputes this value from Machines.

## Public API

AK keeps the existing cursor pagination profile (`pageSize`, `pageToken`,
`items`, `pagination.nextPageToken`, and an RFC 8288 `Link` header). The adapter
translates Agency's cursor representation at the boundary.

`API-Version` remains optional by explicit product decision. Omitting it selects
the current v2 date; a supplied unsupported value fails.

| Method | Path | Purpose | Scope |
| --- | --- | --- | --- |
| `GET` | `/agents` | List current tenant Agents | `agent:read` |
| `POST` | `/agents` | Create a Realmroot Identity and bound Agency Agent | `agent:write` |
| `GET` | `/agents/{agentId}` | Read one Agent projection | `agent:read` |
| `GET` | `/machines` | List self-hosted Environment projections | `machine:read` |
| `POST` | `/machines` | Create a self-hosted Environment and return its Runner setup | `machine:write` |
| `GET` | `/machines/{machineId}` | Read one Environment enriched with Runner state | `machine:read` |
| `DELETE` | `/machines/{machineId}` | Archive the backing Agency Environment | `machine:write` |

`POST /machines` creates a real Agency Environment with `spec.type =
self_hosted`; it never creates an AK row or a fake Runner. Its response includes
the complete AMA Runner setup command for that Environment. The Machine exists
immediately in an offline state and becomes online when its Realmroot-bound AMA
Runner registers and reports a fresh heartbeat.

`DELETE /machines/{machineId}` translates to Agency Environment archival. It returns
`204` only after Agency confirms the archive. It does not delete local Runner
files from the user's computer; the confirmation explains that the Runner will
stop accepting work and that local removal is a separate `ama-runner remove`
operation. Repeating deletion is idempotent.

Agent reads return an `ETag`. AK cannot claim stronger concurrency semantics
than Agency, so `PATCH` and `DELETE` are not published until Agency provides an
atomic version precondition. When that prerequisite exists, both operations
will require `If-Match`; stale validators will return `412` and missing
preconditions will return `428`.

Archival removes an Agent from the default live collection but does not destroy
its canonical resource. Direct GET continues to return the archived Agent with
`schedulable: false`, so historical Task relationships do not become broken
links. Archived Machines follow the same direct-read rule.

### Agent collection

The first version supports these typed filters:

- `schedulable`: exact boolean Agent state;
- `runtime`: exact canonical runtime;
- `search`: bounded name or username search;
- `pageSize` and `pageToken`: the project cursor profile.

Assignment clients discover candidates with:

```text
GET /agents?schedulable=true
```

An Agent representation contains only AK product fields:

```json
{
  "id": "agent-id",
  "name": "Backend Engineer",
  "description": "Implements backend tasks",
  "username": "backend-engineer",
  "runtime": "codex",
  "model": "gpt-5.6",
  "skills": ["agent-kanban"],
  "subject": "realmroot-agent-subject",
  "schedulable": true,
  "createdAt": "2026-09-01T12:00:00.000Z",
  "updatedAt": "2026-09-01T12:00:00.000Z",
  "links": {
    "self": "https://agent-kanban.example/agents/agent-id"
  }
}
```

`subject` is the stable Realmroot Agent subject accepted by the existing Task
Assignment contract. It is an identifier, not a credential. AK does not expose
the Agency Project id, local Identity resource id, Realmroot internal Agent id,
credential reference, provider secret, or raw Agency representation.

### Agent creation

The caller supplies product configuration and never supplies `identityRef`, a
Realmroot actor id, or a credential. AK performs one application operation:

1. validate the complete Agent request before external mutation;
2. create the same-tenant Agency Identity with a derived upstream idempotency
   key;
3. create the Agency Agent bound to that Identity with a second derived key;
4. map the Agency representation to the AK Agent resource;
5. return `201`, `Location`, and the Agent representation.

The AK `Idempotency-Key` identifies the whole operation. Repeating the same
request resumes or replays both upstream creations. A changed request under the
same key returns `409`. A permanent Agent-creation failure after Identity
creation archives the unused Identity; a transient or uncertain failure keeps
the operation retryable with the same keys. This orchestration stores no AK
Agent entity.

### Machine projection

Machine maps one-to-one to an Agency self-hosted Environment and aggregates the
Runners registered beneath it. It exposes safe operational state: id, name,
online/offline state, aggregate current and maximum load, reported runtimes and
models, last heartbeat time, and AK links. It omits Agency Project ids from the
normal representation, secret references, authentication bindings, and
arbitrary Environment/Runner metadata. The Project id appears only inside the
generated local setup command.

Cloud-managed runtime capacity does not invent a Machine. It contributes to
Agency's Agent `schedulable` calculation but has no self-hosted Runner identity.

## Product pages

The browser restores four authenticated product routes:

| Route | Page behavior |
| --- | --- |
| `/agents` | Read-only Agent list with search, runtime, and schedulable filters |
| `/agents/{agentId}` | Read-only Agent identity, configuration, scheduling state, and AK Tasks filtered by its `subject` |
| `/machines` | Machine list with status/runtime/capacity summaries, Add Machine, and per-row Delete Machine |
| `/machines/{machineId}` | Read-only Machine status, heartbeat, runtime inventory, capacity, and environment details |

Agent creation, editing, archival, and configuration controls do not appear in
either Agent page. The public Agent write API remains available to authorized
Toolbox callers; this is a browser product decision, not a reduction of the
Resource Server contract. Legacy Leader/Worker tabs, Sub-agents, local AK
sessions, Inbox contents, token/cost statistics, identity credentials, and raw
Agency metadata are not restored.

The Agent list links every card or row to the detail page and clearly separates
`schedulable` from merely active. The Agent detail page uses the published
`subject` to query AK Tasks through the existing Task filter; it does not query
Agency for task state or reconstruct legacy Agent activity records.

The Machine list's **Add Machine** button opens a focused dialog, never an
inline form. The flow:

1. explains that AMA Runner is the local runtime component;
2. provides the supported installation command;
3. provides `ama-runner auth login` for Realmroot Context selection;
4. creates the Machine's self-hosted AMA Environment and provides a complete
   `ama-runner start` command generated by AK with the current tenant's AMA API
   Server, Project id, and the newly created Environment id already filled in;
5. closes the dialog and polls `/machines/{machineId}` until the Machine becomes
   online or the bounded wait expires with retry guidance.

The user never selects or types an AMA Project or Environment. AK resolves both
from its authenticated tenant integration and fails the setup dialog explicitly
if that integration is incomplete. The generated command has this shape:

```text
ama-runner start --api-server "<ama-origin>" --project-id "<project-id>" --environment-id "<environment-id>" --allow-unsafe-process
```

The flow does not offer the old Cloud Sandbox choice because cloud-managed
capacity is not a Machine. The dialog supports Back/Close, restores focus to
the Add button, labels every control, and keeps commands copyable on mobile.

Delete Machine is available from each list row's overflow menu and may also be
shown in the detail page danger zone. It always opens a destructive
confirmation naming the Machine and its current load. The UI disables repeat
submission, reports an explicit failure, and removes the row only after the AK
API confirms archival.

## Assignment contract

Task Assignment is unchanged. The caller selects a candidate from `/agents`
and submits that Agent's `subject` through the existing representation:

```json
{
  "agentActorId": "realmroot-agent-subject"
}
```

AK stores that value directly in `assigned_to` and continues to use it for
Claim and separation-of-duty authorization. Assignment does not call Agency,
does not revalidate `schedulable`, does not store an Agency Agent id, and gains
no new database field. Candidate discovery is advisory at selection time; the
existing Assignment idempotency, validation, and failure behavior remain
unchanged.

## Authorization and downstream access

AK authenticates the public caller and enforces AK scopes and tenant policy.
Agency separately authenticates the downstream request in the same Realmroot
tenant context. A successful AK authorization is not reused as an Agency
authorization decision.

The current user-owned Agency tenant model remains in force:

- browser operations use the server-held AMA grant obtained during the
  multi-resource Realmroot sign-in;
- Agent Toolbox operations exchange the verified Agent/controller authority
  for the exact Agency scopes required by the downstream operation;
- access and refresh tokens remain server-side and never appear in AK resource
  representations, browser storage, URLs, or logs.

Reads require only Agency `agents:read` or `runners:read`. Agent creation and
mutation require the corresponding Identity and Agent write authority. Machine
deletion requires Agency Runner update/archive authority. The separate
default-permission design is not part of this document.

## Failure and consistency rules

- Map Agency absence to AK `404` only after a successful authoritative lookup.
- Map upstream authorization denial to `403`; never disguise it as an empty
  collection.
- Map Agency timeout/unavailability to `503` with `Retry-After` when known.
- Map malformed or contract-incompatible Agency responses to `502`.
- Return RFC 9457 Problem Details and the AK `Request-Id` for every failure.
- Propagate W3C Trace Context from AK to Agency and record the Agency operation,
  result class, duration, AK tenant id, and correlation ids without bodies or
  credentials.
- Do not cache `schedulable`. Ordinary Agent and Machine GET responses may use
  validators only when Agency supplies a validator that AK can preserve or
  derive without changing freshness semantics.

## AMA prerequisites

The first prerequisite is required before candidate discovery can be
considered complete:

1. **Agent scheduling projection:** Agency Agent list and detail responses add
   an authoritative `status.schedulable` boolean and support exact
   `schedulable` filtering. The calculation is infrastructure-only and contains
   no AK Task knowledge. For AK wake-up, it includes a live provisioned Inbox
   Trigger and a usable execution path; it does not inspect AK assignments.
2. **Agent-created Identity provisioning:** Agency currently requires a User
   principal for Identity creation. It must allow a properly authorized
   Realmroot Agent/controller chain to create another Agent Identity, or expose
   an equivalent controller-approved provisioning flow. Without this, AK can
   support human Agent creation but not the accepted Agent-creates-Agent
   workflow.
3. **Safe Agent writes:** Agency Agent creation must honor an idempotency key,
   and update/archive must enforce an atomic current-version precondition. AK
   cannot safely recover an uncertain create or provide `If-Match` semantics
   when the authoritative service lacks those guarantees.
Agency already supplies the remaining minimum inputs: tenant-scoped Agent
list/detail/create/update, active Identity descriptors with the stable
Realmroot subject, and Runner list/detail with heartbeat and runtime state.

## Code ownership

The implementation adds no Agent or Machine repository backed by D1.

```text
server/usecases/agents/       AK projection and creation orchestration; owns Agency ports
server/usecases/machines/     Environment creation/read/archive and Runner aggregation; owns Agency ports
server/adapters/agency/       Agency HTTP authorization, decoding, and mapping
server/http/agents/           AK Agent routes and schemas
server/http/machines/         AK Machine routes and schemas
shared/                       AK wire representations only
src/features/agents/          read-only Agent list/detail and AK Task links
src/features/machines/        Machine list/detail, Runner setup, and archival UI
```

The existing Task Assignment use case remains unchanged and has no Agency
dependency.

## BDD and test plan

Before implementation, add behavior to `spec/agents.feature` and
`spec/machines.feature`. Existing Assignment scenarios remain unchanged.
Use the cheapest proving layer:

- domain/unit: pure projection mapping, safe field omission, and scheduling
  state interpretation;
- use case: creation idempotency, partial-failure recovery, and projection
  filtering with an Agency port fake;
- adapter integration: exact Agency request translation, cursor mapping,
  response decoding, timeout, `403`, `404`, malformed response, and Trace
  propagation;
- HTTP contract: OpenAPI/runtime agreement, optional `API-Version`, scopes,
  filters, Problem Details, and the public Agent `subject` field;
- web component: read-only Agent pages; Machine setup dialog focus/copy states;
  destructive Machine confirmation and mutation feedback;
- E2E: one crown proving list schedulable Agents, assign by returned subject, Inbox
  activation, Claim, review submission, and completion. Runner installation is
  not executed in browser E2E; a focused journey proves that a newly registered
  Runner appears and can be archived.

During development, run only the exact cases selected by the changed behavior,
following `05-test-pyramid.md`.

## Delivery order

1. Land the AMA `schedulable`, Agent-write idempotency/concurrency, and
   Agent-principal Identity provisioning contracts.
2. Add AK Agency authorization and narrow Agent/Machine projection adapters.
3. Publish and implement read-only Agent/Machine OpenAPI resources.
4. Add Agent create/update/archive orchestration.
5. Restore the four Agent/Machine product pages against AK APIs only, including
   Machine setup and archival.
6. Run the single real cross-service acceptance crown without changing the
   Assignment contract.

## API design gates

- **RESOURCE GATE: PASS.** Agent and Machine have upstream stable identities,
  independent lifecycles, canonical URIs, typed representations, and tenant
  authorization boundaries.
- **PATH VERB AUDIT: PASS.** `/agents`, `/agents/{agentId}`, `/machines`, and
  `/machines/{machineId}` contain only plural resource nouns and identifiers.
- **RPC SHAPE AUDIT: PASS.** No action path, RPC suffix, command selector,
  caller-written status, or generic operation envelope is introduced.
- **PAGINATION PROFILE: PASS.** Both collections use AK's existing cursor
  profile and translate Agency cursors at the adapter boundary.
