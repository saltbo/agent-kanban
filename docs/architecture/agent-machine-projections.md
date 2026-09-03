# Agent and Machine projections

AK presents product resources while Agency remains authoritative.

## Agents

`GET /agents` and `GET /agents/{id}` return safe projections with identity,
runtime, model, Skills, identity subject, and Agency's authoritative
`schedulable` state. AK preserves the membership and cursor of each Agency page;
it does not post-filter Agents by lifecycle or identity binding. Identity fields
are null until Agency binds an identity, and the browser marks those Agents as
`Identity not bound`. The browser pages are read-only and the detail page finds
AK Tasks by the projected subject when one exists.

The browser treats the subject as the stable identity key. It discovers the
configured authorization server from AK's protected-resource metadata and, when
that server advertises an `agent_profile_uri_template`, reads the public Agent
profile for the current name, username, and picture. Profiles are query-cached
per subject and are display-only: failure falls back to the Agency projection or
subject and never changes assignment or authorization behavior. Assignment
candidates still require both a bound subject and authoritative `schedulable`
state; visibility in the Agent collection does not imply assignability.

`POST /agents` validates the complete request, creates a same-tenant Realmroot
Identity through Agency, creates the bound Agent, and returns the projection.
Derived upstream idempotency keys make the compound operation replayable. AK
does not publish update or archive operations for existing Agents.

## Machines

A Machine is one self-hosted Agency Environment plus its current Runners.
Collections exclude cloud Environments. The projection aggregates online state,
heartbeat, runtimes, models, and capacity.

Creating a Machine creates the Environment and returns complete `ama-runner`
authentication and start commands with the resolved Project and Environment.
Deleting a Machine archives the Environment; it does not remove local Runner
files. The UI uses focused dialogs for both operations.

## Project resolution and failures

The first projection request ensures the tenant's fixed-name `Agent Kanban`
Project and stores its binding. Agency absence is `404` only after a successful
lookup; authorization denial is `403`, unavailability is `503`, and an invalid
success representation is `502`. No operation falls back to legacy rows.

See [ADR 0006](../adr/0006-agent-and-machine-projections.md) and
[ADR 0007](../adr/0007-lazy-tenant-agency-project.md).
