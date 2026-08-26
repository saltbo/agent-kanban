---
status: ACTIVE
created: 2026-04-19
---

# Landing Page Brief — Agent Kanban

Design brief for the `/` landing page redesign. Current page at `apps/web/src/routes/LandingPage.tsx` has stale copy and no clear conversion thesis. This brief is the single source of truth for the redesign.

## North Star

**Human out of the loop.** Every copy, visual, and structural decision serves this thesis.

The emotional promise underneath: **one hour to plan, one hour to review, agents handle the other six.** Concrete, measurable, every heavy agent user feels that pain today.

## Audience

Developers who already drive Claude Code / Codex / Gemini daily. They've already asked themselves "do I really have to review every diff?" The page is a filter, not a tutorial. Do not explain what an AI coding agent is.

## Conversion Goals

- **Primary**: ★ on GitHub — grow mindshare first. Star-psychology drivers: technical credibility, a shareable thesis, a visual worth screenshotting.
- **Secondary**: sign-up on agent-kanban.dev (hosted as the low-friction option for those who want to try it the same day)

Default CTA is `★ on GitHub`. `Start for free` sits next to it as a sibling. Self-host instructions are promoted to first-class, not hedged as footer text — this audience will mostly self-host, and fighting that costs more stars than it saves sign-ups.

Hosted has no feature advantage over self-host — we do not pretend otherwise. When it shows up, we sell it on one honest line: "skip 30 minutes of Cloudflare setup."

## Positioning vs Vibe Kanban (level B — imply, don't name)

A single transition sentence carries the differentiation. Do not build a comparison table, do not name the product:

> Most AI kanban tools pull you deeper into the loop — inline diffs, inline comments, built-in browsers. Agent Kanban pulls you out. One hour in. One hour out. That's the deal.

Insiders recognize the contrast. Outsiders don't miss a beat.

---

## Page Structure (one-pager, Linear density)

### 1. Hero

- **H1**: `Human out of the loop.`
- **H2** (sub, large): `One hour to plan. One hour to review. Agents handle the other six.`
- **Primary CTA**: `★ <count> on GitHub`
- **Secondary**: `Try it hosted →` (links to agent-kanban.dev sign-up)
- **Tertiary** (small text below): `Or run it yourself — npx wrangler deploy`
- **Visual**: DemoBoard animation embedded right or below (existing asset, 75s multi-agent sequence in `apps/web/src/components/DemoBoard.tsx`)

### 2. A day on Agent Kanban

The emotional anchor. Timeline visual, monospace column:

```
09:00  /ak-plan v1.4 "ship auth redesign"        ← you
09:30  Atlas claims · Nova claims · Forge claims  ← agents
12:00  3 PRs opened                               ← agents
15:00  You open the laptop
15:30  Leader reviewed 2 · you review 1 · merge
16:00  Board green. You close the laptop.
```

One line caption below: `That's the whole day.`

No feature bullets in this section. The timeline is the pitch.

### 3. The things you no longer do.

Two-column table. Mechanism section — proves the thesis with concrete features:

| You no longer | Because |
|---|---|
| Break goals into tasks | Leader agent plans with dependencies |
| Assign work | Leader picks the right worker |
| Clone repos and spawn CLIs | Daemon sets up a worktree per task |
| Poll for who's working | Agents claim atomically |
| Babysit stuck agents | Stale detection releases after 2h |
| Close tasks after merge | PR monitor auto-completes |
| Split big tasks into small ones | Workers spawn their own subtasks |
| Rescue rate-limited sessions | Daemon resumes at window reset |
| Verify which agent did what | Ed25519 identity signs every commit |

Closing line, large: **You approve. Or reject. That's the whole loop.**

End with the vibekanban transition sentence (see "Positioning" above) as a short paragraph.

### 4. Harness, not rules.

Philosophy section. Three-paragraph body, then three-pillar grid.

**Title**: `Harness, not rules.`

**Body**:
> We don't build workflows. We don't validate what an agent decides. We don't wrap the model in a cage of our opinions.
>
> We build the harness — identity, worktrees, task state, a CLI. Then we get out of the way and let the model do what it's getting better at every month.
>
> Today's agent isn't perfect. But the model ships a new version every six months. Anything built on top of *its* capability compounds. Anything built on top of *our rules* rots.

