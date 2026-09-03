# 0011: Keep v1 semantic migration outside the v2 application

Status: accepted

## Context

V1 stored Agents, Machines, Sessions, Maintainers, mailbox state, and runtime
identity that v2 no longer owns. Translating active work inside normal request
paths would add permanent compatibility complexity and ambiguous authority.

## Decision

V2 application code does not read, reconcile, or clean up legacy runtime
entities. Existing rows remain stored. Upgrade commands stop unless every v1
Task is terminal (`done` or `cancelled`) before applying the v2 structural
schema.

Semantic export, archival, external resource retirement, backup, rollback, and
physical cleanup are a separate migration deliverable.

## Consequences

There is no compatibility reader or runtime fallback in v2. Upgrades with
`todo`, `in_progress`, or `in_review` Tasks fail and report the blocking Task
identifiers rather than guessing a new state or actor mapping.
