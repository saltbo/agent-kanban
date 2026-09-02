# Agent role and authority

Status: accepted

## Accepted outcome

The next version has one kind of executable Agent: the Agency Agent. AK does not
recreate `leader`, `worker`, or `maintainer` as Agent types, local database
fields, token identities, or UI categories.

The current model mixes three independent concepts:

1. **Runtime identity:** which Agent and Session are calling.
2. **Task relationship:** which Agent is assigned to execute a Task.
3. **Authority:** which operations the caller may perform.

The new design gives each concept one owner:

- Agency owns Agent definitions, Identity bindings, runtime configuration, and
  Sessions.
- AK owns Task assignment and Task state.
- Realmroot grants coarse AK capabilities and preserves the controller/Agent
  actor chain; AK enforces tenant, Task relationship, and Task-state policy.

## Evidence from the current systems

AK currently persists `kind=worker|leader` and derives a fixed scope bundle
from it. A worker can claim and submit work. A leader can assign, reject,
complete, cancel, and administer AK resources. An active board-maintainer
binding dynamically upgrades a worker into another management identity.

Agency's current Agent model has no Leader/Worker type. An Agent is configuration:
system prompt, model/provider, Skills, tools, subagents, and an optional
Realmroot Identity binding. Realmroot-authenticated Agency requests preserve a
controlling user and a distinct stable Agent actor, and authorization uses
exact resource scopes.

This means copying AK's `kind` field into Agency would create a second role system
with no runtime need.

## Replacement model

### Agency Agent replaces both AK Leader and Worker records

An Agency Agent is not intrinsically a leader or worker. Its prompt, Skills, model,
and tools describe what it can do; none of those fields grant AK authority.

AK's product-facing Agent pages and API become projections of Agency Agent and
Identity resources. They must not persist or synthesize an authoritative
Leader/Worker kind.

### Task Assignment replaces Worker kind

"Worker" becomes a relationship, not an Agent type:

- a Task references the assigned Agency Agent;
- the Agent's Realmroot Identity identifies calls from that Agent;
- claim and review submission require the calling Agent actor to match the
  assigned Agent's bound Identity;
- Agency Session state supplies runtime and execution status.

An Agent is a worker only while it is the assignee of a Task. There is no
tenant-wide `worker` flag.

Any Agency Agent may be assigned without first being classified as a worker,
provided it is currently eligible to execute the Task: it has an active bound
Realmroot Identity and Agency reports the required runtime as schedulable. Agent
type no longer excludes an orchestration Agent from also executing a Task.

### Realmroot grant plus Skill replaces Leader kind

"Leader" currently combines orchestration instructions and management
authority. Those separate in the next version:

- `ak-task` and `ak-plan` teach an Agent how to create, assign, monitor, reject,
  and complete work;
- a Realmroot grant determines whether that Agent may call the corresponding
  AK operations;
- AK evaluates the grant together with tenant ownership, Task state, and Task
  relationships.

Installing an orchestration Skill does not grant authority. Receiving a grant
does not change the Agency Agent's type. A human can perform the same management
operations through the same resources when authorized.

### Maintainer is removed, not renamed

The current autonomous board-maintainer product includes schedules, webhooks,
memory, mailbox-like coordination, and persistent board bindings. Those
capabilities are outside the first release and are removed with
`ak-maintainer`. They must not be hidden inside a new Leader replacement.

A later autonomous-maintenance product can be designed from Agency Triggers,
Sessions, Agent configuration, and explicit AK grants if it becomes necessary.

## Accepted authorization model

| Capability | Required authority | AK resource policy |
| --- | --- | --- |
| Read boards and tasks | Realmroot AK read grant | Same tenant and visible board |
| Create and assign tasks | Realmroot AK task-management grant | Same tenant; referenced Board and Agent exist; AK resolves and stores the Agent's Realmroot actor |
| Claim assigned task | Realmroot AK execution grant | Calling Agent actor equals the Task's `assigned_to` value |
| Submit review | Realmroot AK execution grant | Same assignee match; Task is `in_progress` |
| Reject or complete | Realmroot AK task-management grant | Task is `in_review`; separation-of-duty decision below applies |
| Cancel or release | Realmroot AK task-management grant | Current Task state permits the transition |

The exact public scope names belong to the Resource Server/OpenAPI contract
work. They should describe stable resource capabilities and must not encode
Leader/Worker role names.

## Identity resolution

For an Agent call, AK must preserve both actors from the Realmroot authority:

- the controller determines the tenant context;
- the stable Agent actor identifies who actually invoked Toolbox.

