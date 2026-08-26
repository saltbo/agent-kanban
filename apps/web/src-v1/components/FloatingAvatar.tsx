import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentAvatar } from "../hooks/useAgentPresence";
import { agentColor } from "../lib/agentIdentity";
import { AgentIdenticon } from "./AgentIdenticon";

const AVATAR_SIZE = 32;

function getSpawnPos(): { x: number; y: number } {
  const el = document.querySelector('a[href="/agents"]');
  if (el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - AVATAR_SIZE / 2, y: rect.bottom + 8 };
  }
  const board = document.querySelector("[data-demo-board]");
  if (board) {
    const rect = board.getBoundingClientRect();
    return { x: rect.right - 60, y: rect.top + 8 };
  }
  return { x: window.innerWidth - 200, y: 20 };
}

function getCardPos(taskId: string): { x: number; y: number } | null {
  const el = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return null;
  return { x: rect.right - 8 - AVATAR_SIZE, y: rect.top - 8 };
}

function FloatingAvatarItem({ avatar }: { avatar: AgentAvatar }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const color = useMemo(() => agentColor(avatar.publicKey), [avatar.publicKey]);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    if (avatar.phase === "spawning") setPos(getSpawnPos());
  }, [avatar.phase]);

  useEffect(() => {
    if (avatar.phase === "returning") {
      setPos(getSpawnPos());
      return;
    }
    if (avatar.phase === "spawning" || avatar.phase === "leaving" || avatar.phase === "absorbing") return;

    function updatePos() {
      const next = getCardPos(avatar.taskId);
      if (!next) return;
      setPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    }

    updatePos();

    if (avatar.phase === "dragging") {
      function loop() {
        updatePos();
        rafRef.current = requestAnimationFrame(loop);
      }
      rafRef.current = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafRef.current);
    }

    const raf = requestAnimationFrame(updatePos);
    window.addEventListener("scroll", updatePos, { passive: true });
    window.addEventListener("resize", updatePos, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", updatePos);
      window.removeEventListener("resize", updatePos);
    };
  }, [avatar.taskId, avatar.phase]);

  if (!pos) return null;

  const isWorking = avatar.phase === "working";
  const baseShadow = "0 2px 8px rgba(0,0,0,0.3)";

  const transition =
    avatar.phase === "spawning" || avatar.phase === "dragging" || avatar.phase === "absorbing" || avatar.phase === "emerging"
      ? "none"
      : avatar.phase === "flying"
        ? "transform 500ms ease-out"
        : avatar.phase === "returning"
          ? "transform 500ms ease-in"
          : "transform 300ms ease-in-out";

  const animClass =
    avatar.phase === "absorbing"
      ? "animate-[avatar-absorb_400ms_ease-in_forwards]"
      : avatar.phase === "emerging"
        ? "animate-[avatar-emerge_400ms_ease-out_forwards]"
        : avatar.phase === "leaving"
          ? "animate-avatar-leave"
          : avatar.phase === "spawning"
            ? "animate-avatar-arrive"
            : isWorking
              ? "animate-breathe"
              : "";

  return (
    <div style={{ position: "fixed", transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`, transition, zIndex: 41 }}>
      <div
        className={animClass}
        style={
          {
            borderRadius: "50%",
            border: `2px solid ${color}`,
            boxShadow: isWorking ? undefined : `${baseShadow}, 0 0 12px color-mix(in srgb, ${color} 25%, transparent)`,
            "--breathe-shadow-max": `${baseShadow}, 0 0 16px color-mix(in srgb, ${color} 30%, transparent)`,
            "--breathe-shadow-min": `${baseShadow}, 0 0 4px color-mix(in srgb, ${color} 10%, transparent)`,
          } as React.CSSProperties
        }
      >
        <AgentIdenticon publicKey={avatar.publicKey} size={AVATAR_SIZE} glow={isWorking} crystallize={avatar.phase === "spawning"} />
      </div>
    </div>
  );
}

export function AgentAvatarOverlay({ avatars }: { avatars: AgentAvatar[] }) {
  if (avatars.length === 0) return null;
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 40 }}>
      {avatars.map((a) => (
        <FloatingAvatarItem key={a.agentId} avatar={a} />
      ))}
    </div>
  );
}
