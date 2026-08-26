# Agent Kanban v2 Product Experience Test Plan

## Application Overview

Agent Kanban v2 retains the complete v1 browser product shell while changing
the ownership behind it. AK owns Boards, Tasks, Labels, Repositories,
Memberships, Assignments, Runs, Progress, Messages, Submissions, and Reviews.
AMA owns Agents, Environments, Runners, Sessions, runtime configuration, and
Realmroot identity provisioning. The browser reaches AMA only through
connection-scoped, session-authenticated `/api/console` BFF resources; these
resources are not published in the AK Toolbox OpenAPI.

The archived v1 experience is a behavior reference, not a source dependency.
The v2 application must not restore AK Agent/Machine persistence, leader/worker
identity kinds, local Agent keys, `ak start`, the AK CLI, or the daemon.

## Baseline Inventory

| Product surface | v1 behavior to retain | Current v2 baseline | Required v2 ownership |
| --- | --- | --- | --- |
| Application shell | Route-aware header, Board switcher, Agents, Machines, Repositories, Settings, theme and sign-out | One route-less Board screen | Browser shell + Realmroot BFF session |
| Board | `/boards/:boardId`, five columns, filters, responsive single-column tabs, task detail sheet | Five columns at `/`, selector, detail aside | AK resources |
| Task detail | Brief, assignment, execution state, progress, messages, artifacts, review history, reject/complete | Observability and review exist | AK resources; AMA Session URI is display-only |
| Board management | Create/switch Board, edit/delete Board, Labels | Missing | AK resources; forms remain dialog/secondary routes |
| Agents | List, detail, create/edit, Sessions and failure/empty states | Missing | AMA Agent resources through console BFF |
| Machines | List/detail/add/remove, status, runtime availability and linked Agents | Missing | AMA Environment product projection with read-only Runner/Session aggregation |
| Repositories | List, create, validation, remove, failure/empty states | Missing | AK Repository resources |
| Browser quality | Desktop and mobile navigation, keyboard dialogs/sheets, theme, responsive columns | Task drawer/review focus and reduced motion only | Shared accessible shell and feature surfaces |

## Required Browser BFF Resources

These paths are session-authenticated product projections and must stay absent
from `/api/openapi.json` and Realmroot Toolbox discovery:

- `/api/console/ama-projects`
- `/api/console/ama-connections/{connectionId}/agents`
- `/api/console/ama-connections/{connectionId}/environments`
- `/api/console/ama-connections/{connectionId}/machines`
- `/api/console/ama-connections/{connectionId}/runners`
- `/api/console/ama-connections/{connectionId}/sessions`

Collection responses use `{ items, pagination }`. AMA resource projections
retain canonical `metadata.uid`, `metadata.projectId`, `spec`, and `status`.
Machine projections use `{ environment, runners, sessions, agents }`; status,
capacity, runtime availability, and session counts are derived from those
embedded authoritative AMA resources, never stored by AK.

Every console response must normalize downstream failures into a stable Problem
Details response while preserving `Request-Id`. The UI distinguishes missing
connection, missing/revoked AMA grant, forbidden, unavailable, invalid upstream
payload, empty collection, and background-refresh failure.

## Test Scenarios

### 1. Routing and Navigation

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 1.1. protected-product-routes

**File:** `tests/v2/e2e/product-shell.spec.ts`

**Steps:**

1. Sign in and navigate through the product header.
   - expect: Board, Agents, Machines, Repositories, and Settings are reachable by keyboard.
   - expect: `/boards/:boardId`, `/agents`, `/machines`, `/repositories`, and `/settings/profile` preserve their URL after reload.
   - expect: the current route has an accessible page heading and active navigation state.
2. Clear the session and open each protected URL directly.
   - expect: the Realmroot sign-in boundary preserves the original return path.

#### 1.2. responsive-product-navigation

**File:** `tests/v2/e2e/product-responsive.spec.ts`

**Steps:**

1. Open the application at desktop width.
   - expect: the persistent header exposes all product destinations.