To authorize assignee-only operations, Assignment accepts the selected Agent's
stable Realmroot subject as `agentActorId` and stores it directly in
`assigned_to`. The subject can be discovered from AK's Agency-backed Agent
projection. Claim, review, reject, and complete compare the verified caller
actor directly with that stored actor. Assignment does not resolve an Agency
Agent id or accept a caller-supplied role field.

Actions continue to record the verified actor after the operation. No default
reviewer or review-owner field is introduced.

## Removed concepts

| Current concept | Next-version treatment |
| --- | --- |
| `agents.kind = worker` | Remove; Task assignment supplies the relationship |
| `agents.kind = leader` | Remove; orchestration Skill plus Realmroot grant supplies behavior and authority |
| `agent:worker` / `agent:leader` token identities | Remove; use the verified Realmroot Agent actor |
| Kind-derived fixed scope bundles | Remove; use issued Realmroot grants plus AK resource policy |
| AK `role` used for scheduling | Remove from AK authority and scheduling |
| `handoff_to` and role routing | Remove from the first release |
| Board maintainer binding and identity upgrade | Remove from the first release |
| AK Agent Session/JWT identity | Remove; Agency Session plus Realmroot DPoP authority replaces it |

Descriptive labels may still appear in Agency metadata or prompts for humans, but
they have no authorization meaning and AK must not schedule by them.

## Separation of duty

The old mutually exclusive Leader/Worker types implicitly prevented one Agent
from both executing and accepting the same Task. Uniform Agents with grants no
longer provide that structural separation.

The accepted rule preserves the old separation of duty without retaining Agent
types:

- an authorized management Agent may reject or complete work submitted by a
  different Agent;
- an Agent must not reject or complete a Task assigned to itself;
- a human with the required authority may reject or complete it;
- there is still no assigned reviewer, default reviewer, or review ownership.

### Implementation model

No reviewer-assignment or review-owner record is required. The existing Task
invariants make the assignee sufficient authorization evidence:

- only the assigned Agent may claim and submit the Task for review;
- assignment cannot change while a Task is `in_progress` or `in_review`;
- rejection preserves the assignment.

Therefore the Agent that submitted the current review is necessarily
`assigned_to`.

For `reject` and `complete`, AK enforces all of the following in one
authoritative transition:

1. the caller has the Realmroot task-management grant;
2. the Task is still `in_review`;
3. when the caller is an Agent, its verified Realmroot Agent actor differs
   from `assigned_to`;
4. the conditional state update succeeds, so concurrent decisions cannot both
   consume the same `in_review` state.

The comparison uses the verified caller actor and the stable actor already
stored by the accepted Assignment. It does not perform a second Agency lookup or
trust an Agent id supplied in the decision request.

Human principals have no Agent actor and therefore cannot equal the assignee.
Their ability to decide remains controlled by their grant and tenant authority.
Existing `task_actions` continue to record who submitted, rejected, or
completed work for audit; they are not authorization state.

The implemented v2 Review Submission resource follows this model without
adding reviewer ownership or a new business table. Its representation is
derived from Task state and the single successful `review_requested` audit
action. The transition atomically guards status, assignee, and the
`realmroot_actor` identity discriminator.

## V2 baseline and accepted projection extension

- Realmroot principals preserve controller and Agent actors separately.
- Centralized resource authorization replaces kind-derived route rules.
- New Assignments continue to store the submitted Realmroot Agent subject in
  `assigned_to`; they have no Agency lookup or runtime side effect.
- Claim, Review Submission, Rejection, and Completion use only the
  `realmroot_actor` path; no legacy Claim or decision handler remains.
- Historical Task and action displays are snapshots, so they do not require a
  live local Agent row.
- Local kind, role routing, Maintainer, Agent Session/JWT, mailbox, and
  handoff runtime code are removed. Their stored legacy rows are ignored.
- The three retained Skills describe Toolbox workflows rather than identity
  roles.

The Assignment-to-Claim-to-Review-to-Decision flow directly compares the
verified Realmroot Agent actor with `assigned_to`, records no review owner, and
keeps controller identity separate from the acting Agent. Rejection and
Completion reserve the current Review Submission only to coordinate the Task
transition; authorization never derives from that record.

Removing Leader/Worker types still uses Agency's uniform Agent model and
Realmroot actor chain. AK exposes Agent creation as an Agency-backed projection:
it creates and binds the Agency/Realmroot resources without adding an AK Agent
entity. Agent-principal creation requires the Agency prerequisite recorded in
`04-agent-machine-projections.md`.

## Acceptance boundary

This document is accepted. Exact canonical URIs and OpenAPI scope names belong
to the implementation documents. Toolbox may expose the accepted resource-first `task review`, `task
reject`, and `task complete` command names without adding review ownership or a
review-assignment model.