**Three pillars (small cards, monospace titles)**:

| One-command deploy | No MCP. Just CLI. | Skills, not scripts |
|---|---|---|
| Cloudflare Workers + D1. `npx wrangler deploy` and you're live. No infra, no database setup. | LLMs are already the best CLI users on earth. Don't abstract the thing they're good at. | `/ak-plan` and `/ak-task` teach the CLI. The agent handles everything else. |

### 5. Every agent has a face.

- Identicon wall: 24–30 real identicons in a grid (component at `apps/web/src/components/AgentIdenticon.tsx`)
- Caption: `Ed25519 keypair. Deterministic identicon. Verifiable commits. Identity follows them across tasks, logs, and PRs.`
- Highest screenshot-worthy moment on the page. Let the visual carry it; minimal copy.

### 6. Five runtimes, one board.

- Logo row: Claude Code · Codex · Gemini · GitHub Copilot · Hermes (ACP)
- Caption: `Bring your agent. Agent Kanban is the coordination layer — not the runtime.`

### 7. Drop it into any repo.

Real runnable block:

```bash
volta install agent-kanban
ak start --api-url https://agent-kanban.dev --api-key ak_xxx
```

Then in any agent runtime:

```
/ak-plan v1.4 "ship auth redesign"
```

Caption: `Two lines. You're out of the loop.`

### 8. Public by default.

- Screenshot of the project's own public board + its SVG badge
- Meta line: `Every feature on this page was shipped on that board ↓`
- Caption: `Public boards. SVG badges. Drop your AI team's status into any README.`

### 9. Final CTA

Three paths, equal visual weight (grid of three cards or three buttons):

- **Star on GitHub** — `★ <count> · saltbo/agent-kanban`
- **Self-host** — `npx wrangler deploy` (short code block, links to self-host guide)
- **Try it hosted** — `agent-kanban.dev` (free, no credit card)

One line below: `FSL-1.1-ALv2 · converts to Apache 2.0 in two years.`

### 10. Footer

Single row: GitHub · Docs · License (FSL-1.1-ALv2)

---

## Voice & Tone

- Default: Linear density. Short sentences. Almost no adjectives. No exclamation marks.
- Every section heading is a reversal or flat assertion: `Human out of the loop.` `The things you no longer do.` `Harness, not rules.` `Every agent has a face.` `Public by default.`
- One punchy line per section permitted (e.g. "Three lines. You're out of the loop.").
- Banned words: `empower`, `powerful`, `revolutionary`, `next-gen`, `seamlessly`, `unlock`, `supercharge`.

## Visual System

- DESIGN.md unchanged: dark default, cyan accent `#22D3EE`, Geist + Geist Mono.
- Three primary visual assets (by priority):
  1. DemoBoard animation (hero) — existing
  2. Identicon wall (Section 5) — new asset needed
  3. Share badge + public board screenshot (Section 8) — needs capture

**Deliberately not using**: scanlines, fake terminal chrome, gradients, glassmorphism, gradient text, emoji.

## What Not to Include

- v2 / v3 vision (role marketplace, competitive execution)
- Fake testimonials or "Trusted by" logo walls
- Pricing page (no paid tier exists)
- Screenshots of humans creating or dragging tasks (the product doesn't do this)
- Direct mention of competing products

## Asset Checklist

**Reuse as-is**:
- `apps/web/src/components/DemoBoard.tsx` — 75s animation
- `apps/web/src/components/AgentIdenticon.tsx` — identicon rendering
- `/api/share/:slug/badge.svg` — live badge endpoint
- `screenshots/` — fallback imagery

**Needed new**:
1. Identicon wall: render 24–30 real identicons in a grid (can generate programmatically)
2. `ak start` terminal capture (static screenshot or 5-second GIF)
3. Public board screenshot (from the project's own `agent-kanban.dev` board)
4. Favicon + OG image for social sharing

## Success Criteria

- A heavy agent user decides to star within 60 seconds — the hero and the 2-hour timeline carry that alone.
- The page doubles as a Show HN pitch: technical audience reads it and wants to post it.
- At least one element (identicon wall / 2-hour timeline / "Harness, not rules") is screenshot-worthy and survives out of context on Twitter.
- Star count growth accelerates post-launch; hosted sign-up is a welcome side effect, not the main metric.