2. Open at a narrow mobile width and with 200% browser zoom equivalent.
   - expect: every product destination remains reachable through an accessible mobile navigation control.
   - expect: no horizontal document overflow or clipped focused control exists.

#### 1.4. legacy-agent-and-administration-surfaces-stay-absent

**File:** `tests/v2/e2e/legacy-surfaces-absent.spec.ts`

**Steps:**

1. Open the restored Agents, Machines, Board, and account navigation surfaces.
   - expect: no leader, worker, subagent, daemon, `ak start`, GitHub App, admin, or maintainer action or label is rendered.
   - expect: legacy `/admin` and Board-maintainer bookmarks are not routable product pages.
2. Navigate between AMA-backed pages with an explicit `connection` query.
   - expect: links, dedicated create/edit/detail pages, reload, and back navigation preserve the selected connection.

### 2. Board and Task Experience

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 2.1. board-switch-management-and-responsive-columns

**File:** `tests/v2/e2e/board-product.spec.ts`

**Steps:**

1. Open `/boards/board-main` and switch Boards.
   - expect: five lifecycle columns and all cards render from AK.
   - expect: Board selection changes the URL and browser back restores the prior Board.
2. Create a Board from the switcher dialog.
   - expect: pending and duplicate submission are visible and prevented.
   - expect: success navigates to the canonical new Board route.
3. Resize to mobile.
   - expect: one status column is visible at a time and status tabs remain keyboard operable.
   - expect: no drag/status/assignment controls are introduced on the Board.

#### 2.2. complete-task-detail-and-review

**File:** `tests/v2/e2e/task-detail-product.spec.ts`

**Steps:**

1. Open a Task card.
   - expect: brief, Repository, dependencies, labels, assignment, Run, progress, messages, submissions/artifacts, and review history are visible.
   - expect: detail data is not fetched before selection and refreshes without closing when the Task status is unchanged.
2. Use Escape and the close control.
   - expect: the sheet closes and restores focus to the originating card.
3. Reject and then complete pending work.
   - expect: dialog focus is trapped/restored, duplicate review submission is prevented, and the Board reconciles to the server state.
4. Make one detail dependency fail during refresh.
   - expect: existing data stays visible with a scoped stale/error state and an explicit retry.

#### 2.3. board-settings-labels-and-errors

**File:** `tests/v2/e2e/board-settings-product.spec.ts`

**Steps:**

1. Edit a Board on `/boards/:boardId/settings` and manage Labels on `/boards/:boardId/labels`.
   - expect: unchanged forms cannot submit; validation and conditional-write conflicts remain in the owning form.
2. Delete a Board through an ID-confirmation dialog.
   - expect: destructive intent, pending state, cancellation, and focus restoration are explicit.
3. Return protocol, authorization, and unavailable failures.
   - expect: stable, actionable states are rendered without losing unaffected navigation.

### 3. AMA Agents

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 3.1. ama-agent-list-detail-and-sessions

**File:** `tests/v2/e2e/agents-product.spec.ts`

**Steps:**

1. Open `/agents` with active, provisioning, unavailable, and retired AMA Agents.
   - expect: cards show name, runtime/model, canonical Realmroot identity, readiness, and lifecycle without leader/worker kinds.
2. Open `/agents/:id`.
   - expect: configuration, stable identity, provisioning/retirement state, and AMA Sessions are visible.
   - expect: Session links and pagination use the selected AMA connection/project.
3. Return an empty collection and an invalid AMA payload.
   - expect: an intentional empty state and a distinct contract-failure state render.

#### 3.2. ama-agent-create-edit-retire

**File:** `tests/v2/e2e/agent-management-product.spec.ts`

**Steps:**

1. Create an Agent on `/agents/new`.
   - expect: runtime, model, prompt, tools, skills, and Environment are configurable on a dedicated secondary page.
   - expect: no Realmroot identity ID, key, credential reference, issuer, or subject input is present.
   - expect: provisioning is shown until AMA reports `ready` and then navigates to `/agents/:id`.
