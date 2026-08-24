/**
 * owner_settings repo — per-owner scheduling preferences (peak-pricing
 * windows). Missing row or malformed JSON resolves to the shared defaults;
 * writes are validated by the route layer before they reach here.
 */
import {
  DEFAULT_RUNTIME_SETTINGS,
  DEFAULT_SCHEDULING_SETTINGS,
  normalizeRuntimeSettings,
  normalizeSchedulingSettings,
  type RuntimeSettings,
  type SchedulingSettings,
} from "@agent-kanban/shared";
import type { D1 } from "./db";

export async function getSchedulingSettings(db: D1, ownerId: string): Promise<SchedulingSettings> {
  const row = await db.prepare("SELECT scheduling FROM owner_settings WHERE owner_id = ?").bind(ownerId).first<{ scheduling: string }>();
  if (!row) return DEFAULT_SCHEDULING_SETTINGS;
  try {
    return normalizeSchedulingSettings(JSON.parse(row.scheduling));
  } catch {
    return DEFAULT_SCHEDULING_SETTINGS;
  }
}

export async function putSchedulingSettings(db: D1, ownerId: string, settings: SchedulingSettings): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO owner_settings (owner_id, scheduling, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET scheduling = excluded.scheduling, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, JSON.stringify(settings), now)
    .run();
}

export async function getRuntimeSettings(db: D1, ownerId: string): Promise<RuntimeSettings> {
  const row = await db.prepare("SELECT runtime FROM owner_settings WHERE owner_id = ?").bind(ownerId).first<{ runtime: string }>();
  if (!row) return DEFAULT_RUNTIME_SETTINGS;
  try {
    return normalizeRuntimeSettings(JSON.parse(row.runtime));
  } catch {
    return DEFAULT_RUNTIME_SETTINGS;
  }
}

export async function putRuntimeSettings(db: D1, ownerId: string, settings: RuntimeSettings): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO owner_settings (owner_id, scheduling, runtime, updated_at) VALUES (?, '{}', ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET runtime = excluded.runtime, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, JSON.stringify(settings), now)
    .run();
}
