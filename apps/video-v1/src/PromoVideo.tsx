import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, Video } from "remotion";
import { type ClaudeEvent, ClaudeTerminal } from "./ClaudeTerminal";
import { Terminal, type TerminalEvent } from "./Terminal";
import { WebPage } from "./WebPage";

export const PROMO_FPS = 30;
export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;

// ─── Scene durations (frames at 30fps) ───

const SCENE_WEB_EMPTY = 75; //  2.5s — Machines page → cursor → click
const SCENE_CHOOSE = 105; //  3.5s — Choose type → click Your Computer
const SCENE_SPLIT = 180; //  6s — Split: web waiting + terminal ak start
const SCENE_CLAUDE = 810; // 27s — ak claude → Claude Code UI
const TRANS = 0; //  直接切 DemoBoard
const SCENE_DEMO = 2379; // 79.3s — DemoBoard recording (matches demo.mov)

export const PROMO_DURATION = SCENE_WEB_EMPTY + SCENE_CHOOSE + SCENE_SPLIT + SCENE_CLAUDE + TRANS + SCENE_DEMO;

// ─── Colors ───

const C = {
  bg: "#09090B",
  surface: "#18181B",
  border: "#27272A",
  text: "#FAFAFA",
  dim: "#71717A",
  accent: "#22D3EE",
  success: "#22C55E",
} as const;

// ─── Scene: ak start (split screen terminal) ───

const akStartEvents: TerminalEvent[] = [
  { type: "type", text: "ak auth login --api-url https://agent-kanban.dev --client-id ak_cli", at: 5, duration: 40 },
  { type: "print", text: "Daemon started (PID 48291)", at: 55 },
  { type: "blank", at: 60 },
  { type: "print", text: "[info] Machine registered: m_macbook_pro", at: 70 },
  { type: "print", text: "[info] Machine online: macbook-pro (darwin arm64), runtimes: Claude Code", at: 85 },
  { type: "print", text: "[info] Daemon ready, polling for tasks...", at: 100 },
];

// ─── Scene: ak claude (regular terminal) ───

const akClaudeEvents: TerminalEvent[] = [
  { type: "type", text: "ak claude", at: 5, duration: 15 },
  { type: "print", text: "Creating leader identity for claude...", at: 30 },
  { type: "print", text: "  Agent ID:    a_claude_7f8a", at: 42 },
  { type: "print", text: "  Fingerprint: 7f8a9b0c1d2e3f4g", at: 50 },
];

// ─── Scene: Claude Code UI (starts after ak claude transition at frame 120) ───

const P1 = 120; // /ak-plan (after crossfade completes)
const P2 = 480; // confirm + create

