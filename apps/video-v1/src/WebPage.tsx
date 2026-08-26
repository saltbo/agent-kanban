import { interpolate, useCurrentFrame } from "remotion";

// ─── Design tokens (dark mode) ───

const C = {
  bg: "#09090B",
  surface: "#18181B",
  border: "#27272A",
  text: "#FAFAFA",
  dim: "#71717A",
  secondary: "#A1A1AA",
  accent: "#22D3EE",
  accentSoft: "rgba(34, 211, 238, 0.1)",
  success: "#22C55E",
  successSoft: "rgba(34, 197, 94, 0.1)",
  successBorder: "rgba(34, 197, 94, 0.3)",
  warning: "#EAB308",
  error: "#EF4444",
} as const;

const FONT = "'Geist', system-ui, sans-serif";
const MONO = "'Geist Mono', 'SF Mono', monospace";

// ─── Web page states ───

export type PageState = "machines-empty" | "machines-choose" | "machines-waiting" | "machines-connected";

interface WebPageProps {
  page: PageState;
}

export function WebPage({ page }: WebPageProps) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: C.bg,
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <BrowserChrome />
      <NavBar />
      <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: "48px 40px" }}>
        <div style={{ width: "100%", maxWidth: 720 }}>
          {page === "machines-empty" && <MachinesEmpty />}
          {page === "machines-choose" && <MachinesWithDialog dialogContent={<ChooseTypeContent />} />}
          {page === "machines-waiting" && <MachinesWithDialog dialogContent={<CommandContent />} />}
          {page === "machines-connected" && <MachinesWithDialog dialogContent={<ConnectedContent />} />}
        </div>
      </div>
    </div>
  );
}

// ─── Browser chrome (minimal) ───

function BrowserChrome() {
  return (
    <div
      style={{
        height: 36,
        backgroundColor: "#1A1A1E",
        display: "flex",
        alignItems: "center",
        paddingLeft: 14,
        gap: 7,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: "#FF5F56" }} />
      <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: "#FFBD2E" }} />
      <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: "#27C93F" }} />
      <div
        style={{
          marginLeft: 16,
          backgroundColor: C.surface,
          borderRadius: 6,
          padding: "3px 16px",
          fontSize: 11,
          color: C.dim,
          fontFamily: MONO,
        }}
      >
        agent-kanban.dev/machines
      </div>
    </div>
  );
}

// ─── App nav bar ───

function NavBar() {
  return (
    <div
      style={{
        height: 48,
        backgroundColor: C.surface,
        borderBottom: `1px solid ${C.border}`,
        display: "flex",
        alignItems: "center",
        paddingLeft: 24,
        paddingRight: 24,
        gap: 24,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, letterSpacing: "-0.03em" }}>Agent Kanban</span>
      <span style={{ fontSize: 12, color: C.dim }}>Boards</span>
      <span style={{ fontSize: 12, color: C.text, fontWeight: 500 }}>Machines</span>
      <span style={{ fontSize: 12, color: C.dim }}>Agents</span>
    </div>
  );
}

// ─── Machines page header ───

