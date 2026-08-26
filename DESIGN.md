# Design System — Agent Kanban v2

## Product surface

The browser is the complete Agent Kanban product workspace. It owns the Board and Task coordination experience and presents AMA-owned Agents, Environments, Runners, runtimes, and Sessions as integrated product surfaces. Domain ownership does not dictate navigation: Agents and Machines remain first-class AK pages while their definitions and runtime state stay in AMA. Realmroot remains the identity and authorization authority.

## Information architecture

- Preserve the established Agent Kanban v1 information architecture, density, interaction patterns, component styling, and visual identity. v2 changes resource ownership, not the product shell.
- One compact header identifies Agent Kanban, switches Boards, and links to Agents, Machines, Repositories, and Settings.
- A Board selector sits above the work area; switching Boards is the primary navigation action.
- The Board has exactly five columns: Todo, Queued, In Progress, In Review, and Done.
- Task cards optimize scanning: title, stable task identifier, priority, assignment/run state, and blocking state only.
- Selecting a card opens a right-side detail drawer. The Board remains visible behind it.
- Progress, messages, run state, artifacts, and review history are sections inside the detail drawer.
- Create/edit/configuration forms use modal, drawer, or dedicated secondary pages; primary pages remain optimized for browsing and operation.
- Agents supports list, create, inspect, edit, and retire through the selected AMA Connection.
- Machines is the product projection of AMA Environments plus associated Runners, runtime capability, heartbeat/load, and Sessions.
- Repositories remains a first-class AK resource surface.

## Visual language

- Direction: industrial/utilitarian mission control. Function-first, data-aware, with restrained decoration and monospace accents.
- Background: `#09090B`; elevated surface: `#18181B`; border/subtle surface: `#27272A`.
- Primary text: `#FAFAFA`; secondary text: `#A1A1AA`; muted text: `#71717A`.
- Cyan `#22D3EE` is the sole primary accent for selection, focus, active execution, and links.
- Yellow `#EAB308` denotes review attention; red `#EF4444` denotes errors or rejection; green is reserved for accepted/done outcomes.
- Use Geist Variable for UI text and Geist Mono for stable identifiers, Agent names, protocol/status labels, telemetry, and logs.
- Corners stay compact: 4px for controls/status labels, 8px for cards, 12px for drawers and dialogs.
- Retain the established deterministic Agent identicons, identity color bars, fingerprint/subject watermark, active-card glow, and low-key presence pulse. These are product identity, not decorative replacement UI.
- Shadows stay restrained outside the existing Agent-active glow. Do not use decorative gradients or glass effects.

## Interaction and accessibility

- Every interactive element has a visible keyboard focus ring using cyan with sufficient contrast.
- Cards are buttons with an accessible name; Escape closes drawer or dialog; modal focus is trapped and restored.
- Status is always expressed in text, never by color alone.
- Loading, empty, authentication, authorization, protocol, and network failures are explicit states rather than silent fallbacks.
- The layout scrolls horizontally below tablet width; the detail drawer becomes full-width on mobile.
- Honor reduced-motion preferences. Motion is limited to short drawer/dialog transitions and an optional low-key running indicator.

## Non-goals

No leader/worker identity roles, AK-owned Agent or Machine records, AK daemon controls, `ak start`, or local Agent keys belong in v2. Removing those backend concepts must not remove the established Agents or Machines product surfaces. Runtime selection shown in Agent management is AMA configuration. Machine setup always uses `ama-runner`. Task status remains lifecycle-driven rather than arbitrary drag-and-drop mutation.