const claudeUIEvents: ClaudeEvent[] = [
  // ── /ak-plan ──
  { type: "user", text: "/ak-plan v1.0 Build an API server with auth, CRUD, and webhook support", at: P1 + 15, duration: 40 },
  { type: "blank", at: P1 + 70 },
  { type: "thinking", text: "Analyzing project scope...", at: P1 + 80 },
  { type: "blank", at: P1 + 95 },
  { type: "tool", command: "ak get board", output: "No boards found.", at: P1 + 100 },
  { type: "tool", command: "ak get repo", output: "No repositories found.", at: P1 + 125 },
  { type: "tool", command: "ak get agent", output: "a_claude_7f8a  [idle]  claude — 0 tasks", at: P1 + 150 },
  { type: "blank", at: P1 + 175 },
  { type: "text", text: "Here's my proposed plan for api-server v1.0:", at: P1 + 185 },
  { type: "blank", at: P1 + 195 },
  { type: "text", text: "  Board: api-server", at: P1 + 200 },
  { type: "text", text: "  Repo:  github.com/acme/api-server", at: P1 + 210 },
  { type: "text", text: "  Tasks: 7 tasks across 3 phases", at: P1 + 220 },
  { type: "blank", at: P1 + 230 },
  { type: "text", text: "  Phase 1 — Foundation (parallel):", at: P1 + 235 },
  { type: "text", text: "    1. Project scaffold + DB schema        [high]", at: P1 + 245 },
  { type: "text", text: "    2. Auth middleware (JWT + sessions)     [high]", at: P1 + 255 },
  { type: "blank", at: P1 + 265 },
  { type: "text", text: "  Phase 2 — Core (depends on Phase 1):", at: P1 + 270 },
  { type: "text", text: "    3. CRUD endpoints for resources         [high]", at: P1 + 280 },
  { type: "text", text: "    4. Input validation + error handling    [medium]", at: P1 + 290 },
  { type: "text", text: "    5. Webhook dispatch + retry             [medium]", at: P1 + 300 },
  { type: "blank", at: P1 + 310 },
  { type: "text", text: "  Phase 3 — Polish:", at: P1 + 315 },
  { type: "text", text: "    6. Rate limiting + API keys             [medium]", at: P1 + 325 },
  { type: "text", text: "    7. OpenAPI docs + health check          [low]", at: P1 + 335 },
  { type: "blank", at: P1 + 345 },
  { type: "text", text: "Shall I proceed with this plan?", at: P1 + 350 },

  // ── Confirm + create ──
  { type: "blank", at: P2 },
  { type: "user", text: "Looks good, go ahead", at: P2 + 10, duration: 25 },
  { type: "blank", at: P2 + 45 },
  { type: "thinking", text: "Creating board and tasks...", at: P2 + 55 },
  { type: "blank", at: P2 + 65 },
  { type: "tool", command: 'ak create board --name "api-server"', output: "Created board b_api01: api-server", at: P2 + 70 },
  {
    type: "tool",
    command: "ak create repo --name api-server --url https://github.com/acme/api-server",
    output: "Created repo r_api01: api-server",
    at: P2 + 95,
  },
  {
    type: "tool",
    command: "ak apply -f agents/atlas.yaml",
    output: "Created agent a_atlas01: Atlas (developer)",
    at: P2 + 120,
  },
  {
    type: "tool",
    command: "ak apply -f agents/nova.yaml",
    output: "Created agent a_nova02: Nova (developer)",
    at: P2 + 140,
  },
  { type: "blank", at: P2 + 160 },
  { type: "thinking", text: "Creating 7 tasks...", at: P2 + 165 },
  { type: "text", text: "  ✓ T1: Project scaffold + DB schema            → Atlas", at: P2 + 180 },
  { type: "text", text: "  ✓ T2: Auth middleware (JWT + sessions)         → Nova", at: P2 + 190 },
  { type: "text", text: "  ✓ T3: CRUD endpoints for resources             → Atlas", at: P2 + 200 },
  { type: "text", text: "  ✓ T4: Input validation + error handling        → Nova", at: P2 + 210 },
  { type: "text", text: "  ✓ T5: Webhook dispatch + retry                 → Atlas", at: P2 + 220 },
  { type: "text", text: "  ✓ T6: Rate limiting + API keys                 → Nova", at: P2 + 230 },
  { type: "text", text: "  ✓ T7: OpenAPI docs + health check              → Atlas", at: P2 + 240 },
  { type: "blank", at: P2 + 255 },
  { type: "text", text: "All set! 7 tasks created, 2 agents assigned. The daemon will start picking up tasks.", at: P2 + 265, color: C.success },
];

// ─── Layout components ───

function SplitScreen({ left, right, splitRatio = 0.5 }: { left: React.ReactNode; right: React.ReactNode; splitRatio?: number }) {
  return (
    <AbsoluteFill style={{ display: "flex", flexDirection: "row" }}>
      <div style={{ width: `${splitRatio * 100}%`, height: "100%", position: "relative" }}>{left}</div>
      <div style={{ width: 1, backgroundColor: C.border }} />
      <div style={{ width: `${(1 - splitRatio) * 100}%`, height: "100%", position: "relative" }}>{right}</div>
    </AbsoluteFill>
  );
}

// ─── Main composition ───

