import { createLogger } from "./logger";
import type { Env } from "./types";

export interface MachineMetrics {
  machine_id: string;
  qps: number;
  error_rate: number;
  avg_latency_ms: number;
  total_requests: number;
}

interface AERow {
  machine_id: string;
  total_requests: number;
  error_requests: number;
  avg_latency: number;
}

interface AEResponse {
  data: AERow[];
  rows: number;
}

const WINDOW_SECONDS = 300;
const logger = createLogger("metrics");

export async function getMachineMetrics(env: Env): Promise<Map<string, MachineMetrics>> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

  const query = `
    SELECT
      index1 AS machine_id,
      SUM(_sample_interval) AS total_requests,
      SUM(IF(double1 >= 400, _sample_interval, 0)) AS error_requests,
      AVG(double2) AS avg_latency
    FROM agent_kanban_metrics
    WHERE timestamp > NOW() - INTERVAL '${WINDOW_SECONDS}' SECOND
    GROUP BY index1
  `;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: query,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error(`AE query failed: ${res.status} ${body}`);
    throw new Error(`Analytics Engine query failed: ${res.status}`);
  }

  const result = (await res.json()) as AEResponse;
  const map = new Map<string, MachineMetrics>();

  for (const row of result.data) {
    map.set(row.machine_id, {
      machine_id: row.machine_id,
      qps: Math.round((row.total_requests / WINDOW_SECONDS) * 100) / 100,
      error_rate: row.total_requests > 0 ? Math.round((row.error_requests / row.total_requests) * 1000) / 10 : 0,
      avg_latency_ms: Math.round(row.avg_latency),
      total_requests: row.total_requests,
    });
  }

  return map;
}
