# Product principles

Agent Kanban helps people understand and review work carried out by Agents.
These principles explain the product's direction when choosing between designs;
concrete behavior remains in [Spec](../spec/README.md), and architectural
choices remain in [ADRs](adr/README.md).

## Agent execution, human visibility

The board primarily supports scanning progress, understanding what happened,
and reviewing results. Task details should make relevant notes, execution
activity, and review evidence easy to find.

The current product leaves task creation, assignment, and execution operations
to Agents through Realmroot Toolbox. Its task UI centers on observation and
review, rather than offering every API operation as a button. This explains
why task creation forms, claim/assign/cancel controls, and drag-to-change task
state or ordering are not part of the current board experience. It does not
make every page read-only: board and repository configuration serve a different
purpose. Evaluate proposed changes against the user need and relevant scenarios
rather than applying “read-only” as a blanket rule.

## Clear work surfaces

Prefer primary pages that make existing work easy to browse and operate.
Create, edit, and configuration flows generally fit a dialog, sheet, or
secondary page; search, filtering, and contextual actions belong with the
content they affect. Choose the surface for the task's complexity and context,
using the existing design when it works. An unrelated fix is not a reason to
rearrange an established page.

Use [DESIGN.md](../DESIGN.md) for visual language and interaction details.
Review the affected experience in scope; unrelated design drift need not turn
a small change into a redesign.

## Explain execution without duplicating its owner

AK connects task progress and review evidence to execution supplied by the
runtime system. Favor a clear view of that relationship over growing a second
runtime control surface inside the board. For the actual ownership and Session
boundaries, consult [the system overview](architecture/system-overview.md) and
[Session observation](architecture/session-observation.md).
