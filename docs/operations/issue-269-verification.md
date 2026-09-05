# Issue 269 delivery evidence

The full AK Task scheduling acceptance is not complete. This record distinguishes
the deployed Enbor prerequisite from the remaining AK delivery.

## Enbor prerequisite

- PR: https://github.com/realmroot/enbor/pull/169
- Merged commit: `e2581050b43442427308f070392a871265e00fc7`.
- Cloudflare production build: `775f8309-6e9e-4e60-9423-b3554c4ce8de`, succeeded 2026-09-05 16:33:28 UTC.
- Production version: `3b77d3bf-8b68-4381-819b-b423dbccde2b`, 100% traffic.
- D1 migration `0044_session_creation_idempotency.sql` applied; migration listing reported no pending migrations.
- Live OpenAPI exposes the optional Session `idempotency-key` header with length 8–200.
- All required PR CI checks passed before merge.

## Bounded production Session regression

Executed on 2026-09-05 using Agent-attributed Realmroot Toolbox authority:

- Organization: `019ff650-9b06-7335-8396-b842b1c27b6a`.
- Project: `project_67d72b76aa864107a3e07487c944548c`.
- Existing cloud Environment: `env_87d32b50ecc44165a7d7072e5ed10ed1`.
- Dedicated Agent: `01a07275-537d-7592-94d1-50eba71826c3` (removed after verification).
- Session: `01a07277-352f-71fd-a506-4875cb3b635b`.
- Creation key: `ak269-20260905-production-session`.

The Session executed through the native Enbor runtime and completed with the
literal output `AK269_SESSION_SMOKE_OK`. The event stream included
`turn.completed` and `runtime.completed`; usage reported 71 tokens. Three
concurrent replays of the original creation request returned the same Session
id. Reusing the key with a changed prompt returned `idempotency_conflict`.
The verification-label collection contained exactly one Session and no further
page. Its final state was `closed` at 16:48:10 UTC. No bootstrap credentials
were required or created for this repository-free smoke check.

This proves a deployed Session execution and idempotent replay, not the full AK
Task workflow, repository bootstrap, or Agent Claim.

## AK local implementation evidence

On 2026-09-05, the current uncommitted implementation passed `pnpm test`:
77 test files and 617 tests. `pnpm typecheck`, `pnpm lint` (67 traced scenarios),
`pnpm build`, and `pnpm check:skills` also passed. The build reported a client
chunk-size warning. These checks do not prove production dispatch wiring.

The D1 integration cases cover durable assignment, lease fencing, immutable
Session requests, late-response cleanup receipts, bootstrap reference/rotation
acknowledgements, and the exact Session Claim gate. Claim tests also recheck
schedule and dependencies after dispatch and exercise concurrent claims.
Dispatch unit tests inject both a remote failure and failure-recording failure;
they prove the batch drains other in-flight requests and preserves both causes.
Those two tests were also run without the fix and failed as expected.

The unresolved design and activation requirements are tracked in
[Proposed ADR 0012](../adr/0012-durable-task-session-dispatch.md).

## Latest scope and annotation verification

The user deferred delayed scheduling and withdrew the separate launch table.
`scheduledAt` remains readable; non-null create/update writes return 422, and
stored scheduled Tasks are excluded from startup. The exact requested Session
is now stored in the Task's server-owned Session annotation. Launch recovery
state uses existing Task metadata; migration 0057 and the new Task column have
been removed. Reserved execution metadata/annotations reject client writes.

The refactored worktree passed 78 files / 625 tests, typecheck, lint (68 traced
scenarios), and build on 2026-09-05. The Task/Board cleanup-before-deletion case
also passed after adding the Board cascade guard. These are local component and
integration results, not proof of deployed direct Session orchestration.

## Early-Claim recovery evidence

The Claim HTTP handler now recovers a pending Session creation by exchanging
the verified caller's source token for `sessions:write` and replaying the stored
request/key. Four focused D1 tests passed for both writer orderings,
cancellation during replay, and exclusion of unrelated actors/tenants. All
seven runtime-provenance HTTP tests passed, including exchange client/scopes,
Project header, original idempotency key, and exact response association.
Typecheck and lint passed with 69 traced scenarios. No production claim is
made from these fake-upstream HTTP tests; deployed scope mapping and direct
assignment orchestration are still outstanding.

## Remaining acceptance constraints

