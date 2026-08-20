/**
 * Relay endpoint configs — the Claude Code env parameters (base URL, token,
 * model mappings) for Kimi/DeepSeek-style relays, stored per-owner and shown
 * on the Agents → 配额 tab. Mirrors the schedulingSettings validate/normalize
 * pattern: a single `validate` for write paths, a `normalize` for untrusted
 * reads.
 *
 * Security: the raw token lives only in D1 and in memory on the server. Every
 * API response carries `masked_token`; validation error messages must never
 * embed the token value.
 */

import type { RelayBalanceInfo, RelayKind, RelayPeakInfo } from "./relayUsage.js";
import type { UsageWindow } from "./types.js";

/** Per-tier model override, mirroring ANTHROPIC_DEFAULT_*_MODEL(+_NAME) env pairs. */
export interface RelayModelMapping {
  model?: string;
  model_name?: string;
}

export interface RelayModelMap {
  opus?: RelayModelMapping;
  sonnet?: RelayModelMapping;
  haiku?: RelayModelMapping;
  fable?: RelayModelMapping;
}

/** API-facing relay config — the token is always masked. */
export interface RelayEndpointConfig {
  id: string;
  name: string;
  kind: RelayKind;
  base_url: string;
  masked_token: string;
  model?: string;
  model_map: RelayModelMap;
  extra_env: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export type RelayKindInput = RelayKind | "auto";

/** Write payload. `token` is write-only: omitted/empty on update = keep existing. */
export interface RelayEndpointInput {
  name: string;
  kind: RelayKindInput;
  base_url: string;
  token?: string;
  model?: string;
  model_map?: RelayModelMap;
  extra_env?: Record<string, string>;
}

/** Live-probe result for `GET /api/relays/:id/usage`. Always HTTP 200 — errors ride in `error`. */
export interface RelayUsageResponse {
  fetched_at: string;
  ok: boolean;
  error?: {
    kind: "unauthorized" | "rate_limited" | "unreachable";
    message: string;
    retry_after_ms?: number;
  };
  windows: UsageWindow[];
  balance: RelayBalanceInfo | null;
  peak: RelayPeakInfo | null;
}

const MODEL_MAP_KEYS = ["opus", "sonnet", "haiku", "fable"] as const;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const KINDS: RelayKindInput[] = ["auto", "kimi", "deepseek"];

/** Display-safe token form: enough to recognize which key is configured, nothing more. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 3)}...${token.slice(-4)}`;
}

function validateModelMap(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "model_map must be an object";
  for (const [tier, mapping] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MODEL_MAP_KEYS as readonly string[]).includes(tier)) return `model_map key must be one of ${MODEL_MAP_KEYS.join(", ")}`;
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) return `model_map.${tier} must be an object`;
    for (const [field, value] of Object.entries(mapping as Record<string, unknown>)) {
      if (field !== "model" && field !== "model_name") return `model_map.${tier} only supports model and model_name`;
      if (typeof value !== "string") return `model_map.${tier}.${field} must be a string`;
    }
  }
  return null;
}

function validateExtraEnv(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "extra_env must be an object";
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_KEY.test(key)) return `extra_env key "${key}" must be UPPER_SNAKE_CASE`;
    if (typeof value !== "string") return `extra_env.${key} must be a string`;
  }
  return null;
}

/**
 * Validate a relay endpoint write payload. Returns an error message, or null
 * when valid. `requireToken` is true on create; on update an omitted token
 * keeps the stored one. Error messages never include the token value.
 */
export function validateRelayEndpointInput(body: unknown, opts: { requireToken: boolean }): string | null {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const { name, kind, base_url, token, model, model_map, extra_env } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) return "name must be 1–80 characters";
  if (!KINDS.includes(kind as RelayKindInput)) return `kind must be one of ${KINDS.join(", ")}`;
  if (typeof base_url !== "string") return "base_url must be a string";
  try {
    const url = new URL(base_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "base_url must be an http(s) URL";
  } catch {
    return "base_url must be a valid URL";
  }
  if (opts.requireToken && (typeof token !== "string" || token.trim().length === 0)) return "token is required";
  if (token !== undefined && typeof token !== "string") return "token must be a string";
  if (model !== undefined && typeof model !== "string") return "model must be a string";
  if (model_map !== undefined) {
    const err = validateModelMap(model_map);
    if (err) return err;
  }
  if (extra_env !== undefined) {
    const err = validateExtraEnv(extra_env);
    if (err) return err;
  }
  return null;
}

/**
 * Parse a validated payload into a RelayEndpointInput with defaults applied.
 * Call only after `validateRelayEndpointInput` returned null.
 */
export function normalizeRelayEndpointInput(body: unknown): RelayEndpointInput {
  const raw = body as Record<string, unknown>;
  const input: RelayEndpointInput = {
    name: (raw.name as string).trim(),
    kind: raw.kind as RelayKindInput,
    base_url: (raw.base_url as string).replace(/\/+$/, ""),
  };
  if (typeof raw.token === "string" && raw.token.trim().length > 0) input.token = raw.token.trim();
  if (typeof raw.model === "string" && raw.model.trim().length > 0) input.model = raw.model.trim();
  if (raw.model_map !== undefined) input.model_map = raw.model_map as RelayModelMap;
  if (raw.extra_env !== undefined) input.extra_env = raw.extra_env as Record<string, string>;
  return input;
}
