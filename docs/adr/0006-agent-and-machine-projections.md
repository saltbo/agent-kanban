# 0006: Expose Agents and Machines as live Agency projections

Status: accepted

## Context

Users and Agents must discover schedulable assignees and manage self-hosted
capacity without learning Agency's resource model. AK must not restore its v1
Agent and Machine entities.

## Decision

AK exposes tenant-scoped Agent and Machine resources assembled from Agency.
Agent list/detail are read-only in the browser; the public API also supports
Agent creation by creating a Realmroot Identity and its bound Agency Agent.
Existing Agent mutation is not published without an authoritative atomic
precondition.

A Machine is an Agency self-hosted Environment enriched with live Runner state.
AK supports list, detail, creation, and archival. Creation returns complete
AMA Runner authentication and start commands containing the resolved Project
and Environment identifiers. Cloud capacity is not represented as a Machine.

Agency's `schedulable` value is authoritative and infrastructure-only. Task
assignment stores the selected projection's Realmroot `subject`; it does not
call Agency or revalidate schedulability.

## Consequences

AK stores no authoritative Agent or Machine row and never reads legacy rows for
these resources. Upstream failure fails the affected operation explicitly;
there is no stale or legacy fallback. Representations omit downstream secrets,
credential references, and internal transport data.