The two current organization-owned AK Project bindings inspected during setup
had no Agents. Enbor rejects Identity creation in organization contexts with
`organization_identity_not_supported`; its current Identity creation contract
only supports user-owned identities. The smoke Agent was deliberately unbound
and cannot stand in for the final Realmroot-bound Task Agent.

Correction following the user's scope clarification: that setup failure does
not establish a requirement to extend Realmroot organization Identities.
Dispatch must reuse the existing AK Agent creation/token-exchange integration
and existing bound Agents. The Inbox M2M token path is not the proposed Session
authorization path. Confirm the acceptance Agent through the AK integration;
do not make a new organization Identity subsystem a prerequisite for #269.

Delayed background scheduling is explicitly out of scope. Remaining delivery
includes continuation delivery ambiguity, credential recovery and
expiry handling, deployed scope mapping, old-trigger retirement, AK deployment,
and a real complete Task scheduling/execution/review/cleanup cycle.

## Direct HTTP dispatch and cleanup acceptance

On 2026-09-05 the focused direct-dispatch and generic Task HTTP suites passed
64 tests. They cover repository-free and GitHub repository assignments using
token exchange, exact Session annotation, repeated assignment without a second
Session, isolation from another pending Task, Vault-only bootstrap token storage,
and cancellation closing the Session before revoking the credential. Repeating
cancellation after settlement issues no further cleanup calls.

Agent orchestration passed 8 unit tests and Agent/Machine projection plus direct
assignment passed 17 integration tests before the cancellation assertions were
added. The Agent creation flow preserves Identity/Agent idempotency and no longer
creates a Trigger or requests `triggers:write`.

Session provenance/observation passed 8 HTTP tests, including exact annotation
lookup before and after Claim. Typecheck and lint passed (69 traced scenarios).
These are local fake-upstream proofs; AK has not been deployed and the real Task
acceptance remains outstanding.

## Reassignment acceptance

The HTTP reassignment flow now fences the previous Agent's Claim before closing
its exact Session, then creates the replacement launch. No new table is used;
the replacement actor is stored in the existing Task launch metadata. Two HTTP
cases passed for successful cleanup and an upstream 503 followed by a same-target
retry after lease expiry. They assert that another replacement is rejected while
cleanup is pending, an old Session Claim is rejected during cleanup, and no new
Session is created until cleanup succeeds. Repeated completed assignments do not
create another Session. The D1 launch/assignment suites passed 25 tests; typecheck
and lint passed. Production behavior remains unverified.

## Review continuation acceptance

Rejection now sends a prompt to the Task's exact existing Session through token
exchange, including its feedback and stable decision request id. The existing
review decision effect is acknowledged only after the API succeeds. Four direct
dispatch HTTP cases passed, covering repository and non-repository rejection,
sequential replay suppression, cancellation cleanup, and reassignment. Four
review usecase tests passed, including propagation of a delivery failure before
acknowledgement; the generic Task lifecycle HTTP case also passed. Typecheck and
lint passed. The now-unused Inbox lifecycle notifier and its usecase were removed.

Source inspection found that Enbor `sendSessionMessage` dispatches before storing
the message and does not deduplicate by `requestId`. Therefore a lost response or
concurrent retry can still duplicate continuation. Stable request ids alone are
not proof of exactly-once delivery. This limitation needs resolution or an
explicitly documented delivery contract before production acceptance.

## Dependency release acceptance

Completion/cancellation now dispatches ready direct dependents in bounded pages
through the current request's delegated authority. It does not add a timer or
support `scheduledAt`. The four direct-dispatch HTTP tests passed with the
reassignment cases first proving that blocked assignment creates no Session and
cancelling the prerequisite starts it. A focused D1 case passed for all-dependency
eligibility, exclusion of scheduled Tasks, tenant isolation, and pagination.
The leftover Inbox error-handler import was removed after a module-load failure;
typecheck and lint then passed. A new full test run is in progress.

## Production Application scope mapping

Updated the existing `Agent Kanban Web` Application
`01a05a6d-17cf-7053-bfe0-8a20f613dfed` in the Realmroot Platform organization
on 2026-09-05 using the Agent's existing `applications:write` authority.
Its Web client remains `01a05a6d-17cf-7053-bfe0-8e6238ec16ca` (Application id
and client id are distinct). Added Enbor `vaults:read`/`vaults:write` to its
resource allowlist, AK `task:write` mappings to Enbor `agents:read`,
`sessions:write`, `vaults:read`, `vaults:write`, `projects:read`, `projects:write`,
and AK `task:claim` to Enbor `sessions:write`.