export const PromoVideo: React.FC = () => {
  let at = 0;
  const s1 = at;
  at += SCENE_WEB_EMPTY;
  const s2 = at;
  at += SCENE_CHOOSE;
  const s3 = at;
  at += SCENE_SPLIT;
  const sClaude = at;
  at += SCENE_CLAUDE;
  at += TRANS;
  const sDemo = at;

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      {/* ── Background music — calm intro extended, climax at ~01:30 ── */}
      <Sequence from={0} durationInFrames={PROMO_DURATION}>
        <BGMusic />
      </Sequence>

      {/* ── Scene 1: Machines page — empty state ── */}
      <Sequence from={s1} durationInFrames={SCENE_WEB_EMPTY}>
        <WebPage page="machines-empty" />
      </Sequence>

      {/* ── Scene 2: Choose → click Your Computer → slide web to left ── */}
      <Sequence from={s2} durationInFrames={SCENE_CHOOSE}>
        <Scene2ChooseAndSlide />
      </Sequence>

      {/* ── Scene 3: Split — left: web, right: terminal (ak start) ── */}
      <Sequence from={s3} durationInFrames={SCENE_SPLIT}>
        <Scene3MachineConnect />
      </Sequence>

      {/* ── Scene 4: ak claude → Claude Code UI ── */}
      <Sequence from={sClaude} durationInFrames={SCENE_CLAUDE}>
        <AbsoluteFill style={{ padding: "60px 160px" }}>
          <ClaudeScene />
        </AbsoluteFill>
      </Sequence>

      {/* ── DemoBoard recording ── */}
      <Sequence from={sDemo} durationInFrames={SCENE_DEMO}>
        <DemoBoardScene />
      </Sequence>
    </AbsoluteFill>
  );
};

// ─── Scene 4: ak claude → crossfade → Claude Code UI ───

function ClaudeScene() {
  const frame = useCurrentFrame();

  // 0-90: regular terminal with ak claude
  // 90-120: crossfade
  // 120+: Claude Code UI
  const FADE_START = 80;
  const FADE_END = 110;

  const terminalOpacity = interpolate(frame, [FADE_START, FADE_END], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const claudeOpacity = interpolate(frame, [FADE_START, FADE_END], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Regular terminal layer */}
      {frame < FADE_END + 5 && (
        <div style={{ position: "absolute", inset: 0, opacity: terminalOpacity }}>
          <Terminal events={akClaudeEvents} title="Terminal" />
        </div>
      )}
      {/* Claude Code UI layer */}
      {frame >= FADE_START && (
        <div style={{ position: "absolute", inset: 0, opacity: claudeOpacity }}>
          <ClaudeTerminal events={claudeUIEvents} />
        </div>
      )}
    </div>
  );
}

// ─── Scene 2: Choose type → click Your Computer ───

function Scene2ChooseAndSlide() {
  const frame = useCurrentFrame();
  const clicked = frame >= 40;
  const page = clicked ? "machines-waiting" : "machines-choose";

  return (
    <AbsoluteFill>
      <WebPage page={page} />
    </AbsoluteFill>
  );
}

// ─── Scene 3: Machine connect (split screen) ───

function Scene3MachineConnect() {
  const frame = useCurrentFrame();
  const connected = frame >= 90;

  return (
    <SplitScreen
      splitRatio={0.45}
      left={<WebPage page={connected ? "machines-connected" : "machines-waiting"} />}
      right={<Terminal events={akStartEvents} title="Terminal" />}
    />
  );
}

// ─── Background music with volume envelope ───
// Place your music file at: apps/video/public/bgm.mp3
//
// The volume builds across the video:
//   Scene 1-2 (web UI):     soft ambient (30%)
//   Scene 3 (split):        rising (40%)
//   Scene Claude (terminal): building (55%)
//   Scene Demo (board):     full epic (80%), peaks at multi-agent section

function BGMusic() {
  const frame = useCurrentFrame();

  // Let the music's natural dynamics do the work.
  // Just gentle fade-in at start and fade-out at end.
  const volume = interpolate(frame, [0, 45, PROMO_DURATION - 90, PROMO_DURATION], [0, 0.7, 0.7, 0.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return <Audio src={staticFile("bgm.mp3")} volume={volume} startFrom={0} />;
}

// ─── DemoBoard scene (placeholder until video recorded) ───

function DemoBoardScene() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity }}>
      <Video src={staticFile("demo.mp4")} />
    </AbsoluteFill>
  );
}
