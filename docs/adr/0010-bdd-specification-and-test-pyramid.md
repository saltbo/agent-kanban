# 0010: Govern product behavior with BDD specs and a test pyramid

Status: accepted

## Context

The system crosses domain, database, HTTP, Toolbox, browser, Realmroot, and
Agency boundaries. Full-suite feedback is too slow for ordinary iteration, and
duplicating the same cases at every layer makes tests expensive and brittle.

## Decision

`spec/*.feature` is the source of truth for observable product behavior. Every
scenario has one stable id, one proof layer, and at least one test breadcrumb
`[spec: <id>]` in that layer. A repository check rejects missing, misplaced,
duplicate, and orphaned traceability.

Place each case at the lowest layer that can prove it through a stable boundary.
Use higher layers only for risk owned by that boundary. During development,
state the behavior at risk and run the smallest exact cases that prove it;
whole files, layers, and suites are not the default.

## Consequences

Feature files describe behavior rather than implementation steps. Unit tests
own rule matrices, integration tests own real boundary behavior, contract tests
own schema/runtime agreement, and only critical user journeys reach browser or
deployed acceptance tests. CI may remain broader than the Agent development
loop.
