# Maintainer Memory Guide

This reference defines the memory layout for an AK board maintainer.

The maintainer creates `HEARTBEAT.md` on the first run if it does not already exist. `HEARTBEAT.md` is the map and current state file. It is not the action log and not the proposal system.

Proposals live in the repository issue tracker: GitHub issues for GitHub repositories, GitLab issues for GitLab repositories, or the equivalent issue system for the provider. Do not create proposal files in memory.

## File Layout

- `HEARTBEAT.md`: memory map, current operating state, latest run pointer, next scheduled investigation focus, and retention rules.
- `runs/<timestamp>-<trigger>-<slug>.md`: one concise action log for each scheduled or event-driven maintainer session.
- `summaries/YYYY-MM.md`: compact monthly summary of older run logs.
- `repos/<owner>__<repo>.md`: durable repository profile for one linked repository.
- `topics/<slug>.md`: cross-repository recurring topic, technical debt area, security concern, release concern, or investigation thread.
- `decisions.md`: accepted maintainer decisions that should guide future triage and task creation.

Use lowercase slugs. Replace `/` in repository full names with `__`. Use ISO-like UTC timestamps in run log filenames, for example `runs/2026-06-27T002500Z-scheduled-dependency-audit.md`.

## HEARTBEAT.md Responsibilities

Write these in `HEARTBEAT.md`:

- Board id, maintainer id, and scope rule.
- Memory directory layout and retention policy.
- Repository memory file map.
- Current operating notes that apply across runs.
- Current watchlist and next heuristic investigation focus.
- Repository quality-loop readiness and gaps, or pointers to repository memory files that contain them.
- Latest run log path and short latest run summary.
- Pointers to durable decisions and topic files.
- Open questions that block future maintainer behavior.

Do not write these in `HEARTBEAT.md`:

- Full per-run action logs.
- Proposal bodies or proposal discussion. Use issue tracker issues.
- Raw issue/PR/comment bodies.
- Raw command output, terminal logs, or stack traces.
- Secrets, tokens, private keys, env vars, credential material.
- Large historical transcripts.

## Run Log Responsibilities

Write one run log at the end of every maintainer session, including GitHub event sessions and scheduled heartbeat sessions.

Each run log should contain:

- Trigger type and source.
- Board id and repository scope observed during the run.
- Intent or investigation theme.
- Evidence checked.
- Decisions made.
- Actions taken.
- AK tasks created and assigned.
- Issue tracker replies or proposal issues opened/updated.
- Memory files changed.
- Blockers or permission failures.
- Recommended next focus.

Run logs must be concise. They are for cross-session continuity, not a complete transcript.

## Retention And Compaction

Keep recent run logs granular so the maintainer can reconstruct what happened across sessions.

When `runs/` becomes large, or at the start of a new month:

1. Summarize older run logs into `summaries/YYYY-MM.md`.
2. Preserve durable facts in `repos/`, `topics/`, or `decisions.md`.
3. Keep links to important issue tracker threads and AK tasks.
4. Delete or archive only raw run logs whose durable facts are represented in summaries or subject memory.

Do not compact away unresolved blockers, open watchlist items, accepted decisions, or links needed to avoid duplicate work.

## When To Update Existing Subject Memory

Update an existing repository, topic, or decision file when:

- You learned a new durable fact about a known item.
- A watchlist item changed state.
- A task, issue, PR, or proposal issue outcome changes future maintainer behavior.
- A decision was accepted, rejected, or superseded.

When updating, revise stale text instead of appending a new dated paragraph. Keep only the current understanding plus a short latest-change note when useful.

## When To Create New Subject Memory

Create a new repository or topic memory file only when:

- The subject is likely to recur across future runs.
- The subject is too detailed for `HEARTBEAT.md`.
- The subject needs durable decisions, constraints, links, or follow-up state.
- Keeping it separate will prevent duplicate tasks or repeated issue tracker replies.

Do not create a new subject memory file for one-off observations, raw command output, transient task state, or content that AK or the issue tracker already stores.

## HEARTBEAT.md Template

```markdown
# Maintainer Heartbeat

## Board
- Board: <board-name-or-id> (<board-id>)
- Maintainer: <agent-id>
- Created: <iso-time>
- Scope: all repositories currently returned by `ak get repo --board <board-id>`

## Memory Layout
- `runs/`: one action log per maintainer session.
- `summaries/`: compacted summaries of older run logs.
- `repos/`: durable per-repository memory.
- `topics/`: durable cross-repository investigation memory.
- `decisions.md`: accepted maintainer decisions.
- Proposals: issue tracker only, never memory files.

## Retention Policy
- Keep recent run logs under `runs/`.
- Compact older logs into `summaries/YYYY-MM.md` when `runs/` becomes large or when a month changes.
- Preserve durable facts in `repos/`, `topics/`, or `decisions.md` before deleting or archiving raw logs.

## Operating Notes
- Durable board-level conventions, support rules, compatibility constraints, and maintainer preferences.

## Repository Memory
- `<owner/repo>` -> `repos/<owner>__<repo>.md`

## Quality Loop Status
- `<owner/repo>`: missing | partial | usable | strong; see `repos/<owner>__<repo>.md`

## Current Watchlist
- Items to re-check later. Include enough context and links to avoid duplicates.

## Latest Run
- Log: none
- Time: never
- Trigger: none
- Investigation theme: none
- Summary: none yet
- Actions: none
- Memory changes: none

## Next Run Focus
- Establish the first project baseline.

## Open Questions
- None yet.

## Durable Memory Pointers
- `decisions.md`: accepted maintainer decisions.
```

## Run Log Template

```markdown
# Maintainer Run <iso-time>

## Trigger
- Type: scheduled | github-event
- Source: <schedule | event/action/url>

## Scope
- Board: <board-id>
- Repositories checked: <repo ids/full names>

## Intent
- <investigation theme or event response goal>

## Evidence Checked
- <concise bullets; no raw dumps>

## Decisions
- <what was decided and why>

## Actions
- AK tasks created/assigned: <ids or none>
- Issue replies/proposals: <links or none>
- Memory changes: <files or none>

## Blockers
- <permission failures, missing information, unavailable workers, or none>

## Next Focus
- <recommended next heartbeat focus or follow-up>
```

## Repository Memory Template

```markdown
# <owner/repo>

## Project Role
- What this repository does and why it matters to the board.

## Maintainer Priorities
- Current priorities, quality bars, compatibility constraints, and support policy.

## Quality Loop
- Readiness: missing | partial | usable | strong
- Feature spec path: <path or none>
- Agent/docs paths: <AGENTS.md/docs paths or none>
- Main verification command: <command or none>
- CI: <workflow/status or none>
- Critical gaps: <bullets>
- Last audited: <iso-time>

## Known Risks
- Durable bugs, security/dependency concerns, flaky areas, or technical debt.

## Active Threads
- Issue tracker threads, PRs, AK tasks, and decisions that future runs must remember.

## Last Reviewed
- Time: <iso-time>
- Summary: <short current-state summary>
```
