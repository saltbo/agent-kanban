import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgentAvatar } from "../hooks/useAgentPresence";
import { glowCard, liftCard, resetCard, slideCard, unglowCard } from "../lib/cardEffects";
import { AgentAvatarOverlay } from "./FloatingAvatar";
import { KanbanColumn } from "./KanbanColumn";
import { Button } from "./ui/button";

// ─── Data ───

interface DemoTask {
  id: string;
  seq: number;
  title: string;
  labels: string[];
  status: string;
  repository_name: string;
  assigned_to: string | null;
  agent_name: string | null;
  agent_public_key: string | null;
  result: string | null;
  glow_suppressed: boolean;
  updated_at: string;
}

const A = [
  { id: "demo-atlas", name: "Atlas", pk: "demo-key-atlas-quantum-forge" },
  { id: "demo-nova", name: "Nova", pk: "demo-key-nova-stellar-drift" },
  { id: "demo-forge", name: "Forge", pk: "demo-key-forge-iron-anvil" },
  { id: "demo-sentinel", name: "Sentinel", pk: "demo-key-sentinel-iron-gate" },
];

const TID = ["dt1", "dt2", "dt3", "dt4", "dt5", "dt6", "dt7"];

function assign(i: number) {
  return { assigned_to: A[i].id, agent_name: A[i].name, agent_public_key: A[i].pk };
}

const DEMO_LABELS = [
  { name: "backend", color: "#22D3EE", description: "API and worker code" },
  { name: "frontend", color: "#A78BFA", description: "Browser UI" },
  { name: "bug", color: "#EF4444", description: "Defect fix" },
  { name: "docs", color: "#71717A", description: "Documentation" },
];

function makeTasks(): DemoTask[] {
  const now = new Date().toISOString();
  let seqCounter = 0;
  const t = (id: string, title: string, labels: string[], repo: string, ag?: number): DemoTask => ({
    id,
    seq: ++seqCounter,
    title,
    labels,
    status: "todo",
    repository_name: repo,
    ...(ag !== undefined ? assign(ag) : { assigned_to: null, agent_name: null, agent_public_key: null }),
    result: null,
    glow_suppressed: false,
    updated_at: now,
  });
  return [
    t(TID[0], "Refactor auth middleware", ["backend"], "api-server", 0),
    t(TID[1], "Fix rate limiter bug", ["backend", "bug"], "api-server", 1),
    t(TID[2], "Add pagination to API", ["backend"], "api-server", 0),
    t(TID[3], "Implement webhook retry", ["backend"], "api-server", 1),
    t(TID[4], "Update API documentation", ["docs"], "docs", 2),
    t(TID[5], "Fix timezone bug in reports", ["frontend", "bug"], "dashboard"),
    t(TID[6], "Add export to CSV", ["frontend"], "dashboard"),
  ];
}

// ─── State ───

interface DS {
  tasks: DemoTask[];
  avatars: Map<string, AgentAvatar>;
}
type Step = (s: DS) => DS;
interface TE {
  delay: number;
  step?: Step;
  effect?: () => void;
}

function patch(s: DS, i: number, p: Partial<DemoTask>): DS {
  return { ...s, tasks: s.tasks.map((t, j) => (j === i ? { ...t, ...p, updated_at: new Date().toISOString() } : t)) };
}
function phase(s: DS, ai: number, p: AgentAvatar["phase"]): DS {
  const av = new Map(s.avatars);
  const a = av.get(A[ai].id);
  if (a) av.set(a.agentId, { ...a, phase: p });
  return { ...s, avatars: av };
}
function spawn(s: DS, ai: number, ti: number): DS {
  const av = new Map(s.avatars);
  av.set(A[ai].id, { agentId: A[ai].id, agentName: A[ai].name, publicKey: A[ai].pk, taskId: TID[ti], phase: "spawning" });
  return { ...s, avatars: av };
}
function rm(s: DS, ai: number): DS {
  const av = new Map(s.avatars);
  av.delete(A[ai].id);
  return { ...s, avatars: av };
}
function sup(s: DS, ti: number): DS {
  return { ...s, tasks: s.tasks.map((t, j) => (j === ti ? { ...t, glow_suppressed: true } : t)) };
}
function unsup(s: DS, ti: number): DS {
  return { ...s, tasks: s.tasks.map((t, j) => (j === ti ? { ...t, glow_suppressed: false } : t)) };
}

