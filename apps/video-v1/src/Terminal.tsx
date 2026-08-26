import { useCurrentFrame } from "remotion";

// ─── Design tokens (from DESIGN.md dark mode) ───

const C = {
  bg: "#09090B",
  surface: "#18181B",
  border: "#27272A",
  text: "#FAFAFA",
  dim: "#71717A",
  secondary: "#A1A1AA",
  accent: "#22D3EE",
  success: "#22C55E",
  warning: "#EAB308",
  error: "#EF4444",
  orange: "#F97316",
} as const;

const FONT = "'Geist Mono', 'SF Mono', 'Cascadia Code', monospace";

// ─── Event types ───

export type TerminalEvent =
  | { type: "type"; text: string; at: number; duration: number }
  | { type: "print"; text: string; at: number; color?: string }
  | { type: "blank"; at: number };

// ─── Auto-scroll container ───

const LINE_H = 26; // matches lineHeight

function AutoScroll({ lineCount, children }: { lineCount: number; children: React.ReactNode }) {
  // Estimate visible lines from a reference height (1080 - 60*2 padding - 40 title bar - 48 body pad)
  // For split-screen the container is smaller, but overflow: hidden on parent clips it anyway.
  // We use a generous max visible count; the translateY just pins the bottom.
  const MAX_VISIBLE = 30;
  const overflow = lineCount - MAX_VISIBLE;
  const scrollY = overflow > 0 ? overflow * LINE_H : 0;

  return <div style={{ transform: `translateY(-${scrollY}px)` }}>{children}</div>;
}

// ─── Helpers ───

function Prompt() {
  return <span style={{ color: C.accent }}>$ </span>;
}

function Cursor({ visible }: { visible: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 20,
        backgroundColor: visible ? C.text : "transparent",
        marginLeft: 2,
        verticalAlign: "text-bottom",
      }}
    />
  );
}

function colorize(text: string, color?: string): React.ReactNode {
  if (color) return <span style={{ color }}>{text}</span>;

  // Auto-colorize patterns
  return text.split(/(\s+)/).map((token, i) => {
    // Checkmark
    if (token === "\u2713")
      return (
        <span key={i} style={{ color: C.success }}>
          {token}
        </span>
      );
    // Priority tags
    if (token === "[urgent]")
      return (
        <span key={i} style={{ color: C.error }}>
          {token}
        </span>
      );
    if (token === "[high]")
      return (
        <span key={i} style={{ color: C.orange }}>
          {token}
        </span>
      );
    if (token === "[medium]")
      return (
        <span key={i} style={{ color: C.warning }}>
          {token}
        </span>
      );
    if (token === "[low]")
      return (
        <span key={i} style={{ color: C.dim }}>
          {token}
        </span>
      );
    // Arrow for agent assignment
    if (token.startsWith("\u2192"))
      return (
        <span key={i} style={{ color: C.accent }}>
          {token}
        </span>
      );
    // Log level tags
    if (token === "[info]")
      return (
        <span key={i} style={{ color: C.accent }}>
          {token}
        </span>
      );
    // IDs and special values
    if (/^[bmatrs]_/.test(token))
      return (
        <span key={i} style={{ color: C.accent }}>
          {token}
        </span>
      );
    return <span key={i}>{token}</span>;
  });
}

// ─── Terminal ───

interface TerminalProps {
  events: TerminalEvent[];
  title?: string;
}

export function Terminal({ events, title }: TerminalProps) {
  const frame = useCurrentFrame();

  const lines: React.ReactNode[] = [];

  for (const ev of events) {
    if (ev.at > frame) continue;

    if (ev.type === "blank") {
      lines.push(<div key={lines.length} style={{ height: 26 }} />);
      continue;
    }

    if (ev.type === "print") {
      lines.push(
        <div key={lines.length} style={{ color: ev.color ?? C.text, lineHeight: "26px" }}>
          {colorize(ev.text, ev.color)}
        </div>,
      );
      continue;
    }

    if (ev.type === "type") {
      const elapsed = frame - ev.at;
      const progress = Math.min(elapsed / ev.duration, 1);
      const chars = Math.floor(progress * ev.text.length);
      const visible = ev.text.slice(0, chars);
      const isDone = progress >= 1;

      lines.push(
        <div key={lines.length} style={{ lineHeight: "26px" }}>
          <Prompt />
          <span style={{ color: C.text }}>{visible}</span>
          {!isDone && <Cursor visible />}
        </div>,
      );
    }
  }

  // If no active typing, show blinking cursor on last line
  const lastEvent = events.filter((e) => e.at <= frame).at(-1);
  const shouldShowIdleCursor = lastEvent && lastEvent.type !== "type" && frame - lastEvent.at > 5;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: C.bg,
        color: C.text,
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
        fontSize: 18,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 40,
          backgroundColor: C.surface,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          paddingLeft: 16,
          gap: 8,
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "#EF4444" }} />
        <div style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "#EAB308" }} />
        <div style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "#22C55E" }} />
        {title && <span style={{ color: C.dim, fontSize: 13, marginLeft: 8, fontFamily: FONT }}>{title}</span>}
      </div>

      {/* Terminal body — auto-scrolls when content exceeds viewport */}
      <div style={{ flex: 1, padding: "24px 32px", overflow: "hidden", position: "relative" }}>
        <AutoScroll lineCount={lines.length + (shouldShowIdleCursor ? 1 : 0)}>
          {lines}
          {shouldShowIdleCursor && (
            <div style={{ lineHeight: "26px" }}>
              <Prompt />
              <Cursor visible={Math.floor(frame / 15) % 2 === 0} />
            </div>
          )}
        </AutoScroll>
      </div>
    </div>
  );
}