function MachinesHeader() {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Machines</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>0 online</span>
        <div
          style={{
            backgroundColor: C.accent,
            color: C.bg,
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 14px",
            borderRadius: 6,
          }}
        >
          Add Machine
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ───

function MachinesEmpty() {
  const frame = useCurrentFrame();
  const showCursor = frame > 15;

  // Cursor moves toward "Add Machine" button quickly
  const cursorX = interpolate(frame, [15, 30], [500, 680], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cursorY = interpolate(frame, [15, 30], [300, 28], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const arrived = frame > 30;
  // Click effect: cursor briefly scales down
  const clicked = frame > 40;
  const clickScale = frame >= 35 && frame <= 42 ? 0.8 : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Machines</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>0 online</span>
          <div
            style={{
              backgroundColor: C.accent,
              color: C.bg,
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: 6,
              boxShadow: arrived ? `0 0 12px ${C.accent}80` : "none",
              transform: clicked ? "scale(0.95)" : "none",
            }}
          >
            Add Machine
          </div>
        </div>
      </div>
      <div style={{ textAlign: "center", padding: "60px 0" }}>
        <p style={{ color: C.secondary, fontSize: 13 }}>No machines registered.</p>
        <p style={{ color: C.dim, fontSize: 11, marginTop: 8 }}>
          Click <span style={{ color: C.accent }}>Add Machine</span> to get started.
        </p>
      </div>
      {/* Cursor */}
      {showCursor && (
        <svg
          width="20"
          height="24"
          viewBox="0 0 20 24"
          style={{
            position: "absolute",
            left: cursorX,
            top: cursorY,
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
            zIndex: 10,
            transform: `scale(${clickScale})`,
            transformOrigin: "top left",
          }}
        >
          <path d="M0 0 L0 18 L5 13 L10 22 L13 20 L8 12 L14 12 Z" fill="white" stroke="#09090B" strokeWidth="1" />
        </svg>
      )}
    </div>
  );
}

// ─── Machines page with dialog overlay ───

function MachinesWithDialog({ dialogContent }: { dialogContent: React.ReactNode }) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Dimmed background */}
      <div style={{ opacity: 0.3 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <MachinesHeader />
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <p style={{ color: C.secondary, fontSize: 13 }}>No machines registered.</p>
          </div>
        </div>
      </div>

      {/* Dialog overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: 80,
        }}
      >
        <div
          style={{
            width: 400,
            backgroundColor: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 20 }}>Add Machine</h2>
          {dialogContent}
        </div>
      </div>
    </div>
  );
}

// ─── Dialog: command + waiting for connection ───

function CommandContent() {
  const frame = useCurrentFrame();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 12, color: C.secondary }}>Run this command in your terminal:</p>

      {/* Terminal snippet */}
      <div
        style={{
          backgroundColor: "#0C0C0C",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          overflow: "hidden",
        }}
      >
        {/* Mini title bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "7px 12px",
            backgroundColor: "#1A1A1A",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#FF5F56" }} />
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#FFBD2E" }} />
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#27C93F" }} />
          <span style={{ fontSize: 9, color: C.dim, marginLeft: 6, fontFamily: MONO }}>terminal</span>
        </div>

        {/* Command */}
        <div style={{ padding: 12, fontSize: 11, fontFamily: MONO, lineHeight: "18px" }}>
          <span style={{ color: C.dim }}>$ </span>
          <span style={{ color: C.secondary }}>ak auth login \</span>
          <br />
          <span style={{ color: C.secondary, paddingLeft: 16 }}>--api-url https://agent-kanban.dev \</span>
          <br />
          <span style={{ color: C.secondary, paddingLeft: 16 }}>--client-id ak_cli</span>
        </div>
      </div>

      {/* Copy button */}
      <div
        style={{
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "8px 0",
          textAlign: "center",
          fontSize: 12,
          color: C.text,
        }}
      >
        Copy to clipboard
      </div>

      {/* Waiting indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: C.warning,
            opacity: Math.sin(frame * 0.15) * 0.3 + 0.7,
          }}
        />
        <span style={{ fontSize: 11, color: C.dim }}>Waiting for connection...</span>
      </div>
    </div>
  );
}

// ─── Dialog: choose type ───

function ChooseTypeContent() {
  const frame = useCurrentFrame();

  // Cursor moves to "Your Computer" and clicks
  const showCursor = frame > 10;
  const cursorX = interpolate(frame, [10, 25], [200, 120], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cursorY = interpolate(frame, [10, 25], [10, 72], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const arrived = frame > 25;
  const clicked = frame > 35;
  const clickScale = frame >= 32 && frame <= 38 ? 0.8 : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
      <p style={{ fontSize: 12, color: C.secondary, marginBottom: 8 }}>Where will this machine run?</p>

      {/* Your Computer option */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          border: `1px solid ${arrived ? `${C.accent}80` : C.border}`,
          borderRadius: 8,
          backgroundColor: arrived ? `${C.accent}10` : C.bg,
          transform: clicked ? "scale(0.98)" : "none",
        }}
      >
        <MonitorIcon color={C.secondary} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>Your Computer</div>
          <div style={{ fontSize: 10, color: C.dim }}>Run the daemon on this machine</div>
        </div>
      </div>

      {/* Cloud Sandbox option */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          backgroundColor: C.bg,
          opacity: 0.5,
        }}
      >
        <CloudIcon color={C.dim} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: C.dim }}>Cloud Sandbox</div>
          <div style={{ fontSize: 10, color: C.dim }}>Coming soon</div>
        </div>
      </div>

      {/* Cursor */}
      {showCursor && (
        <svg
          width="20"
          height="24"
          viewBox="0 0 20 24"
          style={{
            position: "absolute",
            left: cursorX,
            top: cursorY,
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
            zIndex: 10,
            transform: `scale(${clickScale})`,
            transformOrigin: "top left",
          }}
        >
          <path d="M0 0 L0 18 L5 13 L10 22 L13 20 L8 12 L14 12 Z" fill="white" stroke="#09090B" strokeWidth="1" />
        </svg>
      )}
    </div>
  );
}

// ─── Connected content ───

function ConnectedContent() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Success banner */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          backgroundColor: C.successSoft,
          border: `1px solid ${C.successBorder}`,
          borderRadius: 8,
          padding: 12,
        }}
      >
        <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.success }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: C.success }}>Machine connected!</span>
      </div>

      {/* Machine info */}
      <div
        style={{
          backgroundColor: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <InfoRow label="Name" value="macbook-pro" />
        <InfoRow label="Status" value="Online" valueColor={C.success} dot={C.success} />
        <InfoRow label="OS" value="darwin arm64" mono />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: "0.05em" }}>Runtimes</span>
          <div style={{ display: "flex", gap: 4 }}>
            <RuntimeBadge name="Claude Code" />
          </div>
        </div>
      </div>

      {/* Done button */}
      <div
        style={{
          backgroundColor: C.accent,
          color: C.bg,
          fontSize: 13,
          fontWeight: 600,
          padding: "10px 0",
          borderRadius: 6,
          textAlign: "center",
        }}
      >
        Done
      </div>
    </div>
  );
}

// ─── Small helpers ───

function InfoRow({ label, value, valueColor, dot, mono }: { label: string; value: string; valueColor?: string; dot?: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {dot && <div style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: dot }} />}
        <span
          style={{
            fontSize: mono ? 11 : 12,
            color: valueColor ?? C.text,
            fontFamily: mono ? MONO : FONT,
          }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function RuntimeBadge({ name }: { name: string }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: MONO,
        color: C.accent,
        backgroundColor: C.accentSoft,
        padding: "2px 8px",
        borderRadius: 4,
      }}
    >
      {name}
    </span>
  );
}

// ─── SVG Icons ───

function MonitorIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function CloudIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}
