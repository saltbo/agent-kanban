/**
 * relay_endpoints repo — per-owner Kimi/DeepSeek relay configs for the
 * Agents → 配额 tab. Rows carry the raw token (the live probe needs it);
 * routes must return `toPublicConfig(row)` — never the row itself.
 */
import { maskToken, type RelayEndpointConfig, type RelayKind, type RelayModelMap } from "@agent-kanban/shared";
import { type D1, newId } from "./db";

export interface RelayEndpointRow {
  id: string;
  owner_id: string;
  name: string;
  kind: RelayKind;
  base_url: string;
  token: string;
  model: string | null;
  model_map: RelayModelMap;
  extra_env: Record<string, string>;
  created_at: string;
  updated_at: string;
}

interface RawRow extends Omit<RelayEndpointRow, "model_map" | "extra_env"> {
  model_map: string;
  extra_env: string;
}

function parseJsonColumn<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Malformed JSON reads as empty — a corrupt row must not break the list.
    return fallback;
  }
}

function parseRow(row: RawRow): RelayEndpointRow {
  return {
    ...row,
    model_map: parseJsonColumn<RelayModelMap>(row.model_map, {}),
    extra_env: parseJsonColumn<Record<string, string>>(row.extra_env, {}),
  };
}

/** API-facing view — the only shape routes may return. Token is masked. */
export function toPublicConfig(row: RelayEndpointRow): RelayEndpointConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url,
    masked_token: maskToken(row.token),
    ...(row.model ? { model: row.model } : {}),
    model_map: row.model_map,
    extra_env: row.extra_env,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listRelayEndpoints(db: D1, ownerId: string): Promise<RelayEndpointRow[]> {
  const result = await db.prepare("SELECT * FROM relay_endpoints WHERE owner_id = ? ORDER BY created_at ASC").bind(ownerId).all<RawRow>();
  return result.results.map(parseRow);
}

export async function getRelayEndpoint(db: D1, id: string, ownerId: string): Promise<RelayEndpointRow | null> {
  const row = await db.prepare("SELECT * FROM relay_endpoints WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<RawRow>();
  return row ? parseRow(row) : null;
}

export interface RelayEndpointWrite {
  name: string;
  kind: RelayKind;
  baseUrl: string;
  token: string;
  /** null clears the stored model (PUT is full-replace for this field). */
  model?: string | null;
  modelMap: RelayModelMap;
  extraEnv: Record<string, string>;
}

export async function createRelayEndpoint(db: D1, ownerId: string, input: RelayEndpointWrite): Promise<RelayEndpointRow> {
  const now = new Date().toISOString();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO relay_endpoints (id, owner_id, name, kind, base_url, token, model, model_map, extra_env, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ownerId,
      input.name,
      input.kind,
      input.baseUrl,
      input.token,
      input.model ?? null,
      JSON.stringify(input.modelMap),
      JSON.stringify(input.extraEnv),
      now,
      now,
    )
    .run();
  const row = await getRelayEndpoint(db, id, ownerId);
  if (!row) throw new Error("relay endpoint insert failed");
  return row;
}

/** `token` undefined = keep the stored token. Returns null when the row is missing. */
export async function updateRelayEndpoint(db: D1, id: string, ownerId: string, patch: Partial<RelayEndpointWrite>): Promise<RelayEndpointRow | null> {
  const existing = await getRelayEndpoint(db, id, ownerId);
  if (!existing) return null;
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE relay_endpoints SET name = ?, kind = ?, base_url = ?, token = ?, model = ?, model_map = ?, extra_env = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    )
    .bind(
      patch.name ?? existing.name,
      patch.kind ?? existing.kind,
      patch.baseUrl ?? existing.base_url,
      patch.token ?? existing.token,
      patch.model !== undefined ? patch.model : existing.model,
      patch.modelMap !== undefined ? JSON.stringify(patch.modelMap) : JSON.stringify(existing.model_map),
      patch.extraEnv !== undefined ? JSON.stringify(patch.extraEnv) : JSON.stringify(existing.extra_env),
      now,
      id,
      ownerId,
    )
    .run();
  return getRelayEndpoint(db, id, ownerId);
}

export async function deleteRelayEndpoint(db: D1, id: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM relay_endpoints WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
  return result.meta.changes > 0;
}

/** Env keys a relay's structured fields own — extra_env must never shadow them. */
const RELAY_RESERVED_ENV_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  // claude also honors ANTHROPIC_API_KEY as a credential — it must arrive via
  // the vault secret too, never as plaintext extra_env.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
]);

/**
 * Non-secret ANTHROPIC_* env for a relay — base URL, model mappings and extra
 * env. The token is NEVER included here: it is delivered out-of-band via the
 * session vault secret at dispatch. extra_env cannot shadow the structured
 * fields above.
 */
export function relayRuntimeEnv(relay: RelayEndpointRow): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: relay.base_url };
  if (relay.model) env.ANTHROPIC_MODEL = relay.model;
  for (const [tier, mapping] of Object.entries(relay.model_map)) {
    const prefix = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
    if (mapping.model) env[prefix] = mapping.model;
    if (mapping.model_name) env[`${prefix}_NAME`] = mapping.model_name;
  }
  for (const [key, value] of Object.entries(relay.extra_env)) {
    if (RELAY_RESERVED_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  return env;
}
