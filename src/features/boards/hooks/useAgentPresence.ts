import type { BoardAction, TaskActionType } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearCardStyles, liftCard, resetCard, slideCard } from "@/lib/cardEffects";
import { useBoardSSE } from "./useBoardSSE";

export type AvatarPhase = "spawning" | "flying" | "absorbing" | "emerging" | "dragging" | "working" | "returning" | "leaving";

export interface AgentAvatar {
  agentId: string;
  agentName: string | null;
  identitySeed: string;
  taskId: string;
  phase: AvatarPhase;
}

// ─── Choreography definitions ───

const DRAG_TARGETS: Partial<Record<TaskActionType, string>> = {
  claimed: "in_progress",
  review_requested: "in_review",
  completed: "done",
  rejected: "in_progress",
  cancelled: "cancelled",
};

interface ChoreographyStep {
  delay: number;
  phase?: AvatarPhase;
  remove?: boolean;
  cardEffect?: (taskId: string, target: string) => void;
  invalidate?: boolean;
}

// Agent spawns, flies, lifts card, slides to target, absorbs
const CLAIM_SEQUENCE: ChoreographyStep[] = [
  { delay: 0, phase: "spawning" },
  { delay: 500, phase: "flying" },
  { delay: 1100, cardEffect: (tid) => liftCard(tid) },
  { delay: 1300, phase: "dragging", cardEffect: (tid, t) => slideCard(tid, t) },
  { delay: 1900, phase: "absorbing", cardEffect: (tid) => resetCard(tid), invalidate: true },
  { delay: 2200, cardEffect: (tid) => clearCardStyles(tid) },
  { delay: 2300, remove: true },
];

// Agent emerges, lifts card, slides to target, returns to header
const MOVE_SEQUENCE: ChoreographyStep[] = [
  { delay: 0, phase: "emerging" },
  { delay: 500, cardEffect: (tid) => liftCard(tid) },
  { delay: 700, phase: "dragging", cardEffect: (tid, t) => slideCard(tid, t) },
  { delay: 1300, phase: "returning", cardEffect: (tid) => resetCard(tid), invalidate: true },
  { delay: 1700, cardEffect: (tid) => clearCardStyles(tid) },
  { delay: 1800, phase: "leaving" },
  { delay: 2100, remove: true },
];

function getSequence(action: TaskActionType): ChoreographyStep[] | null {
  if (action === "claimed") return CLAIM_SEQUENCE;
  if (action === "review_requested" || action === "completed" || action === "rejected" || action === "cancelled") return MOVE_SEQUENCE;
  return null;
}

// ─── Hook ───

export function useAgentPresenceFromEvents(events: BoardAction[], boardId: string | undefined) {
  const [avatars, setAvatars] = useState<Map<string, AgentAvatar>>(new Map());
  const processedRef = useRef(0);
  const queryClient = useQueryClient();
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map());

  const cancelChoreography = useCallback((agentId: string) => {
    const existing = timersRef.current.get(agentId);
    if (existing) {
      existing.forEach(clearTimeout);
      timersRef.current.delete(agentId);
    }
  }, []);

  const runChoreography = useCallback(
    (event: BoardAction, sequence: ChoreographyStep[]) => {
      const actorId = event.actor_id;
      const taskId = event.task_id;
      const target = DRAG_TARGETS[event.action] || "";

      cancelChoreography(actorId);
      const scheduled: ReturnType<typeof setTimeout>[] = [];

      for (const step of sequence) {
        const timer = setTimeout(() => {
          if (step.phase) {
            setAvatars((prev) => {
              const next = new Map(prev);
              if (step.phase === "spawning" || step.phase === "emerging") {
                next.set(actorId, {
                  agentId: actorId,
                  agentName: event.actor_name ?? null,
                  identitySeed: actorId,
                  taskId,
                  phase: step.phase!,
                });
              } else {
                const a = next.get(actorId);
                if (a) next.set(actorId, { ...a, phase: step.phase! });
              }
              return next;
            });
          }
          if (step.cardEffect) step.cardEffect(taskId, target);
          if (step.remove) {
            setAvatars((prev) => {
              const next = new Map(prev);
              next.delete(actorId);
              return next;
            });
            timersRef.current.delete(actorId);
          }
          if (step.invalidate) {
            queryClient.invalidateQueries({ queryKey: ["board", boardId] });
          }
        }, step.delay);
        scheduled.push(timer);
      }

      timersRef.current.set(actorId, scheduled);
    },
    [boardId, cancelChoreography, queryClient],
  );

  // Process SSE events → choreographies
  useEffect(() => {
    const unprocessed = events.slice(processedRef.current);
    if (unprocessed.length === 0) return;
    processedRef.current = events.length;

    for (const event of unprocessed) {
      const sequence = getSequence(event.action);
      if (!sequence) continue;

      if (event.actor_type === "realmroot:agent") {
        runChoreography(event, sequence);
      }
    }
  }, [events, runChoreography]);

  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) t.forEach(clearTimeout);
    };
  }, []);

  return Array.from(avatars.values());
}

export function useAgentPresence(boardId: string | undefined) {
  const { events } = useBoardSSE(boardId);
  return useAgentPresenceFromEvents(events, boardId);
}