A fresh GET exactly matched both updated fields and verified unchanged client
id, organization, grants, redirect/logout URIs, and secret metadata. Existing
scope mappings were retained so the currently deployed Inbox Trigger creation
flow continues to work until cutover. This confirms stored configuration, not
successful end-to-end Task token exchange or production dispatch.

The full AK suite completed successfully after these changes: 79 files / 636
tests passed in 295.93 seconds. Production build also passed. These checks cover
the current local dispatch, dependency release, continuation, and cleanup code;
they do not settle the documented delivery ambiguity or replace live acceptance.

## Bootstrap recovery changes

Credential preparation now persists its Project and Vault location under the
existing Task launch metadata before creating the credential. Settlement uses
that location to list and revoke active credentials matching the exact Project,
Vault, Task, launch id, name, and managed-by marker, even when `secretRef` was
never recorded. The repository HTTP cancellation case passed with the saved
secret reference removed and an unrelated foreign credential present in the
inventory. Settlement now rejects a failed lease acknowledgement.

Before replaying a repository Session create, dispatch refreshes a near-expiry
saved credential through the same secretRef and waits for Enbor acknowledgement.
Two unit cases passed for successful refresh-before-create with unchanged request
and key, and refresh failure preventing Session creation. This does not yet
prove refresh during an arbitrarily long Enbor runtime placement queue.

## Continuation ambiguity handling

The earlier blind-retry limitation is now addressed on the AK side. A server-owned
Task annotation reserves one sender per review decision. An unknown outcome
retains that reservation; retries read the exact Session's message history and
acknowledge only an accepted/delivered exact-content match. If no evidence exists,
AK reports conflict without resending. Explicit 400/401/403/404/409/422 rejection
releases the reservation. Unknown outcomes without a stored message remain a
visible reconciliation limitation, not a claimed successful continuation.

The four direct HTTP cases passed, including simulated acceptance followed by a
503 response and reconciliation without another POST. A D1/adapter concurrency
case passed proving only one sender while acceptance is unknown. The existing
production Web Application gained `task:write` → Enbor `sessions:read`; a fresh
GET verified the full updated policy. Typecheck and lint passed before the new
concurrency test was added.

## Existing production acceptance fixture

AK `agent list-agents` in Context `019ff417-3c2a-7095-bfff-526e03267968`
returned existing bound/schedulable Codex Agents. Selected Flint Carter:
Agent `01a06824-2513-7542-8e59-fe18a1575284`, Realmroot subject
`01a06824-2513-7828-8cfb-327d1b59b693`, runtime `codex`, model `gpt-5.5`.
His eight returned assigned Tasks were all done. The existing Environment
`env_0d7fe8fcc8a147cd9664588756b90002` was online with current load 0,
three runners, and Codex ready. This AK read succeeded through existing token
exchange; no new Identity or organization subsystem is needed.

The launch prompt now includes the exact AK Context id. Personal tenant keys
`user:<controller>` map to `<controller>`; organization keys remain unchanged.
Focused tests cover both forms, avoiding discovery or a guessed default Context
inside the executing Agent.

## Cutover inventory and late-creation cleanup

PR #271 contains commit dc64042. Its Cloudflare build succeeded; this is a build,
not a deployment. The latest active AK deployment inspected remained version
ce746003-9c3a-4d85-88bb-3a8ca918867f, deployed 2026-09-05T15:15:35Z.

The acceptance Project returned 15 active Inbox Triggers: 14 have the exact
`agent-kanban.dev/managed-by=agent-kanban` template label and matching Agent-id
annotation; the remaining legacy `AK v2 E2E Worker Inbox` has an explicit AK-only
prompt but no ownership label. No Trigger has been mutated yet. Their current
representations are retained in /tmp/ak269-existing-triggers.json for cutover.

An added HTTP case cancels the Task inside the outstanding Enbor Session-create
request. The original assignment now observes terminal/replacement state after
recording the returned Session and settles it immediately. All five direct HTTP
cases passed, including exact closing of this late Session. This closes the gap
where a cancellation request saw no receipt and the receipt arrived afterward.
