import type { D1 } from "./db";

export interface SystemStats {
  users: { total: number; recent: number };
  agents: { total: number; online: number };
  machines: { total: number; online: number };
  tasks: { todo: number; in_progress: number; in_review: number; error: number; done: number; cancelled: number };
  boards: { total: number };
  runtime_sessions: { total: number; active: number };
}

type CountRow = { "COUNT(*)": number };
type TaskStatusRow = { status: string; count: number };

export async function getSystemStats(db: D1): Promise<SystemStats> {
  const [
    usersTotal,
    usersRecent,
    agentsTotal,
    agentsOnline,
    machinesTotal,
    machinesOnline,
    tasksByStatus,
    boardsTotal,
    runtimeSessionsTotal,
    runtimeSessionsActive,
  ] = await db.batch([
    db.prepare("SELECT COUNT(*) FROM user"),
    db.prepare("SELECT COUNT(*) FROM user WHERE createdAt > datetime('now', '-7 days')"),
    db.prepare("SELECT COUNT(*) FROM agents"),
    db.prepare(
      `SELECT COUNT(*) FROM agents WHERE EXISTS (
        SELECT 1 FROM (
          SELECT agent_id, status FROM agent_sessions
          UNION ALL
          SELECT agent_id, status FROM ama_agent_sessions
        ) sessions
        WHERE sessions.agent_id = agents.id AND sessions.status = 'active'
      )`,
    ),
    db.prepare("SELECT COUNT(*) FROM machines"),
    db.prepare("SELECT COUNT(*) FROM machines WHERE status = 'online'"),
    db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status"),
    db.prepare("SELECT COUNT(*) FROM boards"),
    db.prepare("SELECT COUNT(*) FROM (SELECT id FROM agent_sessions UNION ALL SELECT id FROM ama_agent_sessions)"),
    db.prepare(
      "SELECT COUNT(*) FROM (SELECT id FROM agent_sessions WHERE status = 'active' UNION ALL SELECT id FROM ama_agent_sessions WHERE status = 'active')",
    ),
  ]);

  const taskCounts = { todo: 0, in_progress: 0, in_review: 0, error: 0, done: 0, cancelled: 0 };
  for (const row of tasksByStatus.results as TaskStatusRow[]) {
    const s = row.status as keyof typeof taskCounts;
    if (s in taskCounts) taskCounts[s] = row.count;
  }

  return {
    users: {
      total: (usersTotal.results[0] as CountRow)["COUNT(*)"],
      recent: (usersRecent.results[0] as CountRow)["COUNT(*)"],
    },
    agents: {
      total: (agentsTotal.results[0] as CountRow)["COUNT(*)"],
      online: (agentsOnline.results[0] as CountRow)["COUNT(*)"],
    },
    machines: {
      total: (machinesTotal.results[0] as CountRow)["COUNT(*)"],
      online: (machinesOnline.results[0] as CountRow)["COUNT(*)"],
    },
    tasks: taskCounts,
    boards: {
      total: (boardsTotal.results[0] as CountRow)["COUNT(*)"],
    },
    runtime_sessions: {
      total: (runtimeSessionsTotal.results[0] as CountRow)["COUNT(*)"],
      active: (runtimeSessionsActive.results[0] as CountRow)["COUNT(*)"],
    },
  };
}
