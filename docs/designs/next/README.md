# Agent Kanban v2 design

This directory is the source of truth for the breaking v2 implementation.

## Accepted product boundary

- Realmroot Remote owns Agent execution and propagates the signed runtime
  Session binding into Toolbox credentials.
- Agency owns Agent, Machine, Environment, Runner, and Session resources.
- AK exposes Agent and Machine product resources as live Agency projections;
  it stores no authoritative Agent or Machine entity.
- AK owns Boards, Repositories, Tasks, Notes, assignment, claim, review, and
  cancellation.
- Assignment records intent only. It does not dispatch or create a Session.
- Claim is performed by the assigned Agent and stores Remote's verified
  `runtime` plus `session_id` binding.
- Any authorized human or Agent may review another Agent's work. The assignee
  cannot reject or complete its own Task.
- AK exposes generic CRUD through Toolbox verb-first operations and only
  lifecycle workflows through resource-first commands.
- The browser reads Agents through AK and does not expose Agent mutation
  controls. It lists and reads Machines, guides AMA Runner installation, and
  creates and archives Machine Environments through AK; it never calls Agency directly. AMA Runner
  remains the only Agency-branded user-facing runtime component.

AK does not own Agency runtime state, compute scheduling, or register Runners,
close Sessions, or ship the `ak` CLI. Agent mutations and Machine archival are
translated to Agency without introducing AK Agent or Machine persistence.

## Implementation order

1. [Toolbox command surface](./01-toolbox-command-surface.md)
2. [Agent authority and separation of duty](./02-agent-role-and-authority.md)
3. [Engineering architecture](./03-engineering-architecture.md)
4. [Agent and Machine projections](./04-agent-machine-projections.md)
5. [Test pyramid and exact-case rule](./05-test-pyramid.md)
6. [Separate v1 upgrade boundary](./06-v1-to-v2-upgrade.md)
7. [Task resource model](./07-task-api-model.md)
8. [Single-package, Remote binding, and BDD cutover](./08-single-package-bdd-cutover.md)

## Session observation

Remote's signed Agent binding contains the runtime and raw runtime Session
identifier. AK stores those values on claim. Agency resolves the exact Session
by the bound Realmroot Agent actor, canonical runtime, and raw identifier. The
organization-wide lookup is authorized only for AK's confidential service
identity; AK then exposes the Session and a read-only event socket to
authenticated board viewers.

The proxy accepts only history-backfill frames from the browser. It never
guesses the latest Agent Session, accepts a caller-supplied Session URL, or
forwards prompt, abort, steer, or approval commands into Agency.

## BDD delivery rule

Change `spec/*.feature` before or with behavior. Every scenario owns a stable
`@capability/...` id and one proof-layer tag. Its proving test contains
`[spec: capability/id]`. Run only the exact cases affected by an edit during
development.
