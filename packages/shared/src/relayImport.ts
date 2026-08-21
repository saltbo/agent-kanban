/**
 * Relay JSON import — parse a CC-Switch-style config file (e.g. agent.cfg)
 * into relay endpoint payloads for the Agents → Relay tab.
 *
 * Accepted shapes (the text may hold several concatenated JSON documents):
 *
 *   { "kimi": { "ANTHROPIC_BASE_URL": "...", ... } }   — named env blocks
 *   { "env": { "ANTHROPIC_BASE_URL": "...", ... } }    — settings.json shape
 *
 * Each block maps ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL onto the core fields,
 * ANTHROPIC_DEFAULT_<TIER>_MODEL(+_NAME) onto model_map, and every remaining
 * UPPER_SNAKE key onto extra_env (numbers/booleans coerce to strings).
 */

import type { RelayEndpointInput, RelayModelMap } from "./relayEndpoints.js";
import { detectRelay } from "./relayUsage.js";

export interface RelayImportEntry {
  /** Label of the source block, used for per-entry reporting. */
  source: string;
  /** Present when the block parsed cleanly. */
  input?: RelayEndpointInput;
  /** Present when the block was skipped. */
  error?: string;
}

export interface RelayImportResult {
  entries: RelayImportEntry[];
}

const TIERS = ["OPUS", "SONNET", "HAIKU", "FABLE"] as const;

const KNOWN_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  ...TIERS.flatMap((tier) => [`ANTHROPIC_DEFAULT_${tier}_MODEL`, `ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`]),
]);

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split text holding one or more concatenated JSON documents into
 * per-document strings. Whitespace between documents is ignored; anything
 * else outside a document throws.
 */
function splitJsonDocuments(text: string): string[] {
  const docs: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
      } else if (!/\s/.test(ch)) {
        throw new Error(`unexpected text outside a JSON document at offset ${i}`);
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (start !== -1) throw new Error("unterminated JSON document — missing a closing brace");
  if (docs.length === 0) throw new Error("no JSON document found");
  return docs;
}

function envString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Block names come from arbitrary JSON keys — restore brand casing for known relays. */
const KIND_DISPLAY_NAMES: Record<string, string> = { kimi: "Kimi", deepseek: "DeepSeek" };

function displayName(name: string): string {
  return KIND_DISPLAY_NAMES[name.toLowerCase()] ?? capitalize(name);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function blockToEntry(source: string, env: Record<string, unknown>): RelayImportEntry {
  const baseUrl = envString(env, "ANTHROPIC_BASE_URL");
  if (!baseUrl) return { source, error: "missing ANTHROPIC_BASE_URL" };
  const token = envString(env, "ANTHROPIC_AUTH_TOKEN");
  if (!token) return { source, error: "missing ANTHROPIC_AUTH_TOKEN" };

  const modelMap: RelayModelMap = {};
  for (const tier of TIERS) {
    const model = envString(env, `ANTHROPIC_DEFAULT_${tier}_MODEL`);
    const modelName = envString(env, `ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`);
    if (model || modelName) {
      modelMap[tier.toLowerCase() as keyof RelayModelMap] = {
        ...(model ? { model } : {}),
        ...(modelName ? { model_name: modelName } : {}),
      };
    }
  }

  const extraEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (KNOWN_KEYS.has(key) || !ENV_KEY.test(key)) continue;
    if (typeof value === "string") extraEnv[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") extraEnv[key] = String(value);
  }

  const model = envString(env, "ANTHROPIC_MODEL");
  return {
    source,
    input: {
      name: source,
      // The server resolves "auto" via detectRelay and rejects unknown hosts.
      kind: "auto",
      base_url: baseUrl,
      token,
      ...(model ? { model } : {}),
      model_map: modelMap,
      extra_env: extraEnv,
    },
  };
}

/**
 * Parse import text into per-block results. Blocks that fail to parse or
 * lack required keys come back with `error` set; the caller decides whether
 * to import the valid remainder.
 */
export function parseRelayImport(text: string): RelayImportResult {
  let docs: string[];
  try {
    docs = splitJsonDocuments(text);
  } catch (err) {
    return { entries: [{ source: "file", error: (err as Error).message }] };
  }

  const entries: RelayImportEntry[] = [];
  for (const doc of docs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc);
    } catch (err) {
      entries.push({ source: "document", error: `invalid JSON — ${(err as Error).message}` });
      continue;
    }
    if (!isPlainObject(parsed)) {
      entries.push({ source: "document", error: "expected an object of named env blocks" });
      continue;
    }
    // settings.json shape: a lone "env" key holds one unnamed block, named
    // after the detected relay (or its host when unrecognized).
    if (Object.keys(parsed).length === 1 && isPlainObject(parsed.env)) {
      const baseUrl = envString(parsed.env, "ANTHROPIC_BASE_URL");
      const kind = detectRelay(baseUrl);
      const name = kind ? displayName(kind) : baseUrl ? hostOf(baseUrl) : "Relay";
      entries.push(blockToEntry(name, parsed.env));
      continue;
    }
    for (const [name, env] of Object.entries(parsed)) {
      if (!isPlainObject(env)) {
        entries.push({ source: name, error: "block must be an object of env vars" });
        continue;
      }
      entries.push(blockToEntry(displayName(name), env));
    }
  }
  return { entries };
}
