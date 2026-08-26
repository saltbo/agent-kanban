# TODOS

## API

### GitHub PR Status Integration

### GitHub PR Status Integration

**What:** Fetch and cache PR status (open/merged/closed) from GitHub API. Display colored badge on task cards with `pr_url`.

**Why:** Closes the feedback loop — board shows "code actually shipped" not just "agent says done." Users can see at a glance which PRs merged.

**Context:** CEO plan specified: `pr_status_cache` D1 table (pr_url PK, status, fetched_at), stale-while-revalidate via CF `waitUntil()`, 60s TTL with GITHUB_TOKEN / 5min without, refresh only on individual task reads. Optional `GITHUB_TOKEN` CF env var. Graceful degradation: if no token or GitHub unreachable, show `pr_url` as plain link. Deferred from v1 — adds external API dependency and cache management complexity.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Pagination on List Endpoints

**What:** Cursor-based pagination on `GET /api/tasks` and `GET /api/boards` with `after=<id>&limit=20` params.

**Why:** Prevents unbounded response sizes as task count grows. Required before task count hits hundreds.

**Context:** CEO plan specified: default limit 50, max 100, `next_cursor` field in response (null if no more). CLI auto-paginates by default, `--limit N` to cap. Deferred from v1 — unnecessary at personal scale initially.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Task Archiving

**What:** Add `archived_at TEXT` column. `PATCH /api/tasks/:id` with `{ archived: true }` sets timestamp. Archived tasks excluded from lists by default, `?include_archived=true` to include.

**Why:** Clean board UX once completed tasks accumulate. Soft-delete without losing history.

**Context:** CEO plan specified: CLI commands `task archive <id>` and `task list --archived`. Deferred from v1 — not needed until enough tasks accumulate to clutter the board.

**Effort:** S
**Priority:** P4
**Depends on:** None

## Web UI

### Keyboard Shortcuts

**What:** Custom `useKeyboardShortcuts` React hook with n (new task), / (search), arrows (navigate), Enter (open detail), Esc (close), 1-9 (move to column N), ? (help overlay).

**Why:** Power-user UX. Screenshot-worthy for demos. Browser-agent-friendly (navigate by keyboard).

**Context:** CEO plan specified: disabled when text input is focused. Deferred from v1 — polish feature, not core functionality.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Drag-and-Drop for Kanban Board

**What:** Add drag-and-drop to move cards between columns using @dnd-kit/core.

**Why:** Expected UX for kanban boards. Natural way for humans to manually move tasks between columns.

**Context:** Deferred from v1 per design review — agents are the primary card movers (via /claim and /complete API). Humans rarely need manual column moves. Currently, cards are moved via a dropdown in the detail slide-out panel. Implementation is ~100 lines with @dnd-kit. Desktop only — mobile uses tab switcher where drag doesn't apply.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed

### Full Design System (DESIGN.md)

**What:** Run `/design-consultation` to create a proper DESIGN.md with full visual language — typography scale, color system, spacing rules, component patterns, motion guidelines.

**Why:** v1 uses minimum viable design tokens (Inter, shadcn/ui defaults). Before adding more UI features in v2, the product needs a stronger visual identity to avoid "generic SaaS" look.

**Context:** Design review rated design system alignment 7/10 with current tokens. A proper DESIGN.md would bring it to 10/10 and ensure consistency as the UI grows. Should be done before v2 UI work (keyboard shortcuts, drag-and-drop, PR status badges, etc.).

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** v1.0.0 (2026-03-20)

### Task Dependency Chains

**What:** `depends_on` JSON array field, cycle detection via recursive CTE, blocked UI badge, 409 on /claim with unmet dependencies.

**Effort:** M
**Priority:** P2
**Completed:** v1.2.0 (2026-03-20)

### Task Origin Tracking (created_from)

**What:** `created_from` field linking subtasks to parents, subtask list in UI, CLI `--parent` flag.

**Effort:** S
**Priority:** P2
**Completed:** v1.2.0 (2026-03-20)

### Stale Claim Detection

**What:** Auto-release tasks claimed >2 hours, write-on-read pattern, agent set to offline.

**Effort:** S
**Priority:** P3
**Completed:** v1.2.0 (2026-03-20)