// ─── Sequence Builders ───
// Cross-column: slideCard (DOM) moves card visually, then state update triggers Framer Motion entry.
// Within-column: Framer Motion AnimatePresence + layout handles enter/exit/reorder.

// Worker: spawn → fly → lift → slide → hide+claim → absorb (2.8s)
function seqClaim(t: number, ai: number, ti: number): TE[] {
  return [
    { delay: t, step: (s) => spawn(s, ai, ti) },
    { delay: t + 500, step: (s) => phase(s, ai, "flying") },
    { delay: t + 1100, effect: () => liftCard(TID[ti]) },
    { delay: t + 1300, step: (s) => phase(s, ai, "dragging"), effect: () => slideCard(TID[ti], "in_progress") },
    // Hide card + state update: Framer Motion animates entry in target column
    { delay: t + 1900, step: (s) => patch(s, ti, { status: "in_progress", glow_suppressed: true }), effect: () => resetCard(TID[ti]) },
    { delay: t + 2400, step: (s) => phase(unsup(s, ti), ai, "absorbing") },
    { delay: t + 2800, step: (s) => rm(s, ai) },
  ];
}

// Worker: emerge → lift → slide → hide+review → return (2.5s)
function seqReview(t: number, ai: number, ti: number): TE[] {
  return [
    { delay: t, step: (s) => phase(spawn(sup(s, ti), ai, ti), ai, "emerging") },
    { delay: t + 500, effect: () => liftCard(TID[ti]) },
    { delay: t + 700, step: (s) => phase(s, ai, "dragging"), effect: () => slideCard(TID[ti], "in_review") },
    { delay: t + 1300, step: (s) => patch(s, ti, { status: "in_review" }), effect: () => resetCard(TID[ti]) },
    { delay: t + 1600, step: (s) => phase(s, ai, "returning") },
    { delay: t + 2100, step: (s) => phase(s, ai, "leaving") },
    { delay: t + 2400, step: (s) => rm(s, ai) },
  ];
}

// Leader: fly → absorb(glow) → emerge → lift → slide → hide+drop → return (4.5s)
function seqLeaderDrag(t: number, li: number, ti: number, target: string, dropPatch: Partial<DemoTask>): TE[] {
  return [
    { delay: t, step: (s) => spawn(s, li, ti) },
    { delay: t + 500, step: (s) => phase(s, li, "flying") },
    { delay: t + 1100, step: (s) => phase(s, li, "absorbing"), effect: () => glowCard(TID[ti]) },
    { delay: t + 1500, step: (s) => rm(s, li) },
    { delay: t + 2000, step: (s) => phase(spawn(s, li, ti), li, "emerging"), effect: () => unglowCard(TID[ti]) },
    { delay: t + 2500, effect: () => liftCard(TID[ti]) },
    { delay: t + 2700, step: (s) => phase(s, li, "dragging"), effect: () => slideCard(TID[ti], target) },
    { delay: t + 3300, step: (s) => patch(s, ti, dropPatch), effect: () => resetCard(TID[ti]) },
    { delay: t + 3600, step: (s) => phase(s, li, "returning") },
    { delay: t + 4100, step: (s) => phase(s, li, "leaving") },
    { delay: t + 4400, step: (s) => rm(s, li) },
  ];
}

function seqApprove(t: number, li: number, ti: number): TE[] {
  return seqLeaderDrag(t, li, ti, "done", { status: "done", result: "completed" });
}
function seqReject(t: number, li: number, ti: number): TE[] {
  return seqLeaderDrag(t, li, ti, "in_progress", { status: "in_progress", glow_suppressed: true });
}
function seqCancel(t: number, li: number, ti: number): TE[] {
  return seqLeaderDrag(t, li, ti, "cancelled", { status: "cancelled" });
}

// Worker reclaims after reject: fly → absorb (1.5s)
function seqReclaim(t: number, ai: number, ti: number): TE[] {
  return [
    { delay: t, step: (s) => spawn(s, ai, ti) },
    { delay: t + 500, step: (s) => phase(s, ai, "flying") },
    { delay: t + 1100, step: (s) => phase(unsup(s, ti), ai, "absorbing") },
    { delay: t + 1500, step: (s) => rm(s, ai) },
  ];
}

// ─── Timeline ───

