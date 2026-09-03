# 0005: Keep Agency and Remote behind a one-way infrastructure boundary

Status: accepted

## Context

Agent execution, scheduling, Machines, and Sessions already belong to Agency
and Realmroot Remote. Recreating those entities or dispatch behavior in AK
would introduce two sources of truth and a reverse dependency.

## Decision

Agency owns Projects, Identities, Agents, Environments, Runners, and Sessions.
Realmroot Remote starts and hosts Agent Sessions and places signed runtime and
Session provenance in the Agent binding. AK depends on their generic contracts;
Agency and Remote contain no AK-specific configuration, names, routes,
authorization branches, or compatibility behavior.

AK does not create or close Sessions, register Runners, compute scheduling, or
send runtime commands. Task assignment records intent only.

## Consequences

Agency availability is an explicit dependency only for operations that need a
live projection or Session. AK cannot fall back to legacy runtime data. Product
specific adaptation, naming, and policy stay in AK.
