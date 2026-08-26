import { useCurrentFrame } from "remotion";

// ─── Design tokens ───

const C = {
  bg: "#09090B",
  surface: "#111113",
  border: "#27272A",
  text: "#FAFAFA",
  dim: "#71717A",
  secondary: "#A1A1AA",
  accent: "#22D3EE",
  success: "#22C55E",
  orange: "#F97316",
  warning: "#EAB308",
  error: "#EF4444",
  purple: "#C084FC",
  inputBg: "#18181B",
} as const;

const FONT = "'Geist', system-ui, sans-serif";
const MONO = "'Geist Mono', 'SF Mono', monospace";
const LINE_H = 26;

// ─── Event types ───

export type ClaudeEvent =
  | { type: "user"; text: string; at: number; duration?: number }
  | { type: "thinking"; text: string; at: number }
  | { type: "text"; text: string; at: number; color?: string }
  | { type: "tool"; command: string; output?: string; at: number }
  | { type: "blank"; at: number };

// ─── Claude Code Terminal ───

export function ClaudeTerminal({ events }: { events: ClaudeEvent[] }) {
  const frame = useCurrentFrame();

  // Separate user input (goes to bottom bar) from conversation (goes to main area)
  // Find the active user input event (the latest "user" event being typed or just finished)
  const activeUserEvents = events.filter((e) => e.type === "user" && e.at <= frame);
  const latestUserEvent = activeUserEvents.at(-1) as (ClaudeEvent & { type: "user" }) | undefined;

  // Is the user currently typing?
  let inputText = "";
  let inputCursorVisible = false;
  if (latestUserEvent) {
    const duration = latestUserEvent.duration ?? 30;
    const elapsed = frame - latestUserEvent.at;
    const progress = Math.min(elapsed / duration, 1);
    const chars = Math.floor(progress * latestUserEvent.text.length);
    inputText = latestUserEvent.text.slice(0, chars);
    inputCursorVisible = progress < 1;

    // After typing is done + a short delay, input was "sent" — clear it
    if (elapsed > duration + 15) {
      inputText = "";
      inputCursorVisible = false;
    }
  }

  // Build conversation lines (everything except user typing state)
  const lines: React.ReactNode[] = [];

  for (const ev of events) {
    if (ev.at > frame) continue;

    if (ev.type === "blank") {
      lines.push(<div key={lines.length} style={{ height: LINE_H / 2 }} />);
      continue;
    }

    if (ev.type === "user") {
      // Show as sent message once typing is complete + delay
      const duration = ev.duration ?? 30;
      const elapsed = frame - ev.at;
      if (elapsed <= duration + 15) continue; // still typing, shown in input bar

      lines.push(
        <div key={lines.length} style={{ display: "flex", gap: 10, lineHeight: `${LINE_H}px`, marginBottom: 8 }}>
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: C.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: C.bg,
              fontWeight: 700,
              flexShrink: 0,
              marginTop: 3,
            }}
          >
            Y
          </div>
          <span style={{ color: C.text, fontSize: 14 }}>{ev.text}</span>
        </div>,
      );
      continue;
    }

    if (ev.type === "thinking") {
      lines.push(
        <div key={lines.length} style={{ display: "flex", alignItems: "center", gap: 8, lineHeight: `${LINE_H}px` }}>
          <Spinner frame={frame} />
          <span style={{ color: C.secondary, fontSize: 13, fontStyle: "italic" }}>{ev.text}</span>
        </div>,
      );
      continue;
    }

    if (ev.type === "text") {
      lines.push(
        <div key={lines.length} style={{ color: ev.color ?? C.text, lineHeight: `${LINE_H}px`, fontSize: 14, paddingLeft: 4 }}>
          {colorize(ev.text, ev.color)}
        </div>,
      );
      continue;
    }

    if (ev.type === "tool") {
      lines.push(
        <div
          key={lines.length}
          style={{
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "8px 12px",
            marginTop: 4,
            marginBottom: 4,
            marginLeft: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontFamily: MONO }}>
            <ToolIcon />
            <span style={{ color: C.secondary }}>{ev.command}</span>
          </div>
          {ev.output && <div style={{ fontSize: 12, fontFamily: MONO, color: C.dim, marginTop: 6, paddingLeft: 22 }}>{ev.output}</div>}
        </div>,
      );
    }
  }

  // Auto-scroll
  const totalHeight = lines.length * (LINE_H + 2);
  const viewportHeight = 820; // approximate: 1080 - padding - header - input bar
  const scrollY = Math.max(0, totalHeight - viewportHeight);

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
        fontSize: 14,
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${C.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 44,
          backgroundColor: C.surface,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 20,
          paddingRight: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ClaudeIcon />
          <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>Claude Code</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: C.dim, fontSize: 11, fontFamily: MONO }}>opus</span>
          <div style={{ width: 1, height: 14, backgroundColor: C.border }} />
          <span style={{ color: C.accent, fontSize: 11, fontFamily: MONO }}>agent-kanban.dev</span>
        </div>
      </div>

      {/* Conversation area */}
      <div style={{ flex: 1, padding: "16px 24px", overflow: "hidden" }}>
        <div style={{ transform: `translateY(-${scrollY}px)` }}>{lines}</div>
      </div>

      {/* Input bar at bottom */}
      <div
        style={{
          borderTop: `1px solid ${C.border}`,
          padding: "12px 20px",
          backgroundColor: C.surface,
        }}
      >
        <div
          style={{
            backgroundColor: C.inputBg,
            border: `1px solid ${inputCursorVisible ? C.accent : C.border}`,
            borderRadius: 10,
            padding: "10px 16px",
            fontSize: 14,
            fontFamily: FONT,
            minHeight: 20,
            display: "flex",
            alignItems: "center",
          }}
        >
          {inputText ? (
            <>
              <span style={{ color: C.text }}>{inputText}</span>
              {inputCursorVisible && <InputCursor />}
            </>
          ) : (
            <span style={{ color: C.dim }}>Type a message...</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ───

function InputCursor() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height: 18,
        backgroundColor: C.accent,
        marginLeft: 1,
        verticalAlign: "text-bottom",
      }}
    />
  );
}

function Spinner({ frame }: { frame: number }) {
  const chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const idx = Math.floor(frame / 3) % chars.length;
  return <span style={{ color: C.purple, fontSize: 14, fontFamily: MONO, width: 16, display: "inline-block" }}>{chars[idx]}</span>;
}

function ClaudeIcon() {
  return (
    <div
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        backgroundColor: "#D97706",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        color: "white",
        fontWeight: 700,
      }}
    >
      C
    </div>
  );
}

function ToolIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.dim} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function colorize(text: string, color?: string): React.ReactNode {
  if (color) return <span style={{ color }}>{text}</span>;

  return text.split(/(\s+)/).map((token, i) => {
    if (token === "✓")
      return (
        <span key={i} style={{ color: C.success }}>
          {token}
        </span>
      );
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
    if (token.startsWith("→"))
      return (
        <span key={i} style={{ color: C.accent }}>
          {token}
        </span>
      );
    if (/^[bmatrs]_/.test(token))
      return (
        <span key={i} style={{ color: C.accent }}>
          {token}
        </span>
      );
    return <span key={i}>{token}</span>;
  });
}
