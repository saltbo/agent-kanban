# 0007: Lazily bind each AK tenant to an Agency Project

Status: accepted

## Context

Agent and Machine projections require an Agency Project. Creating it during
login would make basic AK access depend on Agency availability, while allowing
callers to choose Projects would expose infrastructure details and risk tenant
mix-ups.

## Decision

The first projection operation creates or reuses an Agency Project named
`Agent Kanban` and stores one tenant-to-Project binding in AK. A bounded D1
claim coordinates concurrent first requests so only the winning binding is
persisted. Later operations resolve the stored binding.

The Project belongs to the same Realmroot tenant as the AK caller. AK does not
support cross-tenant Identity binding or a platform-owned shared Project.

## Consequences

Login and ordinary board access remain available when Agency is unavailable.
The first Agent or Machine operation may fail explicitly or ask the caller to
retry while another request initializes the binding. Users never select or
enter a Project identifier.