2. Edit an Agent on `/agents/:id/edit`.
   - expect: server validation, conflict, pending, and duplicate-submit states are explicit.
3. Retire an Agent from its detail page.
   - expect: a destructive confirmation explains Realmroot identity and managed Vault retirement.
   - expect: success shows the AMA retired state and removes the Agent from active scheduling views.

#### 3.3. ama-agent-boundary-failures

**File:** `tests/v2/e2e/agent-failures-product.spec.ts`

**Steps:**

1. Return missing connection, missing/revoked grant, forbidden, unavailable, and invalid-payload responses.
   - expect: each stable category has a distinct action: connect AMA, reauthorize, request access, retry, or report contract drift.
   - expect: no failure silently falls back to AK Agent data or stale identity definitions.

### 4. AMA Machine Projection

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 4.1. machine-list-and-detail-aggregation

**File:** `tests/v2/e2e/machines-product.spec.ts`

**Steps:**

1. Open `/machines` with multiple AMA Environments and Runners.
   - expect: each Machine is identified by Environment and derives online/offline, capacity, runtimes, models, heartbeat, and active Session count from associated resources.
2. Open `/machines/:environmentId`.
   - expect: Environment configuration, associated Runners, runtime availability, Sessions, and Agent links are visible.
   - expect: an Environment without a live Runner has an offline state and `ama-runner` reconnect guidance.

#### 4.2. machine-create-and-delete-environment

**File:** `tests/v2/e2e/machine-management-product.spec.ts`

**Steps:**

1. Open Add Machine.
   - expect: local setup creates/selects an AMA Environment and displays an `ama-runner` command, never `ak start` or an AK daemon command.
   - expect: cloud setup creates an AMA cloud Environment when supported.
2. Delete a Machine from detail.
   - expect: the confirmation identifies the Environment and the effect on Runners/Sessions.
   - expect: only the AMA Environment delete/archive operation is sent; AK creates no Machine record.

#### 4.3. machine-aggregation-failures

**File:** `tests/v2/e2e/machine-failures-product.spec.ts`

**Steps:**

1. Fail only Runner or Session aggregation while Environment data succeeds.
   - expect: the Environment remains visible with a scoped partial-data warning.
2. Fail the Environment source or return an invalid aggregate.
   - expect: a route-level retryable error or contract-failure state renders.

### 5. Repositories

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 5.1. repository-list-create-and-remove

**File:** `tests/v2/e2e/repositories-product.spec.ts`

**Steps:**

1. Open `/repositories` with empty and populated AK collections.
   - expect: Repository URL, default branch, and related Task count are visible.
2. Create a Repository in a modal.
   - expect: validation, pending, duplicate submission, protocol failure, and input preservation are explicit.
3. Remove an unused Repository through confirmation.
   - expect: cancellation restores focus and success removes it from the list.
4. Attempt to remove a referenced Repository.
   - expect: the conflict is rendered in the confirmation surface without optimistic removal.

### 6. Accessibility and Browser Quality

**Seed:** `tests/v2/helpers/e2e-server.mjs`

#### 6.1. keyboard-focus-motion-and-semantics

**File:** `tests/v2/e2e/accessibility-product.spec.ts`

**Steps:**

1. Traverse the shell, Board, dialogs, sheets, tables, tabs, and cards with the keyboard.
   - expect: landmarks, headings, names, current route, focus order, trapping, restoration, and live error announcements are correct.
2. Enable reduced motion and forced colors.
   - expect: animations are removed and state remains perceivable without color alone.
3. Run automated accessibility scanning on every stable route state.
   - expect: no serious or critical WCAG 2.2 AA violation is reported.

## Initial Red Boundary

The current v2 application should fail first on route-aware product navigation:
`/boards/board-main`, `/agents`, `/machines`, `/repositories`, and
`/settings/profile` all render the same route-less Board application and there
is no console AMA transport. These failures are product gaps, not locator drift.
