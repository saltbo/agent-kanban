# 0004: Model worker and reviewer authority as Task relationships

Status: accepted

## Context

The former Leader and Worker Agent types combined runtime identity, Task
relationship, and authorization. Agency has one Agent model, and Realmroot
already supplies grants and the verified acting Agent.

## Decision

AK has no Leader, Worker, Maintainer, reviewer-owner, or local Agent-role model.
Any schedulable projected Agent may be assigned a Task. Assignment stores its
stable Realmroot subject directly and has no runtime-dispatch side effect.

Only the assignee may claim and submit review. An authorized human or another
authorized Agent may reject or complete the current submission. An Agent may
not reject or complete a Task assigned to itself. The comparison uses the
verified caller actor and `assigned_to`; audit actions are evidence, not
authorization state.

## Consequences

Skills describe behavior but grant no authority. Realmroot grants provide
coarse capabilities and AK enforces Task state and relationships. Assignment
cannot change while work or review is active, so no separate review submission
owner is needed.
