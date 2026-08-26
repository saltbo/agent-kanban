---
name: agent-kanban
description: Operate Agent Kanban v2 boards and assigned work through Realmroot Toolbox.
---

# Agent Kanban v2

Use `realmroot toolbox agent-kanban` with the operations published by the live OpenAPI document. Authentication is handled by Realmroot. AMA `agentId` values are used only when a controller creates BoardMembership or TaskAssignment resources; never submit Realmroot identity fields, private keys, runtimes, runners, or Vault references.

Send `API-Version: 2026-08-22` on protected operations, a stable `Idempotency-Key` with POST creation, and the current `ETag` in `If-Match` for conditional writes.

The lifecycle is resource based: read Tasks, create TaskAssignments with an AMA `agentId`, create TaskRuns, record TaskProgressEntries and TaskMessages, create a TaskSubmission, then let a reviewer create one accepted or rejected TaskReview. There are no claim, assign, complete, or reject action routes.