const S = 3; // Sentinel index
const T: TE[] = [
  // ═══ Round 1: Sequential ═══

  // Task 1: Atlas → approve (smooth one-pass)
  ...seqClaim(1500, 0, 0),
  ...seqReview(5500, 0, 0),
  ...seqApprove(8500, S, 0), // done at ~12.6

  // Task 2: Nova → reject → reclaim → approve
  ...seqClaim(14000, 1, 1),
  ...seqReview(18000, 1, 1),
  ...seqReject(21000, S, 1), // back to IP at ~25.1
  ...seqReclaim(26500, 1, 1),
  ...seqReview(29500, 1, 1),
  ...seqApprove(32500, S, 1), // done at ~36.6

  // ═══ Round 2: Concurrent (3 agents) ═══

  // Staggered claims
  ...seqClaim(38500, 0, 2), // Atlas → task 3
  ...seqClaim(40000, 1, 3), // Nova → task 4
  ...seqClaim(41500, 2, 4), // Forge → task 5

  // Staggered reviews (2.5s apart so each finishes before next starts)
  ...seqReview(45500, 0, 2), // Atlas → IR (done ~47.6)
  ...seqReview(48500, 1, 3), // Nova → IR (done ~50.6)
  ...seqReview(51500, 2, 4), // Forge → IR (done ~53.6)

  // Sentinel reviews one by one
  ...seqApprove(54500, S, 2), // task 3 approved → done at ~58.6
  ...seqReject(59500, S, 3), // task 4 rejected → IP at ~63.6
  ...seqCancel(64500, S, 4), // task 5 cancelled at ~68.6

  // Nova reclaims task 4, reviews again, approved
  ...seqReclaim(65500, 1, 3),
  ...seqReview(68500, 1, 3),
  ...seqApprove(71500, S, 3), // done at ~75.6
];

const DONE_DELAY = Math.max(...T.map((e) => e.delay)) + 1000;

// ─── Hook ───

const STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;
const LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

function useDemoSequence() {
  const [state, dispatch] = useReducer(
    (s: DS, step: Step) => step(s),
    null,
    () => ({ tasks: makeTasks(), avatars: new Map() }),
  );
  const [done, setDone] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const start = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    dispatch(() => ({ tasks: makeTasks(), avatars: new Map() }));
    setDone(false);
    for (const e of T) {
      timers.current.push(
        setTimeout(() => {
          e.step && dispatch(e.step);
          e.effect?.();
        }, e.delay),
      );
    }
    timers.current.push(setTimeout(() => setDone(true), DONE_DELAY));
  }, []);

  useEffect(() => {
    start();
    return () => timers.current.forEach(clearTimeout);
  }, [start]);

  const columns = STATUSES.map((s) => ({
    status: s,
    name: LABELS[s],
    tasks: state.tasks.filter((t) => t.status === s).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  }));

  return { columns, avatars: Array.from(state.avatars.values()), done, replay: start };
}

// ─── Component ───

export function DemoBoard({ onContinue, onSkip }: { onContinue: () => void; onSkip?: () => void }) {
  const { columns, avatars, done, replay } = useDemoSequence();
  return (
    <div className="relative">
      <div className="hidden md:grid grid-cols-5 min-h-[50vh]">
        {columns.map((c) => (
          <KanbanColumn key={c.status} column={c} labels={DEMO_LABELS} onTaskClick={() => {}} />
        ))}
      </div>
      <div className="md:hidden min-h-[40vh] grid grid-cols-2">
        {columns
          .filter((c) => c.status === "todo" || c.status === "in_progress")
          .map((c) => (
            <KanbanColumn key={c.status} column={c} labels={DEMO_LABELS} onTaskClick={() => {}} />
          ))}
      </div>
      <AgentAvatarOverlay avatars={avatars} />
      {!done && onSkip && (
        <div className="text-center mt-4">
          <Button variant="ghost" size="sm" onClick={onSkip} className="text-xs text-content-tertiary">
            Skip demo
          </Button>
        </div>
      )}
      {done && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-primary/80 backdrop-blur-sm">
          <div className="text-center space-y-4">
            <p className="text-lg font-semibold text-content-primary">Your agents are waiting.</p>
            <div className="flex flex-col items-center gap-3 w-48">
              <Button onClick={onContinue} className="w-full">
                Set up your board
              </Button>
              <Button variant="outline" onClick={replay} className="w-full">
                Replay
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
