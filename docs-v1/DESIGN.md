# Design System — Agent Kanban

## Product Context
- **What this is:** An agent-first cross-project kanban board. Mission control for your AI workforce.
- **Who it's for:** Developers who use AI coding agents (Claude Code, Codex, Gemini CLI, GitHub Copilot, Hermes) daily.
- **Space/industry:** Developer tools, project management. Peers: Linear, Trello, Notion. Differentiator: agents are first-class citizens.
- **Project type:** Web app (dashboard / monitoring tool) + CLI

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian — function-first, data-aware, monospace accents
- **Decoration level:** Minimal — typography and spacing do the work. No gradients, no glassmorphism, no decorative borders. Surfaces separated by shade, not lines.
- **Mood:** A spacecraft dashboard, not a SaaS landing page. Serious, focused, alive when agents work. The board should feel like a window into active AI work.
- **Reference sites:** [Linear](https://linear.app), [Raycast](https://raycast.com), [Warp](https://warp.dev), [Vercel](https://vercel.com)

## Typography
- **Display/Hero:** Geist (700) — clean, modern, excellent at large sizes. letter-spacing: -0.03em
- **Body:** Geist (400/500) — same family for coherence. 14px base, line-height 1.6
- **UI/Labels:** Geist (500/600) — 12-13px, used for column headers, field labels, nav items
- **Data/Tables:** Geist Mono (400) — tabular-nums, 13px. For task IDs, durations, timestamps
- **Code/Agent logs:** Geist Mono (400) — 12-13px. Agent output renders in monospace
- **Loading:** Google Fonts CDN: `family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600`
- **Scale:**
  - 3xl: 56px / 700 — hero (letter-spacing: -0.03em)
  - 2xl: 28px / 700 — section titles (letter-spacing: -0.02em)
  - xl: 18px / 600 — panel titles
  - lg: 15px / 600 — card titles, nav
  - md: 14px / 400 — body text
  - sm: 13px / 500 — UI labels, buttons
  - xs: 12px / 500 — column headers, field labels
  - 2xs: 11px / 500 — badges, metadata, section labels (Geist Mono, uppercase, letter-spacing: 0.04-0.08em)

## Color

### Approach: Restrained
Color is rare and meaningful. The cyan accent is reserved for agent activity and interactive elements. Everything else is monochrome.

### Dark Mode (default)
- **Background primary:** #09090B — app background
- **Background secondary:** #18181B — cards, surfaces, panels
- **Background tertiary:** #27272A — elevated surfaces, hover states
- **Text primary:** #FAFAFA — headings, primary content
- **Text secondary:** #A1A1AA — body text, descriptions
- **Text tertiary:** #71717A — metadata, placeholders, disabled
- **Border:** #27272A — subtle dividers, card borders
- **Accent:** #22D3EE — cyan. Primary interactive color. Agent identity.
- **Accent soft:** rgba(34, 211, 238, 0.1) — accent backgrounds (chips, badges)
- **Accent glow:** rgba(34, 211, 238, 0.12) — agent-active card box-shadow

### Light Mode
- **Background primary:** #FAFAFA
- **Background secondary:** #F4F4F5
- **Background tertiary:** #E4E4E7
- **Background card:** #FFFFFF
- **Text primary:** #09090B
- **Text secondary:** #52525B
- **Text tertiary:** #A1A1AA
- **Border:** #E4E4E7
- **Accent:** #0891B2 — darker cyan for light backgrounds (WCAG AA contrast)
- **Accent soft:** rgba(8, 145, 178, 0.1)
- **Accent glow:** rgba(34, 211, 238, 0.15)

### Semantic Colors (both modes)
- **Success:** #22C55E — task completed, positive status
- **Warning:** #EAB308 — stale agent, warnings
- **Error:** #EF4444 — failures, destructive actions
- **Info:** same as accent (#22D3EE dark / #0891B2 light)

### Label Colors
Board labels use user-selected hex colors with low-opacity backgrounds and restrained borders.

### Dark Mode Strategy
Dark is the default. Light mode uses the same hue relationships with adjusted lightness for readability. Accent shifts from #22D3EE (bright cyan) to #0891B2 (deeper cyan) to maintain WCAG AA contrast on light backgrounds.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — not cramped (not a trading terminal) but not wasteful (kanban needs screen real estate)
- **Scale:**
  - 2xs: 2px
  - xs: 4px
  - sm: 8px
  - md: 16px
  - lg: 24px
  - xl: 32px
  - 2xl: 48px
  - 3xl: 64px
- **Card padding:** 12px (p-3)
- **Column gap:** 16px (gap-4)
- **Section spacing:** 16px (space-y-4)

## Layout
- **Approach:** Grid-disciplined — strict columns for the kanban board, predictable alignment
- **Grid:** 5 equal columns (kanban: Todo, In Progress, In Review, Done, Cancelled), 12-column grid for other layouts
- **Max content width:** 1200px
- **Border radius:**
  - sm: 4px — badges, small chips
  - md: 8px — cards, buttons, inputs
  - lg: 12px — panels, modals, major containers
  - full: 9999px — circular elements (avatar dots)
- **Breakpoints:**
  - Desktop: ≥1024px — 3 columns, slide-out panel 50% width
  - Tablet: 768-1023px — 3 columns (narrower), panel 70% width, filter bar collapses
  - Mobile: <768px — tab switcher (Todo | In Progress | In Review | Done | Cancelled), full-screen detail

## Motion
- **Approach:** Intentional — card transitions on poll refresh are the magic moment. Everything else is functional.
- **Easing:**
  - Enter: ease-out (elements appearing)
  - Exit: ease-in (elements leaving)
  - Move: ease-in-out (card column transitions)
- **Duration:**
  - Micro: 50-100ms — hover states, focus rings
  - Short: 150-250ms — button clicks, dropdowns, tooltips
  - Medium: 250-400ms — card column transitions, slide-out panel open/close
  - Long: 400-700ms — skeleton shimmer cycle
- **Special effects:**
  - Agent-active card glow: `box-shadow: 0 0 20px rgba(34, 211, 238, 0.12), 0 0 40px rgba(34, 211, 238, 0.05)`
  - Agent dot pulse: 2s ease-in-out infinite opacity animation (1 → 0.4 → 1)
  - Card creation highlight: brief cyan border flash, 1s fade
  - Skeleton shimmer: gradient sweep, 1.5s infinite

## Agent Visual Identity
Agents are first-class citizens in the UI. Their activity should be visually distinct from human activity:
- **Agent-claimed cards:** cyan accent border + subtle radial glow
- **Agent name:** displayed in Geist Mono, cyan color, with pulsing dot indicator
- **Agent log entries:** monospace font, slightly different background, left border in cyan
- **System log entries:** standard font, left border in gray
- **"In Progress" column:** header text turns cyan when any card was updated in last 5 minutes

## Component Library
Built on **shadcn/ui** (Tailwind + Radix UI primitives):
- Card, Badge, Button, Input, Sheet (slide-out panel), Skeleton
- DropdownMenu (filter dropdowns)
- Toast (errors only, not success — card appearance IS the success confirmation)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-20 | Cyan (#22D3EE) as primary accent | Every dev tool uses blue. Cyan reads as "digital," "machine," "active" — fits agent identity. Stands out in screenshots. |
| 2026-03-20 | Geist + Geist Mono | Inter is invisible (everything uses it). Geist has character without being distracting. Mono variant is perfect for agent logs. |
| 2026-03-20 | Agent glow effect on cards | The board should literally light up when agents work. This is the product's magic moment. Subtle enough to avoid gimmick, strong enough to notice. |
| 2026-03-20 | Dark mode first | Category baseline — every dev tool defaults dark. Light mode exists but dark is home. |
| 2026-03-20 | Restrained color | Color is rare and meaningful. The monochrome foundation makes cyan accents pop. Agent activity stands out because everything else is quiet. |
| 2026-03-20 | Industrial/Utilitarian aesthetic | This is mission control, not a SaaS landing page. Every pixel earns its place. |
